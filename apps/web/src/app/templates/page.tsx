'use client';

import React, { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { DashLayout } from '@/components/DashLayout';
import { Badge } from '@/components/Badge';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { CardSkeleton } from '@/components/Skeleton';
import { useToast, ToastProvider } from '@/components/Toast';
import { apiFetch } from '@/lib/api';
import { spinText } from '@wa-engine/shared';
import type { Template } from '@/types/api';
import { RE_TEMPLATES, RE_CATEGORIES } from '@/data/re-templates';

/* ── SVG Icons ─────────────────────────────────────────────────── */
const IcTrash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/>
  </svg>
);
const IcRefresh = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>
);
const IcFile = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
  </svg>
);
const IcEdit = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);
const IcCopy = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);
const IcSearch = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
  </svg>
);
const IcPlus = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
  </svg>
);
const IcBook = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
  </svg>
);

/* ── Template card (My Templates) ──────────────────────────────── */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function TemplateCard({ template: t, onEdit, onDuplicate, onDelete }: { template: Template; onEdit: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const [spinPreview, setSpinPreview] = useState(spinText(t.body, { name: 'Demo', city: 'Karachi' }));
  // Template bodies are free text (operator-typed or AI-generated) — escape before
  // injecting via dangerouslySetInnerHTML, then highlight the {spin} markers.
  const highlightSpin = (text: string) =>
    escapeHtml(text).replace(/\{[^}]+\}/g, (match) => `<span style="color:var(--bg-accent)">${match}</span>`);
  return (
    <div className="glass glass-card-hover" style={{ borderRadius: 14, padding: '20px 22px', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', flex: 1, marginRight: 10 }}>{t.name}</div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {t.carouselCards?.length ? (
            <span title={`Carousel: ${t.carouselCards.length} cards`} style={{ fontSize: 10, color: '#25d366', background: 'rgba(37,211,102,0.08)', border: '1px solid rgba(37,211,102,0.15)', borderRadius: 10, padding: '2px 7px' }}>
              🎠 {t.carouselCards.length} cards
            </span>
          ) : !!t.buttons?.length && (
            <span title={`${t.buttons.length} button(s)`} style={{ fontSize: 10, color: '#25d366', background: 'rgba(37,211,102,0.08)', border: '1px solid rgba(37,211,102,0.15)', borderRadius: 10, padding: '2px 7px' }}>
              🔘 {t.buttons.length}
            </span>
          )}
          <Badge variant={(t.category ?? 'marketing') as Parameters<typeof Badge>[0]['variant']} size="sm">{t.category ?? 'marketing'}</Badge>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, lineHeight: 1.6, maxHeight: 52, overflow: 'hidden' }} dangerouslySetInnerHTML={{ __html: highlightSpin(t.body) }} />
      <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 10, padding: '12px 14px', marginBottom: 16, flex: 1 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px' }}>Live Preview</div>
          <button onClick={() => setSpinPreview(spinText(t.body, { name: 'Demo', city: 'Karachi' }))} title="Re-spin" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 6, color: 'var(--text-muted)', cursor: 'pointer', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IcRefresh /></button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{spinPreview}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 14 }}>
        <button onClick={onEdit} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 7, color: 'var(--text-secondary)', cursor: 'pointer', padding: '7px 12px', fontSize: 12, fontFamily: 'inherit', transition: 'all 0.15s' }}><IcEdit />Edit</button>
        <button onClick={onDuplicate} title="Duplicate template" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 7, color: 'var(--text-secondary)', cursor: 'pointer', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}><IcCopy /></button>
        <button onClick={onDelete} style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.1)', borderRadius: 7, color: '#ef4444', cursor: 'pointer', width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}><IcTrash /></button>
      </div>
    </div>
  );
}

/* ── Library card (pre-built RE templates) ─────────────────────── */
function LibraryCard({ tpl, onUse }: { tpl: typeof RE_TEMPLATES[number]; onUse: () => void }) {
  const [copied, setCopied] = useState(false);
  const preview = spinText(tpl.body, { name: 'Ahmed', city: 'Dubai', property: 'Villa', agent: 'Sara' });
  const handleCopy = () => {
    navigator.clipboard.writeText(tpl.body).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };
  return (
    <div className="glass glass-card-hover" style={{ borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 3 }}>{tpl.name}</div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', background: 'rgba(37,211,102,0.08)', border: '1px solid rgba(37,211,102,0.15)', borderRadius: 4, padding: '2px 7px', display: 'inline-block' }}>{tpl.category}</div>
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.04)', borderRadius: 4, padding: '2px 6px' }}>{tpl.id}</div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.65, maxHeight: 64, overflow: 'hidden', position: 'relative' }}>
        {preview}
        <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 20, background: 'linear-gradient(transparent, rgba(15,15,15,0.9))' }} />
      </div>
      <div style={{ display: 'flex', gap: 7, paddingTop: 4 }}>
        <button onClick={handleCopy} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: copied ? 'rgba(37,211,102,0.1)' : 'rgba(255,255,255,0.05)', border: `1px solid ${copied ? 'rgba(37,211,102,0.25)' : 'rgba(255,255,255,0.07)'}`, borderRadius: 7, color: copied ? '#25d366' : 'var(--text-secondary)', cursor: 'pointer', padding: '7px 10px', fontSize: 12, fontFamily: 'inherit', transition: 'all 0.2s' }}>
          <IcCopy />{copied ? 'Copied' : 'Copy'}
        </button>
        <button onClick={onUse} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: 'rgba(37,211,102,0.08)', border: '1px solid rgba(37,211,102,0.18)', borderRadius: 7, color: '#25d366', cursor: 'pointer', padding: '7px 10px', fontSize: 12, fontFamily: 'inherit', transition: 'all 0.15s' }}>
          <IcPlus />Use
        </button>
      </div>
    </div>
  );
}

/* ── Shared styles ─────────────────────────────────────────────── */
const inputStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };

type TypeFilter = 'ALL' | 'SINGLE' | 'CAROUSEL';

/* ── Main content ───────────────────────────────────────────────── */
function TemplatesContent() {
  const router = useRouter();
  const { data, isLoading, mutate } = useSWR<Template[]>('/templates', (url: string) => apiFetch<Template[]>(url));
  const { toast } = useToast();

  // Tab state
  const [activeTab, setActiveTab] = useState<'mine' | 'library'>('mine');

  // My Templates filter state
  const [mySearch, setMySearch] = useState('');
  const [myCategory, setMyCategory] = useState<string>('All');
  const [myType, setMyType] = useState<TypeFilter>('ALL');

  // Library filter state
  const [libSearch, setLibSearch] = useState('');
  const [libCategory, setLibCategory] = useState<string>('All');
  const [libPage, setLibPage] = useState(1);
  const LIB_PAGE_SIZE = 30;

  const templates = useMemo(() => data ?? [], [data]);

  const filteredMine = useMemo(() => {
    let list = templates;
    if (myCategory !== 'All') list = list.filter((t) => (t.category ?? 'marketing') === myCategory);
    if (myType !== 'ALL') list = list.filter((t) => (t.carouselCards?.length ? 'CAROUSEL' : 'SINGLE') === myType);
    if (mySearch.trim()) {
      const q = mySearch.toLowerCase();
      list = list.filter((t) => t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q));
    }
    return list;
  }, [templates, mySearch, myCategory, myType]);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this template?')) return;
    try {
      await apiFetch(`/templates/${id}`, { method: 'DELETE' });
      toast('Template deleted', 'success');
      mutate();
    } catch (err) { toast(String(err), 'error'); }
  };

  const handleDuplicate = async (t: Template) => {
    try {
      const payload = t.carouselCards?.length
        ? {
            name: `${t.name} (Copy)`,
            category: t.category ?? undefined,
            body: t.body,
            carouselCards: t.carouselCards.map((c) => ({ ...c, id: crypto.randomUUID() })),
          }
        : {
            name: `${t.name} (Copy)`,
            category: t.category ?? undefined,
            body: t.body,
            mediaUrl: t.mediaUrl ?? undefined,
            buttons: (t.buttons ?? []).map((b) => ({ ...b, id: crypto.randomUUID() })),
          };
      await apiFetch('/templates', { method: 'POST', body: JSON.stringify(payload) });
      toast('Template duplicated', 'success');
      mutate();
    } catch (err) { toast(String(err), 'error'); }
  };

  // Library filtering
  const filteredLib = useMemo(() => {
    let list = RE_TEMPLATES;
    if (libCategory !== 'All') list = list.filter(t => t.category === libCategory);
    if (libSearch.trim()) {
      const q = libSearch.toLowerCase();
      list = list.filter(t => t.body.toLowerCase().includes(q) || t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q));
    }
    return list;
  }, [libSearch, libCategory]);

  const libPageCount = Math.ceil(filteredLib.length / LIB_PAGE_SIZE);
  const libVisible = filteredLib.slice((libPage - 1) * LIB_PAGE_SIZE, libPage * LIB_PAGE_SIZE);

  React.useEffect(() => { setLibPage(1); }, [libSearch, libCategory]);

  const tabStyle = (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 7, padding: '8px 18px', borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: 'pointer', border: 'none', fontFamily: 'inherit', transition: 'all 0.15s',
    background: active ? 'rgba(37,211,102,0.12)' : 'rgba(255,255,255,0.04)',
    color: active ? '#25d366' : 'var(--text-muted)',
    outline: active ? '1px solid rgba(37,211,102,0.2)' : '1px solid rgba(255,255,255,0.06)',
  });

  const typePillStyle = (active: boolean): React.CSSProperties => ({
    padding: '7px 14px', borderRadius: 6, fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${active ? 'rgba(37,211,102,0.3)' : 'rgba(255,255,255,0.06)'}`,
    background: active ? 'rgba(37,211,102,0.12)' : 'rgba(255,255,255,0.04)',
    color: active ? '#25d366' : 'var(--text-muted)',
  });

  return (
    <DashLayout title="Templates" onRefresh={() => mutate()}>

      {/* Tabs */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={tabStyle(activeTab === 'mine')} onClick={() => setActiveTab('mine')}>
            <IcFile />My Templates {templates.length > 0 && <span style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 10, padding: '1px 7px', fontSize: 10 }}>{templates.length}</span>}
          </button>
          <button style={tabStyle(activeTab === 'library')} onClick={() => setActiveTab('library')}>
            <IcBook />RE Library <span style={{ background: 'rgba(37,211,102,0.1)', borderRadius: 10, padding: '1px 7px', fontSize: 10, color: '#25d366' }}>{RE_TEMPLATES.length}</span>
          </button>
        </div>
        {activeTab === 'mine' && <Button onClick={() => router.push('/templates/new')}>New Template</Button>}
      </div>

      {/* ── MY TEMPLATES TAB ── */}
      {activeTab === 'mine' && (
        <>
          {templates.length > 0 && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ position: 'relative', flex: '1 1 220px' }}>
                <div style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}><IcSearch /></div>
                <input
                  value={mySearch}
                  onChange={(e) => setMySearch(e.target.value)}
                  placeholder="Search your templates..."
                  style={{ ...inputStyle, paddingLeft: 34 }}
                />
              </div>
              <select
                value={myCategory}
                onChange={(e) => setMyCategory(e.target.value)}
                style={{ ...inputStyle, width: 'auto', minWidth: 160, flex: '0 0 auto' }}
              >
                <option value="All">All Categories</option>
                {['marketing', 'utility', 'auth', 'service'].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={typePillStyle(myType === 'ALL')} onClick={() => setMyType('ALL')}>All</button>
                <button style={typePillStyle(myType === 'SINGLE')} onClick={() => setMyType('SINGLE')}>Single</button>
                <button style={typePillStyle(myType === 'CAROUSEL')} onClick={() => setMyType('CAROUSEL')}>🎠 Carousel</button>
              </div>
            </div>
          )}

          {isLoading ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
              {[1, 2, 3, 4].map((i) => <CardSkeleton key={i} />)}
            </div>
          ) : templates.length === 0 ? (
            <EmptyState
              icon={<IcFile />}
              title="No templates yet"
              subtitle="Create your own templates below, or browse the Real Estate Library to get started instantly"
              action={
                <div style={{ display: 'flex', gap: 10 }}>
                  <Button onClick={() => router.push('/templates/new')}>New Template</Button>
                  <Button variant="outline" onClick={() => setActiveTab('library')}>Browse RE Library</Button>
                </div>
              }
            />
          ) : filteredMine.length === 0 ? (
            <EmptyState icon={<IcSearch />} title="No templates found" subtitle="Try a different search term or filter" />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
              {filteredMine.map((t, i) => (
                <div key={t.id} className={`anim-${Math.min(i + 1, 6) as 1 | 2 | 3 | 4 | 5 | 6}`}>
                  <TemplateCard
                    template={t}
                    onEdit={() => router.push(`/templates/${t.id}/edit`)}
                    onDuplicate={() => handleDuplicate(t)}
                    onDelete={() => handleDelete(t.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── LIBRARY TAB ── */}
      {activeTab === 'library' && (
        <div>
          {/* Search + category filter */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: '1 1 220px' }}>
              <div style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }}><IcSearch /></div>
              <input
                value={libSearch}
                onChange={e => setLibSearch(e.target.value)}
                placeholder="Search templates..."
                style={{ ...inputStyle, paddingLeft: 34 }}
              />
            </div>
            <select
              value={libCategory}
              onChange={e => setLibCategory(e.target.value)}
              style={{ ...inputStyle, width: 'auto', minWidth: 180, flex: '0 0 auto' }}
            >
              <option value="All">All Categories</option>
              {RE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {/* Count + pagination info */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Showing <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{libVisible.length}</span> of <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{filteredLib.length}</span> templates
            </div>
            {libPageCount > 1 && (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button onClick={() => setLibPage(p => Math.max(1, p - 1))} disabled={libPage === 1} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: 'var(--text-muted)', cursor: libPage === 1 ? 'not-allowed' : 'pointer', padding: '4px 10px', fontSize: 12, fontFamily: 'inherit', opacity: libPage === 1 ? 0.4 : 1 }}>Prev</button>
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{libPage} / {libPageCount}</span>
                <button onClick={() => setLibPage(p => Math.min(libPageCount, p + 1))} disabled={libPage === libPageCount} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: 'var(--text-muted)', cursor: libPage === libPageCount ? 'not-allowed' : 'pointer', padding: '4px 10px', fontSize: 12, fontFamily: 'inherit', opacity: libPage === libPageCount ? 0.4 : 1 }}>Next</button>
              </div>
            )}
          </div>

          {/* Grid */}
          {libVisible.length === 0 ? (
            <EmptyState icon={<IcSearch />} title="No templates found" subtitle="Try a different search term or category" />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
              {libVisible.map((tpl, i) => (
                <div key={tpl.id} className={`anim-${Math.min(i + 1, 6) as 1 | 2 | 3 | 4 | 5 | 6}`}>
                  <LibraryCard
                    tpl={tpl}
                    onUse={() => router.push(`/templates/new?from=${tpl.id}`)}
                  />
                </div>
              ))}
            </div>
          )}

          {/* Bottom pagination */}
          {libPageCount > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: 6, marginTop: 24 }}>
              <button onClick={() => setLibPage(p => Math.max(1, p - 1))} disabled={libPage === 1} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: 'var(--text-muted)', cursor: libPage === 1 ? 'not-allowed' : 'pointer', padding: '6px 16px', fontSize: 12, fontFamily: 'inherit', opacity: libPage === 1 ? 0.4 : 1 }}>Previous</button>
              {Array.from({ length: Math.min(libPageCount, 7) }, (_, i) => {
                const p = libPageCount <= 7 ? i + 1 : libPage <= 4 ? i + 1 : libPage >= libPageCount - 3 ? libPageCount - 6 + i : libPage - 3 + i;
                return (
                  <button key={p} onClick={() => setLibPage(p)} style={{ background: p === libPage ? 'rgba(37,211,102,0.15)' : 'rgba(255,255,255,0.04)', border: `1px solid ${p === libPage ? 'rgba(37,211,102,0.3)' : 'rgba(255,255,255,0.07)'}`, borderRadius: 6, color: p === libPage ? '#25d366' : 'var(--text-muted)', cursor: 'pointer', width: 32, height: 32, fontSize: 12, fontFamily: 'inherit' }}>{p}</button>
                );
              })}
              <button onClick={() => setLibPage(p => Math.min(libPageCount, p + 1))} disabled={libPage === libPageCount} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: 'var(--text-muted)', cursor: libPage === libPageCount ? 'not-allowed' : 'pointer', padding: '6px 16px', fontSize: 12, fontFamily: 'inherit', opacity: libPage === libPageCount ? 0.4 : 1 }}>Next</button>
            </div>
          )}
        </div>
      )}
    </DashLayout>
  );
}

export default function TemplatesPage() {
  return (
    <ToastProvider>
      <TemplatesContent />
    </ToastProvider>
  );
}
