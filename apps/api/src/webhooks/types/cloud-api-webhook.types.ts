export interface MetaStatusUpdate {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: Array<{ code: number; title: string; details?: string }>;
}

export interface MetaInboundMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  /** Tapped quick-reply template button (type === 'button'). */
  button?: { payload: string; text: string };
  /** Tapped session-interactive button (type === 'interactive'). */
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
  };
}

export interface MetaContact {
  profile: { name: string };
  wa_id: string;
}

export interface MetaWebhookValue {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  statuses?: MetaStatusUpdate[];
  messages?: MetaInboundMessage[];
  contacts?: MetaContact[];
}

/**
 * WABA-level ban/restriction signal — the `account_update` webhook field. This is the
 * only early-warning signal Cloud API mode gets that a WABA is at risk of/has been
 * disabled; there is no equivalent of Baileys' disconnect-code ban detection here since
 * Cloud API has no persistent connection to drop.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update/
 */
export interface MetaAccountUpdateValue {
  event: 'DISABLED_UPDATE' | 'ACCOUNT_VIOLATION' | 'ACCOUNT_RESTRICTION' | string;
  ban_info?: { waba_ban_state: 'DISABLE' | 'REINSTATE' | 'SCHEDULE_FOR_DISABLE' | string; waba_ban_date?: string };
  violation_info?: { violation_type: string };
  restriction_info?: Array<{ restriction_type: string; expiration?: string }>;
}

/**
 * WABA approval-review outcome — the `account_review_update` webhook field.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_review_update/
 */
export interface MetaAccountReviewUpdateValue {
  decision: 'APPROVED' | 'REJECTED' | 'PENDING' | 'DEFERRED' | string;
}

/**
 * Per-number quality/throughput tier change — the `phone_number_quality_update` field.
 * A drop from a higher tier to a lower one (or to TIER_NOT_SET) signals a quality
 * demotion, which precedes many real-world number restrictions.
 * https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/phone_number_quality_update/
 */
export interface MetaPhoneNumberQualityUpdateValue {
  display_phone_number: string;
  event: string;
  old_limit?: string;
  current_limit: 'TIER_50' | 'TIER_250' | 'TIER_2K' | 'TIER_10K' | 'TIER_100K' | 'TIER_UNLIMITED' | 'TIER_NOT_SET' | string;
  max_daily_conversations_per_business?: string;
}

// Not a discriminated union: `field` is an open string (Meta adds new webhook fields over
// time), so a fallback `{ field: string; ... }` variant would make TS narrowing on the
// known literals collapse `value` back to `unknown` anyway. Each field's real shape is
// documented above; callers cast `value` to the matching type per `field` in a switch.
export interface MetaWebhookChange {
  value: unknown;
  field: string;
}

export interface MetaWebhookEntry {
  id: string;
  changes: MetaWebhookChange[];
}

export interface MetaWebhookPayload {
  object: string;
  entry: MetaWebhookEntry[];
}
