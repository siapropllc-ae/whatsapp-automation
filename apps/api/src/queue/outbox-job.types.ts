import { MediaType, SessionMode } from '@prisma/client';
import type { ButtonDef } from '@wa-engine/shared';

export interface OutboxJob {
  campaignMessageId: string;
  campaignId: string;
  contactId: string;
  sessionId: string;
  phone: string;
  renderedText: string;
  /** Present for CLOUD_API mode: the approved Meta template name. */
  templateName?: string;
  activeFrom: number;
  activeTo: number;
  mode: SessionMode;
  /** Campaign media attachment — public URL served by GET /media/:filename. */
  mediaUrl?: string;
  mediaType?: MediaType;
  /** Required for Baileys document sends; unused by Cloud API (link-based header). */
  mediaMimeType?: string;
  mediaFilename?: string;
  /** From the template's Template.buttons, if any — see CampaignsService.launch(). */
  buttons?: ButtonDef[];
}

export interface DlqJob {
  originalJob: OutboxJob;
  error: string;
  failedAt: string;
}
