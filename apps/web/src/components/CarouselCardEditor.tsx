import React, { useState } from 'react';
import { useToast } from '@/components/Toast';
import { ButtonListEditor } from '@/components/ButtonListEditor';
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
const IcPaperclip = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
  </svg>
);
const IcX = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

interface CarouselCardEditorProps {
  card: CarouselCardDef;
  index: number;
  onChange: (patch: Partial<CarouselCardDef>) => void;
  onRemove: () => void;
}

/** One card's editor within a carousel Template: image/video upload, body text, and
 * up to 2 buttons (mixed types allowed — Meta's carousel rule, unlike single-card mode). */
export function CarouselCardEditor({ card, index, onChange, onRemove }: CarouselCardEditorProps) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/media/upload', { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as { url: string; type: string; filename: string };
      onChange({ mediaUrl: data.url, mediaType: data.type === 'VIDEO' ? 'VIDEO' : 'IMAGE' });
    } catch (err) {
      toast(`Upload failed: ${String(err)}`, 'error');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  return (
    <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: 14, marginBottom: 10, background: 'rgba(255,255,255,0.015)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>Card {index + 1}</div>
        <button onClick={onRemove} style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.1)', borderRadius: 7, color: '#ef4444', cursor: 'pointer', width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IcTrash /></button>
      </div>

      <div style={{ marginBottom: 10 }}>
        <label style={labelStyle}>Image / Video</label>
        {card.mediaUrl ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(37,211,102,0.05)', border: '1px solid rgba(37,211,102,0.15)', borderRadius: 8, padding: '8px 10px' }}>
            {card.mediaType === 'VIDEO' ? (
              <div style={{ width: 36, height: 36, borderRadius: 6, background: 'rgba(37,211,102,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#25d366' }}><IcPaperclip /></div>
            ) : (
              <img src={card.mediaUrl} alt={`Card ${index + 1}`} style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
            )}
            <div style={{ flex: 1, fontSize: 11, color: 'var(--text-muted)' }}>{card.mediaType ?? 'IMAGE'} attached</div>
            <button onClick={() => onChange({ mediaUrl: '', mediaType: undefined })} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}><IcX /></button>
          </div>
        ) : (
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.1)', borderRadius: 8, cursor: uploading ? 'wait' : 'pointer', color: 'var(--text-muted)', fontSize: 12 }}>
            <IcPaperclip />
            {uploading ? 'Uploading…' : 'Attach image or video'}
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/3gpp" style={{ display: 'none' }} disabled={uploading} onChange={handleUpload} />
          </label>
        )}
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
