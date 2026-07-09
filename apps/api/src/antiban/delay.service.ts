import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingsService } from '../settings/settings.service';

@Injectable()
export class DelayService {
  private readonly log = new Logger(DelayService.name);

  readonly activeHoursTimezone: string;

  // env defaults — used when no DB override is stored
  private readonly _defaultMeanMs: number;
  private readonly _defaultStdDevMs: number;
  private readonly _defaultFloorMs: number;
  private readonly _defaultCeilingMs: number;
  private readonly _defaultTypingMs: number;

  /** Fraction of the daily cap allowed within any single clock hour (spreads volume across the day). */
  readonly hourlyCapFraction: number;

  /** After this many sends on a session, insert a human "break" pause. */
  readonly burstBreakMinSends: number;
  readonly burstBreakMaxSends: number;

  constructor(
    config: ConfigService,
    private readonly settings: SettingsService,
  ) {
    // A malformed .env value (e.g. DELAY_MEAN_MS=abc) must never silently become NaN —
    // NaN propagates through computeDelayMs()'s Math.max/min clamp untouched, and
    // `elapsed < NaN` is always false, which disables the minimum-gap anti-ban gate
    // entirely without ever throwing. Fall back to the hardcoded default instead.
    const parseMs = (raw: string | undefined, fallback: number): number => {
      const n = +(raw ?? fallback);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    this._defaultMeanMs = parseMs(config.get<string>('DELAY_MEAN_MS'), 120_000);
    this._defaultStdDevMs = parseMs(config.get<string>('DELAY_STD_DEV_MS'), 35_000);
    this._defaultFloorMs = parseMs(config.get<string>('DELAY_FLOOR_MS'), 60_000);
    this._defaultCeilingMs = parseMs(config.get<string>('DELAY_CEILING_MS'), 480_000);
    this._defaultTypingMs = parseMs(config.get<string>('TYPING_SIMULATION_MS'), 3_000);
    this.activeHoursTimezone = config.get<string>('ACTIVE_HOURS_TIMEZONE') ?? 'UTC';
    const frac = +(config.get<string>('HOURLY_CAP_FRACTION') ?? '0.2');
    this.hourlyCapFraction = Number.isFinite(frac) && frac > 0 && frac <= 1 ? frac : 0.2;
    const bMin = +(config.get<string>('BURST_BREAK_MIN_SENDS') ?? '8');
    const bMax = +(config.get<string>('BURST_BREAK_MAX_SENDS') ?? '12');
    this.burstBreakMinSends = Number.isFinite(bMin) && bMin > 0 ? Math.floor(bMin) : 8;
    this.burstBreakMaxSends = Number.isFinite(bMax) && bMax >= this.burstBreakMinSends ? Math.floor(bMax) : Math.max(12, this.burstBreakMinSends);
    this.log.debug(`Delay engine initialized tz=${this.activeHoursTimezone} hourlyFraction=${this.hourlyCapFraction}`);
  }

  // Getters read from DB settings (hot-reloadable) with env fallback
  get meanMs(): number { return +(this.settings.get('DELAY_MEAN_MS') ?? this._defaultMeanMs); }
  get stdDevMs(): number { return +(this.settings.get('DELAY_STD_DEV_MS') ?? this._defaultStdDevMs); }
  get floorMs(): number { return +(this.settings.get('DELAY_FLOOR_MS') ?? this._defaultFloorMs); }
  get ceilingMs(): number { return +(this.settings.get('DELAY_CEILING_MS') ?? this._defaultCeilingMs); }
  get typingMs(): number { return +(this.settings.get('TYPING_SIMULATION_MS') ?? this._defaultTypingMs); }

  computeDelayMs(): number {
    const raw = this.gaussianSample(this.meanMs, this.stdDevMs);
    return Math.max(this.floorMs, Math.min(this.ceilingMs, Math.round(raw)));
  }

  /**
   * Typing-indicator duration that scales with message length + per-char jitter,
   * clamped to [1000, 15000]ms. A fixed typing time regardless of length is itself
   * a bot signature; humans take longer to "type" longer messages.
   */
  computeTypingMs(textLength: number): number {
    const perCharMs = 35 + Math.random() * 30; // 35–65 ms per character (jitter)
    const raw = this.typingMs * 0.4 + Math.max(0, textLength) * perCharMs;
    return Math.round(Math.max(1000, Math.min(15000, raw)));
  }

  /** Hourly send cap for a session given its effective daily cap. */
  hourlyCap(effectiveDailyCap: number): number {
    return Math.max(1, Math.ceil(effectiveDailyCap * this.hourlyCapFraction));
  }

  /**
   * Cold-outreach gap multiplier, tiered by how many prior messages a contact has
   * already been sent: 2.5× for a true stranger (never sent to), 1.8× for a second
   * message, no penalty (1.0×) from the third onward — WhatsApp throttles cold first
   * contact hardest. This is the single source of truth for the multiplier: both the
   * real-time worker gate (the enforced value) and campaign-launch scheduling (an
   * estimate used only to stagger initial BullMQ job delays) must derive it from here,
   * or the launch-time estimate silently drifts from what the worker actually enforces.
   */
  contactMultiplier(prevSentCount: number): number {
    return prevSentCount === 0 ? 2.5 : prevSentCount === 1 ? 1.8 : 1.0;
  }

  /** UTC hour bucket key suffix (YYYYMMDDHH) — used to scope the per-hour send counter in Redis. */
  utcHourStamp(now: Date = new Date()): string {
    return (
      `${now.getUTCFullYear()}` +
      `${String(now.getUTCMonth() + 1).padStart(2, '0')}` +
      `${String(now.getUTCDate()).padStart(2, '0')}` +
      `${String(now.getUTCHours()).padStart(2, '0')}`
    );
  }

  /** Milliseconds until the next UTC clock-hour boundary (min 30s) — used to requeue over-hourly-cap jobs. */
  msUntilNextHour(now: Date = new Date()): number {
    const msIntoHour =
      now.getUTCMinutes() * 60_000 + now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
    return Math.max(3_600_000 - msIntoHour, 30_000);
  }

  /** Random number of sends before the next human "break", in [burstBreakMinSends, burstBreakMaxSends]. */
  computeBurstThreshold(): number {
    const span = this.burstBreakMaxSends - this.burstBreakMinSends + 1;
    return this.burstBreakMinSends + Math.floor(Math.random() * span);
  }

  /** Random human "break" duration between 15 and 45 minutes, in ms. */
  computeBurstBreakMs(): number {
    return Math.round((15 + Math.random() * 30) * 60_000);
  }

  /**
   * Small random offset added when many jobs are requeued to the same wake time
   * (active-hours open, midnight cap reset) so they don't all come due simultaneously
   * and collapse the per-message pacing. Spread ≈ one mean-gap.
   */
  requeueJitterMs(): number {
    return Math.floor(Math.random() * this.meanMs);
  }

  isWithinActiveHours(activeFrom: number, activeTo: number): boolean {
    const hour = this.currentHourInTz();
    if (activeFrom <= activeTo) {
      return hour >= activeFrom && hour < activeTo;
    }
    return hour >= activeFrom || hour < activeTo;
  }

  msUntilMidnight(): number {
    const now = new Date();
    // Use the same TZ as active-hours so the daily-cap reset aligns with ACTIVE_HOURS_TIMEZONE midnight
    const dtf = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      timeZone: this.activeHoursTimezone,
    });
    const parts = dtf.formatToParts(now);
    const tzHour = (() => {
      const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
      return h === 24 ? 0 : h;
    })();
    const tzMinute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    // Minutes remaining until next midnight in the configured TZ
    const minutesUntilMidnight = (24 - tzHour) * 60 - tzMinute;
    return Math.max(minutesUntilMidnight * 60 * 1000, 60_000);
  }

  msUntilNextWindow(activeFrom: number): number {
    const now = new Date();
    const dtf = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
      timeZone: this.activeHoursTimezone,
    });
    const parts = dtf.formatToParts(now);
    const tzHour = (() => {
      const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
      return h === 24 ? 0 : h;
    })();
    const tzMinute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);

    let minutesUntil = (activeFrom - tzHour) * 60 - tzMinute;
    if (minutesUntil <= 0) minutesUntil += 24 * 60;
    return minutesUntil * 60 * 1000;
  }

  private currentHourInTz(): number {
    const parts = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: this.activeHoursTimezone,
    }).formatToParts(new Date());
    const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    return h === 24 ? 0 : h;
  }

  private gaussianSample(mean: number, stdDev: number): number {
    const u1 = 1 - Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z0 * stdDev;
  }
}
