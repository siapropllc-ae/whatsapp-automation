import React from 'react';
import { ButtonListEditor } from '@/components/ButtonListEditor';
import { MediaDropzone } from '@/components/MediaDropzone';
import type { CarouselCardDef } from '@/types/api';

const MAX_BUTTONS_PER_CARD = 2;

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.8px', textTransform: 'uppercase' };
const inputStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };

const IcTrash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6" /><path d="M14 11v6" />
  </svg>
);
const IcGrip = () => (
  <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor">
    <circle cx="3" cy="2.5" r="1.4" /><circle cx="9" cy="2.5" r="1.4" />
    <circle cx="3" cy="8" r="1.4" /><circle cx="9" cy="8" r="1.4" />
    <circle cx="3" cy="13.5" r="1.4" /><circle cx="9" cy="13.5" r="1.4" />
  </svg>
);

interface CarouselCardEditorProps {
  card: CarouselCardDef;
  index: number;
  onChange: (patch: Partial<CarouselCardDef>) => void;
  onRemove: () => void;
  /** Drag events wired up by the parent list (which owns reorder state) — only this
   * handle initiates a drag, never the card body, so text inputs/textareas inside the
   * card keep normal text-selection behavior. */
  dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
}

/** One card's editor within a carousel Template: image/video upload, body text, and
 * up to 2 buttons (mixed types allowed — Meta's carousel rule, unlike single-card mode). */
export function CarouselCardEditor({ card, index, onChange, onRemove, dragHandleProps }: CarouselCardEditorProps) {
  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: 14, marginBottom: 10, background: 'rgba(255,255,255,0.015)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {dragHandleProps && (
            <span {...dragHandleProps} style={{ cursor: 'grab', color: 'var(--text-muted)', display: 'flex', ...dragHandleProps.style }} title="Drag to reorder">
              <IcGrip />
            </span>
          )}
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>Card {index + 1}</div>
        </div>
        <button onClick={onRemove} style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.1)', borderRadius: 7, color: '#ef4444', cursor: 'pointer', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IcTrash /></button>
      </div>

      <div style={{ marginBottom: 10 }}>
        <MediaDropzone
          value={card.mediaUrl ? { url: card.mediaUrl, type: card.mediaType } : null}
          onChange={(media) => onChange({ mediaUrl: media?.url ?? '', mediaType: media?.type === 'VIDEO' ? 'VIDEO' : media ? 'IMAGE' : undefined })}
          allowDocument={false}
          compact
          label="Image / Video"
        />
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Card body</label>
        <textarea value={card.body} onChange={(e) => onChange({ body: e.target.value })} rows={2} placeholder="Card text..." style={{ ...inputStyle, height: 'auto', resize: 'vertical' as const, fontSize: 12 }} />
      </div>

      <ButtonListEditor
        buttons={card.buttons}
        onChange={(buttons) => onChange({ buttons })}
        maxButtons={MAX_BUTTONS_PER_CARD}
        showCloudApiWarning={false}
      />
    </div>
  );
}
