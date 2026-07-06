import type { ButtonDef } from './button';

/** A single card in a carousel Template — image/video header + body + up to 2 buttons. */
export interface CarouselCardDef {
  /** Stable id (crypto.randomUUID()) for React keys/diffing — NOT sent to Meta (Meta uses card_index). */
  id: string;
  mediaUrl: string;
  /** Carousel headers only support image/video, never document. Defaults to IMAGE. */
  mediaType?: 'IMAGE' | 'VIDEO';
  /** Required non-empty — sidesteps Meta's "all cards must have body if any does" rule by always having it. */
  body: string;
  /** Max 2 per card (Meta's carousel limit); mixed types allowed, unlike single-card Cloud API mode. */
  buttons: ButtonDef[];
}
