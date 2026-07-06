import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Template } from '@prisma/client';
import { validateButtons, validateCarousel } from '@wa-engine/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreateTemplateDto } from './dto/create-template.dto';

interface ModeFields {
  buttons?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  carouselCards?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  mediaUrl?: string | null;
}

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateTemplateDto): Promise<Template> {
    this.assertValidButtons(dto.buttons);
    this.assertValidCarousel(dto.carouselCards);
    const { buttons: _buttons, carouselCards: _carouselCards, mediaUrl: _mediaUrl, ...rest } = dto;
    return this.prisma.template.create({
      data: { ...rest, ...this.buildModeFields(dto) },
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
    this.assertValidCarousel(dto.carouselCards);
    const { buttons: _buttons, carouselCards: _carouselCards, mediaUrl: _mediaUrl, ...rest } = dto;
    try {
      return await this.prisma.template.update({
        where: { id },
        data: { ...rest, ...this.buildModeFields(dto) },
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2025') throw new NotFoundException(`Template ${id} not found`);
      throw e;
    }
  }

  /**
   * Single-card (buttons/mediaUrl) and carousel (carouselCards) mode are mutually
   * exclusive on a Template. Whichever key is PRESENT in the request (even as an
   * empty array — presence, not truthiness, so "clear my buttons" still works)
   * wins and forcibly nulls the other two fields. Neither key present (e.g. an
   * update that only touches `name`) leaves both untouched.
   */
  private buildModeFields(dto: Partial<CreateTemplateDto>): ModeFields {
    if (dto.carouselCards !== undefined) {
      return {
        carouselCards: dto.carouselCards as unknown as Prisma.InputJsonValue,
        buttons: Prisma.JsonNull,
        mediaUrl: null,
      };
    }
    if (dto.buttons !== undefined) {
      return {
        buttons: dto.buttons as unknown as Prisma.InputJsonValue,
        carouselCards: Prisma.JsonNull,
        mediaUrl: dto.mediaUrl,
      };
    }
    return { mediaUrl: dto.mediaUrl };
  }

  // Lenient (mode-agnostic) check at save time — the strict Cloud-API-vs-Baileys
  // rule can only be enforced once a campaign's mode is known, at launch time
  // (see CampaignsService.launch()).
  private assertValidButtons(buttons: CreateTemplateDto['buttons']): void {
    if (!buttons?.length) return;
    const result = validateButtons(buttons, 'ANY');
    if (!result.valid) throw new BadRequestException(result.errors.join('; '));
  }

  private assertValidCarousel(cards: CreateTemplateDto['carouselCards']): void {
    if (!cards?.length) return;
    const result = validateCarousel(cards, 'ANY');
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
