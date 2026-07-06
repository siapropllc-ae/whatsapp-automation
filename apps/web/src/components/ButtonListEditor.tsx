import React from 'react';
import { validateButtons } from '@wa-engine/shared';
import type { ButtonDef, ButtonType } from '@/types/api';

const BUTTON_TYPES: { value: ButtonType; label: string }[] = [
  { value: 'QUICK_REPLY', label: 'Quick Reply' },
  { value: 'URL', label: 'Link' },
  { value: 'CALL', label: 'Call' },
];

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.8px', textTransform: 'uppercase' };
const inputStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };

const IcTrash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" /><path d="M14 11v6" />
  </svg>
);
const IcPlus = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

interface ButtonListEditorProps {
  buttons: ButtonDef[];
  onChange: (buttons: ButtonDef[]) => void;
  maxButtons: number;
  /** Single-card mode enforces Meta's strict quick-reply-XOR-url/call rule — carousel
   * cards don't (Meta explicitly allows mixed types per card), so callers editing a
   * carousel card should pass false here. */
  showCloudApiWarning?: boolean;
}

/** Reusable button-row editor — used both by the single-card Templates editor and
 * each carousel card's per-card button editor. */
export function ButtonListEditor({ buttons, onChange, maxButtons, showCloudApiWarning }: ButtonListEditorProps) {
  const addButton = () => {
    if (buttons.length >= maxButtons) return;
    onChange([...buttons, { id: crypto.randomUUID(), type: 'QUICK_REPLY', label: '' }]);
  };
  const updateButton = (index: number, patch: Partial<ButtonDef>) => {
    onChange(buttons.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  };
  const removeButton = (index: number) => {
    onChange(buttons.filter((_, i) => i !== index));
  };
  const cloudApiCheck = showCloudApiWarning ? validateButtons(buttons, 'CLOUD_API') : null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <label style={{ ...labelStyle, marginBottom: 0 }}>Buttons (optional)</label>
        <button
          onClick={addButton}
          disabled={buttons.length >= maxButtons}
          style={{ background: 'rgba(37,211,102,0.1)', border: '1px solid rgba(37,211,102,0.2)', borderRadius: 6, color: '#25d366', cursor: buttons.length >= maxButtons ? 'not-allowed' : 'pointer', opacity: buttons.length >= maxButtons ? 0.4 : 1, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          title="Add button"
        >
          <IcPlus />
        </button>
      </div>
      {buttons.map((b, i) => (
        <div key={b.id} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
          <select value={b.type} onChange={(e) => updateButton(i, { type: e.target.value as ButtonType, url: undefined, phoneNumber: undefined })} style={{ ...inputStyle, width: 110, flexShrink: 0, fontSize: 11, padding: '8px 8px' }}>
            {BUTTON_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <input value={b.label} onChange={(e) => updateButton(i, { label: e.target.value })} placeholder="Label" maxLength={20} style={{ ...inputStyle, fontSize: 12, padding: '8px 10px' }} />
          {b.type === 'URL' && (
            <input value={b.url ?? ''} onChange={(e) => updateButton(i, { url: e.target.value })} placeholder="https://..." style={{ ...inputStyle, fontSize: 12, padding: '8px 10px' }} />
          )}
          {b.type === 'CALL' && (
            <input value={b.phoneNumber ?? ''} onChange={(e) => updateButton(i, { phoneNumber: e.target.value })} placeholder="+1..." style={{ ...inputStyle, fontSize: 12, padding: '8px 10px' }} />
          )}
          <button onClick={() => removeButton(i)} style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.1)', borderRadius: 7, color: '#ef4444', cursor: 'pointer', width: 28, height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IcTrash /></button>
        </div>
      ))}
      {showCloudApiWarning && !!buttons.length && cloudApiCheck && !cloudApiCheck.valid && (
        <div style={{ fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: 8, padding: '8px 10px', marginTop: 6, lineHeight: 1.5 }}>
          ⚠ Not valid for a Meta-approved Cloud API template: {cloudApiCheck.errors.join(' ')} Fine for Baileys.
        </div>
      )}
    </div>
  );
}
