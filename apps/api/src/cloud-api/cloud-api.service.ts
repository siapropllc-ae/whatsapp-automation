import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ButtonDef, CarouselCardDef } from '@wa-engine/shared';
import { MediaService } from '../media/media.service';

export interface TemplateParameter {
  type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video' | 'payload';
  text?: string;
  image?: { link?: string; id?: string };
  document?: { link: string; filename?: string };
  video?: { link?: string; id?: string };
  payload?: string;
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button' | 'carousel';
  sub_type?: string;
  index?: string;
  parameters?: TemplateParameter[];
  /** carousel component only. */
  cards?: CarouselCardComponent[];
}

export interface CarouselCardComponent {
  card_index: number;
  components: TemplateComponent[];
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
  /**
   * Carousel cards — mutually exclusive with headerMedia/buttons above. `assetIds` must be
   * pre-uploaded via uploadMediaAsset() (once per card per campaign launch, not per contact)
   * and index-aligned with `cards`. Only meaningful if `templateName` was approved in Meta
   * Business Manager as a CAROUSEL template with a matching card/button structure.
   */
  carousel?: { cards: CarouselCardDef[]; assetIds: string[] };
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

  constructor(
    config: ConfigService,
    private readonly media: MediaService,
  ) {
    this.accessToken = config.get<string>('META_ACCESS_TOKEN') ?? '';
    this.defaultPhoneNumberId = config.get<string>('META_PHONE_NUMBER_ID') ?? '';
    this.isDryRun = config.get<string>('DRY_RUN') === 'true';
    this.defaultLanguageCode = config.get<string>('META_DEFAULT_TEMPLATE_LANGUAGE') ?? 'en_US';
  }

  async sendTemplate(opts: SendTemplateOptions): Promise<SendTemplateResult> {
    const phoneNumberId = opts.phoneNumberId ?? this.defaultPhoneNumberId;
    const components =
      opts.components ??
      (opts.carousel
        ? this.buildCarouselComponents(opts.carousel.cards, opts.carousel.assetIds)
        : [
            ...(this.buildHeaderMediaComponents(opts.headerMedia) ?? []),
            ...this.buildButtonComponents(opts.buttons),
          ]);

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

  /**
   * Uploads a locally-hosted media file to Meta's `/media` endpoint, returning the
   * asset id carousel header components require (`{image:{id}}` — unlike single-card
   * headers, which accept a plain `{image:{link}}` and need no upload at all). Call
   * this ONCE per card per campaign launch, not per contact — the same card image is
   * identical across every recipient, and re-uploading per contact would waste Meta's
   * media-API rate limit on any campaign over a few hundred contacts.
   */
  async uploadMediaAsset(storedName: string, phoneNumberId?: string): Promise<string> {
    if (this.isDryRun) {
      const assetId = `dry_asset_${Date.now()}`;
      this.log.log(`[DRY_RUN] uploadMediaAsset storedName=${storedName} => ${assetId}`);
      return assetId;
    }

    if (!this.accessToken) {
      throw new Error('META_ACCESS_TOKEN not configured — set it in .env to use Cloud API mode');
    }

    const buffer = await this.media.readFile(storedName);
    const mimeType = this.media.mimeTypeForStoredName(storedName) ?? 'application/octet-stream';
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([Uint8Array.from(buffer)], { type: mimeType }), storedName);

    const url = `https://graph.facebook.com/${CloudApiService.GRAPH_VERSION}/${phoneNumberId ?? this.defaultPhoneNumberId}/media`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
    });

    if (!res.ok) {
      throw new Error(`Meta media upload ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { id?: string };
    if (!json.id) {
      throw new Error(`Meta media upload returned no asset id: ${JSON.stringify(json)}`);
    }

    this.log.log(`uploadMediaAsset storedName=${storedName} => id=${json.id}`);
    return json.id;
  }

  /**
   * Builds the `carousel` component for a Meta carousel template send. Each card's
   * header uses the pre-uploaded asset id (see uploadMediaAsset) rather than a link.
   * Unlike single-card mode, Meta's carousel buttons allow mixed types per card —
   * buildButtonComponents is reused unchanged (it already only emits entries for
   * QUICK_REPLY buttons; URL/CALL stay static-in-template either way).
   */
  private buildCarouselComponents(cards: CarouselCardDef[], assetIds: string[]): TemplateComponent[] {
    return [
      {
        type: 'carousel',
        cards: cards.map((card, i) => ({
          card_index: i,
          components: [
            {
              type: 'header',
              parameters: [
                card.mediaType === 'VIDEO'
                  ? { type: 'video', video: { id: assetIds[i] } }
                  : { type: 'image', image: { id: assetIds[i] } },
              ],
            },
            ...this.buildButtonComponents(card.buttons),
          ],
        })),
      },
    ];
  }
}
