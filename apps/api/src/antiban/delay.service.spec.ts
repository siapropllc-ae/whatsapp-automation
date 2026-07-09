import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DelayService } from './delay.service';
import { SettingsService } from '../settings/settings.service';

const mockSettingsService = { get: () => undefined } as unknown as SettingsService;

const mockConfigService = {
  get: (key: string): string | undefined => {
    const cfg: Record<string, string> = {
      ACTIVE_HOURS_TIMEZONE: 'UTC',
      DELAY_MEAN_MS: '120000',
      DELAY_STD_DEV_MS: '35000',
      DELAY_FLOOR_MS: '60000',
      DELAY_CEILING_MS: '480000',
      TYPING_SIMULATION_MS: '6000',
    };
    return cfg[key];
  },
} as unknown as ConfigService;

describe('DelayService', () => {
  let service: DelayService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        DelayService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SettingsService, useValue: mockSettingsService },
      ],
    }).compile();
    service = module.get(DelayService);
  });

  // ── computeDelayMs ──────────────────────────────────────────────────────────

  describe('computeDelayMs', () => {
    it('always stays within [floor, ceiling] over 1000 samples', () => {
      for (let i = 0; i < 1000; i++) {
        const delay = service.computeDelayMs();
        expect(delay).toBeGreaterThanOrEqual(service.floorMs);
        expect(delay).toBeLessThanOrEqual(service.ceilingMs);
      }
    });

    it('returns an integer', () => {
      for (let i = 0; i < 20; i++) {
        expect(Number.isInteger(service.computeDelayMs())).toBe(true);
      }
    });

    it('mean of 10 000 samples is within ±10 % of configured mean', () => {
      const samples = Array.from({ length: 10_000 }, () => service.computeDelayMs());
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      expect(mean).toBeGreaterThan(service.meanMs * 0.9);
      expect(mean).toBeLessThan(service.meanMs * 1.1);
    });
  });

  // ── isWithinActiveHours ─────────────────────────────────────────────────────

  describe('isWithinActiveHours', () => {
    beforeAll(() => jest.useFakeTimers());
    afterAll(() => jest.useRealTimers());

    // Suffix 'Z' ensures explicit UTC so Intl.DateTimeFormat(UTC) reads the same hour
    const setHour = (h: number) =>
      jest.setSystemTime(new Date(`2024-01-15T${String(h).padStart(2, '0')}:00:00Z`));

    describe('normal window 08:00–22:00', () => {
      it('returns true inside the window (10:00)', () => {
        setHour(10);
        expect(service.isWithinActiveHours(8, 22)).toBe(true);
      });

      it('returns true at exactly activeFrom (08:00)', () => {
        setHour(8);
        expect(service.isWithinActiveHours(8, 22)).toBe(true);
      });

      it('returns false at exactly activeTo (22:00)', () => {
        setHour(22);
        expect(service.isWithinActiveHours(8, 22)).toBe(false);
      });

      it('returns false before the window (06:00)', () => {
        setHour(6);
        expect(service.isWithinActiveHours(8, 22)).toBe(false);
      });

      it('returns false after the window (23:00)', () => {
        setHour(23);
        expect(service.isWithinActiveHours(8, 22)).toBe(false);
      });
    });

    describe('overnight window 22:00–06:00', () => {
      it('returns true at 23:00', () => {
        setHour(23);
        expect(service.isWithinActiveHours(22, 6)).toBe(true);
      });

      it('returns true at 01:00', () => {
        setHour(1);
        expect(service.isWithinActiveHours(22, 6)).toBe(true);
      });

      it('returns false at 10:00 (midday gap)', () => {
        setHour(10);
        expect(service.isWithinActiveHours(22, 6)).toBe(false);
      });
    });
  });

  // ── computeTypingMs ─────────────────────────────────────────────────────────

  describe('computeTypingMs', () => {
    it('always returns an integer within [1000, 15000]', () => {
      for (const len of [0, 1, 10, 50, 200, 1000, 5000]) {
        for (let i = 0; i < 50; i++) {
          const t = service.computeTypingMs(len);
          expect(Number.isInteger(t)).toBe(true);
          expect(t).toBeGreaterThanOrEqual(1000);
          expect(t).toBeLessThanOrEqual(15000);
        }
      }
    });

    it('caps very long messages at 15000ms', () => {
      expect(service.computeTypingMs(10_000)).toBe(15000);
    });

    it('scales up with message length on average', () => {
      const avg = (len: number) =>
        Array.from({ length: 200 }, () => service.computeTypingMs(len)).reduce((a, b) => a + b, 0) / 200;
      expect(avg(200)).toBeGreaterThan(avg(10));
    });
  });

  // ── hourlyCap ───────────────────────────────────────────────────────────────

  describe('hourlyCap', () => {
    it('is ceil(dailyCap × 0.2) with a floor of 1', () => {
      expect(service.hourlyCap(1000)).toBe(200);
      expect(service.hourlyCap(60)).toBe(12);
      expect(service.hourlyCap(1)).toBe(1); // max(1, ceil(0.2))
    });
  });

  // ── requeueJitterMs ─────────────────────────────────────────────────────────

  describe('requeueJitterMs', () => {
    it('stays within [0, meanMs)', () => {
      for (let i = 0; i < 500; i++) {
        const j = service.requeueJitterMs();
        expect(j).toBeGreaterThanOrEqual(0);
        expect(j).toBeLessThan(service.meanMs);
      }
    });
  });

  // ── burst-break helpers ─────────────────────────────────────────────────────

  describe('computeBurstThreshold', () => {
    it('stays within [burstBreakMinSends, burstBreakMaxSends]', () => {
      for (let i = 0; i < 500; i++) {
        const n = service.computeBurstThreshold();
        expect(n).toBeGreaterThanOrEqual(service.burstBreakMinSends);
        expect(n).toBeLessThanOrEqual(service.burstBreakMaxSends);
      }
    });
  });

  describe('computeBurstBreakMs', () => {
    it('is between 15 and 45 minutes', () => {
      for (let i = 0; i < 200; i++) {
        const ms = service.computeBurstBreakMs();
        expect(ms).toBeGreaterThanOrEqual(15 * 60_000);
        expect(ms).toBeLessThanOrEqual(45 * 60_000);
      }
    });
  });

  // ── malformed .env fallback (NaN guard regression) ─────────────────────────
  // A malformed env value must fall back to the hardcoded default, not become NaN —
  // NaN would silently disable the minimum-gap anti-ban gate (`elapsed < NaN` is
  // always false) instead of throwing something an operator would notice.

  describe('malformed .env fallback', () => {
    it('falls back to the hardcoded default for a non-numeric DELAY_MEAN_MS', async () => {
      const badConfig = {
        get: (key: string): string | undefined => (key === 'DELAY_MEAN_MS' ? 'not-a-number' : undefined),
      } as unknown as ConfigService;
      const module = await Test.createTestingModule({
        providers: [
          DelayService,
          { provide: ConfigService, useValue: badConfig },
          { provide: SettingsService, useValue: mockSettingsService },
        ],
      }).compile();
      const badService = module.get(DelayService);

      expect(badService.meanMs).toBe(120_000);
      expect(Number.isFinite(badService.computeDelayMs())).toBe(true);
    });

    it('falls back to the hardcoded default for a negative DELAY_FLOOR_MS', async () => {
      const badConfig = {
        get: (key: string): string | undefined => (key === 'DELAY_FLOOR_MS' ? '-1000' : undefined),
      } as unknown as ConfigService;
      const module = await Test.createTestingModule({
        providers: [
          DelayService,
          { provide: ConfigService, useValue: badConfig },
          { provide: SettingsService, useValue: mockSettingsService },
        ],
      }).compile();
      const badService = module.get(DelayService);

      expect(badService.floorMs).toBe(60_000);
    });
  });

  // ── contactMultiplier ───────────────────────────────────────────────────────
  // Single source of truth for the cold-outreach tiered multiplier — both worker gates
  // and campaign-launch scheduling must derive it from here (see delay.service.ts's
  // doc comment on this method for why a drift here is a real, if low-severity, bug).

  describe('contactMultiplier', () => {
    it('is 2.5× for a true stranger (0 prior sent messages)', () => {
      expect(service.contactMultiplier(0)).toBe(2.5);
    });

    it('is 1.8× for a contact with exactly 1 prior sent message', () => {
      expect(service.contactMultiplier(1)).toBe(1.8);
    });

    it('is 1.0× (no penalty) from the 3rd prior sent message onward', () => {
      expect(service.contactMultiplier(2)).toBe(1.0);
      expect(service.contactMultiplier(3)).toBe(1.0);
      expect(service.contactMultiplier(50)).toBe(1.0);
    });
  });

  // ── hourly bucket helpers ────────────────────────────────────────────────────

  describe('utcHourStamp / msUntilNextHour', () => {
    it('formats the UTC hour bucket as YYYYMMDDHH', () => {
      expect(service.utcHourStamp(new Date('2026-07-05T13:42:10Z'))).toBe('2026070513');
    });

    it('returns ms remaining to the next UTC hour (min 30s)', () => {
      expect(service.msUntilNextHour(new Date('2026-07-05T13:30:00Z'))).toBe(1_800_000);
      // Within the last 30s of the hour it clamps to the 30s floor
      expect(service.msUntilNextHour(new Date('2026-07-05T13:59:50Z'))).toBe(30_000);
    });
  });
});
