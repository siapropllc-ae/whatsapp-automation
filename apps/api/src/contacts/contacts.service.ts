import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Contact } from '@prisma/client';
import { LeadTemp } from '@prisma/client';
import { isValidE164 } from '@wa-engine/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import type { ImportContactsDto } from './dto/import-contacts.dto';
import type { ContactItemDto } from './dto/contact-item.dto';

export interface ImportResult {
  imported: number;   // new contacts created
  skipped: number;    // rows with a blank/invalid phone number
  duplicates: number; // rows whose phone already existed (in the file or the DB)
}

// Postgres caps a statement at 65535 bind params; contacts have ~8 columns, so keep
// each createMany batch well under that. Also keeps memory/pooler pressure low for 10k+ files.
const IMPORT_BATCH_SIZE = 1000;

/**
 * Recovers a sendable E.164 number from messy input (Excel numeric cells, spaces, dashes,
 * dots, slashes, a leading "00" international prefix). Returns null when nothing valid
 * can be salvaged (e.g. blank, too short/long, or a local number with no country code).
 */
function normalizePhone(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  let digits = s.replace(/\D/g, ''); // drop every non-digit (keeps only 0-9)
  if (digits.startsWith('00')) digits = digits.slice(2); // 00 = international dialing prefix
  if (!digits) return null;
  const e164 = `+${digits}`;
  return isValidE164(e164) ? e164 : null;
}

export interface ValidateResult {
  valid: number;
  invalid: number;
}

export interface ContactsPage {
  data: Contact[];
  total: number;
  skip: number;
  take: number;
}

@Injectable()
export class ContactsService {
  constructor(private readonly prisma: PrismaService) {}

  async createContact(dto: ContactItemDto): Promise<Contact> {
    const vars =
      dto.vars !== undefined ? (dto.vars as Prisma.InputJsonValue) : undefined;
    return this.prisma.contact.upsert({
      where: { phone: dto.phone },
      update: {
        name: dto.name,
        city: dto.city,
        interest: dto.interest,
        notes: dto.notes,
        leadTemp: dto.leadTemp ?? LeadTemp.COLD,
        vars,
        tags: dto.tags ?? [],
      },
      create: {
        phone: dto.phone,
        name: dto.name,
        city: dto.city,
        interest: dto.interest,
        notes: dto.notes,
        leadTemp: dto.leadTemp ?? LeadTemp.COLD,
        vars,
        tags: dto.tags ?? [],
      },
    });
  }

  async updateContact(id: string, dto: Partial<ContactItemDto>): Promise<Contact> {
    const vars =
      dto.vars !== undefined ? (dto.vars as Prisma.InputJsonValue) : undefined;
    try {
      return await this.prisma.contact.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.city !== undefined && { city: dto.city }),
          ...(dto.interest !== undefined && { interest: dto.interest }),
          ...(dto.notes !== undefined && { notes: dto.notes }),
          ...(dto.leadTemp !== undefined && { leadTemp: dto.leadTemp }),
          ...(vars !== undefined && { vars }),
          ...(dto.tags !== undefined && { tags: dto.tags }),
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') throw new NotFoundException(`Contact ${id} not found`);
      throw e;
    }
  }

  async importContacts(dto: ImportContactsDto): Promise<ImportResult> {
    // 1) Normalize + validate each row; drop (don't reject) the ones we can't salvage.
    //    Dedupe by phone within the file, keeping the first occurrence.
    let invalid = 0;
    let validCount = 0; // valid rows BEFORE in-file dedupe (used to count duplicates)
    const byPhone = new Map<string, Prisma.ContactCreateManyInput>();
    for (const item of dto.contacts) {
      const phone = normalizePhone(item.phone);
      if (!phone) {
        invalid++;
        continue;
      }
      validCount++;
      if (byPhone.has(phone)) continue; // in-file duplicate
      byPhone.set(phone, {
        phone,
        name: item.name,
        city: item.city,
        interest: item.interest,
        notes: item.notes,
        leadTemp: item.leadTemp ?? LeadTemp.COLD,
        vars: item.vars !== undefined ? (item.vars as Prisma.InputJsonValue) : undefined,
        tags: item.tags ?? [],
      });
    }

    const rows = [...byPhone.values()];
    const uniquePhones = [...byPhone.keys()];

    // 2) Bulk insert in batches. createMany + skipDuplicates is one statement per batch —
    //    it can't exhaust the connection pool the way hundreds of concurrent upserts could,
    //    and existing phones are simply skipped (the unique phone constraint dedupes vs the DB).
    let created = 0;
    for (let i = 0; i < rows.length; i += IMPORT_BATCH_SIZE) {
      const batch = rows.slice(i, i + IMPORT_BATCH_SIZE);
      const res = await this.prisma.contact.createMany({ data: batch, skipDuplicates: true });
      created += res.count;
    }

    // 3) Optionally add every valid contact (new OR pre-existing) to the target smart list.
    if (dto.smartListId && uniquePhones.length > 0) {
      for (let i = 0; i < uniquePhones.length; i += IMPORT_BATCH_SIZE) {
        const phoneBatch = uniquePhones.slice(i, i + IMPORT_BATCH_SIZE);
        const contacts = await this.prisma.contact.findMany({
          where: { phone: { in: phoneBatch } },
          select: { id: true },
        });
        if (contacts.length > 0) {
          await this.prisma.smartListContact.createMany({
            data: contacts.map((c) => ({ smartListId: dto.smartListId!, contactId: c.id })),
            skipDuplicates: true,
          });
        }
      }
    }

    // duplicates = valid rows that did not become a NEW contact (in-file dupes + already in DB)
    const duplicates = validCount - created;
    return { imported: created, skipped: invalid, duplicates };
  }

  async listContacts(params?: {
    search?: string;
    tag?: string;
    valid?: boolean;
    leadTemp?: LeadTemp;
    smartListId?: string;
    skip?: number;
    take?: number;
  }): Promise<ContactsPage> {
    const skip = params?.skip ?? 0;
    const take = Math.min(params?.take ?? 50, 200);
    const where: Prisma.ContactWhereInput = {
      ...(params?.search
        ? {
            OR: [
              { phone: { contains: params.search, mode: 'insensitive' } },
              { name: { contains: params.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(params?.tag ? { tags: { has: params.tag } } : {}),
      ...(params?.valid !== undefined ? { valid: params.valid } : {}),
      ...(params?.leadTemp ? { leadTemp: params.leadTemp } : {}),
      ...(params?.smartListId
        ? { smartLists: { some: { smartListId: params.smartListId } } }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.contact.count({ where }),
    ]);

    return { data, total, skip, take };
  }

  async validateContacts(): Promise<ValidateResult> {
    const contacts = await this.prisma.contact.findMany({
      select: { id: true, phone: true },
    });

    const validIds: string[] = [];
    const invalidIds: string[] = [];

    for (const c of contacts) {
      if (isValidE164(c.phone)) {
        validIds.push(c.id);
      } else {
        invalidIds.push(c.id);
      }
    }

    if (invalidIds.length) {
      await this.prisma.contact.updateMany({
        where: { id: { in: invalidIds } },
        data: { valid: false },
      });
    }

    if (validIds.length) {
      await this.prisma.contact.updateMany({
        where: { id: { in: validIds } },
        data: { valid: true },
      });
    }

    return { valid: validIds.length, invalid: invalidIds.length };
  }

  async deleteContact(id: string): Promise<void> {
    try {
      await this.prisma.contact.delete({ where: { id } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') throw new NotFoundException(`Contact ${id} not found`);
      throw e;
    }
  }

  async deleteContacts(ids: string[]): Promise<{ deleted: number }> {
    const result = await this.prisma.contact.deleteMany({ where: { id: { in: ids } } });
    return { deleted: result.count };
  }

  async deleteAllContacts(): Promise<{ deleted: number }> {
    const result = await this.prisma.contact.deleteMany({});
    return { deleted: result.count };
  }

  async upsertFromWhatsApp(
    contacts: { phone: string; name?: string }[],
  ): Promise<{ imported: number }> {
    let imported = 0;
    for (const c of contacts) {
      if (!c.phone || !isValidE164(c.phone)) continue;
      try {
        await this.prisma.contact.upsert({
          where: { phone: c.phone },
          update: { name: c.name ?? undefined },
          create: { phone: c.phone, name: c.name ?? undefined, leadTemp: LeadTemp.COLD, tags: [] },
        });
        imported++;
      } catch {
        // skip duplicates / invalid
      }
    }
    return { imported };
  }
}
