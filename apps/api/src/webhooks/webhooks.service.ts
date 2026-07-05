import { Injectable, Logger } from '@nestjs/common';
import { MsgStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionsGateway } from '../sessions/sessions.gateway';
import type {
  MetaWebhookPayload,
  MetaStatusUpdate,
  MetaInboundMessage,
  MetaContact,
} from './types/cloud-api-webhook.types';

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
  ) {}

  async processCloudApiPayload(payload: MetaWebhookPayload): Promise<void> {
    if (payload.object !== 'whatsapp_business_account') return;

    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const { statuses, messages, contacts } = change.value;

        for (const status of statuses ?? []) {
          await this.handleStatusUpdate(status);
        }

        for (const message of messages ?? []) {
          await this.handleInboundMessage(message, contacts ?? []);
        }
      }
    }
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

    await this.prisma.reply.create({
      data: {
        contactId: contact.id,
        campaignId: lastMsg?.campaignId ?? null,
        text: body,
        buttonId,
        buttonLabel,
      },
    });

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
