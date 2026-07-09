import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { type JobsOptions, Queue } from 'bullmq';
import { SessionMode } from '@prisma/client';
import { BAILEYS_QUEUE, CLOUD_API_QUEUE } from './queue.constants';
import { type OutboxJob } from './outbox-job.types';

const BASE_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};

export interface EnqueueBulkResult {
  /**
   * campaignMessageId of every job that failed to reach Redis. These rows were already
   * persisted (e.g. via campaignMessage.createMany) with status QUEUED before enqueueBulk
   * ran, but have no backing BullMQ job — callers must reconcile (mark FAILED or retry)
   * or the rows are stuck QUEUED forever with nothing that will ever process them.
   */
  failedCampaignMessageIds: string[];
}

@Injectable()
export class OutboxProducer {
  private readonly log = new Logger(OutboxProducer.name);

  constructor(
    @InjectQueue(CLOUD_API_QUEUE) private readonly cloudApiQueue: Queue,
    @InjectQueue(BAILEYS_QUEUE) private readonly baileysQueue: Queue,
  ) {}

  async enqueue(data: OutboxJob, opts: { delay?: number } = {}): Promise<void> {
    const queue =
      data.mode === SessionMode.CLOUD_API ? this.cloudApiQueue : this.baileysQueue;
    await queue.add('send', data, { ...BASE_OPTS, delay: opts.delay });
  }

  /**
   * Bulk variant of enqueue() — one round-trip to Redis instead of one per job.
   * Campaign launches can carry hundreds of jobs; awaiting queue.add() sequentially
   * in a loop was slow enough to blow past the Vercel proxy's 60s function timeout.
   *
   * The two queues are addBulk'd independently via allSettled (not Promise.all) — a
   * transient failure writing to one queue must not be silently swallowed just because
   * the other queue's addBulk happened to succeed; the caller needs to know exactly
   * which campaignMessageIds have no backing job so it can reconcile.
   */
  async enqueueBulk(jobs: { data: OutboxJob; delay?: number }[]): Promise<EnqueueBulkResult> {
    if (!jobs.length) return { failedCampaignMessageIds: [] };
    const cloudApiJobs = jobs.filter((j) => j.data.mode === SessionMode.CLOUD_API);
    const baileysJobs = jobs.filter((j) => j.data.mode !== SessionMode.CLOUD_API);

    const toBulkSpec = (list: typeof jobs) =>
      list.map((j) => ({ name: 'send', data: j.data, opts: { ...BASE_OPTS, delay: j.delay } }));

    const [cloudApiResult, baileysResult] = await Promise.allSettled([
      cloudApiJobs.length ? this.cloudApiQueue.addBulk(toBulkSpec(cloudApiJobs)) : Promise.resolve([]),
      baileysJobs.length ? this.baileysQueue.addBulk(toBulkSpec(baileysJobs)) : Promise.resolve([]),
    ]);

    const failedCampaignMessageIds: string[] = [];
    if (cloudApiResult.status === 'rejected') {
      this.log.error(
        `enqueueBulk: Cloud API addBulk failed — ${cloudApiJobs.length} job(s) not enqueued: ${String(cloudApiResult.reason)}`,
      );
      failedCampaignMessageIds.push(...cloudApiJobs.map((j) => j.data.campaignMessageId));
    }
    if (baileysResult.status === 'rejected') {
      this.log.error(
        `enqueueBulk: Baileys addBulk failed — ${baileysJobs.length} job(s) not enqueued: ${String(baileysResult.reason)}`,
      );
      failedCampaignMessageIds.push(...baileysJobs.map((j) => j.data.campaignMessageId));
    }
    return { failedCampaignMessageIds };
  }
}
