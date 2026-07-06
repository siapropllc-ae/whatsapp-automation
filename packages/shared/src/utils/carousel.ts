import { validateSingleButton, type ButtonValidationMode, type ButtonValidationResult } from './buttons';
import type { CarouselCardDef } from '../types/carousel';

const MIN_CARDS = 2;
const MAX_CARDS = 10;
const MAX_BUTTONS_PER_CARD = 2;

/**
 * Validates a carousel's cards. Unlike validateButtons, this never enforces the
 * Cloud API quick-reply-XOR-url/call rule — Meta's carousel format explicitly
 * allows mixed button types per card. Only the per-card count cap applies.
 */
export function validateCarousel(
  cards: CarouselCardDef[],
  mode: ButtonValidationMode,
): ButtonValidationResult {
  void mode; // no mode-specific divergence today — carousel rules are the same across CLOUD_API/BAILEYS/ANY
  const errors: string[] = [];

  if (cards.length < MIN_CARDS || cards.length > MAX_CARDS) {
    errors.push(`A carousel needs between ${MIN_CARDS} and ${MAX_CARDS} cards.`);
  }

  cards.forEach((card, i) => {
    const n = i + 1;
    if (!card.mediaUrl?.trim()) errors.push(`Card ${n}: media is required.`);
    if (!card.body?.trim()) errors.push(`Card ${n}: body text is required.`);
    if (card.buttons.length > MAX_BUTTONS_PER_CARD) {
      errors.push(`Card ${n}: at most ${MAX_BUTTONS_PER_CARD} buttons are allowed.`);
    }
    for (const error of card.buttons.flatMap(validateSingleButton)) {
      errors.push(`Card ${n}: ${error}`);
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Safely parses a Prisma `Json` value (e.g. Template.carouselCards) as
 * CarouselCardDef[], never throwing on malformed/absent data.
 */
export function parseCarouselCards(json: unknown): CarouselCardDef[] | undefined {
  if (!Array.isArray(json) || json.length === 0) return undefined;
  const isCarouselCardDef = (v: unknown): v is CarouselCardDef =>
    typeof v === 'object' &&
    v !== null &&
    'id' in v &&
    'mediaUrl' in v &&
    'body' in v &&
    'buttons' in v &&
    Array.isArray((v as CarouselCardDef).buttons);
  return json.every(isCarouselCardDef) ? (json as CarouselCardDef[]) : undefined;
}
