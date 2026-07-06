import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { MediaType, MsgStatus, SessionStatus } from '@prisma/client';
import { BaileysWorker } from './baileys.worker';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { SessionsGateway } from '../sessions/sessions.gateway';
import { DelayService } from '../antiban/delay.service';
import { WarmupService } from '../antiban/warmup.service';
import { DLQ_QUEUE, REDIS_CLIENT } from './queue.constants';
import type { OutboxJob } from './outbox-job.types';

const mockPrisma = {
  campaignMessage: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    count: jest.fn().mockResolvedValue(0),
    groupBy: jest.fn().mockResolvedValue([]),
  },
  campaign: {
    findUnique: jest.fn(),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  session: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({ consecutiveFailures: 1 }),
  },
  analyticsEvent: {
    create: jest.fn().mockResolvedValue({}),
  },
};

const mockSessions = {
  sendBaileyMessage: jest.fn().mockResolvedValue(undefined),
  sendBaileyCarousel: jest.fn().mockResolvedValue(undefined),
  tripCircuitBreaker: jest.fn().mockResolvedValue(undefined),
};

const mockDelay = {
  isWithinActiveHours: jest.fn().mockReturnValue(true),
  msUntilNextWindow: jest.fn().mockReturnValue(3_600_000),
  msUntilMidnight: jest.fn().mockReturnValue(3_600_000),
  msUntilNextHour: jest.fn().mockReturnValue(1_800_000),
  requeueJitterMs: jest.fn().mockReturnValue(0),
  computeDelayMs: jest.fn().mockReturnValue(60_000),
  computeTypingMs: jest.fn().mockReturnValue(3_000),
  hourlyCap: jest.fn().mockReturnValue(1000),
  utcHourStamp: jest.fn().mockReturnValue('2026070512'),
  computeBurstThreshold: jest.fn().mockReturnValue(1000),
  computeBurstBreakMs: jest.fn().mockReturnValue(1_800_000),
  floorMs: 60_000,
  meanMs: 120_000,
  typingMs: 3_000,
};

const mockWarmup = {
  getEffectiveDailyLimit: jest.fn().mockReturnValue(200),
  getEffectiveStrangerLimit: jest.fn().mockReturnValue(200),
};

const mockGateway = {
  emitCampaignStats: jest.fn(),
};

const mockDlqQueue = {
  add: jest.fn().mockResolvedValue(undefined),
};

// Key-aware in-memory Redis so the worker's several keys (lastSent, hourly, breakUntil,
// sinceBreak, breakThreshold) don't collide on a single mocked return value.
let redisStore: Record<string, string>;
const mockRedis = {
  get: jest.fn((key: string) => Promise.resolve(redisStore[key] ?? null)),
  set: jest.fn((key: string, val: string) => {
    redisStore[key] = String(val);
    return Promise.resolve('OK');
  }),
  incr: jest.fn((key: string) => {
    const v = parseInt(redisStore[key] ?? '0', 10) + 1;
    redisStore[key] = String(v);
    return Promise.resolve(v);
  }),
  expire: jest.fn(() => Promise.resolve(1)),
};

function makeJobData(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    campaignMessageId: 'msg-1',
    campaignId: 'camp-1',
    contactId: 'contact-1',
    sessionId: 'session-1',
    phone: '+15551234567',
    renderedText: 'Hello there',
    activeFrom: 0,
    activeTo: 24,
    mode: 'BAILEYS' as OutboxJob['mode'],
    ...overrides,
  };
}

function makeJob(data: OutboxJob): Job<OutboxJob> {
  return {
    id: 'job-1',
    data,
    opts: { attempts: 1 },
    attemptsMade: 1,
    moveToDelayed: jest.fn(),
  } as unknown as Job<OutboxJob>;
}

describe('BaileysWorker', () => {
  let worker: BaileysWorker;

  beforeEach(async () => {
    jest.clearAllMocks();
    redisStore = {};
    mockPrisma.campaignMessage.findUnique.mockResolvedValue({ status: MsgStatus.QUEUED });
    mockPrisma.campaign.findUnique.mockResolvedValue({ status: 'RUNNING' });
    mockPrisma.session.findUnique.mockResolvedValue({
      dailySent: 0,
      strangerSent: 0,
      warmupDay: 21,
      status: SessionStatus.ONLINE,
    });
    mockPrisma.session.update.mockResolvedValue({ consecutiveFailures: 1 });
    mockPrisma.campaignMessage.count.mockResolvedValue(0);
    // jest.clearAllMocks() resets call history but NOT configured mockReturnValue —
    // re-pin every gate to its open/default state so tests can't leak into each other.
    mockDelay.isWithinActiveHours.mockReturnValue(true);
    mockDelay.msUntilNextWindow.mockReturnValue(3_600_000);
    mockDelay.msUntilMidnight.mockReturnValue(3_600_000);
    mockDelay.msUntilNextHour.mockReturnValue(1_800_000);
    mockDelay.requeueJitterMs.mockReturnValue(0);
    mockDelay.computeDelayMs.mockReturnValue(60_000);
    mockDelay.computeTypingMs.mockReturnValue(3_000);
    mockDelay.hourlyCap.mockReturnValue(1000);
    mockDelay.computeBurstThreshold.mockReturnValue(1000);
    mockWarmup.getEffectiveDailyLimit.mockReturnValue(200);
    mockWarmup.getEffectiveStrangerLimit.mockReturnValue(200);

    const module = await Test.createTestingModule({
      providers: [
        BaileysWorker,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: SessionsService, useValue: mockSessions },
        { provide: DelayService, useValue: mockDelay },
        { provide: WarmupService, useValue: mockWarmup },
        { provide: SessionsGateway, useValue: mockGateway },
        { provide: getQueueToken(DLQ_QUEUE), useValue: mockDlqQueue },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    worker = module.get(BaileysWorker);
  });

  describe('idempotency gate', () => {
    it.each([MsgStatus.SENT, MsgStatus.DELIVERED, MsgStatus.READ, MsgStatus.REPLIED, MsgStatus.FAILED])(
      'skips the send when the message is already in terminal status %s',
      async (status) => {
        mockPrisma.campaignMessage.findUnique.mockResolvedValue({ status });
        await worker.process(makeJob(makeJobData()));
        expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
      },
    );

    it('proceeds to send when the message is still QUEUED', async () => {
      mockPrisma.campaignMessage.findUnique.mockResolvedValue({ status: MsgStatus.QUEUED });
      await worker.process(makeJob(makeJobData()));
      expect(mockSessions.sendBaileyMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('requeue gates', () => {
    const FIXED_NOW = 1_750_000_000_000;

    beforeEach(() => {
      jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    });

    afterEach(() => {
      jest.spyOn(Date, 'now').mockRestore();
    });

    it('requeues 5 minutes out and never sends when the campaign is PAUSED', async () => {
      mockPrisma.campaign.findUnique.mockResolvedValue({ status: 'PAUSED' });
      const job = makeJob(makeJobData());

      await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

      expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 300_000, undefined);
      expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
    });

    it('requeues to the next active-hours window and never sends when outside active hours', async () => {
      mockDelay.isWithinActiveHours.mockReturnValue(false);
      mockDelay.msUntilNextWindow.mockReturnValue(7_200_000);
      const job = makeJob(makeJobData({ activeFrom: 8, activeTo: 22 }));

      await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

      expect(mockDelay.isWithinActiveHours).toHaveBeenCalledWith(8, 22);
      expect(mockDelay.msUntilNextWindow).toHaveBeenCalledWith(8);
      expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 7_200_000, undefined);
      expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
    });

    it('requeues to the midnight reset and never sends when the session is at its daily cap', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ dailySent: 200, strangerSent: 0, warmupDay: 21, status: SessionStatus.ONLINE });
      mockWarmup.getEffectiveDailyLimit.mockReturnValue(200);
      mockDelay.msUntilMidnight.mockReturnValue(5_400_000);
      const job = makeJob(makeJobData());

      await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

      expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 5_400_000, undefined);
      expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
    });

    it('does NOT requeue when dailySent is one below the cap (boundary check)', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ dailySent: 199, strangerSent: 0, warmupDay: 21, status: SessionStatus.ONLINE });
      mockWarmup.getEffectiveDailyLimit.mockReturnValue(200);

      await worker.process(makeJob(makeJobData()));

      expect(mockSessions.sendBaileyMessage).toHaveBeenCalledTimes(1);
    });

    describe('stranger sub-cap gate', () => {
      it('requeues a cold first-contact message when the stranger cap is reached', async () => {
        mockPrisma.campaignMessage.count.mockResolvedValue(0); // never messaged → stranger
        mockPrisma.session.findUnique.mockResolvedValue({ dailySent: 10, strangerSent: 35, warmupDay: 7, status: SessionStatus.ONLINE });
        mockWarmup.getEffectiveStrangerLimit.mockReturnValue(35);
        mockDelay.msUntilMidnight.mockReturnValue(5_400_000);
        const job = makeJob(makeJobData());

        await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

        expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 5_400_000, undefined);
        expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
      });

      it('still sends to a known contact (not a stranger) even when the stranger cap is reached', async () => {
        mockPrisma.campaignMessage.count.mockResolvedValue(2); // has prior sends → not a stranger
        mockPrisma.session.findUnique.mockResolvedValue({ dailySent: 10, strangerSent: 35, warmupDay: 7, status: SessionStatus.ONLINE });
        mockWarmup.getEffectiveStrangerLimit.mockReturnValue(35);

        await worker.process(makeJob(makeJobData()));

        expect(mockSessions.sendBaileyMessage).toHaveBeenCalledTimes(1);
      });
    });

    describe('hourly cap gate', () => {
      it('requeues to the next hour when the hourly cap is reached', async () => {
        redisStore['session:hourly:session-1:2026070512'] = '40';
        mockDelay.hourlyCap.mockReturnValue(40);
        mockDelay.msUntilNextHour.mockReturnValue(1_200_000);
        const job = makeJob(makeJobData());

        await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

        expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 1_200_000, undefined);
        expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
      });
    });

    describe('burst-break gate', () => {
      it('requeues while the session is on a burst-break', async () => {
        redisStore['session:breakUntil:session-1'] = String(FIXED_NOW + 600_000);
        const job = makeJob(makeJobData());

        await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

        expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 600_000, undefined);
        expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
      });

      it('sends normally once the burst-break has elapsed', async () => {
        redisStore['session:breakUntil:session-1'] = String(FIXED_NOW - 1_000);
        await worker.process(makeJob(makeJobData()));
        expect(mockSessions.sendBaileyMessage).toHaveBeenCalledTimes(1);
      });
    });

    describe('Redis min-gap gate (Gaussian gap × stranger multiplier)', () => {
      it.each([
        [0, 2.5],
        [1, 1.8],
        [2, 1.0],
      ])('uses a %sx gap multiplier when the contact has %i prior sent message(s)', async (prevSentCount, multiplier) => {
        mockPrisma.campaignMessage.count.mockResolvedValue(prevSentCount);
        mockDelay.computeDelayMs.mockReturnValue(60_000);
        const lastSent = FIXED_NOW - 1_000; // 1s ago — well within any of these gaps
        redisStore['session:lastSent:session-1'] = String(lastSent);
        const job = makeJob(makeJobData());

        await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

        const expectedMinGap = Math.round(60_000 * multiplier);
        const expectedWait = expectedMinGap - 1_000 + 1_000; // elapsed=1000ms
        expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + expectedWait, undefined);
        expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
      });

      it('proceeds to send when there is no prior lastSent record on this session', async () => {
        mockPrisma.campaignMessage.count.mockResolvedValue(0);

        await worker.process(makeJob(makeJobData()));

        expect(mockSessions.sendBaileyMessage).toHaveBeenCalledTimes(1);
      });

      it('proceeds to send once the elapsed time exactly meets the minimum gap', async () => {
        mockPrisma.campaignMessage.count.mockResolvedValue(0); // 2.5x multiplier -> minGap = 150_000
        mockDelay.computeDelayMs.mockReturnValue(60_000);
        redisStore['session:lastSent:session-1'] = String(FIXED_NOW - 150_000);

        await worker.process(makeJob(makeJobData()));

        expect(mockSessions.sendBaileyMessage).toHaveBeenCalledTimes(1);
      });

      it('records the lastSent timestamp in Redis with a 24h expiry after a successful send', async () => {
        await worker.process(makeJob(makeJobData()));

        expect(mockRedis.set).toHaveBeenCalledWith('session:lastSent:session-1', String(FIXED_NOW), 'EX', 86400);
      });
    });
  });

  describe('media attachment send path', () => {
    it('sends without a media argument when the job has no attachment', async () => {
      await worker.process(makeJob(makeJobData()));

      expect(mockSessions.sendBaileyMessage).toHaveBeenCalledWith(
        'session-1',
        '+15551234567',
        'Hello there',
        3_000,
        undefined,
        undefined,
      );
    });

    it('passes the media descriptor through to sendBaileyMessage when the job has an attachment', async () => {
      const jobData = makeJobData({
        mediaUrl: 'http://localhost:3001/api/media/a.jpg',
        mediaType: MediaType.IMAGE,
        mediaMimeType: 'image/jpeg',
        mediaFilename: 'a.jpg',
      });

      await worker.process(makeJob(jobData));

      expect(mockSessions.sendBaileyMessage).toHaveBeenCalledWith(
        'session-1',
        '+15551234567',
        'Hello there',
        3_000,
        { url: 'http://localhost:3001/api/media/a.jpg', type: MediaType.IMAGE, mimeType: 'image/jpeg', filename: 'a.jpg' },
        undefined,
      );
    });

    it('uses a length-scaled typing duration from DelayService.computeTypingMs', async () => {
      mockDelay.computeTypingMs.mockReturnValue(7_500);
      await worker.process(makeJob(makeJobData({ renderedText: 'A much longer message body' })));

      expect(mockDelay.computeTypingMs).toHaveBeenCalledWith('A much longer message body'.length);
      expect(mockSessions.sendBaileyMessage).toHaveBeenCalledWith('session-1', '+15551234567', 'A much longer message body', 7_500, undefined, undefined);
    });

    it('passes the template buttons through to sendBaileyMessage when present', async () => {
      const buttons = [{ id: 'yes-1', type: 'QUICK_REPLY' as const, label: 'Yes' }];
      await worker.process(makeJob(makeJobData({ buttons })));

      expect(mockSessions.sendBaileyMessage).toHaveBeenCalledWith(
        'session-1',
        '+15551234567',
        'Hello there',
        3_000,
        undefined,
        buttons,
      );
    });

    it('marks the message FAILED and rethrows when the send itself throws', async () => {
      mockSessions.sendBaileyMessage.mockRejectedValueOnce(new Error('socket closed'));

      await expect(worker.process(makeJob(makeJobData()))).rejects.toThrow('socket closed');

      expect(mockPrisma.campaignMessage.update).toHaveBeenCalledWith({
        where: { id: 'msg-1' },
        data: { status: MsgStatus.FAILED },
      });
    });
  });

  describe('carousel routing', () => {
    it('routes to sendBaileyCarousel (not sendBaileyMessage) when the job has carouselCards', async () => {
      const carouselCards = [
        { id: 'c1', mediaUrl: 'http://x/a.jpg', body: 'A', buttons: [] },
        { id: 'c2', mediaUrl: 'http://x/b.jpg', body: 'B', buttons: [] },
      ];

      await worker.process(makeJob(makeJobData({ carouselCards })));

      expect(mockSessions.sendBaileyCarousel).toHaveBeenCalledWith(
        'session-1',
        '+15551234567',
        'Hello there',
        3_000,
        carouselCards,
      );
      expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
    });

    it('routes to sendBaileyMessage (not sendBaileyCarousel) when the job has no carouselCards', async () => {
      await worker.process(makeJob(makeJobData()));

      expect(mockSessions.sendBaileyMessage).toHaveBeenCalledTimes(1);
      expect(mockSessions.sendBaileyCarousel).not.toHaveBeenCalled();
    });
  });

  describe('circuit breaker', () => {
    it('trips the breaker after the failure threshold and pauses the session campaigns', async () => {
      mockSessions.sendBaileyMessage.mockRejectedValueOnce(new Error('socket closed'));
      mockPrisma.session.update.mockResolvedValueOnce({ consecutiveFailures: 5 });

      await expect(worker.process(makeJob(makeJobData()))).rejects.toThrow('socket closed');

      expect(mockSessions.tripCircuitBreaker).toHaveBeenCalledWith('session-1', 5);
    });

    it('does not trip the breaker below the threshold', async () => {
      mockSessions.sendBaileyMessage.mockRejectedValueOnce(new Error('socket closed'));
      mockPrisma.session.update.mockResolvedValueOnce({ consecutiveFailures: 2 });

      await expect(worker.process(makeJob(makeJobData()))).rejects.toThrow('socket closed');

      expect(mockSessions.tripCircuitBreaker).not.toHaveBeenCalled();
    });

    it('resets the failure streak and counts a stranger send on success', async () => {
      mockPrisma.campaignMessage.count.mockResolvedValue(0); // stranger

      await worker.process(makeJob(makeJobData()));

      expect(mockPrisma.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-1' },
          data: expect.objectContaining({
            dailySent: { increment: 1 },
            consecutiveFailures: 0,
            strangerSent: { increment: 1 },
          }),
        }),
      );
    });
  });

  describe('session not ONLINE', () => {
    it('marks the job FAILED without attempting to send', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({
        dailySent: 0,
        strangerSent: 0,
        warmupDay: 21,
        status: SessionStatus.OFFLINE,
      });

      await worker.process(makeJob(makeJobData()));

      expect(mockSessions.sendBaileyMessage).not.toHaveBeenCalled();
      expect(mockPrisma.campaignMessage.update).toHaveBeenCalledWith({
        where: { id: 'msg-1' },
        data: { status: MsgStatus.FAILED },
      });
    });
  });
});
