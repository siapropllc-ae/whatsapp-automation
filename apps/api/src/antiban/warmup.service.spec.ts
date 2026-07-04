import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SessionStatus } from '@prisma/client';
import { WarmupService } from './warmup.service';
import { PrismaService } from '../common/prisma/prisma.service';

const mockPrisma = {
  session: {
    updateMany: jest.fn(),
  },
};

function makeModule(dailyLimit = 1000) {
  return Test.createTestingModule({
    providers: [
      WarmupService,
      { provide: PrismaService, useValue: mockPrisma },
      {
        provide: ConfigService,
        useValue: { get: jest.fn().mockReturnValue(String(dailyLimit)) },
      },
    ],
  }).compile();
}

describe('WarmupService', () => {
  let service: WarmupService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await makeModule();
    service = module.get(WarmupService);
  });

  // ── getEffectiveDailyLimit (total cap) ───────────────────────────────────

  describe('getEffectiveDailyLimit — total cap boundaries', () => {
    const cases: [warmupDay: number, expected: number][] = [
      [0, 15],
      [2, 15],
      [3, 35],
      [6, 35],
      [7, 60],
      [10, 60],
      [11, 100],
      [14, 100],
      [15, 160],
      [19, 160],
      [20, 250],
      [24, 250],
      [25, 400],
      [29, 400],
      [30, 600],
      [34, 600],
      [35, 800],
      [39, 800],
      [40, 1000], // graduated — env DAILY_SEND_LIMIT
      [60, 1000],
    ];

    it.each(cases)('warmupDay=%i → total cap %i', (warmupDay, expected) => {
      expect(service.getEffectiveDailyLimit({ warmupDay, dailySent: 0 })).toBe(expected);
    });
  });

  // ── getEffectiveStrangerLimit (cold sub-cap) ─────────────────────────────

  describe('getEffectiveStrangerLimit — cold sub-cap boundaries', () => {
    const cases: [warmupDay: number, expected: number][] = [
      [0, 8],
      [2, 8],
      [3, 20],
      [6, 20],
      [7, 35],
      [10, 35],
      [11, 60],
      [14, 60],
      [15, 100],
      [19, 100],
      [20, 170],
      [24, 170],
      [25, 300],
      [29, 300],
      [30, 480],
      [34, 480],
      [35, 700],
      [39, 700],
      [40, 1000],
    ];

    it.each(cases)('warmupDay=%i → cold cap %i', (warmupDay, expected) => {
      expect(service.getEffectiveStrangerLimit({ warmupDay, dailySent: 0 })).toBe(expected);
    });

    it('never exceeds the total daily cap', () => {
      for (let day = 0; day <= 45; day++) {
        const stranger = service.getEffectiveStrangerLimit({ warmupDay: day, dailySent: 0 });
        const total = service.getEffectiveDailyLimit({ warmupDay: day, dailySent: 0 });
        expect(stranger).toBeLessThanOrEqual(total);
      }
    });
  });

  describe('respects configured env limit for graduated (day 40+) sessions', () => {
    it('uses 2000 when DAILY_SEND_LIMIT=2000', async () => {
      const mod = await makeModule(2000);
      const svc = mod.get(WarmupService);
      expect(svc.getEffectiveDailyLimit({ warmupDay: 40, dailySent: 0 })).toBe(2000);
      expect(svc.getEffectiveStrangerLimit({ warmupDay: 40, dailySent: 0 })).toBe(2000);
    });
  });

  // ── midnightReset (idle-day-aware) ───────────────────────────────────────

  describe('midnightReset', () => {
    it('advances warmupDay only for ONLINE sessions that actually sent that day', async () => {
      mockPrisma.session.updateMany.mockResolvedValue({ count: 0 });

      await service.midnightReset();

      expect(mockPrisma.session.updateMany).toHaveBeenNthCalledWith(1, {
        where: { status: SessionStatus.ONLINE, dailySent: { gt: 0 } },
        data: { warmupDay: { increment: 1 } },
      });
    });

    it('resets both daily counters for every session', async () => {
      mockPrisma.session.updateMany.mockResolvedValue({ count: 0 });

      await service.midnightReset();

      expect(mockPrisma.session.updateMany).toHaveBeenNthCalledWith(2, {
        where: {},
        data: { dailySent: 0, strangerSent: 0 },
      });
    });

    it('issues exactly two updateMany calls per midnight tick', async () => {
      mockPrisma.session.updateMany.mockResolvedValue({ count: 0 });
      await service.midnightReset();
      expect(mockPrisma.session.updateMany).toHaveBeenCalledTimes(2);
    });
  });
});
