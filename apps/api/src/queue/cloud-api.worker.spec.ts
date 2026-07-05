import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { DelayedError, type Job } from 'bullmq';
import { MediaType, MsgStatus, SessionStatus } from '@prisma/client';
import { CloudApiWorker } from './cloud-api.worker';
import { PrismaService } from '../common/prisma/prisma.service';
import { CloudApiService } from '../cloud-api/cloud-api.service';
import { DelayService } from '../antiban/delay.service';
import { WarmupService } from '../antiban/warmup.service';
import { SessionsService } from '../sessions/sessions.service';
import { SessionsGateway } from '../sessions/sessions.gateway';
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

const mockCloudApi = {
  sendTemplate: jest.fn().mockResolvedValue({ wamid: 'wamid.test' }),
};

const mockSessions = {
  tripCircuitBreaker: jest.fn().mockResolvedValue(undefined),
};

const mockDelay = {
  isWithinActiveHours: jest.fn().mockReturnValue(true),
  msUntilNextWindow: jest.fn().mockReturnValue(3_600_000),
  msUntilMidnight: jest.fn().mockReturnValue(3_600_000),
  msUntilNextHour: jest.fn().mockReturnValue(1_800_000),
  requeueJitterMs: jest.fn().mockReturnValue(0),
  computeDelayMs: jest.fn().mockReturnValue(60_000),
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

// Key-aware in-memory Redis (see baileys.worker.spec for rationale).
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
    templateName: 'welcome_template',
    activeFrom: 0,
    activeTo: 24,
    mode: 'CLOUD_API' as OutboxJob['mode'],
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

describe('CloudApiWorker', () => {
  let worker: CloudApiWorker;

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
    mockDelay.hourlyCap.mockReturnValue(1000);
    mockDelay.computeBurstThreshold.mockReturnValue(1000);
    mockWarmup.getEffectiveDailyLimit.mockReturnValue(200);
    mockWarmup.getEffectiveStrangerLimit.mockReturnValue(200);
    mockCloudApi.sendTemplate.mockResolvedValue({ wamid: 'wamid.test' });

    const module = await Test.createTestingModule({
      providers: [
        CloudApiWorker,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CloudApiService, useValue: mockCloudApi },
        { provide: DelayService, useValue: mockDelay },
        { provide: WarmupService, useValue: mockWarmup },
        { provide: SessionsService, useValue: mockSessions },
        { provide: SessionsGateway, useValue: mockGateway },
        { provide: getQueueToken(DLQ_QUEUE), useValue: mockDlqQueue },
        { provide: REDIS_CLIENT, useValue: mockRedis },
      ],
    }).compile();

    worker = module.get(CloudApiWorker);
  });

  describe('idempotency gate', () => {
    it.each([MsgStatus.SENT, MsgStatus.DELIVERED, MsgStatus.READ, MsgStatus.REPLIED, MsgStatus.FAILED])(
      'skips the send when the message is already in terminal status %s',
      async (status) => {
        mockPrisma.campaignMessage.findUnique.mockResolvedValue({ status });
        await worker.process(makeJob(makeJobData()));
        expect(mockCloudApi.sendTemplate).not.toHaveBeenCalled();
      },
    );
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
      expect(mockCloudApi.sendTemplate).not.toHaveBeenCalled();
    });

    it('requeues to the next active-hours window and never sends when outside active hours', async () => {
      mockDelay.isWithinActiveHours.mockReturnValue(false);
      mockDelay.msUntilNextWindow.mockReturnValue(7_200_000);
      const job = makeJob(makeJobData({ activeFrom: 8, activeTo: 22 }));

      await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

      expect(mockDelay.isWithinActiveHours).toHaveBeenCalledWith(8, 22);
      expect(mockDelay.msUntilNextWindow).toHaveBeenCalledWith(8);
      expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 7_200_000, undefined);
      expect(mockCloudApi.sendTemplate).not.toHaveBeenCalled();
    });

    it('requeues to the midnight reset and never sends when the session is at its daily cap', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ dailySent: 200, strangerSent: 0, warmupDay: 21, status: SessionStatus.ONLINE });
      mockWarmup.getEffectiveDailyLimit.mockReturnValue(200);
      mockDelay.msUntilMidnight.mockReturnValue(5_400_000);
      const job = makeJob(makeJobData());

      await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

      expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 5_400_000, undefined);
      expect(mockCloudApi.sendTemplate).not.toHaveBeenCalled();
    });

    it('does NOT requeue when dailySent is one below the cap (boundary check)', async () => {
      mockPrisma.session.findUnique.mockResolvedValue({ dailySent: 199, strangerSent: 0, warmupDay: 21, status: SessionStatus.ONLINE });
      mockWarmup.getEffectiveDailyLimit.mockReturnValue(200);

      await worker.process(makeJob(makeJobData()));

      expect(mockCloudApi.sendTemplate).toHaveBeenCalledTimes(1);
    });

    it('requeues a cold first-contact message when the stranger sub-cap is reached', async () => {
      mockPrisma.campaignMessage.count.mockResolvedValue(0); // stranger
      mockPrisma.session.findUnique.mockResolvedValue({ dailySent: 10, strangerSent: 35, warmupDay: 7, status: SessionStatus.ONLINE });
      mockWarmup.getEffectiveStrangerLimit.mockReturnValue(35);
      mockDelay.msUntilMidnight.mockReturnValue(5_400_000);
      const job = makeJob(makeJobData());

      await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

      expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 5_400_000, undefined);
      expect(mockCloudApi.sendTemplate).not.toHaveBeenCalled();
    });

    it('requeues to the next hour when the hourly cap is reached', async () => {
      redisStore['session:hourly:session-1:2026070512'] = '40';
      mockDelay.hourlyCap.mockReturnValue(40);
      mockDelay.msUntilNextHour.mockReturnValue(1_200_000);
      const job = makeJob(makeJobData());

      await expect(worker.process(job)).rejects.toBeInstanceOf(DelayedError);

      expect(job.moveToDelayed).toHaveBeenCalledWith(FIXED_NOW + 1_200_000, undefined);
      expect(mockCloudApi.sendTemplate).not.toHaveBeenCalled();
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
        expect(mockCloudApi.sendTemplate).not.toHaveBeenCalled();
      });

      it('proceeds to send when there is no prior lastSent record on this session', async () => {
        mockPrisma.campaignMessage.count.mockResolvedValue(0);

        await worker.process(makeJob(makeJobData()));

        expect(mockCloudApi.sendTemplate).toHaveBeenCalledTimes(1);
      });

      it('records the lastSent timestamp in Redis with a 24h expiry after a successful send', async () => {
        await worker.process(makeJob(makeJobData()));

        expect(mockRedis.set).toHaveBeenCalledWith('session:lastSent:session-1', String(FIXED_NOW), 'EX', 86400);
      });
    });
  });

  describe('missing templateName guard', () => {
    it('fails the job without calling Cloud API when templateName is absent', async () => {
      await worker.process(makeJob(makeJobData({ templateName: undefined })));

      expect(mockCloudApi.sendTemplate).not.toHaveBeenCalled();
      expect(mockPrisma.campaignMessage.update).toHaveBeenCalledWith({
        where: { id: 'msg-1' },
        data: { status: MsgStatus.FAILED },
      });
    });
  });

  describe('media attachment send path', () => {
    it('omits headerMedia when the job has no attachment', async () => {
      await worker.process(makeJob(makeJobData()));

      expect(mockCloudApi.sendTemplate).toHaveBeenCalledWith({
        to: '+15551234567',
        templateName: 'welcome_template',
        headerMedia: undefined,
      });
    });

    it('builds headerMedia (type/url/filename, no mimeType) when the job has an attachment', async () => {
      const jobData = makeJobData({
        mediaUrl: 'http://localhost:3001/api/media/a.jpg',
        mediaType: MediaType.IMAGE,
        mediaMimeType: 'image/jpeg',
        mediaFilename: 'a.jpg',
      });

      await worker.process(makeJob(jobData));

      expect(mockCloudApi.sendTemplate).toHaveBeenCalledWith({
        to: '+15551234567',
        templateName: 'welcome_template',
        headerMedia: { type: MediaType.IMAGE, url: 'http://localhost:3001/api/media/a.jpg', filename: 'a.jpg' },
      });
    });

    it('persists the returned wamid on success', async () => {
      mockCloudApi.sendTemplate.mockResolvedValue({ wamid: 'wamid.abc123' });

      await worker.process(makeJob(makeJobData()));

      expect(mockPrisma.campaignMessage.update).toHaveBeenCalledWith({
        where: { id: 'msg-1' },
        data: expect.objectContaining({ status: MsgStatus.SENT, wamid: 'wamid.abc123' }),
      });
    });

    it('marks the message FAILED and rethrows when the send itself throws', async () => {
      mockCloudApi.sendTemplate.mockRejectedValueOnce(new Error('Meta API error'));

      await expect(worker.process(makeJob(makeJobData()))).rejects.toThrow('Meta API error');

      expect(mockPrisma.campaignMessage.update).toHaveBeenCalledWith({
        where: { id: 'msg-1' },
        data: { status: MsgStatus.FAILED },
      });
    });

    it('passes the template buttons through to sendTemplate when present', async () => {
      const buttons = [{ id: 'yes-1', type: 'QUICK_REPLY' as const, label: 'Yes' }];
      await worker.process(makeJob(makeJobData({ buttons })));

      expect(mockCloudApi.sendTemplate).toHaveBeenCalledWith({
        to: '+15551234567',
        templateName: 'welcome_template',
        headerMedia: undefined,
        buttons,
      });
    });
  });

  describe('circuit breaker', () => {
    it('trips the breaker after the failure threshold and pauses the session campaigns', async () => {
      mockCloudApi.sendTemplate.mockRejectedValueOnce(new Error('Meta API error'));
      mockPrisma.session.update.mockResolvedValueOnce({ consecutiveFailures: 5 });

      await expect(worker.process(makeJob(makeJobData()))).rejects.toThrow('Meta API error');

      expect(mockSessions.tripCircuitBreaker).toHaveBeenCalledWith('session-1', 5);
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

      expect(mockCloudApi.sendTemplate).not.toHaveBeenCalled();
      expect(mockPrisma.campaignMessage.update).toHaveBeenCalledWith({
        where: { id: 'msg-1' },
        data: { status: MsgStatus.FAILED },
      });
    });
  });
});
