import { Inject, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { type Job, Queue, DelayedError } from 'bullmq';
import type Redis from 'ioredis';
import { CampaignStatus, MsgStatus, SessionStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { CloudApiService } from '../cloud-api/cloud-api.service';
import { DelayService } from '../antiban/delay.service';
import { WarmupService } from '../antiban/warmup.service';
import { SessionsService } from '../sessions/sessions.service';
import { SessionsGateway } from '../sessions/sessions.gateway';
import { CLOUD_API_QUEUE, DLQ_QUEUE, REDIS_CLIENT } from './queue.constants';
import { type DlqJob, type OutboxJob } from './outbox-job.types';

/** Consecutive send failures on a session before its campaigns are auto-paused. */
const CIRCUIT_BREAKER_THRESHOLD = 5;

@Processor(CLOUD_API_QUEUE, { concurrency: 1 })
export class CloudApiWorker extends WorkerHost {
  private readonly log = new Logger(CloudApiWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudApi: CloudApiService,
    private readonly delay: DelayService,
    private readonly warmup: WarmupService,
    private readonly sessions: SessionsService,
    private readonly gateway: SessionsGateway,
    @InjectQueue(DLQ_QUEUE) private readonly dlqQueue: Queue,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  async process(job: Job<OutboxJob>, token?: string): Promise<void> {
    // Idempotency: skip if already sent — guards against stalled-job replays on restart
    const current = await this.prisma.campaignMessage.findUnique({
      where: { id: job.data.campaignMessageId },
      select: { status: true },
    });
    const TERMINAL: MsgStatus[] = [MsgStatus.SENT, MsgStatus.DELIVERED, MsgStatus.READ, MsgStatus.REPLIED, MsgStatus.FAILED];
    if (!current || TERMINAL.includes(current.status)) {
      this.log.log(
        `[CLOUD_API] job ${job.id} already sent (status=${current?.status ?? 'missing'}) — skipping`,
      );
      return;
    }

    // Campaign PAUSED check — delay 5 min and re-check when campaign is manually paused
    const campaignStatus = await this.prisma.campaign.findUnique({
      where: { id: job.data.campaignId },
      select: { status: true },
    });
    if (campaignStatus?.status === CampaignStatus.PAUSED) {
      this.log.log(`[CLOUD_API] job ${job.id} campaign PAUSED → requeue in 5min`);
      await job.moveToDelayed(Date.now() + 300_000, token);
      throw new DelayedError();
    }

    // Active-hours gate — requeue until next window
    if (!this.delay.isWithinActiveHours(job.data.activeFrom, job.data.activeTo)) {
      const ms = this.delay.msUntilNextWindow(job.data.activeFrom) + this.delay.requeueJitterMs();
      this.log.log(
        `[CLOUD_API] job ${job.id} outside active hours → requeue in ${Math.round(ms / 60_000)}min`,
      );
      await job.moveToDelayed(Date.now() + ms, token);
      throw new DelayedError();
    }

    // Warmup daily cap — check before every send, not just at launch
    const session = await this.prisma.session.findUnique({
      where: { id: job.data.sessionId },
      select: { dailySent: true, strangerSent: true, warmupDay: true, status: true },
    });
    if (!session || session.status !== SessionStatus.ONLINE) {
      this.log.warn(`[CLOUD_API] session ${job.data.sessionId} not ONLINE — failing job`);
      await this.markFailed(job.data.campaignMessageId);
      await this.emitStats(job.data.campaignId);
      await this.checkCampaignDone(job.data.campaignId);
      return;
    }
    const cap = this.warmup.getEffectiveDailyLimit(session);
    if (session.dailySent >= cap) {
      const msUntilReset = this.delay.msUntilMidnight() + this.delay.requeueJitterMs();
      this.log.warn(
        `[CLOUD_API] session ${job.data.sessionId} hit daily cap (${session.dailySent}/${cap}) → requeue in ${Math.round(msUntilReset / 60_000)}min`,
      );
      await job.moveToDelayed(Date.now() + msUntilReset, token);
      throw new DelayedError();
    }

    // Contact history → stranger classification + gap multiplier (cold outreach is throttled hardest).
    const prevSentCount = await this.prisma.campaignMessage.count({
      where: {
        contactId: job.data.contactId,
        status: { in: [MsgStatus.SENT, MsgStatus.DELIVERED, MsgStatus.READ, MsgStatus.REPLIED] },
        NOT: { id: job.data.campaignMessageId },
      },
    });
    const isStranger = prevSentCount === 0;
    const contactMultiplier = prevSentCount === 0 ? 2.5 : prevSentCount === 1 ? 1.8 : 1.0;

    // Stranger (cold first-contact) daily sub-cap
    if (isStranger) {
      const strangerCap = this.warmup.getEffectiveStrangerLimit(session);
      if (session.strangerSent >= strangerCap) {
        const msUntilReset = this.delay.msUntilMidnight() + this.delay.requeueJitterMs();
        this.log.warn(
          `[CLOUD_API] session ${job.data.sessionId} hit stranger cap (${session.strangerSent}/${strangerCap}) → requeue in ${Math.round(msUntilReset / 60_000)}min`,
        );
        await job.moveToDelayed(Date.now() + msUntilReset, token);
        throw new DelayedError();
      }
    }

    // Hourly cap — spread the daily volume across the active window
    const hourKey = `session:hourly:${job.data.sessionId}:${this.delay.utcHourStamp()}`;
    const hourlyCount = parseInt((await this.redis.get(hourKey)) ?? '0', 10);
    const hourlyCap = this.delay.hourlyCap(cap);
    if (hourlyCount >= hourlyCap) {
      const wait = this.delay.msUntilNextHour();
      this.log.warn(
        `[CLOUD_API] session ${job.data.sessionId} hit hourly cap (${hourlyCount}/${hourlyCap}) → requeue in ${Math.round(wait / 60_000)}min`,
      );
      await job.moveToDelayed(Date.now() + wait, token);
      throw new DelayedError();
    }

    // Human burst-break — after N sends, pause for 15–45 min
    const breakUntilStr = await this.redis.get(`session:breakUntil:${job.data.sessionId}`);
    if (breakUntilStr) {
      const breakUntil = parseInt(breakUntilStr, 10);
      const now = Date.now();
      if (now < breakUntil) {
        const wait = breakUntil - now;
        this.log.log(
          `[CLOUD_API] session ${job.data.sessionId} on burst-break → requeue in ${Math.round(wait / 60_000)}min`,
        );
        await job.moveToDelayed(Date.now() + wait, token);
        throw new DelayedError();
      }
    }

    // Redis minimum-gap gate — Gaussian-sampled gap (NOT the raw floor) so pacing holds
    // even when many jobs were requeued to the same wake time. Stranger penalty multiplies it.
    const minGap = Math.round(this.delay.computeDelayMs() * contactMultiplier);
    const redisKey = `session:lastSent:${job.data.sessionId}`;
    const lastSentStr = await this.redis.get(redisKey);
    if (lastSentStr) {
      const elapsed = Date.now() - parseInt(lastSentStr, 10);
      if (elapsed < minGap) {
        const wait = minGap - elapsed + 1000;
        this.log.warn(
          `[CLOUD_API] min-gap not met for session ${job.data.sessionId} (${elapsed}ms < ${minGap}ms, multiplier=${contactMultiplier}×) → requeue in ${wait}ms`,
        );
        await job.moveToDelayed(Date.now() + wait, token);
        throw new DelayedError();
      }
    }

    try {
      if (!job.data.templateName) {
        this.log.error(`[CLOUD_API] job ${job.id} has no templateName — failing (Cloud API requires an approved template)`);
        await this.markFailed(job.data.campaignMessageId);
        await this.emitStats(job.data.campaignId);
        await this.checkCampaignDone(job.data.campaignId);
        return;
      }
      const result = await this.cloudApi.sendTemplate({
        to: job.data.phone,
        templateName: job.data.templateName,
        headerMedia: job.data.mediaUrl && job.data.mediaType
          ? { type: job.data.mediaType, url: job.data.mediaUrl, filename: job.data.mediaFilename }
          : undefined,
      });

      await this.prisma.campaignMessage.update({
        where: { id: job.data.campaignMessageId },
        data: { status: MsgStatus.SENT, sentAt: new Date(), wamid: result.wamid },
      });

      void this.prisma.analyticsEvent
        .create({ data: { type: 'SENT', campaignId: job.data.campaignId, sessionId: job.data.sessionId } })
        .catch(() => undefined);

      await this.recordSuccess(job.data.sessionId, isStranger, redisKey, hourKey);
      await this.emitStats(job.data.campaignId);
      await this.checkCampaignDone(job.data.campaignId);

      this.log.log(
        `[CLOUD_API] sent msg=${job.data.campaignMessageId} to=${job.data.phone} wamid=${result.wamid}`,
      );
    } catch (err) {
      await this.recordFailure(job.data.sessionId);
      await this.markFailed(job.data.campaignMessageId);
      throw err;
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<OutboxJob> | undefined, error: Error): Promise<void> {
    if (!job) return;
    // DelayedError is an intentional requeue signal — never route to DLQ
    if (error instanceof DelayedError) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      const dlqPayload: DlqJob = {
        originalJob: job.data,
        error: error.message,
        failedAt: new Date().toISOString(),
      };
      await this.dlqQueue
        .add('failed', dlqPayload)
        .catch((e: unknown) => this.log.error(`DLQ enqueue failed: ${String(e)}`));
    }
  }

  private async markFailed(msgId: string): Promise<void> {
    await this.prisma.campaignMessage
      .update({ where: { id: msgId }, data: { status: MsgStatus.FAILED } })
      .catch(() => undefined);
  }

  /**
   * Post-send bookkeeping: record the send time + daily/stranger/hourly counters, reset the
   * failure streak, and advance the burst-break counter (scheduling a pause when it trips).
   */
  private async recordSuccess(sessionId: string, isStranger: boolean, lastSentKey: string, hourKey: string): Promise<void> {
    await this.redis.set(lastSentKey, String(Date.now()), 'EX', 86400);

    await this.prisma.session
      .update({
        where: { id: sessionId },
        data: {
          dailySent: { increment: 1 },
          consecutiveFailures: 0,
          ...(isStranger ? { strangerSent: { increment: 1 } } : {}),
        },
      })
      .catch((e: unknown) => this.log.warn(`counter increment failed [${sessionId}]: ${String(e)}`));

    await this.redis.incr(hourKey).catch(() => 0);
    await this.redis.expire(hourKey, 3700).catch(() => 0);

    await this.advanceBurstCounter(sessionId);
  }

  private async advanceBurstCounter(sessionId: string): Promise<void> {
    try {
      const counterKey = `session:sinceBreak:${sessionId}`;
      const thresholdKey = `session:breakThreshold:${sessionId}`;
      const sent = await this.redis.incr(counterKey);
      let threshold = parseInt((await this.redis.get(thresholdKey)) ?? '0', 10);
      if (!threshold) {
        threshold = this.delay.computeBurstThreshold();
        await this.redis.set(thresholdKey, String(threshold));
      }
      if (sent >= threshold) {
        const breakMs = this.delay.computeBurstBreakMs();
        await this.redis.set(`session:breakUntil:${sessionId}`, String(Date.now() + breakMs), 'EX', Math.ceil(breakMs / 1000) + 60);
        await this.redis.set(counterKey, '0');
        await this.redis.set(thresholdKey, String(this.delay.computeBurstThreshold()));
        this.log.log(`[CLOUD_API] session ${sessionId} taking a ${Math.round(breakMs / 60_000)}min burst-break after ${sent} sends`);
      }
    } catch (e) {
      this.log.warn(`burst-break bookkeeping failed [${sessionId}]: ${String(e)}`);
    }
  }

  /** Increment the consecutive-failure counter and trip the circuit breaker at the threshold. */
  private async recordFailure(sessionId: string): Promise<void> {
    try {
      const updated = await this.prisma.session.update({
        where: { id: sessionId },
        data: { consecutiveFailures: { increment: 1 } },
        select: { consecutiveFailures: true },
      });
      if (updated.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
        await this.sessions.tripCircuitBreaker(sessionId, updated.consecutiveFailures);
        await this.prisma.session
          .update({ where: { id: sessionId }, data: { consecutiveFailures: 0 } })
          .catch(() => undefined);
      }
    } catch (e) {
      this.log.warn(`recordFailure failed [${sessionId}]: ${String(e)}`);
    }
  }

  private async checkCampaignDone(campaignId: string): Promise<void> {
    try {
      const remaining = await this.prisma.campaignMessage.count({
        where: { campaignId, status: MsgStatus.QUEUED },
      });
      if (remaining === 0) {
        // updateMany is safe to call concurrently — won't throw if already DONE
        await this.prisma.campaign.updateMany({
          where: { id: campaignId, status: CampaignStatus.RUNNING },
          data: { status: CampaignStatus.DONE },
        });
      }
    } catch {
      // non-critical; swallow
    }
  }

  private async emitStats(campaignId: string): Promise<void> {
    try {
      const rows = await this.prisma.campaignMessage.groupBy({
        by: ['status'],
        where: { campaignId },
        _count: { status: true },
      });
      const counts: Record<string, number> = {};
      for (const r of rows) counts[r.status] = r._count.status;
      this.gateway.emitCampaignStats(campaignId, counts);
    } catch {
      // non-critical; swallow to avoid disrupting the main flow
    }
  }
}
