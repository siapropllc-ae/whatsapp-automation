import { Test } from '@nestjs/testing';
import { SessionStatus } from '@prisma/client';
import { FingerprintService, FINGERPRINT_POOL_SIZE } from './fingerprint.service';
import { PrismaService } from '../common/prisma/prisma.service';

const mockPrisma = {
  session: {
    update: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
};

describe('FingerprintService', () => {
  let service: FingerprintService;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        FingerprintService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get(FingerprintService);
  });

  // ── pool sanity ──────────────────────────────────────────────────────────

  it('pool contains exactly 20 profiles', () => {
    expect(FINGERPRINT_POOL_SIZE).toBe(20);
  });

  // ── assignFingerprint ───────────────────────────────────────────────────

  describe('assignFingerprint', () => {
    it('updates Session.fingerprint and returns the profile', async () => {
      mockPrisma.session.update.mockResolvedValue({});

      const fp = await service.assignFingerprint('sess-1');

      expect(fp).toMatchObject({
        userAgent: expect.any(String),
        deviceModel: expect.any(String),
        osVersion: expect.any(String),
        screenWidth: expect.any(Number),
        screenHeight: expect.any(Number),
      });
      expect(mockPrisma.session.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: { fingerprint: expect.objectContaining({ deviceModel: fp.deviceModel }) },
      });
    });

    it('assigns different profiles across multiple sessions (stochastic — 100 calls)', async () => {
      mockPrisma.session.update.mockResolvedValue({});

      const profiles = new Set<string>();
      for (let i = 0; i < 100; i++) {
        const fp = await service.assignFingerprint(`sess-${i}`);
        profiles.add(fp.deviceModel);
      }
      // Expect at least 5 distinct device models across 100 random assignments
      expect(profiles.size).toBeGreaterThanOrEqual(5);
    });
  });

  // ── getFingerprint ───────────────────────────────────────────────────────

  describe('getFingerprint', () => {
    it('returns undefined when no fingerprint is stored', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ fingerprint: null });
      const result = await service.getFingerprint('sess-1');
      expect(result).toBeUndefined();
    });

    it('returns the stored fingerprint when present', async () => {
      const stored = { userAgent: 'ua', deviceModel: 'Pixel 7', osVersion: 'Android 13', screenWidth: 1080, screenHeight: 2400 };
      mockPrisma.session.findUnique.mockResolvedValue({ fingerprint: stored });

      const result = await service.getFingerprint('sess-1');
      expect(result).toEqual(stored);
    });
  });

  // ── rotateFingerprints (cron method) ────────────────────────────────────

  describe('rotateFingerprints', () => {
    it('force-assigns a new fingerprint for OFFLINE sessions only', async () => {
      mockPrisma.session.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);
      mockPrisma.session.update.mockResolvedValue({});

      await service.rotateFingerprints();

      // rotation writes directly to Prisma — one update per session
      expect(mockPrisma.session.update).toHaveBeenCalledTimes(2);
      expect(mockPrisma.session.findMany).toHaveBeenCalledWith({
        where: { status: SessionStatus.OFFLINE },
        select: { id: true, fingerprint: true },
      });
    });

    it('does nothing when there are no active sessions', async () => {
      mockPrisma.session.findMany.mockResolvedValue([]);
      await service.rotateFingerprints();
      expect(mockPrisma.session.update).not.toHaveBeenCalled();
    });
  });
});
