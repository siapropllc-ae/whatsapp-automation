import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SessionStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

/** Shape required from a Session to compute the effective limit. */
export interface SessionWarmupData {
  warmupDay: number;
  dailySent: number;
}

/** Warmup schedule graduates on this day — after it, the env DAILY_SEND_LIMIT applies. */
const GRADUATION_DAY = 40;

/**
 * Total daily-send cap by warmup day-range. Ramps gently to the env DAILY_SEND_LIMIT
 * (target 1000/day) over ~40 days. Day GRADUATION_DAY+ falls through to DAILY_SEND_LIMIT.
 */
const WARMUP_CAPS: [minDay: number, maxDay: number, cap: number][] = [
  [0,  2,  15],
  [3,  6,  35],
  [7,  10, 60],
  [11, 14, 100],
  [15, 19, 160],
  [20, 24, 250],
  [25, 29, 400],
  [30, 34, 600],
  [35, 39, 800],
  // Day 40+ falls through to DAILY_SEND_LIMIT env (default 1000)
];

/**
 * Cold first-contact ("stranger") daily sub-cap by warmup day-range. This is the real
 * ban protection: WhatsApp throttles new-conversation spam hardest. Always <= total cap.
 * Day GRADUATION_DAY+ falls through to DAILY_SEND_LIMIT (cold cap catches up to total).
 */
const STRANGER_CAPS: [minDay: number, maxDay: number, cap: number][] = [
  [0,  2,  8],
  [3,  6,  20],
  [7,  10, 35],
  [11, 14, 60],
  [15, 19, 100],
  [20, 24, 170],
  [25, 29, 300],
  [30, 34, 480],
  [35, 39, 700],
  // Day 40+ falls through to DAILY_SEND_LIMIT env (default 1000)
];

@Injectable()
export class WarmupService {
  private readonly log = new Logger(WarmupService.name);
  readonly dailyLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.dailyLimit = +(config.get<string>('DAILY_SEND_LIMIT') ?? '1000');
  }

  /**
   * Returns the effective total daily send cap for a session.
   * Uses warmup schedule until GRADUATION_DAY; then falls back to env limit.
   */
  getEffectiveDailyLimit(session: SessionWarmupData): number {
    return this.capFrom(WARMUP_CAPS, session.warmupDay);
  }

  /**
   * Returns the effective cold first-contact ("stranger") daily sub-cap for a session.
   * Never exceeds the total daily cap.
   */
  getEffectiveStrangerLimit(session: SessionWarmupData): number {
    return Math.min(
      this.capFrom(STRANGER_CAPS, session.warmupDay),
      this.getEffectiveDailyLimit(session),
    );
  }

  private capFrom(table: [number, number, number][], warmupDay: number): number {
    if (warmupDay >= GRADUATION_DAY) return this.dailyLimit;
    for (const [min, max, cap] of table) {
      if (warmupDay >= min && warmupDay <= max) return cap;
    }
    return this.dailyLimit;
  }

  /**
   * Midnight cron: advance warmup + reset daily counters.
   * warmupDay only advances for ONLINE sessions that actually SENT something that day —
   * an idle-but-connected number must not "graduate" to higher caps without real
   * sending reputation. Counters (dailySent, strangerSent) reset for every session.
   * Two updateMany calls (increment-then-blanket-reset) avoid overlap races.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async midnightReset(): Promise<void> {
    const advanced = await this.prisma.session.updateMany({
      where: { status: SessionStatus.ONLINE, dailySent: { gt: 0 } },
      data: { warmupDay: { increment: 1 } },
    });
    const reset = await this.prisma.session.updateMany({
      where: {},
      data: { dailySent: 0, strangerSent: 0 },
    });
    this.log.log(
      `Warmup midnight: advanced warmupDay for ${advanced.count} active session(s); reset counters for ${reset.count} session(s)`,
    );
  }
}
