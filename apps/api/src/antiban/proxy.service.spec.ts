import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ProxyService } from './proxy.service';
import { PrismaService } from '../common/prisma/prisma.service';

// Minimal proxy fixture
const makeProxy = (id: string, inUse = false) => ({
  id,
  host: '1.2.3.4',
  port: 8080,
  username: 'user',
  password: 'pass',
  country: 'US',
  inUse,
  lastRotat: null,
});

// Minimal session fixture
const makeSession = (id: string, proxyId: string | null = null) => ({ id, proxyId });

// Transaction mock shape (matches what ProxyService.assignProxy expects)
interface TxMock {
  proxy: { findFirst: jest.Mock; update: jest.Mock; findUnique: jest.Mock };
  session: { update: jest.Mock };
  $queryRaw: jest.Mock;
}

describe('ProxyService', () => {
  let service: ProxyService;
  let tx: TxMock;

  const mockPrisma = {
    proxy: { findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn(), count: jest.fn().mockResolvedValue(0) },
    session: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn() },
    $transaction: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    tx = {
      proxy: { findFirst: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
      session: { update: jest.fn() },
      $queryRaw: jest.fn(),
    };

    mockPrisma.$transaction.mockImplementation(async (arg: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (t: TxMock) => unknown)(tx);
      }
      // Array form (parallel prisma calls): execute each in sequence
      const items = arg as Array<Promise<unknown>>;
      return Promise.all(items);
    });

    const module = await Test.createTestingModule({
      providers: [
        ProxyService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('48') },
        },
      ],
    }).compile();

    service = module.get(ProxyService);
  });

  // ── assignProxy ──────────────────────────────────────────────────────────

  describe('assignProxy', () => {
    it('marks proxy inUse and links session, returns config', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 'p-1' }]);
      tx.proxy.update.mockResolvedValue({});
      tx.session.update.mockResolvedValue({});
      tx.proxy.findUnique.mockResolvedValue(makeProxy('p-1'));

      const result = await service.assignProxy('sess-1');

      expect(result).toMatchObject({ host: '1.2.3.4', port: 8080 });
      expect(tx.proxy.update).toHaveBeenCalledWith({
        where: { id: 'p-1' },
        data: { inUse: true, lastRotat: expect.any(Date) },
      });
      expect(tx.session.update).toHaveBeenCalledWith({
        where: { id: 'sess-1' },
        data: { proxyId: 'p-1' },
      });
    });

    it('returns null and logs warning when pool is exhausted', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      const result = await service.assignProxy('sess-1');

      expect(result).toBeNull();
      expect(tx.session.update).not.toHaveBeenCalled();
    });
  });

  // ── releaseProxy ─────────────────────────────────────────────────────────

  describe('releaseProxy', () => {
    it('sets proxy inUse=false and clears session.proxyId', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(makeSession('sess-1', 'p-1'));
      mockPrisma.proxy.update.mockResolvedValue({});
      mockPrisma.session.update.mockResolvedValue({});

      await service.releaseProxy('sess-1');

      // $transaction was called (array form with two updates)
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('is a no-op when session has no proxy assigned', async () => {
      mockPrisma.session.findUnique.mockResolvedValue(makeSession('sess-1', null));

      await service.releaseProxy('sess-1');

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── rotateStalledProxies (cron method) ───────────────────────────────────

  describe('rotateStalledProxies', () => {
    it('cycles sessions whose proxies are older than PROXY_ROTATION_HOURS', async () => {
      mockPrisma.proxy.findMany.mockResolvedValue([{ id: 'p-stale' }]);
      mockPrisma.session.findMany.mockResolvedValue([{ id: 'sess-old' }]);
      // releaseProxy: findUnique returns session with proxyId
      mockPrisma.session.findUnique.mockResolvedValue(makeSession('sess-old', 'p-stale'));
      mockPrisma.proxy.update.mockResolvedValue({});
      mockPrisma.session.update.mockResolvedValue({});
      // assignProxy: find a new free proxy via FOR UPDATE SKIP LOCKED
      tx.$queryRaw.mockResolvedValue([{ id: 'p-new' }]);
      tx.proxy.findUnique.mockResolvedValue(makeProxy('p-new'));
      tx.proxy.update.mockResolvedValue({});
      tx.session.update.mockResolvedValue({});

      await service.rotateStalledProxies();

      expect(mockPrisma.proxy.findMany).toHaveBeenCalledWith({
        where: { inUse: true, lastRotat: { lt: expect.any(Date) } },
        select: { id: true },
      });
      expect(mockPrisma.session.findMany).toHaveBeenCalledWith({
        where: { proxyId: { in: ['p-stale'] } },
        select: { id: true },
      });
    });

    it('does nothing when no stale proxies exist', async () => {
      mockPrisma.proxy.findMany.mockResolvedValue([]);

      await service.rotateStalledProxies();

      expect(mockPrisma.session.findMany).not.toHaveBeenCalled();
    });
  });
});
