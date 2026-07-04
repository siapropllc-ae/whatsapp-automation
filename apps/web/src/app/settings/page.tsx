'use client';

import React, { useEffect, useState } from 'react';
import useSWR from 'swr';
import { DashLayout } from '@/components/DashLayout';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { useToast, ToastProvider } from '@/components/Toast';
import { apiFetch } from '@/lib/api';
import type { Proxy } from '@/types/api';

type SettingsTab = 'engine' | 'warmup' | 'ai' | 'proxies' | 'danger';

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'engine', label: 'Send Engine' },
  { id: 'warmup', label: 'Warmup' },
  { id: 'ai', label: 'AI Brain' },
  { id: 'proxies', label: 'Proxies' },
  { id: 'danger', label: 'Danger Zone' },
];

/* ── SVG icons ─────────────────────────────────────────────── */
const IcTrash = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/>
  </svg>
);
const IcWarn = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
  </svg>
);

/* ── Shared form styles ─────────────────────────────────────── */
const label: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.8px', textTransform: 'uppercase' };
const inputCss: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };

/* ── Reusable setting row components ────────────────────────── */
function SliderRow({ label: lbl, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 3 }}>{lbl}</div>
        <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ width: 180, accentColor: '#25d366', marginTop: 4 }} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#25d366', minWidth: 60, textAlign: 'right' }}>{value}{unit}</div>
    </div>
  );
}

function ToggleRow({ label: lbl, desc, value, onChange }: { label: string; desc?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div>
        <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{lbl}</div>
        {desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>{desc}</div>}
      </div>
      <div
        onClick={() => onChange(!value)}
        style={{ width: 44, height: 24, borderRadius: 12, background: value ? '#25d366' : 'rgba(255,255,255,0.08)', position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0 }}
      >
        <div style={{ position: 'absolute', top: 2, left: value ? 22 : 2, width: 20, height: 20, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 4px rgba(0,0,0,0.3)' }} />
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>{children}</div>;
}

interface EngineSettings {
  meanMs: number; stdDevMs: number; floorMs: number; ceilingMs: number;
  typingMs: number; dailyLimit: number; dryRun: boolean;
}

/* ── Tab contents ───────────────────────────────────────────── */
function SendEngineTab() {
  const { toast } = useToast();
  const { data: engine, mutate: mutateEngine } = useSWR<EngineSettings>(
    '/settings/engine',
    (url: string) => apiFetch<EngineSettings>(url),
  );
  const [minDelay, setMinDelay] = useState(60);
  const [maxDelay, setMaxDelay] = useState(480);
  const [dailyLimit, setDailyLimit] = useState(200);
  const [dryRun, setDryRun] = useState(true);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (engine && !initialized) {
      setMinDelay(Math.round(engine.floorMs / 1000));
      setMaxDelay(Math.round(engine.ceilingMs / 1000));
      setDailyLimit(engine.dailyLimit);
      setDryRun(engine.dryRun);
      setInitialized(true);
    }
  }, [engine, initialized]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch('/settings/antiban', {
        method: 'PATCH',
        body: JSON.stringify({ floorMs: minDelay * 1000, ceilingMs: maxDelay * 1000, dailyLimit, dryRun }),
      });
      toast('Settings saved', 'success');
      void mutateEngine();
    } catch (err) { toast(String(err), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      {dryRun && (
        <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 10, padding: '10px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#f59e0b' }}><IcWarn /></span>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#f59e0b' }}>DRY RUN MODE ACTIVE</div>
            <div style={{ fontSize: 11, color: 'rgba(245,158,11,0.7)', marginTop: 2 }}>Messages are logged, not sent. Toggle off when ready for production.</div>
          </div>
        </div>
      )}
      <SectionTitle>Delay Settings</SectionTitle>
      <div style={{ marginBottom: 20 }}>
        <SliderRow label="Min delay between messages" value={minDelay} min={45} max={300} unit="s" onChange={setMinDelay} />
        <SliderRow label="Max delay between messages" value={maxDelay} min={minDelay} max={900} unit="s" onChange={(v) => setMaxDelay(Math.max(v, minDelay))} />
        <SliderRow label="Daily limit per session" value={dailyLimit} min={10} max={1000} onChange={setDailyLimit} />
      </div>
      <ToggleRow label="Dry Run Mode" desc="Log instead of sending — safe for testing" value={dryRun} onChange={setDryRun} />
      <div style={{ marginTop: 20 }}>
        <Button loading={saving} onClick={handleSave}>Save Engine Settings</Button>
      </div>
    </div>
  );
}

interface WarmupRow { fromDay: number; toDay: number | null; dailyCap: number; strangerCap?: number; }
interface WarmupScheduleData { schedule: WarmupRow[]; note: string; }

function WarmupTab() {
  const { data, isLoading } = useSWR<WarmupScheduleData>(
    '/settings/warmup',
    (url: string) => apiFetch<WarmupScheduleData>(url),
  );

  return (
    <div>
      <SectionTitle>Warmup Schedule</SectionTitle>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 18, lineHeight: 1.6 }}>
        {data?.note ?? 'Warmup schedule is fixed for optimal anti-ban protection.'}
      </div>
      {isLoading ? (
        <div style={{ height: 180, background: 'rgba(255,255,255,0.03)', borderRadius: 8 }} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {data?.schedule.map((row, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Day {row.fromDay}{row.toDay !== null ? `–${row.toDay}` : '+'}
              </div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
                {row.strangerCap !== undefined && (
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>
                    {row.strangerCap} cold
                  </div>
                )}
                <div style={{ fontSize: 13, fontWeight: 600, color: '#25d366', minWidth: 78, textAlign: 'right' }}>
                  {row.dailyCap} msg/day
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ background: 'rgba(37,211,102,0.06)', border: '1px solid rgba(37,211,102,0.12)', borderRadius: 8, padding: '10px 14px', marginTop: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          The warmup schedule is enforced automatically and cannot be modified — this protects your WhatsApp number from getting banned during the critical first 21 days.
        </div>
      </div>
    </div>
  );
}

interface AiSettings { provider: string; model: string; autoReply: boolean; sentiment: boolean; }

function AIBrainTab() {
  const { toast } = useToast();
  const { data: aiData, mutate: mutateAi } = useSWR<AiSettings>(
    '/settings/ai-provider',
    (url: string) => apiFetch<AiSettings>(url),
  );
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [autoReply, setAutoReply] = useState(false);
  const [sentiment, setSentiment] = useState(true);
  const [saving, setSaving] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (aiData && !initialized) {
      setProvider(aiData.provider === 'openai' ? 'openai' : 'anthropic');
      setModel(aiData.model);
      setAutoReply(aiData.autoReply);
      setSentiment(aiData.sentiment);
      setInitialized(true);
    }
  }, [aiData, initialized]);

  const models = {
    anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'],
    openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch('/settings/ai', { method: 'PATCH', body: JSON.stringify({ provider, model, autoReply, sentiment }) });
      toast('AI settings saved', 'success');
      void mutateAi();
    } catch (err) { toast(String(err), 'error'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <SectionTitle>Sia AI Brain</SectionTitle>
      <div style={{ marginBottom: 20 }}>
        <div style={{ padding: '0 0 12px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ ...label, marginBottom: 10 }}>Provider</div>
          <div style={{ display: 'flex', gap: 10 }}>
            {(['anthropic', 'openai'] as const).map((p) => (
              <button
                key={p}
                onClick={() => { setProvider(p); setModel(models[p][0] ?? ''); }}
                style={{
                  flex: 1, padding: '10px 16px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 500, transition: 'all 0.15s',
                  background: provider === p ? 'rgba(37,211,102,0.1)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${provider === p ? 'rgba(37,211,102,0.25)' : 'rgba(255,255,255,0.07)'}`,
                  color: provider === p ? '#25d366' : 'var(--text-muted)',
                }}
              >
                {p === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI (GPT)'}
              </button>
            ))}
          </div>
        </div>
        <div style={{ padding: '12px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <div style={{ ...label }}>Model</div>
          <select value={model} onChange={(e) => setModel(e.target.value)} style={{ ...inputCss, fontFamily: 'inherit' }}>
            {models[provider].map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>
        <ToggleRow label="Auto-reply to hot leads" desc="AI replies to HOT sentiment contacts automatically" value={autoReply} onChange={setAutoReply} />
        <ToggleRow label="Sentiment analysis" desc="Classify reply sentiment on inbound messages" value={sentiment} onChange={setSentiment} />
      </div>
      <Button loading={saving} onClick={handleSave}>Save AI Settings</Button>
    </div>
  );
}

function ProxiesTab() {
  const { toast } = useToast();
  const { data, mutate } = useSWR<Proxy[]>('/settings/proxies', (url: string) => apiFetch<Proxy[]>(url));
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ host: '', port: '', username: '', password: '', protocol: 'socks5', country: '' });
  const [saving, setSaving] = useState(false);
  const proxies = data ?? [];

  const handleAdd = async () => {
    setSaving(true);
    try {
      await apiFetch('/settings/proxies', { method: 'POST', body: JSON.stringify({ ...form, port: Number(form.port) }) });
      toast('Proxy added', 'success');
      setAddOpen(false);
      setForm({ host: '', port: '', username: '', password: '', protocol: 'socks5', country: '' });
      mutate();
    } catch (err) { toast(String(err), 'error'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiFetch(`/settings/proxies/${id}`, { method: 'DELETE' });
      toast('Proxy removed', 'success');
      mutate();
    } catch (err) { toast(String(err), 'error'); }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <SectionTitle>Proxy Pool ({proxies.length})</SectionTitle>
        <Button size="sm" onClick={() => setAddOpen(true)}>Add Proxy</Button>
      </div>
      {proxies.length === 0 ? (
        <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 10, padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          No proxies configured. Add proxies to rotate IPs across sessions.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {proxies.map((p) => (
            <div key={p.id} style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 10, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', fontFamily: 'monospace' }}>{p.host}:{p.port}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                  {p.protocol.toUpperCase()} · {p.country ?? 'Unknown'} · {p.inUse ? <span style={{ color: '#25d366' }}>In use</span> : 'Available'}
                </div>
              </div>
              <button onClick={() => handleDelete(p.id)} style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.1)', borderRadius: 6, color: '#ef4444', cursor: 'pointer', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <IcTrash />
              </button>
            </div>
          ))}
        </div>
      )}

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add Proxy" width={460}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <div><label style={label}>Host</label><input value={form.host} onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))} placeholder="192.168.1.1" style={inputCss} /></div>
            <div><label style={label}>Port</label><input type="number" value={form.port} onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))} placeholder="1080" style={inputCss} /></div>
          </div>
          <div><label style={label}>Protocol</label>
            <select value={form.protocol} onChange={(e) => setForm((f) => ({ ...f, protocol: e.target.value }))} style={{ ...inputCss, fontFamily: 'inherit' }}>
              {['socks5', 'socks4', 'http', 'https'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div><label style={label}>Username</label><input value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} placeholder="optional" style={inputCss} /></div>
            <div><label style={label}>Password</label><input type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} placeholder="optional" style={inputCss} /></div>
          </div>
          <div><label style={label}>Country</label><input value={form.country} onChange={(e) => setForm((f) => ({ ...f, country: e.target.value }))} placeholder="e.g. PK, US, GB" style={inputCss} /></div>
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button loading={saving} onClick={handleAdd} disabled={!form.host || !form.port}>Add Proxy</Button>
        </div>
      </Modal>
    </div>
  );
}

function DangerZoneTab() {
  const { toast } = useToast();
  const [confirmText, setConfirmText] = useState('');
  const [purgeLoading, setPurgeLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const handlePurgeQueue = async () => {
    if (!confirm('Purge all queued messages? This cannot be undone.')) return;
    setPurgeLoading(true);
    try {
      await apiFetch('/settings/queue/purge', { method: 'POST' });
      toast('Queue purged', 'success');
    } catch (err) { toast(String(err), 'error'); }
    finally { setPurgeLoading(false); }
  };

  const handleDeleteContacts = async () => {
    if (confirmText !== 'DELETE ALL') return;
    setDeleteLoading(true);
    try {
      await apiFetch('/contacts/all', { method: 'DELETE' });
      toast('All contacts deleted', 'success');
      setConfirmText('');
    } catch (err) { toast(String(err), 'error'); }
    finally { setDeleteLoading(false); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Purge queue */}
      <div style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.14)', borderRadius: 12, padding: '18px 20px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#ef4444', marginBottom: 6 }}>Purge Message Queue</div>
        <div style={{ fontSize: 12, color: 'rgba(239,68,68,0.65)', marginBottom: 14, lineHeight: 1.5 }}>
          Removes all pending messages from the BullMQ queue. Running campaigns will stop immediately.
        </div>
        <Button variant="danger" loading={purgeLoading} onClick={handlePurgeQueue}>Purge Queue</Button>
      </div>

      {/* Delete all contacts */}
      <div style={{ background: 'rgba(239,68,68,0.05)', border: '1px solid rgba(239,68,68,0.14)', borderRadius: 12, padding: '18px 20px' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#ef4444', marginBottom: 6 }}>Delete All Contacts</div>
        <div style={{ fontSize: 12, color: 'rgba(239,68,68,0.65)', marginBottom: 14, lineHeight: 1.5 }}>
          Permanently deletes every contact. Type <code style={{ color: '#ef4444', fontFamily: 'monospace' }}>DELETE ALL</code> to confirm.
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="Type DELETE ALL to confirm"
            style={{ ...inputCss, borderColor: confirmText === 'DELETE ALL' ? 'rgba(239,68,68,0.4)' : undefined, flex: 1 }}
          />
          <Button variant="danger" loading={deleteLoading} onClick={handleDeleteContacts} disabled={confirmText !== 'DELETE ALL'}>
            Delete All
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ── Page shell ─────────────────────────────────────────────── */
function SettingsContent() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('engine');

  const tabContent: Record<SettingsTab, React.ReactNode> = {
    engine: <SendEngineTab />,
    warmup: <WarmupTab />,
    ai: <AIBrainTab />,
    proxies: <ProxiesTab />,
    danger: <DangerZoneTab />,
  };

  return (
    <DashLayout title="Settings">
      <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 18, alignItems: 'start' }}>
        {/* Vertical tab nav */}
        <div className="glass" style={{ borderRadius: 14, padding: '10px 8px' }}>
          {TABS.map((t) => {
            const active = activeTab === t.id;
            const isDanger = t.id === 'danger';
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '9px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                  fontSize: 13, fontWeight: active ? 500 : 400, border: 'none',
                  background: active ? (isDanger ? 'rgba(239,68,68,0.1)' : 'rgba(37,211,102,0.1)') : 'transparent',
                  color: active ? (isDanger ? '#ef4444' : '#25d366') : (isDanger ? 'rgba(239,68,68,0.7)' : 'var(--text-secondary)'),
                  textAlign: 'left', transition: 'all 0.15s',
                  marginBottom: 2,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="glass" style={{ borderRadius: 14, padding: '22px 24px' }}>
          {tabContent[activeTab]}
        </div>
      </div>
    </DashLayout>
  );
}

export default function SettingsPage() {
  return <ToastProvider><SettingsContent /></ToastProvider>;
}
