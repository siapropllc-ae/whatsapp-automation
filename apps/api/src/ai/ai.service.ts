import { randomUUID } from 'crypto';
import { BadRequestException, Inject, Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MsgStatus, SessionMode, SessionStatus } from '@prisma/client';
import { spinText } from '@wa-engine/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { DelayService } from '../antiban/delay.service';
import { WarmupService } from '../antiban/warmup.service';
import { OutboxProducer } from '../queue/outbox.producer';
import { type OutboxJob } from '../queue/outbox-job.types';
import { type ContactInputDto, type GenerateCampaignDto, type GenerateCampaignResult, type GenerateTemplatesDto } from './dto/generate-campaign.dto';
import { type AnalyzeReplyDto, type ReplyAnalysis, type Sentiment, type ReplyIntent } from './dto/analyze-reply.dto';
import { type OptimizeDto, type OptimizeResult, type VariantStat } from './dto/optimize.dto';

// ─── Provider interface ───────────────────────────────────────────────────────

export interface AiProvider {
  complete(systemPrompt: string, userPrompt: string): Promise<string>;
}

export const AI_PROVIDER_TOKEN = Symbol('AI_PROVIDER');

/**
 * Thrown by an AiProvider implementation instead of letting a raw SDK error (network
 * failure, 429, 5xx, malformed response) propagate — callers need `retryable` to decide
 * whether to surface a "try again" message vs. a hard failure, without depending on
 * SDK-specific error classes (Anthropic.APIError vs. OpenAI.APIError).
 */
export class AiProviderError extends Error {
  readonly cause?: unknown;

  constructor(
    message: string,
    public readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'AiProviderError';
    this.cause = options?.cause;
  }
}

// ─── LLM system prompts ───────────────────────────────────────────────────────

const GENERATE_SYSTEM = `You are a WhatsApp copywriting engine.
Your output must be ONLY a valid JSON object — no prose, no markdown, no code fences.
Schema: { "templates": string[] }
Each template is a WhatsApp message body that uses spin-syntax for variation:
  - {option A|option B|option C} selects one branch at random — use this heavily so every lead gets a unique message
  - {name} is replaced with the lead's real name at send time — EVERY template MUST start with a greeting that includes {name}
  - {city} is replaced with the lead's city — use it to make messages feel local and personal
  - {interest} is replaced with the lead's interest or product they looked at — reference it to show relevance
Rules:
  - MANDATORY: every template must begin differently, e.g. "Hi {name}," / "Hey {name}!" / "Hello {name}," — rotate these with spin-syntax
  - MANDATORY: include {name} in EVERY template
  - Use {city} and {interest} wherever they add personalisation — but write the message so it still makes sense if those are empty
  - Each template must be distinct in structure and wording — no two templates should feel similar
  - Keep each template under 800 characters
  - Never use HTML or markdown
  - Return EXACTLY the number of templates requested`;

const ANALYZE_SYSTEM = `You are a sales-intelligence engine analysing WhatsApp reply messages.
Your output must be ONLY a valid JSON object — no prose, no markdown, no code fences.
Schema: { "sentiment": string, "intent": string, "score": number, "action": string }
Fields:
  sentiment — exactly one of: HOT | WARM | COLD | NEGATIVE
  intent    — exactly one of: BUYING | QUESTION | OBJECTION | OPT_OUT
  score     — float 0.0–1.0 (confidence in your classification)
  action    — one short sentence recommending the next step for the sales rep`;

// ─── Service ─────────────────────────────────────────────────────────────────

@Injectable()
export class AiService {
  private readonly log = new Logger(AiService.name);

  constructor(
    @Inject(AI_PROVIDER_TOKEN) private readonly provider: AiProvider,
    private readonly prisma: PrismaService,
    private readonly producer: OutboxProducer,
    private readonly delay: DelayService,
    private readonly warmup: WarmupService,
  ) {}

  // ── generate-campaign ─────────────────────────────────────────────────────

  async generateCampaign(dto: GenerateCampaignDto): Promise<GenerateCampaignResult> {
    if (dto.campaignId) {
      const exists = await this.prisma.campaign.findUnique({ where: { id: dto.campaignId }, select: { id: true } });
      if (!exists) throw new BadRequestException(`Campaign ${dto.campaignId} not found`);
    }
    const templates = await this.callGenerateTemplates(dto);

    const messages = dto.contacts.map((contact, idx) => {
      const template = templates[idx % templates.length] ?? '';
      const vars = this.buildVars(contact);
      return { contactId: contact.contactId, renderedText: spinText(template, vars) };
    });

    if (dto.campaignId) {
      await this.enqueueMessages(dto.campaignId, dto.contacts, messages);
    }

    return { campaignId: dto.campaignId, messages };
  }

  /**
   * Single choke point for every provider.complete() call — translates a raw AiProviderError
   * (or any other SDK-level throw) into a clean 503 instead of an unhandled 500 leaking SDK
   * internals. `retryable` only changes the message text; NestJS has no built-in 502, and a
   * 503 is the closest honest signal for "the upstream AI call failed" either way.
   */
  private async callProvider(systemPrompt: string, userPrompt: string): Promise<string> {
    try {
      return await this.provider.complete(systemPrompt, userPrompt);
    } catch (err) {
      if (err instanceof AiProviderError) {
        this.log.error(`AI provider call failed (retryable=${err.retryable}): ${err.message}`);
        throw new ServiceUnavailableException(
          err.retryable
            ? 'AI provider is temporarily unavailable — please retry shortly.'
            : 'AI provider rejected the request.',
        );
      }
      this.log.error(`AI provider call failed with unexpected error: ${String(err)}`);
      throw new ServiceUnavailableException('AI provider is temporarily unavailable — please retry shortly.');
    }
  }

  private async callGenerateTemplates(dto: GenerateCampaignDto): Promise<string[]> {
    const userPrompt =
      `Product: ${dto.productBrief}\n` +
      `Target audience: ${dto.audience}\n` +
      `Tone: ${dto.tone}\n` +
      `Generate exactly ${dto.count} unique message templates.`;

    const raw = await this.callProvider(GENERATE_SYSTEM, userPrompt);
    const parsed = this.parseJson<{ templates: unknown }>(raw);

    if (!Array.isArray(parsed.templates)) {
      throw new InternalServerErrorException('LLM returned malformed templates array');
    }
    return (parsed.templates as unknown[]).map((t) => String(t));
  }

  private buildVars(contact: ContactInputDto): Record<string, string> {
    const base: Record<string, string> = {};
    base['name'] = contact.name ?? contact.phone; // mirrors campaigns.service.ts — always defined
    if (contact.city) base['city'] = contact.city;
    if (contact.interest) base['interest'] = contact.interest;
    if (contact.vars) Object.assign(base, contact.vars);
    return base;
  }

  private async enqueueMessages(
    campaignId: string,
    contacts: ContactInputDto[],
    messages: Array<{ contactId: string; renderedText: string }>,
  ): Promise<void> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId } });
    if (!campaign) {
      this.log.warn(`generateCampaign: campaign ${campaignId} not found, skipping enqueue`);
      return;
    }

    // For Cloud API campaigns, look up the approved Meta template name
    let templateName: string | undefined;
    if (campaign.mode === SessionMode.CLOUD_API && campaign.templateId) {
      const tpl = await this.prisma.template.findUnique({
        where: { id: campaign.templateId },
        select: { name: true },
      });
      templateName = tpl?.name;
      if (!templateName) {
        this.log.warn(`generateCampaign: Cloud API campaign ${campaignId} has no template — skipping enqueue`);
        return;
      }
    }

    const allSessions = await this.prisma.session.findMany({
      where: { mode: campaign.mode, status: SessionStatus.ONLINE },
    });
    // Respect warmup daily cap — only schedule on sessions that have headroom
    const sessions = allSessions.filter(
      (s) => s.dailySent < this.warmup.getEffectiveDailyLimit(s),
    );
    if (!sessions.length) {
      this.log.warn(`generateCampaign: no sessions with warmup headroom for campaign ${campaignId}`);
      return;
    }

    // Cumulative delay per session — same staggering logic as campaigns.service.ts
    const sessionDelays = new Map<string, number>();
    for (const s of sessions) sessionDelays.set(s.id, 0);

    // Remaining daily-cap headroom per session, tracked so round-robin assignment below
    // honors it — see campaigns.service.ts's identical fix (Gap 4) for the full rationale:
    // plain `i % sessions.length` cycling can dump most of a large batch on one
    // near-capacity session. Falls back to unrestricted round-robin once every tracked
    // session is exhausted; the worker's per-message daily-cap gate remains authoritative.
    const headroom = new Map(
      sessions.map((s) => [s.id, Math.max(0, this.warmup.getEffectiveDailyLimit(s) - s.dailySent)]),
    );
    let sessionCursor = 0;
    const pickSession = (): (typeof sessions)[number] => {
      for (let attempt = 0; attempt < sessions.length; attempt++) {
        const candidate = sessions[sessionCursor % sessions.length]!;
        sessionCursor++;
        const remaining = headroom.get(candidate.id) ?? 0;
        if (remaining > 0) {
          headroom.set(candidate.id, remaining - 1);
          return candidate;
        }
      }
      const fallback = sessions[sessionCursor % sessions.length]!;
      sessionCursor++;
      return fallback;
    };

    // Dedup: skip contacts that are still QUEUED for this campaign (not yet sent).
    // Only exclude QUEUED — contacts with SENT/DELIVERED/READ/REPLIED can still receive
    // follow-up messages if the operator re-runs the AI campaign.
    const alreadyQueued = new Set(
      (
        await this.prisma.campaignMessage.findMany({
          where: {
            campaignId,
            contactId: { in: messages.map((m) => m.contactId) },
            status: MsgStatus.QUEUED,
          },
          select: { contactId: true },
        })
      ).map((m) => m.contactId),
    );

    // Bulk-check how many times each contact has been messaged before — mirrors
    // campaigns.service.ts: grouped (not a boolean presence check) so this estimate uses
    // the exact same tiered multiplier the worker's real-time gate enforces (DelayService
    // .contactMultiplier), rather than drifting from it.
    const prevSentCounts = new Map(
      (
        await this.prisma.campaignMessage.groupBy({
          by: ['contactId'],
          where: {
            contactId: { in: messages.map((m) => m.contactId) },
            status: { in: [MsgStatus.SENT, MsgStatus.DELIVERED, MsgStatus.READ, MsgStatus.REPLIED] },
          },
          _count: { _all: true },
        })
      ).map((row) => [row.contactId, row._count._all] as const),
    );

    // Build all message rows + jobs in memory, then flush in two bulk round-trips — the
    // same fix commit 8b496bc applied to campaigns.service.ts for the identical HTTP 504
    // (per-contact create()+enqueue() in a loop is 2 network round-trips × N contacts).
    const messageRows: {
      id: string;
      campaignId: string;
      contactId: string;
      sessionId: string;
      renderedText: string;
      status: MsgStatus;
    }[] = [];
    const jobs: { data: OutboxJob; delay: number }[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const contact = contacts[i];
      if (!msg || !contact) continue;

      if (alreadyQueued.has(msg.contactId)) {
        this.log.log(`generateCampaign: skipping contact ${msg.contactId} — already scheduled`);
        continue;
      }

      const session = pickSession();

      const msgId = randomUUID();
      messageRows.push({
        id: msgId,
        campaignId,
        contactId: msg.contactId,
        sessionId: session.id,
        renderedText: msg.renderedText,
        status: MsgStatus.QUEUED,
      });
      alreadyQueued.add(msg.contactId); // prevent duplicate if contacts array contains same contactId twice

      const prevDelay = sessionDelays.get(session.id) ?? 0;
      const contactMultiplier = this.delay.contactMultiplier(prevSentCounts.get(msg.contactId) ?? 0);
      const nextGap = Math.round(this.delay.computeDelayMs() * contactMultiplier);
      const totalDelay = prevDelay + nextGap;
      sessionDelays.set(session.id, totalDelay);

      jobs.push({
        data: {
          campaignMessageId: msgId,
          campaignId,
          contactId: msg.contactId,
          sessionId: session.id,
          phone: contact.phone,
          renderedText: msg.renderedText,
          activeFrom: campaign.activeFrom,
          activeTo: campaign.activeTo,
          mode: campaign.mode as SessionMode,
          templateName,
          mediaUrl: campaign.mediaUrl ?? undefined,
          mediaType: campaign.mediaType ?? undefined,
          mediaMimeType: campaign.mediaMimeType ?? undefined,
          mediaFilename: campaign.mediaFilename ?? undefined,
        },
        delay: totalDelay,
      });
    }

    if (!messageRows.length) {
      this.log.log(`generateCampaign: all contacts already scheduled for campaign ${campaignId}, nothing to enqueue`);
      return;
    }

    await this.prisma.campaignMessage.createMany({ data: messageRows });
    const { failedCampaignMessageIds } = await this.producer.enqueueBulk(jobs);

    if (failedCampaignMessageIds.length) {
      // Same reconciliation as campaigns.service.ts's launch() — without this, a Redis
      // blip mid-enqueue leaves these rows QUEUED with no backing job, stuck forever.
      await this.prisma.campaignMessage.updateMany({
        where: { id: { in: failedCampaignMessageIds } },
        data: { status: MsgStatus.FAILED },
      });
      this.log.error(
        `generateCampaign: ${failedCampaignMessageIds.length} message(s) failed to enqueue for campaign ${campaignId} — marked FAILED so a re-run will retry them.`,
      );
    }

    const enqueuedCount = messageRows.length - failedCampaignMessageIds.length;
    this.log.log(
      `generateCampaign: enqueued ${enqueuedCount} message(s) across ${sessions.length} sessions for campaign ${campaignId}` +
        (failedCampaignMessageIds.length ? ` (${failedCampaignMessageIds.length} failed to enqueue)` : ''),
    );
  }

  // ── generate-templates (UI helper — no contacts required) ────────────────

  async generateTemplates(dto: GenerateTemplatesDto): Promise<{ messages: string[] }> {
    const userPrompt =
      `Product: ${dto.brief}\n` +
      `Target audience: ${dto.audience}\n` +
      `Tone: ${dto.tone}\n` +
      `Generate exactly ${dto.count} unique message templates.`;

    const raw = await this.callProvider(GENERATE_SYSTEM, userPrompt);
    const parsed = this.parseJson<{ templates: unknown }>(raw);

    if (!Array.isArray(parsed.templates)) {
      throw new InternalServerErrorException('LLM returned malformed templates array');
    }
    return { messages: (parsed.templates as unknown[]).map((t) => String(t)) };
  }

  // ── analyze-reply ─────────────────────────────────────────────────────────

  async analyzeReply(dto: AnalyzeReplyDto): Promise<ReplyAnalysis> {
    const raw = await this.callProvider(ANALYZE_SYSTEM, dto.text);
    const parsed = this.parseJson<{ sentiment: unknown; intent: unknown; score: unknown; action: unknown }>(raw);

    const analysis = this.validateAnalysis(parsed);
    await this.persistAnalysis(dto, analysis);
    return analysis;
  }

  private validateAnalysis(parsed: {
    sentiment: unknown;
    intent: unknown;
    score: unknown;
    action: unknown;
  }): ReplyAnalysis {
    const SENTIMENTS: Sentiment[] = ['HOT', 'WARM', 'COLD', 'NEGATIVE'];
    const INTENTS: ReplyIntent[] = ['BUYING', 'QUESTION', 'OBJECTION', 'OPT_OUT'];

    const sentiment = parsed.sentiment as string;
    const intent = parsed.intent as string;
    const score = Number(parsed.score);
    const action = String(parsed.action ?? '');

    if (!SENTIMENTS.includes(sentiment as Sentiment)) {
      throw new InternalServerErrorException(`Invalid sentiment: ${sentiment}`);
    }
    if (!INTENTS.includes(intent as ReplyIntent)) {
      throw new InternalServerErrorException(`Invalid intent: ${intent}`);
    }
    if (Number.isNaN(score) || score < 0 || score > 1) {
      throw new InternalServerErrorException(`Invalid score: ${String(parsed.score)}`);
    }

    return {
      sentiment: sentiment as Sentiment,
      intent: intent as ReplyIntent,
      score,
      action,
    };
  }

  private async persistAnalysis(dto: AnalyzeReplyDto, analysis: ReplyAnalysis): Promise<void> {
    const existing = await this.prisma.reply.findFirst({
      where: { contactId: dto.contactId, text: dto.text },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      await this.prisma.reply.update({
        where: { id: existing.id },
        data: { sentiment: analysis.sentiment, intent: analysis.intent, score: analysis.score },
      });
    } else {
      await this.prisma.reply.create({
        data: {
          contactId: dto.contactId,
          campaignId: dto.campaignId,
          text: dto.text,
          sentiment: analysis.sentiment,
          intent: analysis.intent,
          score: analysis.score,
        },
      });
    }
  }

  // ── optimize ──────────────────────────────────────────────────────────────

  async optimize(dto: OptimizeDto): Promise<OptimizeResult> {
    const messages = await this.prisma.campaignMessage.findMany({
      where: { campaignId: dto.campaignId },
      select: { renderedText: true, status: true },
    });

    // Group by exact renderedText
    const map = new Map<string, { sent: number; replied: number }>();
    for (const m of messages) {
      const key = m.renderedText;
      const existing = map.get(key) ?? { sent: 0, replied: 0 };
      const SENT_STATUSES: MsgStatus[] = [
        MsgStatus.SENT,
        MsgStatus.DELIVERED,
        MsgStatus.READ,
        MsgStatus.REPLIED,
      ];
      const wasSent = SENT_STATUSES.includes(m.status);
      existing.sent += wasSent ? 1 : 0;
      existing.replied += m.status === MsgStatus.REPLIED ? 1 : 0;
      map.set(key, existing);
    }

    const variants: VariantStat[] = Array.from(map.entries()).map(([text, stats]) => ({
      text,
      sentCount: stats.sent,
      repliedCount: stats.replied,
      replyRate: stats.sent > 0 ? stats.replied / stats.sent : 0,
      weight: 0, // computed below
    }));

    variants.sort((a, b) => b.replyRate - a.replyRate);
    this.applySoftmaxWeights(variants);

    return { campaignId: dto.campaignId, variants };
  }

  private applySoftmaxWeights(variants: VariantStat[]): void {
    if (!variants.length) return;
    const exps = variants.map((v) => Math.exp(v.replyRate));
    const sum = exps.reduce((a, b) => a + b, 0);
    variants.forEach((v, i) => {
      v.weight = sum > 0 ? (exps[i] ?? 0) / sum : 1 / variants.length;
    });
  }

  // ── shared JSON parser ────────────────────────────────────────────────────

  private parseJson<T>(raw: string): T {
    // 1. Strip markdown code fences at start/end (most common wrapping pattern)
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    try {
      return JSON.parse(stripped) as T;
    } catch {
      // 2. LLM wrapped JSON in prose — extract the first complete {...} block
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]) as T;
        } catch {
          // fall through to error below
        }
      }
      this.log.error(`LLM returned non-JSON: ${raw.slice(0, 200)}`);
      throw new InternalServerErrorException('AI provider returned non-JSON response');
    }
  }
}
