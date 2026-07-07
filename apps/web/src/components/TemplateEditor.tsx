'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/Toast';
import { Button } from '@/components/Button';
import { MediaDropzone, type MediaValue } from '@/components/MediaDropzone';
import { ButtonListEditor } from '@/components/ButtonListEditor';
import { CarouselCardEditor } from '@/components/CarouselCardEditor';
import { ButtonPreview } from '@/components/ButtonPreview';
import { CarouselPreview } from '@/components/CarouselPreview';
import { SpinToolbar } from '@/components/SpinToolbar';
import { apiFetch } from '@/lib/api';
import { spinText, validateCarousel } from '@wa-engine/shared';
import type { Template, ButtonDef, CarouselCardDef } from '@/types/api';

const MAX_BUTTONS = 3;
const MIN_CARDS = 2;
const MAX_CARDS = 10;
const CATEGORIES = ['marketing', 'utility', 'auth', 'service'] as const;
type Category = (typeof CATEGORIES)[number];

function newCarouselCard(): CarouselCardDef {
  return { id: crypto.randomUUID(), mediaUrl: '', body: '', buttons: [] };
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.8px', textTransform: 'uppercase' };
const inputStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };

const IcArrowLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" />
  </svg>
);
const IcCheck2 = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><polyline points="20 6 9 17 4 12" /></svg>
);

interface TemplateEditorProps {
  mode: 'create' | 'edit';
  initial?: Template;
  prefillFromLibrary?: { name: string; body: string };
  onSaved: (template: Template) => void;
}

interface EditableFields {
  name: string;
  category: string;
  body: string;
  editorMode: 'SINGLE' | 'CAROUSEL';
  mediaUrl: string;
  buttons: ButtonDef[];
  carouselCards: CarouselCardDef[];
}

function snapshotOf(f: EditableFields): string {
  return JSON.stringify(f);
}

/** The shared template-editing workspace, rendered by both /templates/new and
 * /templates/[id]/edit. Split-panel layout: editing fields on the left, a sticky
 * WhatsApp-realistic live preview on the right. */
export function TemplateEditor({ mode, initial, prefillFromLibrary, onSaved }: TemplateEditorProps) {
  const router = useRouter();
  const { toast } = useToast();
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const [name, setName] = useState(initial?.name ?? prefillFromLibrary?.name ?? '');
  const [category, setCategory] = useState<Category>((initial?.category as Category) ?? 'marketing');
  const [body, setBody] = useState(initial?.body ?? prefillFromLibrary?.body ?? '');
  const [editorMode, setEditorMode] = useState<'SINGLE' | 'CAROUSEL'>(initial?.carouselCards?.length ? 'CAROUSEL' : 'SINGLE');
  const [media, setMedia] = useState<MediaValue | null>(initial?.mediaUrl ? { url: initial.mediaUrl } : null);
  const [buttons, setButtons] = useState<ButtonDef[]>(initial?.buttons ?? []);
  const [carouselCards, setCarouselCards] = useState<CarouselCardDef[]>(initial?.carouselCards ?? []);
  const [saving, setSaving] = useState(false);

  // Drag-to-reorder state for carousel cards — owned here (not CarouselCardEditor),
  // matching the existing ownership split where this component already owns add/remove.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const initialSnapshot = useMemo(
    () =>
      snapshotOf({
        name: initial?.name ?? prefillFromLibrary?.name ?? '',
        category: initial?.category ?? 'marketing',
        body: initial?.body ?? prefillFromLibrary?.body ?? '',
        editorMode: initial?.carouselCards?.length ? 'CAROUSEL' : 'SINGLE',
        mediaUrl: initial?.mediaUrl ?? '',
        buttons: initial?.buttons ?? [],
        carouselCards: initial?.carouselCards ?? [],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [initial?.id],
  );
  const snapshotRef = useRef(initialSnapshot);
  useEffect(() => { snapshotRef.current = initialSnapshot; }, [initialSnapshot]);

  const isDirty =
    snapshotOf({ name, category, body, editorMode, mediaUrl: media?.url ?? '', buttons, carouselCards }) !== snapshotRef.current;

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const preview = body ? spinText(body, { name: 'Demo', city: 'Karachi', phone: '+923001234567' }) : '';
  const carouselCheck = useMemo(() => validateCarousel(carouselCards, 'ANY'), [carouselCards]);

  const addCard = () => {
    if (carouselCards.length >= MAX_CARDS) return;
    setCarouselCards([...carouselCards, newCarouselCard()]);
  };
  const updateCard = (index: number, patch: Partial<CarouselCardDef>) => {
    setCarouselCards(carouselCards.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };
  const removeCard = (index: number) => {
    setCarouselCards(carouselCards.filter((_, i) => i !== index));
  };

  const handleDrop = (index: number) => {
    if (dragIndex === null || dragIndex === index) { setDragIndex(null); setOverIndex(null); return; }
    const next = [...carouselCards];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(index, 0, moved!);
    setCarouselCards(next);
    setDragIndex(null);
    setOverIndex(null);
  };

  const handleBack = () => {
    if (isDirty && !confirm('Discard unsaved changes?')) return;
    router.push('/templates');
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Backend mutual-exclusivity keys off which of buttons/carouselCards is PRESENT
      // in the body (JSON.stringify drops undefined-valued keys) — the active mode's
      // field is always sent, even empty, so switching modes actually clears the other.
      const payload =
        editorMode === 'CAROUSEL'
          ? { name, category, body, carouselCards, buttons: undefined, mediaUrl: undefined }
          : { name, category, body, mediaUrl: media?.url || undefined, buttons, carouselCards: undefined };
      const saved = initial
        ? await apiFetch<Template>(`/templates/${initial.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
        : await apiFetch<Template>('/templates', { method: 'POST', body: JSON.stringify(payload) });
      snapshotRef.current = snapshotOf({ name, category, body, editorMode, mediaUrl: media?.url ?? '', buttons, carouselCards });
      toast('Template saved', 'success');
      onSaved(saved);
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 240 }}>
          <button
            onClick={handleBack}
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, color: 'var(--text-secondary)', cursor: 'pointer', width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
            title="Back to Templates"
          >
            <IcArrowLeft />
          </button>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled Template"
            style={{ fontSize: 19, fontWeight: 600, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontFamily: 'inherit', flex: 1, minWidth: 0 }}
          />
        </div>
        <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
          <Button variant="outline" onClick={handleBack}>Cancel</Button>
          <Button
            loading={saving}
            onClick={handleSave}
            disabled={!name || !body || (editorMode === 'CAROUSEL' && !carouselCheck.valid)}
          >
            {mode === 'edit' ? 'Save Changes' : 'Save Template'}
          </Button>
        </div>
      </div>

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, maxWidth: 480 }}>
        <button
          onClick={() => setEditorMode('SINGLE')}
          style={{ flex: 1, padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${editorMode === 'SINGLE' ? 'rgba(37,211,102,0.3)' : 'rgba(255,255,255,0.06)'}`, background: editorMode === 'SINGLE' ? 'rgba(37,211,102,0.12)' : 'rgba(255,255,255,0.04)', color: editorMode === 'SINGLE' ? '#25d366' : 'var(--text-muted)' }}
        >
          Single Message
        </button>
        <button
          onClick={() => setEditorMode('CAROUSEL')}
          style={{ flex: 1, padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${editorMode === 'CAROUSEL' ? 'rgba(37,211,102,0.3)' : 'rgba(255,255,255,0.06)'}`, background: editorMode === 'CAROUSEL' ? 'rgba(37,211,102,0.12)' : 'rgba(255,255,255,0.04)', color: editorMode === 'CAROUSEL' ? '#25d366' : 'var(--text-muted)' }}
        >
          🎠 Carousel (2-10 cards)
        </button>
      </div>

      <div className="template-editor-grid" style={{ display: 'grid', gap: 24, alignItems: 'start' }}>
        {/* ── Editing column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
          <div>
            <label style={labelStyle}>Category</label>
            <select value={category} onChange={(e) => setCategory(e.target.value as Category)} style={{ ...inputStyle, fontFamily: 'inherit', maxWidth: 240 }}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          <div>
            <label style={labelStyle}>{editorMode === 'CAROUSEL' ? 'Intro text (shared across all cards)' : 'Message body'}</label>
            <SpinToolbar textareaRef={bodyRef} value={body} onChange={setBody} />
            <textarea
              ref={bodyRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={editorMode === 'CAROUSEL' ? 3 : 9}
              placeholder="{Hi|Hello} {name}! Check out our offer..."
              style={{ ...inputStyle, height: 'auto', resize: 'vertical' as const, fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6 }}
            />
          </div>

          {editorMode === 'SINGLE' ? (
            <>
              <MediaDropzone value={media} onChange={setMedia} allowDocument label="Media (optional)" />
              <ButtonListEditor buttons={buttons} onChange={setButtons} maxButtons={MAX_BUTTONS} showCloudApiWarning />
            </>
          ) : (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <label style={{ ...labelStyle, marginBottom: 0 }}>Cards ({carouselCards.length}/{MAX_CARDS})</label>
                <button
                  onClick={addCard}
                  disabled={carouselCards.length >= MAX_CARDS}
                  style={{ background: 'rgba(37,211,102,0.1)', border: '1px solid rgba(37,211,102,0.2)', borderRadius: 6, color: '#25d366', cursor: carouselCards.length >= MAX_CARDS ? 'not-allowed' : 'pointer', opacity: carouselCards.length >= MAX_CARDS ? 0.4 : 1, fontSize: 11, padding: '4px 10px' }}
                >
                  + Add card
                </button>
              </div>
              {carouselCards.map((card, i) => (
                <div
                  key={card.id}
                  onDragOver={(e) => { e.preventDefault(); setOverIndex(i); }}
                  onDrop={(e) => { e.preventDefault(); handleDrop(i); }}
                >
                  {dragIndex !== null && overIndex === i && dragIndex !== i && (
                    <div style={{ height: 3, background: 'var(--gold)', borderRadius: 2, boxShadow: '0 0 8px rgba(212,175,55,0.4)', marginBottom: 6 }} />
                  )}
                  <div style={{ opacity: dragIndex === i ? 0.4 : 1, transition: 'opacity 0.15s' }}>
                    <CarouselCardEditor
                      card={card}
                      index={i}
                      onChange={(patch) => updateCard(i, patch)}
                      onRemove={() => removeCard(i)}
                      dragHandleProps={{
                        draggable: true,
                        onDragStart: (e) => { setDragIndex(i); e.dataTransfer.effectAllowed = 'move'; },
                        onDragEnd: () => { setDragIndex(null); setOverIndex(null); },
                      }}
                    />
                  </div>
                </div>
              ))}
              {carouselCards.length < MIN_CARDS && (
                <div style={{ fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: 8, padding: '8px 10px', marginTop: 4 }}>
                  A carousel needs at least {MIN_CARDS} cards.
                </div>
              )}
              {!!carouselCards.length && !carouselCheck.valid && (
                <div style={{ fontSize: 11, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: 8, padding: '8px 10px', marginTop: 4, lineHeight: 1.5 }}>
                  ⚠ {carouselCheck.errors.join(' ')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Live preview column ── */}
        <div className="template-editor-preview">
          <label style={labelStyle}>Live Preview</label>
          <div
            style={{
              borderRadius: 20,
              border: '1px solid rgba(255,255,255,0.08)',
              background: '#0b141a',
              overflow: 'hidden',
              boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
            }}
          >
            {/* Faux chat header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-subtle)' }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(212,175,55,0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--gold)', fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
                {(name || 'T')[0]?.toUpperCase()}
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name || 'Your Business'}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>online</div>
              </div>
            </div>

            {/* Message bubble */}
            <div style={{ padding: 16, minHeight: 180 }}>
              <div
                style={{
                  background: '#005c4b',
                  borderRadius: '10px 10px 2px 10px',
                  padding: '10px 12px',
                  fontSize: 13,
                  color: '#e9edef',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  maxWidth: '100%',
                  boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
                }}
              >
                {preview || <span style={{ color: 'rgba(233,237,239,0.4)' }}>Preview will appear as you type...</span>}
                {editorMode === 'SINGLE' ? <ButtonPreview buttons={buttons} /> : <CarouselPreview cards={carouselCards} />}
                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 3, marginTop: 6, color: 'rgba(233,237,239,0.5)', fontSize: 10 }}>
                  {new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  <span style={{ color: '#53bdeb', display: 'flex' }}><IcCheck2 /></span>
                </div>
              </div>
            </div>
          </div>
          <div style={{ marginTop: 10, background: 'rgba(37,211,102,0.05)', border: '1px solid rgba(37,211,102,0.1)', borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>Rendered with</div>
            <div style={{ fontSize: 11, color: '#25d366' }}>name=Demo · city=Karachi · phone=+923...</div>
          </div>
        </div>
      </div>
    </div>
  );
}
