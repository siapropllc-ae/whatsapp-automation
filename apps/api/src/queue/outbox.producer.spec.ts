import { Test, type TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { MediaType, SessionMode } from '@prisma/client';
import { OutboxProducer } from './outbox.producer';
import { BAILEYS_QUEUE, CLOUD_API_QUEUE } from './queue.constants';
import type { OutboxJob } from './outbox-job.types';

const mockCloudApiQueue = { add: jest.fn(), addBulk: jest.fn().mockResolvedValue([]) };
const mockBaileysQueue = { add: jest.fn(), addBulk: jest.fn().mockResolvedValue([]) };

function makeJob(overrides: Partial<OutboxJob> = {}): OutboxJob {
  return {
    campaignMessageId: 'msg-1',
    campaignId: 'camp-1',
    contactId: 'contact-1',
    sessionId: 'sess-1',
    phone: '+15551234567',
    renderedText: 'Hello',
    activeFrom: 8,
    activeTo: 22,
    mode: SessionMode.BAILEYS,
    ...overrides,
  };
}

describe('OutboxProducer', () => {
  let producer: OutboxProducer;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCloudApiQueue.addBulk.mockResolvedValue([]);
    mockBaileysQueue.addBulk.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OutboxProducer,
        { provide: getQueueToken(CLOUD_API_QUEUE), useValue: mockCloudApiQueue },
        { provide: getQueueToken(BAILEYS_QUEUE), useValue: mockBaileysQueue },
      ],
    }).compile();
    producer = module.get(OutboxProducer);
  });

  describe('enqueue', () => {
    it('routes a CLOUD_API job to the cloud-api queue', async () => {
      await producer.enqueue(makeJob({ mode: SessionMode.CLOUD_API }));
      expect(mockCloudApiQueue.add).toHaveBeenCalledWith('send', expect.objectContaining({ mode: SessionMode.CLOUD_API }), expect.any(Object));
      expect(mockBaileysQueue.add).not.toHaveBeenCalled();
    });

    it('routes a BAILEYS job to the baileys queue', async () => {
      await producer.enqueue(makeJob({ mode: SessionMode.BAILEYS }));
      expect(mockBaileysQueue.add).toHaveBeenCalledWith('send', expect.objectContaining({ mode: SessionMode.BAILEYS }), expect.any(Object));
      expect(mockCloudApiQueue.add).not.toHaveBeenCalled();
    });
  });

  describe('enqueueBulk', () => {
    it('does nothing and returns no failures for an empty job list', async () => {
      const result = await producer.enqueueBulk([]);
      expect(result).toEqual({ failedCampaignMessageIds: [] });
      expect(mockCloudApiQueue.addBulk).not.toHaveBeenCalled();
      expect(mockBaileysQueue.addBulk).not.toHaveBeenCalled();
    });

    it('splits jobs by mode across both queues in one addBulk call each', async () => {
      const jobs = [
        { data: makeJob({ campaignMessageId: 'm1', mode: SessionMode.CLOUD_API }), delay: 1000 },
        { data: makeJob({ campaignMessageId: 'm2', mode: SessionMode.BAILEYS }), delay: 2000 },
        { data: makeJob({ campaignMessageId: 'm3', mode: SessionMode.CLOUD_API }), delay: 3000 },
      ];

      const result = await producer.enqueueBulk(jobs);

      expect(mockCloudApiQueue.addBulk).toHaveBeenCalledTimes(1);
      expect(mockCloudApiQueue.addBulk.mock.calls[0]![0]).toHaveLength(2);
      expect(mockBaileysQueue.addBulk).toHaveBeenCalledTimes(1);
      expect(mockBaileysQueue.addBulk.mock.calls[0]![0]).toHaveLength(1);
      expect(result).toEqual({ failedCampaignMessageIds: [] });
    });

    // Regression test for Gap 3: a Promise.all would let one queue's rejection swallow/
    // abort visibility into the OTHER queue's outcome. Promise.allSettled must report
    // exactly which campaignMessageIds have no backing job, per queue, independently.
    it('reports only the failed queue\'s campaignMessageIds when one addBulk rejects and the other succeeds', async () => {
      mockCloudApiQueue.addBulk.mockRejectedValueOnce(new Error('Redis connection reset'));
      mockBaileysQueue.addBulk.mockResolvedValueOnce([{ id: 'job-1' }]);

      const jobs = [
        { data: makeJob({ campaignMessageId: 'cloud-1', mode: SessionMode.CLOUD_API }), delay: 0 },
        { data: makeJob({ campaignMessageId: 'cloud-2', mode: SessionMode.CLOUD_API }), delay: 0 },
        { data: makeJob({ campaignMessageId: 'baileys-1', mode: SessionMode.BAILEYS }), delay: 0 },
      ];

      const result = await producer.enqueueBulk(jobs);

      expect(result.failedCampaignMessageIds.sort()).toEqual(['cloud-1', 'cloud-2']);
      // The baileys queue's successful addBulk must not be affected by the cloud-api rejection.
      expect(mockBaileysQueue.addBulk).toHaveBeenCalledTimes(1);
    });

    it('reports campaignMessageIds from both queues when both addBulk calls reject', async () => {
      mockCloudApiQueue.addBulk.mockRejectedValueOnce(new Error('down'));
      mockBaileysQueue.addBulk.mockRejectedValueOnce(new Error('down'));

      const jobs = [
        { data: makeJob({ campaignMessageId: 'cloud-1', mode: SessionMode.CLOUD_API }), delay: 0 },
        { data: makeJob({ campaignMessageId: 'baileys-1', mode: SessionMode.BAILEYS }), delay: 0 },
      ];

      const result = await producer.enqueueBulk(jobs);

      expect(result.failedCampaignMessageIds.sort()).toEqual(['baileys-1', 'cloud-1']);
    });

    it('carries media fields and delay through into the bulk spec', async () => {
      const jobs = [
        {
          data: makeJob({ mode: SessionMode.BAILEYS, mediaUrl: 'http://x/a.jpg', mediaType: MediaType.IMAGE }),
          delay: 5000,
        },
      ];
      await producer.enqueueBulk(jobs);
      const spec = mockBaileysQueue.addBulk.mock.calls[0]![0] as Array<{ opts: { delay: number }; data: OutboxJob }>;
      expect(spec[0]!.opts.delay).toBe(5000);
      expect(spec[0]!.data.mediaUrl).toBe('http://x/a.jpg');
    });
  });
});
