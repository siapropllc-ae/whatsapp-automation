/** A single interactive button attached to a message Template. */
export type ButtonType = 'QUICK_REPLY' | 'URL' | 'CALL';

export interface ButtonDef {
  /** Stable id — also used as Meta's quick-reply payload and Reply.buttonId. */
  id: string;
  type: ButtonType;
  /** Display text, max 20 chars (Meta's real button-text limit). */
  label: string;
  /** Required iff type === 'URL'. */
  url?: string;
  /** Required iff type === 'CALL', E.164 format. */
  phoneNumber?: string;
}
