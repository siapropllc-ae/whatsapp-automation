'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import useSWR from 'swr';
import { DashLayout } from '@/components/DashLayout';
import { Button } from '@/components/Button';
import { useToast, ToastProvider } from '@/components/Toast';
import { apiFetch } from '@/lib/api';
import { spinText, validateButtons, validateCarousel } from '@wa-engine/shared';
import type { Template, SmartList, Session } from '@/types/api';
import { ButtonPreview } from '@/components/ButtonPreview';
import { CarouselPreview } from '@/components/CarouselPreview';

const STEPS = ['Basics', 'Message', 'Contacts', 'Schedule', 'Review'];

/* ── SVG icons ─────────────────────────────────────────────── */
const IcCloud = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>
  </svg>
);
const IcWifi = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/>
    <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="20" r="1" fill="currentColor"/>
  </svg>
);
const IcFile = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
  </svg>
);
const IcBrain = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a5 5 0 0 0-4.9 6A5 5 0 0 0 4 13a5 5 0 0 0 3.1 4.6A3.5 3.5 0 0 0 10.5 22h3a3.5 3.5 0 0 0 3.4-4.4A5 5 0 0 0 20 13a5 5 0 0 0-3.1-5A5 5 0 0 0 12 2z"/>
  </svg>
);
const IcPaperclip = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
  </svg>
);
const IcX = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

/* ── Shared styles ─────────────────────────────────────────── */
const inputStyle: React.CSSProperties = {
  width: '100%',
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 8,
  padding: '10px 14px',
  color: 'var(--text-primary)',
  fontSize: 13,
  outline: 'none',
  fontFamily: 'inherit',
};
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--text-muted)',
  marginBottom: 6,
  letterSpacing: '0.8px',
  textTransform: 'uppercase',
};

/* ── Option card ────────────────────────────────────────────── */
function OptionCard({ active, icon, title, desc, onClick }: { active: boolean; icon: React.ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        border: `1px solid ${active ? 'rgba(212,175,55,0.35)' : 'rgba(255,255,255,0.06)'}`,
        borderRadius: 12, padding: '18px 20px', cursor: 'pointer',
        background: active ? 'rgba(212,175,55,0.07)' : 'rgba(255,255,255,0.02)',
        transition: 'all 0.15s',
      }}
    >
      <div style={{ color: active ? '#D4AF37' : 'var(--text-muted)', marginBottom: 10 }}>{icon}</div>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>{title}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>{desc}</div>
    </div>
  );
}

/* ── Main content ───────────────────────────────────────────── */
function NewCampaignContent() {
  const router = useRouter();
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState('');
  const [mode, setMode] = useState<'CLOUD_API' | 'BAILEYS'>('BAILEYS');
  const [sourceType, setSourceType] = useState<'template' | 'ai'>('template');
  const [templateId, setTemplateId] = useState('');
  const [aiBrief, setAiBrief] = useState('');
  const [aiAudience, setAiAudience] = useState('');
  const [aiTone, setAiTone] = useState('Friendly');
  const [aiCount, setAiCount] = useState(10);
  const [smartListId, setSmartListId] = useState('');
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[] | null>(null);
  const [activeFrom, setActiveFrom] = useState(8);
  const [activeTo, setActiveTo] = useState(22);
  const [aiMessages, setAiMessages] = useState<string[]>([]);
  const [aiGenerating, setAiGenerating] = useState(false);

  const [mediaUrl, setMediaUrl] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [mediaMimeType, setMediaMimeType] = useState('');
  const [mediaFilename, setMediaFilename] = useState('');
  const [mediaUploading, setMediaUploading] = useState(false);

  const { data: templates } = useSWR<Template[]>('/templates', (url: string) => apiFetch<Template[]>(url));
  const { data: smartLists } = useSWR<SmartList[]>('/smart-lists', (url: string) => apiFetch<SmartList[]>(url));
  const { data: allSessions } = useSWR<Session[]>('/sessions', (url: string) => apiFetch<Session[]>(url));

  const selectedTemplate = templates?.find((t) => t.id === templateId);
  const selectedSmartList = smartLists?.find((sl) => sl.id === smartListId);
  const onlineSessions = (allSessions ?? []).filter((s) => s.status === 'ONLINE' && s.mode === mode);
  const effectiveSessionIds = selectedSessionIds ?? onlineSessions.map((s) => s.id);

  const toggleSession = (sessionId: string) => {
    const current = selectedSessionIds ?? onlineSessions.map((s) => s.id);
    setSelectedSessionIds(current.includes(sessionId) ? current.filter((s) => s !== sessionId) : [...current, sessionId]);
  };

  const handleMediaUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setMediaUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch('/api/media/upload', {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json() as { url: string; type: string; mimeType: string; filename: string };
      setMediaUrl(data.url);
      setMediaType(data.type);
      setMediaMimeType(data.mimeType);
      setMediaFilename(data.filename);
      toast(`Attachment added: ${data.filename}`, 'success');
    } catch (err) { toast(`Upload failed: ${String(err)}`, 'error'); }
    finally { setMediaUploading(false); e.target.value = ''; }
  };

  const clearMedia = () => { setMediaUrl(''); setMediaType(''); setMediaMimeType(''); setMediaFilename(''); };

  const handleGenerateAI = async () => {
    setAiGenerating(true);
    try {
      const result = await apiFetch<{ messages: string[] }>('/ai/generate-templates', {
        method: 'POST',
        body: JSON.stringify({ brief: aiBrief, audience: aiAudience, tone: aiTone, count: aiCount }),
      });
      setAiMessages(result.messages ?? []);
      toast(`Generated ${result.messages?.length ?? 0} messages`, 'success');
    } catch (err) { toast(String(err), 'error'); }
    finally { setAiGenerating(false); }
  };

  const handleLaunch = async (asDraft = false) => {
    setLoading(true);
    try {
      let resolvedTemplateId: string | undefined = sourceType === 'template' ? templateId || undefined : undefined;

      // AI brief mode: always save generated messages as a spin-syntax template — even
      // for drafts — so the content is preserved and can be launched later.
      if (sourceType === 'ai' && aiMessages.length > 0) {
        const spinBody = aiMessages.length === 1
          ? aiMessages[0]!
          : `{${aiMessages.join('|')}}`;
        const tpl = await apiFetch<{ id: string }>('/templates', {
          method: 'POST',
          body: JSON.stringify({ name: `AI — ${name}`, body: spinBody }),
        });
        resolvedTemplateId = tpl.id;
      }

      const campaign = await apiFetch<{ id: string }>('/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          name, mode, templateId: resolvedTemplateId, activeFrom, activeTo,
          ...(mediaUrl ? { mediaUrl, mediaType, mediaMimeType, mediaFilename } : {}),
        }),
      });

      if (!asDraft && smartListId) {
        const allSessionsSelected = effectiveSessionIds.length === onlineSessions.length;
        await apiFetch(`/campaigns/${campaign.id}/launch`, {
          method: 'POST',
          body: JSON.stringify({
            smartListId,
            ...(!allSessionsSelected ? { sessionIds: effectiveSessionIds } : {}),
          }),
        });
        toast('Campaign launched!', 'success');
      } else {
        toast('Campaign saved as draft', 'success');
      }
      router.push(`/campaigns/${campaign.id}`);
    } catch (err) { toast(String(err), 'error'); }
    finally { setLoading(false); }
  };

  const estimatedMinutes = (selectedSmartList?.contactCount ?? 0) * 15;
  const estimatedHours = Math.floor(estimatedMinutes / 60);
  const estimatedMins = estimatedMinutes % 60;

  return (
    <DashLayout title="New Campaign">
      <div style={{ maxWidth: 700, margin: '0 auto' }}>
        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 28, alignItems: 'flex-start' }}>
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <div style={{
                  width: 30, height: 30, borderRadius: '50%',
                  background: i < step ? '#D4AF37' : i === step ? 'rgba(212,175,55,0.15)' : 'rgba(255,255,255,0.04)',
                  border: `1px solid ${i <= step ? 'rgba(212,175,55,0.35)' : 'rgba(255,255,255,0.07)'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 11, fontWeight: 600,
                  color: i < step ? '#000' : i === step ? '#D4AF37' : 'var(--text-muted)',
                  flexShrink: 0,
                }}>
                  {i < step ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg> : i + 1}
                </div>
                <div style={{ fontSize: 10, color: i === step ? 'var(--text-primary)' : 'var(--text-muted)', textAlign: 'center', fontWeight: i === step ? 500 : 400 }}>
                  {s}
                </div>
              </div>
              {i < STEPS.length - 1 && (
                <div style={{ flex: 1, height: 1, background: i < step ? '#D4AF37' : 'rgba(255,255,255,0.06)', marginTop: 15 }} />
              )}
            </React.Fragment>
          ))}
        </div>

        {/* Step content */}
        <div className="glass" style={{ borderRadius: 14, padding: '24px 26px', marginBottom: 16 }}>

          {/* Step 0: Basics */}
          {step === 0 && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 22, color: 'var(--text-primary)' }}>Campaign Basics</div>
              <div style={{ marginBottom: 22 }}>
                <label style={labelStyle}>Campaign name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Summer Sale Blast" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Connection Mode</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <OptionCard active={mode === 'CLOUD_API'} icon={<IcCloud />} title="Cloud API" desc="Official Meta Business. Compliant, 100K+/day." onClick={() => { setMode('CLOUD_API'); setSelectedSessionIds(null); }} />
                  <OptionCard active={mode === 'BAILEYS'} icon={<IcWifi />} title="WebSocket" desc="Any number. Zero cost, instant setup." onClick={() => { setMode('BAILEYS'); setSelectedSessionIds(null); }} />
                </div>
              </div>

              <div style={{ marginTop: 22 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Send from</label>
                  {onlineSessions.length > 0 && (
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{effectiveSessionIds.length}/{onlineSessions.length} selected</span>
                  )}
                </div>
                {onlineSessions.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#f59e0b', background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: '10px 14px' }}>
                    No ONLINE {mode === 'CLOUD_API' ? 'Cloud API' : 'WebSocket'} sessions available. Connect a session first, or the campaign will auto-pause when launched.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {onlineSessions.map((s) => {
                      const isSelected = effectiveSessionIds.includes(s.id);
                      return (
                        <div
                          key={s.id}
                          onClick={() => toggleSession(s.id)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 12px', borderRadius: 8, cursor: 'pointer', transition: 'all 0.15s',
                            border: `1px solid ${isSelected ? 'rgba(212,175,55,0.35)' : 'rgba(255,255,255,0.06)'}`,
                            background: isSelected ? 'rgba(212,175,55,0.07)' : 'rgba(255,255,255,0.02)',
                          }}
                        >
                          <div style={{
                            width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                            border: `1.5px solid ${isSelected ? '#D4AF37' : 'rgba(255,255,255,0.2)'}`,
                            background: isSelected ? '#D4AF37' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                          }}>
                            {isSelected && <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#0A0800" strokeWidth="3.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>}
                          </div>
                          <div style={{ flex: 1, overflow: 'hidden' }}>
                            <div style={{ fontSize: 12, fontWeight: 500, color: isSelected ? '#D4AF37' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {s.phoneNumber ?? s.label}
                            </div>
                            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
                              Day {s.warmupDay} · {s.dailySent} sent today
                            </div>
                          </div>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#25d366', flexShrink: 0, display: 'inline-block' }} />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Step 1: Message source */}
          {step === 1 && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 22, color: 'var(--text-primary)' }}>Message Source</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 22 }}>
                <OptionCard active={sourceType === 'template'} icon={<IcFile />} title="Use Template" desc="Pick a saved template with spin syntax" onClick={() => setSourceType('template')} />
                <OptionCard active={sourceType === 'ai'} icon={<IcBrain />} title="AI Brief" desc="Describe your offer and let Sia AI write it" onClick={() => setSourceType('ai')} />
              </div>

              {sourceType === 'template' && (
                <div>
                  <label style={labelStyle}>Select Template</label>
                  <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} style={{ ...inputStyle, fontFamily: 'inherit' }}>
                    <option value="">— choose a template —</option>
                    {(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                  {selectedTemplate && (
                    <div style={{ marginTop: 14, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: 14 }}>
                      <div style={{ fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 8 }}>Preview</div>
                      <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        {spinText(selectedTemplate.body, { name: 'Demo', city: 'Karachi' })}
                      </div>
                      {selectedTemplate.carouselCards?.length ? (
                        <>
                          <CarouselPreview cards={selectedTemplate.carouselCards} />
                          {!validateCarousel(selectedTemplate.carouselCards, mode).valid && (
                            <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 10, lineHeight: 1.5 }}>
                              ⚠ This carousel needs a matching approved Meta carousel template before it&apos;ll work in Cloud API mode.
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          {!!selectedTemplate.buttons?.length && <ButtonPreview buttons={selectedTemplate.buttons} />}
                          {mode === 'CLOUD_API' && !!selectedTemplate.buttons?.length && !validateButtons(selectedTemplate.buttons, 'CLOUD_API').valid && (
                            <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 10, lineHeight: 1.5 }}>
                              ⚠ This template&apos;s buttons need a matching approved Meta template before they&apos;ll work in Cloud API mode.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {sourceType === 'ai' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div>
                    <label style={labelStyle}>Describe your product / offer</label>
                    <textarea value={aiBrief} onChange={(e) => setAiBrief(e.target.value)} rows={3} placeholder="e.g. 50% off our new skincare line for Eid..." style={{ ...inputStyle, height: 'auto', resize: 'vertical' as const }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Target audience</label>
                    <input value={aiAudience} onChange={(e) => setAiAudience(e.target.value)} placeholder="e.g. Women 25-40 in Karachi" style={inputStyle} />
                  </div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <div style={{ flex: 1 }}>
                      <label style={labelStyle}>Tone</label>
                      <select value={aiTone} onChange={(e) => setAiTone(e.target.value)} style={{ ...inputStyle, fontFamily: 'inherit' }}>
                        {['Friendly', 'Professional', 'Urgent', 'Casual'].map((t) => <option key={t}>{t}</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={labelStyle}>Count — {aiCount} messages</label>
                      <input type="range" min={10} max={500} value={aiCount} onChange={(e) => setAiCount(Number(e.target.value))} style={{ width: '100%', marginTop: 10, accentColor: '#D4AF37' }} />
                    </div>
                  </div>
                  <Button loading={aiGenerating} onClick={handleGenerateAI} disabled={!aiBrief}>Generate Messages</Button>
                  {aiMessages.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: 10 }}>
                        Sample previews ({aiMessages.length} generated)
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {aiMessages.slice(0, 3).map((m, i) => (
                          <div key={i} style={{ background: 'rgba(212,175,55,0.05)', border: '1px solid rgba(212,175,55,0.12)', borderRadius: 10, padding: '12px 14px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                            <div style={{ fontSize: 9, color: '#D4AF37', fontWeight: 600, letterSpacing: '1px', marginBottom: 6 }}>VARIANT {i + 1}</div>
                            {m}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── Optional media attachment ─────────────────── */}
              <div style={{ marginTop: 24, paddingTop: 20, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                <label style={labelStyle}>Attachment (optional)</label>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10, lineHeight: 1.5 }}>
                  Add an image, video, or document that will be sent alongside the message. Max 16 MB.
                </div>
                {mediaUrl ? (
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    background: 'rgba(212,175,55,0.05)', border: '1px solid rgba(212,175,55,0.15)',
                    borderRadius: 10, padding: '10px 14px',
                  }}>
                    {mediaType === 'IMAGE' ? (
                      <img src={mediaUrl} alt={mediaFilename} style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, flexShrink: 0 }} />
                    ) : (
                      <div style={{ width: 40, height: 40, borderRadius: 8, background: 'rgba(212,175,55,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: '#D4AF37' }}>
                        <IcPaperclip />
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{mediaFilename}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginTop: 2 }}>{mediaType}</div>
                    </div>
                    <button onClick={clearMedia} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>
                      <IcX />
                    </button>
                  </div>
                ) : (
                  <label style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
                    background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.1)',
                    borderRadius: 10, cursor: mediaUploading ? 'wait' : 'pointer',
                    color: 'var(--text-muted)', fontSize: 12, transition: 'border-color 0.15s',
                  }}>
                    <IcPaperclip />
                    {mediaUploading ? 'Uploading…' : 'Click to attach a file'}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/3gpp,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      style={{ display: 'none' }}
                      disabled={mediaUploading}
                      onChange={handleMediaUpload}
                    />
                  </label>
                )}
              </div>
            </div>
          )}

          {/* Step 2: Smart List */}
          {step === 2 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>Select Smart List</div>
                {smartListId && (
                  <button
                    onClick={() => setSmartListId('')}
                    style={{ fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
                  >
                    Clear
                  </button>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 18, lineHeight: 1.5 }}>
                Pick a smart list — all valid contacts inside it will be included in the campaign.
              </div>

              {(!smartLists || smartLists.length === 0) ? (
                <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--text-muted)', fontSize: 13 }}>
                  <div style={{ fontSize: 28, marginBottom: 10 }}>📋</div>
                  No smart lists yet. Go to <strong style={{ color: 'var(--text-secondary)' }}>Contacts → Smart Lists</strong> to create one first.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 360, overflowY: 'auto' }}>
                  {(smartLists ?? []).map((sl) => {
                    const active = smartListId === sl.id;
                    return (
                      <div
                        key={sl.id}
                        onClick={() => setSmartListId(active ? '' : sl.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 14,
                          padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
                          border: `1px solid ${active ? 'rgba(212,175,55,0.4)' : 'rgba(255,255,255,0.06)'}`,
                          background: active ? 'rgba(212,175,55,0.07)' : 'rgba(255,255,255,0.02)',
                          transition: 'all 0.15s',
                        }}
                      >
                        {/* radio dot */}
                        <div style={{
                          width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                          border: `2px solid ${active ? '#D4AF37' : 'rgba(255,255,255,0.15)'}`,
                          background: active ? '#D4AF37' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                        }}>
                          {active && <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#0A0800' }} />}
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 }}>{sl.name}</div>
                          {sl.description && (
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sl.description}</div>
                          )}
                        </div>

                        <div style={{
                          flexShrink: 0, textAlign: 'right',
                          background: active ? 'rgba(212,175,55,0.12)' : 'rgba(255,255,255,0.04)',
                          border: `1px solid ${active ? 'rgba(212,175,55,0.25)' : 'rgba(255,255,255,0.06)'}`,
                          borderRadius: 8, padding: '4px 10px',
                        }}>
                          <div style={{ fontSize: 15, fontWeight: 700, color: active ? '#D4AF37' : 'var(--text-primary)' }}>{sl.contactCount}</div>
                          <div style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.5px' }}>CONTACTS</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {selectedSmartList && (
                <div style={{ marginTop: 14, padding: '10px 14px', background: 'rgba(212,175,55,0.05)', border: '1px solid rgba(212,175,55,0.15)', borderRadius: 8, fontSize: 12, color: 'var(--text-muted)' }}>
                  <span style={{ color: '#D4AF37', fontWeight: 600 }}>{selectedSmartList.contactCount} contacts</span> from <span style={{ color: 'var(--text-secondary)' }}>{selectedSmartList.name}</span> will be included. Only valid contacts in this list will receive messages.
                </div>
              )}
            </div>
          )}

          {/* Step 3: Schedule */}
          {step === 3 && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 22, color: 'var(--text-primary)' }}>Schedule</div>
              <div style={{ background: 'rgba(212,175,55,0.05)', border: '1px solid rgba(212,175,55,0.12)', borderRadius: 10, padding: '12px 16px', marginBottom: 22, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.6 }}>
                Messages only send within the active window (server timezone). Outside these hours messages queue and resume automatically.
              </div>
              <div style={{ display: 'flex', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>From hour (0–23)</label>
                  <input type="number" min={0} max={23} value={activeFrom} onChange={(e) => setActiveFrom(Number(e.target.value))} style={inputStyle} />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>To hour (0–23)</label>
                  <input type="number" min={0} max={23} value={activeTo} onChange={(e) => setActiveTo(Number(e.target.value))} style={inputStyle} />
                </div>
              </div>
              <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-muted)' }}>
                Active window: <span style={{ color: '#D4AF37' }}>{activeFrom}:00 – {activeTo}:00</span>
              </div>
            </div>
          )}

          {/* Step 4: Review */}
          {step === 4 && (
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 22, color: 'var(--text-primary)' }}>Review & Launch</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {[
                  { label: 'Campaign Name', value: name || '(unnamed)' },
                  { label: 'Mode', value: mode === 'CLOUD_API' ? 'Cloud API' : 'WebSocket' },
                  { label: 'Send From', value: onlineSessions.length === 0 ? 'No sessions online' : `${effectiveSessionIds.length} of ${onlineSessions.length} session(s)` },
                  { label: 'Message Source', value: sourceType === 'template' ? (selectedTemplate?.name ?? 'None selected') : `AI Generated (${aiMessages.length} messages)` },
                  ...(selectedTemplate?.carouselCards?.length
                    ? [{ label: 'Carousel', value: `${selectedTemplate.carouselCards.length} cards` }]
                    : selectedTemplate?.buttons?.length
                      ? [{ label: 'Buttons', value: selectedTemplate.buttons.map((b) => b.label).join(', ') }]
                      : []),
                  { label: 'Attachment', value: mediaFilename || 'None' },
                  { label: 'Smart List', value: selectedSmartList ? `${selectedSmartList.name} (${selectedSmartList.contactCount} contacts)` : 'None selected' },
                  { label: 'Active Hours', value: `${activeFrom}:00 – ${activeTo}:00` },
                  { label: 'Est. Duration', value: estimatedHours > 0 ? `~${estimatedHours}h ${estimatedMins}m` : `~${estimatedMins}m` },
                ].map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '13px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
                    <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{value}</span>
                  </div>
                ))}
              </div>
              {!smartListId && (
                <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 8, padding: '10px 14px', marginTop: 16, fontSize: 12, color: '#f59e0b' }}>
                  No smart list selected — campaign will be saved as draft
                </div>
              )}
            </div>
          )}
        </div>

        {/* Navigation */}
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <Button variant="outline" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>Back</Button>
          <div style={{ display: 'flex', gap: 10 }}>
            {step < STEPS.length - 1 ? (
              <Button
                onClick={() => setStep((s) => s + 1)}
                disabled={
                  (step === 0 && !name) ||
                  (step === 1 && sourceType === 'ai' && aiMessages.length === 0) ||
                  (step === 1 && sourceType === 'template' && !templateId) ||
                  (step === 2 && !smartListId)
                }
              >Next</Button>
            ) : (
              <>
                <Button variant="outline" loading={loading} onClick={() => handleLaunch(true)}>Save as Draft</Button>
                <Button loading={loading} onClick={() => handleLaunch(false)} disabled={!smartListId || effectiveSessionIds.length === 0}>Launch Now</Button>
              </>
            )}
          </div>
        </div>
      </div>
    </DashLayout>
  );
}

export default function NewCampaignPage() {
  return (
    <ToastProvider>
      <NewCampaignContent />
    </ToastProvider>
  );
}
