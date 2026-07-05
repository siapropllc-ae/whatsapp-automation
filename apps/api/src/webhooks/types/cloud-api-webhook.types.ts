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

export interface MetaWebhookChange {
  value: MetaWebhookValue;
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
