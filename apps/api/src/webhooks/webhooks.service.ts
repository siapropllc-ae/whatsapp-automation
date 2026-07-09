import { Injectable, Logger } from '@nestjs/common';
import { type Session, MsgStatus, SessionMode, SessionStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionsGateway } from '../sessions/sessions.gateway';
import { SessionsService } from '../sessions/sessions.service';
import type {
  MetaWebhookPayload,
  MetaWebhookEntry,
  MetaWebhookValue,
  MetaStatusUpdate,
  MetaInboundMessage,
  MetaContact,
  MetaAccountUpdateValue,
  MetaAccountReviewUpdateValue,
  MetaPhoneNumberQualityUpdateValue,
} from './types/cloud-api-webhook.types';

// Lowest to highest — used to detect a quality-tier demotion (current < old).
const QUALITY_TIER_RANK: Record<string, number> = {
  TIER_NOT_SET: 0,
  TIER_50: 1,
  TIER_250: 2,
  TIER_2K: 3,
  TIER_10K: 4,
  TIER_100K: 5,
  TIER_UNLIMITED: 6,
};

const STATUS_MAP: Record<string, MsgStatus | undefined> = {
  sent: MsgStatus.SENT,
  delivered: MsgStatus.DELIVERED,
  read: MsgStatus.READ,
  failed: MsgStatus.FAILED,
};

// Rank order: only update if the new status is a promotion (prevents out-of-order event downgrade).
// FAILED is rank 1 — it can only overwrite QUEUED, never SENT/DELIVERED/READ/REPLIED.
// This prevents a late "failed" webhook from Meta downgrading a message the customer already replied to.
const STATUS_RANK: Record<MsgStatus, number> = {
  [MsgStatus.QUEUED]: 0,
  [MsgStatus.FAILED]: 1,
  [MsgStatus.SENT]: 2,
  [MsgStatus.DELIVERED]: 3,
  [MsgStatus.READ]: 4,
  [MsgStatus.REPLIED]: 5,
};
const STATUSES_BELOW = (rank: number): MsgStatus[] =>
  (Object.keys(STATUS_RANK) as MsgStatus[]).filter((s) => STATUS_RANK[s] < rank);

@Injectable()
export class WebhooksService {
  private readonly log = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: SessionsGateway,
    private readonly sessions: SessionsService,
  ) {}

  async processCloudApiPayload(payload: MetaWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') return;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        switch (change.field) {
          case 'messages': {
            const { statuses, messages, contacts } = change.value as MetaWebhookValue;
            for (const status of statuses ?? []) {
              await this.handleStatusUpdate(status);
            }
            for (const message of messages ?? []) {
              await this.handleInboundMessage(message, contacts ?? []);
            }
            break;
          }
          case 'account_update':
            await this.handleAccountUpdate(entry, change.value as MetaAccountUpdateValue);
            break;
          case 'account_review_update':
            await this.handleAccountReviewUpdate(entry, change.value as MetaAccountReviewUpdateValue);
            break;
          case 'phone_number_quality_update':
            await this.handlePhoneNumberQualityUpdate(change.value as MetaPhoneNumberQualityUpdateValue);
            break;
          default:
            // Previously silently dropped — at minimum, surface that Meta sent something
            // this integration doesn't yet understand, so a real gap doesn't go unnoticed.
            this.log.debug(`Unhandled Cloud API webhook field=${change.field}`);
        }
      }
    }
  }

  /**
   * Finds the CLOUD_API sessions belonging to a given WhatsApp Business Account. Filters
   * in-memory rather than via a Prisma JSON-path query — the CLOUD_API session count is
   * always small, and this avoids depending on Postgres-specific JSON query syntax for
   * a field (`Session.cloudApi`) with no dedicated index.
   */
  private async findSessionsForWaba(wabaId: string): Promise<Session[]> {
    const sessions = await this.prisma.session.findMany({ where: { mode: SessionMode.CLOUD_API } });
    return sessions.filter((s) => (s.cloudApi as { wabaId?: string } | null)?.wabaId === wabaId);
  }

  /**
   * account_update is the only ban/restriction signal Cloud API mode gets — there is no
   * persistent connection to drop the way Baileys detects a ban via disconnect codes.
   * DISABLED_UPDATE + waba_ban_state=DISABLE means the WABA can no longer send at all;
   * ACCOUNT_RESTRICTION is less severe but still a reason to stop sending automatically
   * rather than grind out failures against a flagged account.
   */
  private async handleAccountUpdate(entry: MetaWebhookEntry, value: MetaAccountUpdateValue): Promise<void> {
    const affected = await this.findSessionsForWaba(entry.id);
    if (!affected.length) {
      this.log.warn(`account_update event=${value.event} for unknown WABA=${entry.id}`);
      return;
    }

    const isDisabled = value.event === 'DISABLED_UPDATE' && value.ban_info?.waba_ban_state === 'DISABLE';
    const isRestricted = value.event === 'ACCOUNT_RESTRICTION';
    if (!isDisabled && !isRestricted) {
      this.log.warn(`account_update event=${value.event} for WABA=${entry.id} — no action taken (not a ban/restriction signal)`);
      return;
    }

    for (const session of affected) {
      if (isDisabled) {
        this.log.error(
          `[${session.id}] Cloud API WABA DISABLED (ban_info.waba_ban_state=DISABLE) — marking BANNED and pausing its campaigns.`,
        );
        await this.prisma.session.update({ where: { id: session.id }, data: { status: SessionStatus.BANNED } });
        this.gateway.emitStatus(session.id, SessionStatus.BANNED);
      } else {
        this.log.warn(`[${session.id}] Cloud API account restricted (${value.restriction_info?.map((r) => r.restriction_type).join(',') ?? 'unknown'}) — pausing its campaigns.`);
      }
      await this.sessions.pauseCampaignsForSession(session.id);
    }
  }

  /** WABA approval outcome — REJECTED means the account can never send, ever. */
  private async handleAccountReviewUpdate(entry: MetaWebhookEntry, value: MetaAccountReviewUpdateValue): Promise<void> {
    if (value.decision !== 'REJECTED') return;
    const affected = await this.findSessionsForWaba(entry.id);
    for (const session of affected) {
      this.log.error(`[${session.id}] Cloud API WABA review REJECTED — pausing its campaigns.`);
      await this.sessions.pauseCampaignsForSession(session.id);
    }
  }

  /**
   * A quality-tier demotion (or drop to TIER_NOT_SET) commonly precedes a full number
   * restriction. Not paused automatically — a demotion still allows sending, just at a
   * lower throughput — but logged loudly so an operator can react before it escalates.
   */
  private async handlePhoneNumberQualityUpdate(value: MetaPhoneNumberQualityUpdateValue): Promise<void> {
    const oldRank = value.old_limit ? QUALITY_TIER_RANK[value.old_limit] : undefined;
    const currentRank = QUALITY_TIER_RANK[value.current_limit];
    const isDemotion = oldRank !== undefined && currentRank !== undefined && currentRank < oldRank;
    if (!isDemotion) {
      this.log.debug(`phone_number_quality_update ${value.display_phone_number}: ${value.old_limit ?? '?'} → ${value.current_limit}`);
      return;
    }
    this.log.warn(
      `Quality-tier DEMOTION for ${value.display_phone_number}: ${value.old_limit} → ${value.current_limit} — number is at elevated risk of restriction.`,
    );
  }

  private async handleStatusUpdate(status: MetaStatusUpdate): Promise<void> {
    const msgStatus = STATUS_MAP[status.status];
    if (!msgStatus) return;

    // Only promote — never downgrade (guards against out-of-order Meta delivery events)
    const rank = STATUS_RANK[msgStatus];
    const updated = await this.prisma.campaignMessage.updateMany({
      where: { wamid: status.id, status: { in: STATUSES_BELOW(rank) } },
      data: { status: msgStatus },
    });

    if (updated.count === 0) {
      this.log.warn(`Status update for unknown wamid=${status.id} (${status.status})`);
      return;
    }

    this.log.log(`wamid=${status.id} → ${msgStatus}`);

    // Emit real-time campaign stats to the frontend after status changes
    const msg = await this.prisma.campaignMessage.findFirst({
      where: { wamid: status.id },
      select: { campaignId: true },
    });
    if (msg?.campaignId) {
      void this.emitCampaignStats(msg.campaignId);
    }
  }

  private async emitCampaignStats(campaignId: string): Promise<void> {
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
      // non-critical
    }
  }

  /**
   * Resolves the text/buttonId/buttonLabel for an inbound message, recognizing Meta's
   * two button-tap shapes before falling back to plain text. Both shapes carry the
   * button's display text directly on the webhook payload, so — unlike Baileys' plain-text
   * fallback matching — no lookup against the sent template is needed here.
   */
  private resolveInboundContent(
    message: MetaInboundMessage,
  ): { text: string; buttonId?: string; buttonLabel?: string } | null {
    if (message.type === 'button' && message.button) {
      return { text: message.button.text, buttonId: message.button.payload, buttonLabel: message.button.text };
    }
    if (message.type === 'interactive' && message.interactive?.button_reply) {
      const { id, title } = message.interactive.button_reply;
      return { text: title, buttonId: id, buttonLabel: title };
    }
    const body = message.text?.body;
    return body ? { text: body } : null;
  }

  private async handleInboundMessage(
    message: MetaInboundMessage,
    contacts: MetaContact[],
  ): Promise<void> {
    const resolved = this.resolveInboundContent(message);
    if (!resolved) return;
    const { text: body, buttonId, buttonLabel } = resolved;

    // Meta's webhook delivery is documented at-least-once — a redelivered notification for
    // a message already processed must not create a second Reply (inflates reply counts,
    // duplicates rows in the Replies UI). message.id is Meta's wamid for the inbound
    // message itself, globally unique, so it's a reliable dedup key.
    const existing = await this.prisma.reply.findUnique({ where: { waMessageId: message.id } });
    if (existing) {
      this.log.debug(`Duplicate inbound webhook for wamid=${message.id} — already processed, skipping`);
      return;
    }

    // Meta sends `from` without '+' prefix (e.g. "15551234567").
    // Contacts are stored in E.164 format with '+', so we normalise here.
    const rawPhone = message.from;
    const phone = rawPhone.startsWith('+') ? rawPhone : `+${rawPhone}`;
    const contact = await this.prisma.contact.findUnique({ where: { phone } });

    if (!contact) {
      this.log.warn(`Inbound from unknown phone=${phone}, skipping Reply creation`);
      return;
    }

    const lastMsg = await this.prisma.campaignMessage.findFirst({
      where: {
        contactId: contact.id,
        // Include REPLIED so a second reply from the same contact still correlates
        // to the campaign message (avoids campaignId: null on follow-up replies)
        status: { in: [MsgStatus.SENT, MsgStatus.DELIVERED, MsgStatus.READ, MsgStatus.REPLIED] },
      },
      orderBy: { sentAt: 'desc' },
    });

    try {
      await this.prisma.reply.create({
        data: {
          contactId: contact.id,
          campaignId: lastMsg?.campaignId ?? null,
          text: body,
          buttonId,
          buttonLabel,
          waMessageId: message.id,
        },
      });
    } catch (err: unknown) {
      // P2002 = unique constraint violation on waMessageId — a concurrent redelivery lost
      // the race against the findUnique check above and got here first. Same outcome as
      // the early-return above: already processed, nothing more to do.
      if ((err as { code?: string }).code === 'P2002') {
        this.log.debug(`Duplicate inbound webhook for wamid=${message.id} (race) — already processed, skipping`);
        return;
      }
      throw err;
    }

    if (lastMsg) {
      await this.prisma.campaignMessage.update({
        where: { id: lastMsg.id },
        data: { status: MsgStatus.REPLIED },
      });
    }

    // Auto-invalidate contacts who signal opt-out — prevents continued sending after STOP
    const lowerBody = body.toLowerCase();
    // Short keywords must match the WHOLE message — tokenising on word boundaries still
    // false-positives on "non-stop" (hyphen) and "bus stop" / "won't stop" (legit standalone word)
    const OPT_OUT_KEYWORDS = new Set(['stop', 'unsubscribe', 'optout']);
    // Multi-word phrases are unambiguous enough to match anywhere in the message
    const OPT_OUT_PHRASES = ['remove me', 'opt out', "don't message", 'dont message', 'stop messaging', 'no more messages'];
    const cleanedBody = lowerBody.trim().replace(/^[.,!?;:]+/, '').replace(/[.,!?;:]+$/, '');
    const isOptOut =
      OPT_OUT_KEYWORDS.has(cleanedBody) ||
      OPT_OUT_PHRASES.some((p) => lowerBody.includes(p));
    if (isOptOut) {
      await this.prisma.contact.update({ where: { id: contact.id }, data: { valid: false } });
      this.log.log(`OPT_OUT from ${phone} — contact marked invalid`);
    }

    // Emit real-time reply event to the frontend (mirrors Baileys handleInboundMessage)
    this.gateway.emitReply(contact.id, phone, body, lastMsg?.campaignId ?? null);

    // wa_id from Meta is also without '+', so compare against rawPhone
    const senderName = contacts.find((c) => c.wa_id === rawPhone)?.profile.name ?? phone;
    this.log.log(`Reply created: contact=${contact.id} from=${senderName}`);
  }
}
