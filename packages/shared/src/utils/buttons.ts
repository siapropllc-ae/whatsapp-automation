import { isValidE164 } from './spin';
import type { ButtonDef } from '../types/button';

const MAX_LABEL_LENGTH = 20;
const MAX_BUTTONS_LENIENT = 3;
const MAX_QUICK_REPLY = 3;
const MAX_CTA = 2;

export type ButtonValidationMode = 'CLOUD_API' | 'BAILEYS' | 'ANY';

export interface ButtonValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a single button's own fields (id/label/url/phoneNumber), independent of
 * what other buttons are in the list or which mode they're being sent through. Shared
 * by validateButtons (flat single-card lists) and validateCarousel (per-card lists).
 */
export function validateSingleButton(button: ButtonDef): string[] {
  const errors: string[] = [];
  if (!button.id?.trim()) errors.push('Every button needs an id.');
  if (!button.label?.trim()) errors.push('Every button needs a label.');
  if (button.label && button.label.length > MAX_LABEL_LENGTH) {
    errors.push(`Button label "${button.label}" exceeds ${MAX_LABEL_LENGTH} characters.`);
  }
  if (button.type === 'URL' && !button.url?.trim()) {
    errors.push(`URL button "${button.label}" is missing a url.`);
  }
  if (button.type === 'CALL' && !isValidE164(button.phoneNumber ?? '')) {
    errors.push(`Call button "${button.label}" needs a valid E.164 phone number.`);
  }
  if (button.type === 'QUICK_REPLY' && (button.url || button.phoneNumber)) {
    errors.push(`Quick-reply button "${button.label}" must not have a url/phoneNumber.`);
  }
  return errors;
}

/**
 * Validates a button list against WhatsApp's real structural rules.
 *
 * Meta's Cloud API templates allow EITHER up to 3 quick-reply buttons OR up to
 * 2 URL/Call buttons — never a mix of both — because that's what Meta accepts
 * when a template is submitted for approval. Baileys buttons are our own
 * construction (not Meta-template-bound), so only a lenient cap applies.
 */
export function validateButtons(
  buttons: ButtonDef[],
  mode: ButtonValidationMode,
): ButtonValidationResult {
  const errors: string[] = buttons.flatMap(validateSingleButton);

  if (mode === 'CLOUD_API') {
    const quickReplyCount = buttons.filter((b) => b.type === 'QUICK_REPLY').length;
    const ctaCount = buttons.filter((b) => b.type === 'URL' || b.type === 'CALL').length;
    if (quickReplyCount > 0 && ctaCount > 0) {
      errors.push('Cloud API templates cannot mix quick-reply and URL/Call buttons.');
    }
    if (quickReplyCount > MAX_QUICK_REPLY) {
      errors.push(`Cloud API allows at most ${MAX_QUICK_REPLY} quick-reply buttons.`);
    }
    if (ctaCount > MAX_CTA) {
      errors.push(`Cloud API allows at most ${MAX_CTA} URL/Call buttons.`);
    }
  } else {
    // BAILEYS and ANY: lenient — just cap the total.
    if (buttons.length > MAX_BUTTONS_LENIENT) {
      errors.push(`At most ${MAX_BUTTONS_LENIENT} buttons are allowed.`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Safely parses a Prisma `Json` value (e.g. Template.buttons) as a ButtonDef[],
 * never throwing on malformed/absent data — returns undefined instead so callers
 * can log a warning and continue without buttons rather than crash.
 */
export function parseButtonDefs(json: unknown): ButtonDef[] | undefined {
  if (!Array.isArray(json) || json.length === 0) return undefined;
  const isButtonDef = (v: unknown): v is ButtonDef =>
    typeof v === 'object' && v !== null && 'id' in v && 'type' in v && 'label' in v;
  return json.every(isButtonDef) ? (json as ButtonDef[]) : undefined;
}
