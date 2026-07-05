import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, Template } from '@prisma/client';
import { validateButtons } from '@wa-engine/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateTemplateDto } from './dto/create-template.dto';

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateTemplateDto): Promise<Template> {
    this.assertValidButtons(dto.buttons);
    return this.prisma.template.create({
      data: { ...dto, buttons: dto.buttons as Prisma.InputJsonValue | undefined },
    });
  }

  async findAll(): Promise<Template[]> {
    return this.prisma.template.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string): Promise<Template> {
    const t = await this.prisma.template.findUnique({ where: { id } });
    if (!t) throw new NotFoundException(`Template ${id} not found`);
    return t;
  }

  async update(id: string, dto: Partial<CreateTemplateDto>): Promise<Template> {
    this.assertValidButtons(dto.buttons);
    try {
      return await this.prisma.template.update({
        where: { id },
        data: { ...dto, buttons: dto.buttons as Prisma.InputJsonValue | undefined },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') throw new NotFoundException(`Template ${id} not found`);
      throw e;
    }
  }

  // Lenient (mode-agnostic) check at save time — the strict Cloud-API-vs-Baileys
  // rule can only be enforced once a campaign's mode is known, at launch time
  // (see CampaignsService.launch()).
  private assertValidButtons(buttons: CreateTemplateDto['buttons']): void {
    if (!buttons?.length) return;
    const result = validateButtons(buttons, 'ANY');
    if (!result.valid) throw new BadRequestException(result.errors.join('; '));
  }

  async delete(id: string): Promise<void> {
    try {
      await this.prisma.template.delete({ where: { id } });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') throw new NotFoundException(`Template ${id} not found`);
      throw e;
    }
  }
}
