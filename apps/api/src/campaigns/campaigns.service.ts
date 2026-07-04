import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  type Campaign,
  CampaignStatus,
  MsgStatus,
  SessionStatus,
} from '@prisma/client';

import { spinText, countSpinVariants } from '@wa-engine/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { DelayService } from '../antiban/delay.service';
import { WarmupService } from '../antiban/warmup.service';
import { OutboxProducer } from '../queue/outbox.producer';
import { SmartListsService } from '../smart-lists/smart-lists.service';
import { type CreateCampaignDto } from './dto/create-campaign.dto';
import { type LaunchCampaignDto } from './dto/launch-campaign.dto';

/** Below this many spin variants, a large cold send looks templated — warn the operator. */
const MIN_SPIN_VARIANTS = 5;

function mapP2025(id: string, label: string): (e: unknown) => never {
  return (e: unknown) => {
    if ((e as { code?: string }).code === 'P2025') throw new NotFoundException(`${label} ${id} not found`);
    throw e;
  };
}

export interface CampaignStats {
  status: CampaignStatus;
  total: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
}

export interface CampaignMessageRow {
  id: string;
  campaignId: string;
  contactId: string;
  sessionId: string | null;
  wamid: string | null;
  renderedText: string;
  status: string;
  sentAt: Date | null;
  phone: string | null;
  contactName: string | null;
}

@Injectable()
export class CampaignsService {
  private readonly log = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly delay: DelayService,
    private readonly warmup: WarmupService,
    private readonly producer: OutboxProducer,
    private readonly smartLists: SmartListsService,
  ) {}

  async create(dto: CreateCampaignDto): Promise<Campaign> {
    return this.prisma.campaign.create({
      data: {
        name: dto.name,
        mode: dto.mode,
        templateId: dto.templateId,
        activeFrom: dto.activeFrom ?? 8,
        activeTo: dto.activeTo ?? 22,
        mediaUrl: dto.mediaUrl,
        mediaType: dto.mediaType,
        mediaMimeType: dto.mediaMimeType,
        mediaFilename: dto.mediaFilename,
      },
    });
  }

  async list(): Promise<Campaign[]> {
    return this.prisma.campaign.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string): Promise<Campaign> {
    return this.prisma.campaign.findUniqueOrThrow({ where: { id } }).catch(mapP2025(id, 'Campaign'));
  }

  async delete(id: string): Promise<void> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id }, select: { status: true } });
    if (!campaign) throw new NotFoundException(`Campaign ${id} not found`);
    if (campaign.status === CampaignStatus.RUNNING) {
      throw new BadRequestException('Pause the campaign before deleting it');
    }
    await this.prisma.campaignMessage.deleteMany({ where: { campaignId: id } });
    await this.prisma.campaign.delete({ where: { id } }).catch(mapP2025(id, 'Campaign'));
  }

  /**
   * Transitions DRAFT/PAUSED → RUNNING.
   * Creates one CampaignMessage per contact, assigns sessions round-robin,
   * and enqueues jobs with staggered Gaussian delays.
   * Session daily limits honour the warmup schedule (Layer 2).
   * Auto-pauses immediately if no sessions have remaining capacity.
   */
  async launch(id: string, dto: LaunchCampaignDto): Promise<void> {
    const campaign = await this.prisma.campaign.findUniqueOrThrow({ where: { id } }).catch(mapP2025(id, 'Campaign'));

    if (
      campaign.status !== CampaignStatus.DRAFT &&
      campaign.status !== CampaignStatus.PAUSED &&
      campaign.status !== CampaignStatus.RUNNING
    ) {
      throw new BadRequestException(
        `Campaign must be DRAFT, PAUSED, or RUNNING to add contacts (current: ${campaign.status})`,
      );
    }

    // Resolve contact IDs — smart list takes priority, launchAll fetches all valid, falls back to explicit contactIds
    let resolvedContactIds: string[] | null = null; // null = "all valid contacts"
    if (dto.smartListId) {
      resolvedContactIds = await this.smartLists.resolveContactIds(dto.smartListId);
      if (!resolvedContactIds.length) {
        throw new BadRequestException('Smart list is empty');
      }
    } else if (dto.launchAll) {
      resolvedContactIds = null; // signal to fetch all valid below
    } else if (dto.contactIds?.length) {
      resolvedContactIds = dto.contactIds;
    } else {
      throw new BadRequestException('Provide contactIds, smartListId, or launchAll=true');
    }

    const template = campaign.templateId
      ? await this.prisma.template.findUnique({ where: { id: campaign.templateId } })
      : null;

    if (!template) {
      throw new BadRequestException(
        'Campaign has no template — assign a message template before launching',
      );
    }

    const contacts = await this.prisma.contact.findMany({
      where: resolvedContactIds !== null
        ? { id: { in: resolvedContactIds }, valid: true }
        : { valid: true },
    });

    if (!contacts.length) {
      throw new BadRequestException('No valid contacts found for the provided IDs');
    }

    const allSessions = await this.prisma.session.findMany({
      where: {
        mode: campaign.mode,
        status: SessionStatus.ONLINE,
        ...(dto.sessionIds?.length ? { id: { in: dto.sessionIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });

    // Layer 2: warmup caps override the global daily limit for new sessions
    const sessions = allSessions.filter(
      (s) => s.dailySent < this.warmup.getEffectiveDailyLimit(s),
    );

    if (!sessions.length) {
      await this.prisma.campaign.update({
        where: { id },
        data: { status: CampaignStatus.PAUSED },
      });
      this.log.warn(`Campaign ${id} auto-paused — all sessions at daily limit`);
      return;
    }

    if (campaign.status !== CampaignStatus.RUNNING) {
      // Use updateMany so a concurrent launch request sees count=0 and skips the duplicate work
      const updated = await this.prisma.campaign.updateMany({
        where: { id, status: { not: CampaignStatus.RUNNING } },
        data: { status: CampaignStatus.RUNNING },
      });
      if (updated.count === 0) {
        this.log.warn(`Campaign ${id} already set to RUNNING by concurrent request — proceeding with dedup`);
      }
    }

    // Skip contacts that already have a non-failed message in this campaign (dedup)
    const alreadyQueued = new Set(
      (
        await this.prisma.campaignMessage.findMany({
          where: {
            campaignId: id,
            contactId: { in: contacts.map((c) => c.id) },
            status: { not: MsgStatus.FAILED },
          },
          select: { contactId: true },
        })
      ).map((m) => m.contactId),
    );

    const newContacts = contacts.filter((c) => {
      if (alreadyQueued.has(c.id)) {
        this.log.log(`Campaign ${id} skipping contact ${c.id} — already has active message`);
        return false;
      }
      return true;
    });

    if (!newContacts.length) {
      this.log.log(`Campaign ${id} — all contacts already scheduled, nothing to enqueue`);
      return;
    }

    // Bulk-check which contacts have been messaged before across any campaign
    // Used for per-contact delay multiplier: strangers get 2.5× longer gaps (anti-ban)
    const previouslySentToIds = new Set(
      (
        await this.prisma.campaignMessage.findMany({
          where: {
            contactId: { in: newContacts.map((c) => c.id) },
            status: { in: [MsgStatus.SENT, MsgStatus.DELIVERED, MsgStatus.READ, MsgStatus.REPLIED] },
          },
          select: { contactId: true },
          distinct: ['contactId'],
        })
      ).map((m) => m.contactId),
    );

    // Anti-ban spin-variation guard. A template with little spin variety sends nearly the
    // same text to everyone — a strong spam signal. Personalization variables ({name}) also
    // add real-world variety, so this is a warning (not a hard block) to avoid breaking
    // legitimate personalized-but-unspun templates.
    const spinVariants = countSpinVariants(template.body);
    if (spinVariants < MIN_SPIN_VARIANTS && newContacts.length > spinVariants * 4) {
      this.log.warn(
        `Campaign ${id}: template "${template.name}" has only ~${spinVariants} spin variant(s) for ` +
        `${newContacts.length} recipients — add {option A|option B} spin syntax to reduce ban risk.`,
      );
    }

    // Cumulative delay per session (ms from now)
    const sessionDelays = new Map<string, number>();
    for (const s of sessions) sessionDelays.set(s.id, 0);

    for (let i = 0; i < newContacts.length; i++) {
      const contact = newContacts[i]!;
      const session = sessions[i % sessions.length]!;

      const renderedText = spinText(template.body, this.buildVars(contact));

      const msg = await this.prisma.campaignMessage.create({
        data: {
          campaignId: id,
          contactId: contact.id,
          sessionId: session.id,
          renderedText,
          status: MsgStatus.QUEUED,
        },
      });

      const prevDelay = sessionDelays.get(session.id) ?? 0;
      // Stranger penalty: first-ever outreach to a contact gets 2.5× the delay
      const contactMultiplier = previouslySentToIds.has(contact.id) ? 1.0 : 2.5;
      const nextGap = Math.round(this.delay.computeDelayMs() * contactMultiplier);
      const totalDelay = prevDelay + nextGap;
      sessionDelays.set(session.id, totalDelay);

      await this.producer.enqueue(
        {
          campaignMessageId: msg.id,
          campaignId: id,
          contactId: contact.id,
          sessionId: session.id,
          phone: contact.phone,
          renderedText,
          templateName: template?.name,
          activeFrom: campaign.activeFrom,
          activeTo: campaign.activeTo,
          mode: campaign.mode,
          mediaUrl: campaign.mediaUrl ?? undefined,
          mediaType: campaign.mediaType ?? undefined,
          mediaMimeType: campaign.mediaMimeType ?? undefined,
          mediaFilename: campaign.mediaFilename ?? undefined,
        },
        { delay: totalDelay },
      );
    }

    this.log.log(
      `Campaign ${id} launched: ${newContacts.length} new jobs across ${sessions.length} sessions`,
    );
  }

  async pause(id: string): Promise<void> {
    try {
      await this.prisma.campaign.update({
        where: { id },
        data: { status: CampaignStatus.PAUSED },
      });
    } catch (e) { mapP2025(id, 'Campaign')(e); }
  }

  async resume(id: string): Promise<void> {
    const campaign = await this.prisma.campaign.findUniqueOrThrow({ where: { id } }).catch(mapP2025(id, 'Campaign'));
    if (campaign.status !== CampaignStatus.PAUSED) {
      throw new BadRequestException(
        `Campaign must be PAUSED to resume (current: ${campaign.status})`,
      );
    }
    await this.prisma.campaign.update({
      where: { id },
      data: { status: CampaignStatus.RUNNING },
    });
    this.log.log(`Campaign ${id} resumed`);
  }

  async getMessages(id: string, take: number): Promise<CampaignMessageRow[]> {
    await this.prisma.campaign.findUniqueOrThrow({ where: { id } }).catch(mapP2025(id, 'Campaign'));
    const safeTake = Math.min(isNaN(take) ? 20 : take, 200);
    const rows = await this.prisma.campaignMessage.findMany({
      where: { campaignId: id },
      orderBy: { id: 'desc' },
      take: safeTake,
      include: { contact: { select: { phone: true, name: true } } },
    });
    return rows.map(({ contact, ...msg }) => ({
      ...msg,
      phone: contact?.phone ?? null,
      contactName: contact?.name ?? null,
    }));
  }

  async getStats(id: string): Promise<CampaignStats> {
    const campaign = await this.prisma.campaign.findUniqueOrThrow({ where: { id } }).catch(mapP2025(id, 'Campaign'));

    const rows = await this.prisma.campaignMessage.groupBy({
      by: ['status'],
      where: { campaignId: id },
      _count: { status: true },
    });

    const counts: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      counts[row.status] = row._count.status;
      total += row._count.status;
    }

    return {
      status: campaign.status,
      total,
      queued: counts[MsgStatus.QUEUED] ?? 0,
      sent: counts[MsgStatus.SENT] ?? 0,
      delivered: counts[MsgStatus.DELIVERED] ?? 0,
      read: counts[MsgStatus.READ] ?? 0,
      replied: counts[MsgStatus.REPLIED] ?? 0,
      failed: counts[MsgStatus.FAILED] ?? 0,
    };
  }

  private buildVars(contact: {
    name: string | null;
    phone: string;
    city: string | null;
    interest: string | null;
    vars: unknown;
  }): Record<string, string> {
    const out: Record<string, string> = {};
    out['name'] = contact.name ?? contact.phone; // always defined so {name} never renders empty
    if (contact.city) out['city'] = contact.city;
    if (contact.interest) out['interest'] = contact.interest;
    out['phone'] = contact.phone;

    if (contact.vars && typeof contact.vars === 'object') {
      for (const [k, v] of Object.entries(contact.vars as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
    }

    return out;
  }
}
