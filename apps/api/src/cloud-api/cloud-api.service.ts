import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ButtonDef } from '@wa-engine/shared';

export interface TemplateParameter {
  type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video' | 'payload';
  text?: string;
  image?: { link: string };
  document?: { link: string; filename?: string };
  video?: { link: string };
  payload?: string;
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: string;
  index?: string;
  parameters?: TemplateParameter[];
}

export interface HeaderMedia {
  type: 'IMAGE' | 'DOCUMENT' | 'VIDEO';
  url: string;
  filename?: string;
}

export interface SendTemplateOptions {
  to: string;
  templateName: string;
  languageCode?: string;
  components?: TemplateComponent[];
  phoneNumberId?: string;
  /**
   * Fills the template's pre-approved media header slot with this link.
   * Only works if `templateName` was approved in Meta Business Manager with a
   * matching header type (image/document/video) — otherwise Meta rejects the send.
   */
  headerMedia?: HeaderMedia;
  /**
   * Quick-reply/URL/Call buttons. Only meaningful if `templateName` was approved in
   * Meta Business Manager with a matching button structure — see buildButtonComponents.
   */
  buttons?: ButtonDef[];
}

export interface SendTemplateResult {
  wamid: string;
  dryRun: boolean;
}

@Injectable()
export class CloudApiService {
  private static readonly GRAPH_VERSION = 'v21.0';
  private readonly log = new Logger(CloudApiService.name);
  private readonly accessToken: string;
  private readonly defaultPhoneNumberId: string;
  private readonly isDryRun: boolean;
  private readonly defaultLanguageCode: string;

  constructor(config: ConfigService) {
    this.accessToken = config.get<string>('META_ACCESS_TOKEN') ?? '';
    this.defaultPhoneNumberId = config.get<string>('META_PHONE_NUMBER_ID') ?? '';
    this.isDryRun = config.get<string>('DRY_RUN') === 'true';
    this.defaultLanguageCode = config.get<string>('META_DEFAULT_TEMPLATE_LANGUAGE') ?? 'en_US';
  }

  async sendTemplate(opts: SendTemplateOptions): Promise<SendTemplateResult> {
    const phoneNumberId = opts.phoneNumberId ?? this.defaultPhoneNumberId;
    const components =
      opts.components ??
      [
        ...(this.buildHeaderMediaComponents(opts.headerMedia) ?? []),
        ...this.buildButtonComponents(opts.buttons),
      ];

    if (this.isDryRun) {
      const wamid = `dry_wamid_${Date.now()}`;
      this.log.log(
        `[DRY_RUN] sendTemplate to=${opts.to} template=${opts.templateName} phoneNumberId=${phoneNumberId}` +
          `${opts.headerMedia ? ` [+${opts.headerMedia.type}]` : ''} => ${wamid}`,
      );
      return { wamid, dryRun: true };
    }

    if (!this.accessToken) {
      throw new Error('META_ACCESS_TOKEN not configured — set it in .env to use Cloud API mode');
    }

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: opts.to,
      type: 'template',
      template: {
        name: opts.templateName,
        language: { code: opts.languageCode ?? this.defaultLanguageCode },
        ...(components?.length ? { components } : {}),
      },
    };

    const url = `https://graph.facebook.com/${CloudApiService.GRAPH_VERSION}/${phoneNumberId}/messages`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Meta Graph API ${res.status}: ${body}`);
    }

    const json = (await res.json()) as { messages?: Array<{ id: string }> };
    const wamid = json.messages?.[0]?.id;
    if (!wamid) {
      throw new Error(`Meta Cloud API returned no message id: ${JSON.stringify(json)}`);
    }

    this.log.log(`sendTemplate to=${opts.to} template=${opts.templateName} => wamid=${wamid}`);
    return { wamid, dryRun: false };
  }

  private buildHeaderMediaComponents(headerMedia?: HeaderMedia): TemplateComponent[] | undefined {
    if (!headerMedia) return undefined;

    const parameter: TemplateParameter =
      headerMedia.type === 'DOCUMENT'
        ? { type: 'document', document: { link: headerMedia.url, filename: headerMedia.filename } }
        : headerMedia.type === 'VIDEO'
          ? { type: 'video', video: { link: headerMedia.url } }
          : { type: 'image', image: { link: headerMedia.url } };

    return [{ type: 'header', parameters: [parameter] }];
  }

  /**
   * Builds Meta's `components` entries for buttons. Only QUICK_REPLY buttons need an
   * entry (the button's `payload` — echoed back on the inbound webhook, wiring reply
   * capture to the button that produced it). URL/CALL buttons are static in the
   * approved template — nothing dynamic to send, so no components entry at all.
   * Dynamic URL-suffix support is an explicit non-goal for v1.
   */
  private buildButtonComponents(buttons?: ButtonDef[]): TemplateComponent[] {
    if (!buttons?.length) return [];
    return buttons
      .map((button, index): TemplateComponent | null => {
        if (button.type !== 'QUICK_REPLY') return null;
        return {
          type: 'button',
          sub_type: 'quick_reply',
          index: String(index),
          parameters: [{ type: 'payload', payload: button.id }],
        };
      })
      .filter((c): c is TemplateComponent => c !== null);
  }
}
