import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min, IsBoolean } from 'class-validator';
import { CampaignStatus, type Proxy } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { SettingsService, type EngineSettings, type AiSettings } from './settings.service';
import { BAILEYS_QUEUE, CLOUD_API_QUEUE, DLQ_QUEUE } from '../queue/queue.constants';

class CreateProxyDto {
  @IsString()
  @IsNotEmpty()
  host!: string;

  @IsInt()
  @Min(1)
  @Max(65535)
  port!: number;

  @IsOptional()
  @IsString()
  @IsIn(['http', 'https', 'socks5', 'socks4'])
  protocol?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  country?: string;
}

// Hard anti-ban bounds — these floors/ceilings keep the delay engine in a safe range even
// when an operator edits settings. Cross-field ordering (floor < mean < ceiling) is enforced
// in patchEngine() against the MERGED effective values, since a PATCH may set only some fields.
const MIN_DELAY_FLOOR_MS = 30_000; // 30s hard minimum between messages
const MAX_DELAY_MS = 1_800_000; // 30min ceiling on any single delay
const MIN_STD_DEV_MS = 5_000; // keep some timing variance (even spacing is a bot signal)
const MAX_TYPING_MS = 30_000;
const MAX_DAILY_LIMIT = 1_000;

class PatchEngineDto {
  @IsOptional()
  @IsInt()
  @Min(MIN_DELAY_FLOOR_MS)
  @Max(MAX_DELAY_MS)
  meanMs?: number;

  @IsOptional()
  @IsInt()
  @Min(MIN_STD_DEV_MS)
  @Max(MAX_DELAY_MS)
  stdDevMs?: number;

  @IsOptional()
  @IsInt()
  @Min(MIN_DELAY_FLOOR_MS)
  @Max(MAX_DELAY_MS)
  floorMs?: number;

  @IsOptional()
  @IsInt()
  @Min(MIN_DELAY_FLOOR_MS)
  @Max(MAX_DELAY_MS)
  ceilingMs?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_TYPING_MS)
  typingMs?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_DAILY_LIMIT)
  dailyLimit?: number;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

class PatchAiDto {
  @IsOptional()
  @IsString()
  @IsIn(['anthropic', 'openai'])
  provider?: string;

  @IsOptional()
  @IsString()
  model?: string;

  @IsOptional()
  @IsBoolean()
  autoReply?: boolean;

  @IsOptional()
  @IsBoolean()
  sentiment?: boolean;
}

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @InjectQueue(BAILEYS_QUEUE) private readonly baileysQ: Queue,
    @InjectQueue(CLOUD_API_QUEUE) private readonly cloudApiQ: Queue,
    @InjectQueue(DLQ_QUEUE) private readonly dlqQ: Queue,
  ) {}

  /* ── Root (Sessions page reads dailyLimit from here) ────────── */
  @Get()
  getRoot(): EngineSettings {
    return this.settings.getEngineSettings();
  }

  /* ── Dry-run status (kept for backwards compatibility) ─────── */
  @Get('dry-run')
  dryRun(): { dryRun: boolean } {
    const engine = this.settings.getEngineSettings();
    return { dryRun: engine.dryRun };
  }

  /* ── Engine / delay settings ────────────────────────────────── */
  @Get('engine')
  getEngine(): EngineSettings {
    return this.settings.getEngineSettings();
  }

  @Patch('antiban')
  async patchEngine(@Body() dto: PatchEngineDto): Promise<EngineSettings> {
    // Validate cross-field ordering against the MERGED effective values (a PATCH may set
    // only some fields, so we can't judge floor<mean<ceiling from the DTO alone).
    const current = this.settings.getEngineSettings();
    const floorMs = dto.floorMs ?? current.floorMs;
    const meanMs = dto.meanMs ?? current.meanMs;
    const ceilingMs = dto.ceilingMs ?? current.ceilingMs;
    const stdDevMs = dto.stdDevMs ?? current.stdDevMs;
    if (!(floorMs < meanMs && meanMs < ceilingMs)) {
      throw new BadRequestException(
        `Delay bounds must satisfy floor < mean < ceiling (got floor=${floorMs}, mean=${meanMs}, ceiling=${ceilingMs}).`,
      );
    }
    if (stdDevMs > meanMs) {
      throw new BadRequestException(
        `Delay standard deviation (${stdDevMs}) cannot exceed the mean (${meanMs}).`,
      );
    }

    const pairs: [string, string][] = [];
    if (dto.meanMs !== undefined) pairs.push(['DELAY_MEAN_MS', String(dto.meanMs)]);
    if (dto.stdDevMs !== undefined) pairs.push(['DELAY_STD_DEV_MS', String(dto.stdDevMs)]);
    if (dto.floorMs !== undefined) pairs.push(['DELAY_FLOOR_MS', String(dto.floorMs)]);
    if (dto.ceilingMs !== undefined) pairs.push(['DELAY_CEILING_MS', String(dto.ceilingMs)]);
    if (dto.typingMs !== undefined) pairs.push(['TYPING_SIMULATION_MS', String(dto.typingMs)]);
    if (dto.dailyLimit !== undefined) pairs.push(['DAILY_SEND_LIMIT', String(dto.dailyLimit)]);
    if (dto.dryRun !== undefined) pairs.push(['DRY_RUN', dto.dryRun ? 'true' : 'false']);
    await Promise.all(pairs.map(([k, v]) => this.settings.set(k, v)));
    return this.settings.getEngineSettings();
  }

  /* ── Warmup schedule (read-only — hardcoded by design) ──────── */
  @Get('warmup')
  getWarmup() {
    const graduatedCap = this.settings.getEngineSettings().dailyLimit;
    return {
      schedule: [
        { fromDay: 0, toDay: 2, dailyCap: 15, strangerCap: 8 },
        { fromDay: 3, toDay: 6, dailyCap: 35, strangerCap: 20 },
        { fromDay: 7, toDay: 10, dailyCap: 60, strangerCap: 35 },
        { fromDay: 11, toDay: 14, dailyCap: 100, strangerCap: 60 },
        { fromDay: 15, toDay: 19, dailyCap: 160, strangerCap: 100 },
        { fromDay: 20, toDay: 24, dailyCap: 250, strangerCap: 170 },
        { fromDay: 25, toDay: 29, dailyCap: 400, strangerCap: 300 },
        { fromDay: 30, toDay: 34, dailyCap: 600, strangerCap: 480 },
        { fromDay: 35, toDay: 39, dailyCap: 800, strangerCap: 700 },
        { fromDay: 40, toDay: null, dailyCap: graduatedCap, strangerCap: graduatedCap },
      ],
      note:
        'Warmup schedule is fixed for optimal anti-ban protection. "Cold" is the stricter sub-cap ' +
        'for first-contact messages to people who have never received one. Day 40+ uses DAILY_SEND_LIMIT.',
    };
  }

  /* ── AI Brain settings ───────────────────────────────────────── */
  @Get('ai-provider')
  getAi(): AiSettings {
    return this.settings.getAiSettings();
  }

  @Patch('ai')
  async patchAi(@Body() dto: PatchAiDto): Promise<AiSettings> {
    const pairs: [string, string][] = [];
    if (dto.provider !== undefined) pairs.push(['AI_PROVIDER', dto.provider]);
    if (dto.model !== undefined) pairs.push(['AI_MODEL', dto.model]);
    if (dto.autoReply !== undefined) pairs.push(['AI_AUTO_REPLY', dto.autoReply ? 'true' : 'false']);
    if (dto.sentiment !== undefined) pairs.push(['AI_SENTIMENT', dto.sentiment ? 'true' : 'false']);
    await Promise.all(pairs.map(([k, v]) => this.settings.set(k, v)));
    return this.settings.getAiSettings();
  }

  /* ── Queue purge ─────────────────────────────────────────────── */
  @Post('queue/purge')
  @HttpCode(200)
  async purgeQueues(): Promise<{ purged: boolean; message: string }> {
    const running = await this.prisma.campaign.count({ where: { status: CampaignStatus.RUNNING } });
    if (running > 0) {
      throw new BadRequestException(
        `Pause all running campaigns before purging queues (${running} campaign${running > 1 ? 's' : ''} still running)`,
      );
    }
    await Promise.all([
      this.baileysQ.obliterate({ force: true }),
      this.cloudApiQ.obliterate({ force: true }),
      this.dlqQ.obliterate({ force: true }),
    ]);
    return { purged: true, message: 'All queued messages removed from Baileys, Cloud API, and DLQ queues.' };
  }

  /* ── Proxy CRUD ──────────────────────────────────────────────── */
  @Get('proxies')
  listProxies(): Promise<Proxy[]> {
    return this.prisma.proxy.findMany({ orderBy: { id: 'asc' } });
  }

  @Post('proxies')
  createProxy(@Body() dto: CreateProxyDto): Promise<Proxy> {
    return this.prisma.proxy.create({
      data: {
        host: dto.host,
        port: dto.port,
        protocol: dto.protocol ?? 'http',
        username: dto.username,
        password: dto.password,
        country: dto.country,
      },
    });
  }

  @Delete('proxies/:id')
  @HttpCode(204)
  async deleteProxy(@Param('id') id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.session.updateMany({
        where: { proxyId: id },
        data: { proxyId: null },
      });
      try {
        await tx.proxy.delete({ where: { id } });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2025') throw new NotFoundException(`Proxy ${id} not found`);
        throw e;
      }
    });
  }
}
