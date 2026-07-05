'use client';

import React, { useEffect, useRef, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import useSWR from 'swr';
import * as XLSX from 'xlsx';
import { DashLayout } from '@/components/DashLayout';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { EmptyState } from '@/components/EmptyState';
import { SkeletonRows } from '@/components/Skeleton';
import { useToast, ToastProvider } from '@/components/Toast';
import { apiFetch } from '@/lib/api';
import type { Campaign, Contact, LeadTemp, SmartList } from '@/types/api';

/* ── Lead temp helpers ──────────────────────────────────────── */
const TEMP_CFG: Record<LeadTemp, { label: string; bg: string; color: string }> = {
  HOT:  { label: 'Hot',  bg: 'rgba(239,68,68,0.12)',   color: '#ef4444' },
  WARM: { label: 'Warm', bg: 'rgba(245,158,11,0.12)',  color: '#f59e0b' },
  COLD: { label: 'Cold', bg: 'rgba(96,165,250,0.12)',  color: '#60a5fa' },
};
const TAG_COLORS = ['#25d366','#60a5fa','#f59e0b','#a78bfa','#ef4444','#4ade80','#fb923c'];
function tagColor(tag: string) {
  let sum = 0; for (const c of tag) sum += c.charCodeAt(0);
  return TAG_COLORS[sum % TAG_COLORS.length] ?? '#888';
}

/* ── Icons ──────────────────────────────────────────────────── */
const IcTrash = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>;
const IcEdit = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>;
const IcNote = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>;
const IcCheck = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#25d366" strokeWidth="2" strokeLinecap="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>;
const IcX = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>;
const IcUsers = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
const IcSearch = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
const IcUpload = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>;
const IcList = () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;
const IcPlus = () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;

/* ── Smart Lists Sidebar ────────────────────────────────────── */
interface SmartListsSidebarProps {
  lists: SmartList[];
  activeId: string | null;
  totalContacts: number;
  onSelect: (id: string | null) => void;
  onDelete: (id: string) => Promise<void>;
  onNewList: () => void;
  onImportToList: (id: string) => void;
}
function SmartListsSidebar({ lists, activeId, totalContacts, onSelect, onDelete, onNewList, onImportToList }: SmartListsSidebarProps) {
  const allActive = activeId === null;

  const sidebarItem = (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 10px',
    borderRadius: 8,
    cursor: 'pointer',
    background: active ? 'rgba(37,211,102,0.1)' : 'transparent',
    border: `1px solid ${active ? 'rgba(37,211,102,0.25)' : 'transparent'}`,
    transition: 'all 0.12s',
    marginBottom: 2,
  });

  return (
    <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 0 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <IcList /> Smart Lists
        </span>
        <button
          onClick={onNewList}
          title="New Smart List"
          style={{ background: 'rgba(37,211,102,0.1)', border: '1px solid rgba(37,211,102,0.2)', borderRadius: 6, color: '#25d366', cursor: 'pointer', width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <IcPlus />
        </button>
      </div>

      {/* All Contacts */}
      <div style={sidebarItem(allActive)} onClick={() => onSelect(null)}>
        <span style={{ fontSize: 16 }}>👥</span>
        <span style={{ flex: 1, fontSize: 13, color: allActive ? '#25d366' : 'var(--text-primary)', fontWeight: allActive ? 500 : 400 }}>
          All Contacts
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 10 }}>
          {totalContacts}
        </span>
      </div>

      {/* Divider */}
      {lists.length > 0 && (
        <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '6px 0' }} />
      )}

      {/* List items */}
      {lists.map((list) => {
        const active = activeId === list.id;
        return (
          <div
            key={list.id}
            style={{ ...sidebarItem(active), paddingRight: 4 }}
            onClick={() => onSelect(list.id)}
          >
            <span style={{ fontSize: 16 }}>📋</span>
            <span style={{ flex: 1, fontSize: 12, color: active ? '#25d366' : 'var(--text-primary)', fontWeight: active ? 500 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {list.name}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'rgba(255,255,255,0.06)', padding: '1px 6px', borderRadius: 10, flexShrink: 0 }}>
              {list.contactCount}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onImportToList(list.id); }}
              title="Import Excel to this list"
              style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center', opacity: 0.7, flexShrink: 0 }}
            >
              <IcUpload />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); void onDelete(list.id); }}
              title="Delete list"
              style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '2px 4px', display: 'flex', alignItems: 'center', opacity: 0.6, flexShrink: 0 }}
            >
              <IcTrash />
            </button>
          </div>
        );
      })}

      {lists.length === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: '16px 8px', lineHeight: 1.5 }}>
          Select contacts and click "Save as Smart List"
        </div>
      )}
    </div>
  );
}

/* ── Save List Modal ────────────────────────────────────────── */
function SaveListModal({ contactCount, onSave, onClose }: { contactCount: number; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  const handle = async () => {
    if (!name.trim()) return;
    setLoading(true);
    try { await onSave(name.trim()); } finally { setLoading(false); }
  };

  const inp: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };

  return (
    <Modal open onClose={onClose} title="Save as Smart List" width={380}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        Saving <strong style={{ color: 'var(--text-primary)' }}>{contactCount}</strong> contact{contactCount !== 1 ? 's' : ''} to a new Smart List.
      </div>
      <label style={{ display: 'block', fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.8px', textTransform: 'uppercase' }}>List Name</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Hot leads June, Real estate prospects"
        style={inp}
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') void handle(); }}
      />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button loading={loading} onClick={handle} disabled={!name.trim()}>Create List</Button>
      </div>
    </Modal>
  );
}

/* ── Assign to List Modal ───────────────────────────────────── */
interface AssignToListModalProps {
  contactCount: number;
  lists: SmartList[];
  onAssignExisting: (listId: string) => Promise<void>;
  onCreateNew: (name: string) => Promise<void>;
  onClose: () => void;
}
function AssignToListModal({ contactCount, lists, onAssignExisting, onCreateNew, onClose }: AssignToListModalProps) {
  const [tab, setTab] = useState<'existing' | 'new'>(lists.length > 0 ? 'existing' : 'new');
  const [selectedId, setSelectedId] = useState('');
  const [newName, setNewName] = useState('');
  const [loading, setLoading] = useState(false);

  const canConfirm = tab === 'existing' ? !!selectedId : !!newName.trim();

  const handle = async () => {
    if (!canConfirm) return;
    setLoading(true);
    try {
      if (tab === 'existing') await onAssignExisting(selectedId);
      else await onCreateNew(newName.trim());
    } finally { setLoading(false); }
  };

  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: '7px 0', background: active ? 'rgba(37,211,102,0.12)' : 'rgba(255,255,255,0.03)',
    border: `1px solid ${active ? 'rgba(37,211,102,0.3)' : 'rgba(255,255,255,0.08)'}`,
    borderRadius: 7, color: active ? '#25d366' : 'var(--text-muted)', cursor: 'pointer',
    fontSize: 12, fontWeight: active ? 600 : 400, fontFamily: 'inherit', transition: 'all 0.12s',
  });

  const inp: React.CSSProperties = {
    width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit',
  };

  return (
    <Modal open onClose={onClose} title="Add to Smart List" width={430}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        Adding <strong style={{ color: 'var(--text-primary)' }}>{contactCount}</strong> contact{contactCount !== 1 ? 's' : ''} to a Smart List.
      </div>

      {/* Tab toggle */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button style={tabBtn(tab === 'existing')} onClick={() => setTab('existing')}>Existing List</button>
        <button style={tabBtn(tab === 'new')} onClick={() => setTab('new')}>New List</button>
      </div>

      {tab === 'existing' ? (
        lists.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' }}>
            No lists yet — switch to "New List" to create one.
          </div>
        ) : (
          <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {lists.map((list) => {
              const active = selectedId === list.id;
              return (
                <div key={list.id} onClick={() => setSelectedId(list.id)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, cursor: 'pointer', background: active ? 'rgba(37,211,102,0.08)' : 'rgba(255,255,255,0.03)', border: `1px solid ${active ? 'rgba(37,211,102,0.25)' : 'rgba(255,255,255,0.06)'}`, transition: 'all 0.1s' }}>
                  <div style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${active ? '#25d366' : 'rgba(255,255,255,0.2)'}`, background: active ? '#25d366' : 'transparent', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {active && <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }} />}
                  </div>
                  <span style={{ flex: 1, fontSize: 13, color: active ? 'var(--text-primary)' : 'var(--text-secondary)', fontWeight: active ? 500 : 400 }}>{list.name}</span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{list.contactCount} contacts</span>
                </div>
              );
            })}
          </div>
        )
      ) : (
        <>
          <label style={{ display: 'block', fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.8px', textTransform: 'uppercase' }}>List Name</label>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g. Hot leads June, Real estate prospects"
            style={inp}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') void handle(); }}
          />
        </>
      )}

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button loading={loading} onClick={handle} disabled={!canConfirm}>
          {tab === 'existing' ? 'Add to List' : 'Create & Add'}
        </Button>
      </div>
    </Modal>
  );
}

/* ── Contact form (add / edit) ──────────────────────────────── */
interface ContactFormProps {
  initial?: Partial<Contact>;
  onSave: (data: Partial<Contact>) => Promise<void>;
  onClose: () => void;
  loading: boolean;
  title: string;
}
function ContactForm({ initial, onSave, onClose, loading, title }: ContactFormProps) {
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [city, setCity] = useState(initial?.city ?? '');
  const [interest, setInterest] = useState(initial?.interest ?? '');
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [leadTemp, setLeadTemp] = useState<LeadTemp>(initial?.leadTemp ?? 'COLD');
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));

  const inp: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '9px 12px', color: 'var(--text-primary)', fontSize: 13, outline: 'none', fontFamily: 'inherit' };
  const lbl: React.CSSProperties = { display: 'block', fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 5, letterSpacing: '0.8px', textTransform: 'uppercase' };

  const handleSubmit = async () => {
    const parsedTags = tags.split(',').map((t) => t.trim()).filter(Boolean);
    await onSave({ phone: phone.trim(), name: name || undefined, city: city || undefined, interest: interest || undefined, notes: notes || undefined, leadTemp, tags: parsedTags });
  };

  return (
    <Modal open onClose={onClose} title={title} width={500}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10 }}>
          <div>
            <label style={lbl}>Phone (E.164)</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+923001234567" style={inp} disabled={!!initial?.id} />
          </div>
          <div>
            <label style={lbl}>Temperature</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {(['HOT','WARM','COLD'] as LeadTemp[]).map((t) => {
                const cfg = TEMP_CFG[t];
                return (
                  <button key={t} onClick={() => setLeadTemp(t)} style={{ background: leadTemp === t ? cfg.bg : 'rgba(255,255,255,0.03)', color: leadTemp === t ? cfg.color : 'var(--text-muted)', border: `1px solid ${leadTemp === t ? cfg.color + '40' : 'transparent'}`, borderRadius: 8, padding: '8px 14px', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'uppercase', letterSpacing: '0.5px', transition: 'all 0.15s' }}>
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div><label style={lbl}>Name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ahmed Khan" style={inp} /></div>
          <div><label style={lbl}>City</label><input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Karachi" style={inp} /></div>
        </div>
        <div><label style={lbl}>Interest / Product</label><input value={interest} onChange={(e) => setInterest(e.target.value)} placeholder="e.g. Solar panels, Real estate, Clothing" style={inp} /></div>
        <div><label style={lbl}>Tags (comma-separated)</label><input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, follow-up, warm-lead" style={inp} /></div>
        <div>
          <label style={lbl}>Notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Any notes about this contact..." style={{ ...inp, resize: 'vertical' }} />
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button loading={loading} onClick={handleSubmit} disabled={!phone.trim()}>Save Contact</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Notes modal ────────────────────────────────────────────── */
function NotesModal({ contact, onClose, onSaved }: { contact: Contact; onClose: () => void; onSaved: () => void }) {
  const [notes, setNotes] = useState(contact.notes ?? '');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const save = async () => {
    setLoading(true);
    try {
      await apiFetch(`/contacts/${contact.id}`, { method: 'PATCH', body: JSON.stringify({ notes }) });
      toast('Notes saved', 'success');
      onSaved();
      onClose();
    } catch (err) { toast(String(err), 'error'); }
    finally { setLoading(false); }
  };

  return (
    <Modal open onClose={onClose} title={`Notes — ${contact.name ?? contact.phone}`} width={440}>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={6}
        placeholder="Notes about this contact..."
        style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none' }}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button loading={loading} onClick={save}>Save Notes</Button>
      </div>
    </Modal>
  );
}

/* ── Schedule modal ─────────────────────────────────────────── */
function ScheduleModal({ contactIds, onClose, onDone }: { contactIds: string[]; onClose: () => void; onDone: () => void }) {
  const { data: campaigns } = useSWR<Campaign[]>('/campaigns', (url: string) => apiFetch<Campaign[]>(url));
  const [selectedCampaign, setSelectedCampaign] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const draftCampaigns = (campaigns ?? []).filter((c) => c.status === 'DRAFT' || c.status === 'PAUSED' || c.status === 'RUNNING');

  const launch = async () => {
    if (!selectedCampaign) return;
    setLoading(true);
    try {
      await apiFetch(`/campaigns/${selectedCampaign}/launch`, {
        method: 'POST',
        body: JSON.stringify({ contactIds }),
      });
      toast(`${contactIds.length} contact(s) scheduled!`, 'success');
      onDone();
      onClose();
    } catch (err) { toast(String(err), 'error'); }
    finally { setLoading(false); }
  };

  const selStyle: React.CSSProperties = { width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none', cursor: 'pointer' };

  return (
    <Modal open onClose={onClose} title="Schedule to Campaign" width={420}>
      <div style={{ marginBottom: 14, fontSize: 13, color: 'var(--text-muted)' }}>
        Scheduling <strong style={{ color: 'var(--text-primary)' }}>{contactIds.length}</strong> contact(s) to a campaign.
      </div>
      {draftCampaigns.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          No DRAFT or PAUSED campaigns available.<br />Create a campaign first.
        </div>
      ) : (
        <>
          <label style={{ display: 'block', fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, letterSpacing: '0.8px', textTransform: 'uppercase' }}>Select Campaign</label>
          <select value={selectedCampaign} onChange={(e) => setSelectedCampaign(e.target.value)} style={selStyle}>
            <option value="">— choose campaign —</option>
            {draftCampaigns.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 16 }}>
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button loading={loading} onClick={launch} disabled={!selectedCampaign}>Launch</Button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ── phone normaliser ───────────────────────────────────────── */
// Salvage a sendable E.164 number from messy input: strips every non-digit (spaces,
// dashes, dots, slashes, parens), drops a leading "00" international prefix, and requires
// a non-zero first digit + 7–15 digits (matches the backend's isValidE164). Excel cells
// stored as numbers stringify cleanly here too. Returns '' when nothing valid can be built.
function toE164(raw: unknown): string {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!digits) return '';
  const e164 = `+${digits}`;
  return /^\+[1-9]\d{6,14}$/.test(e164) ? e164 : '';
}

/* ── Import modal ───────────────────────────────────────────── */
interface ParsedContact { phone: string; name?: string; city?: string; interest?: string; notes?: string; leadTemp?: LeadTemp }

// RFC 4180 compliant CSV line parser — handles quoted commas and escaped quotes
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i += 2; }
        else { inQuotes = false; i++; }
      } else { current += ch; i++; }
    } else {
      if (ch === '"') { inQuotes = true; i++; }
      else if (ch === ',') { fields.push(current.trim()); current = ''; i++; }
      else { current += ch; i++; }
    }
  }
  fields.push(current.trim());
  return fields;
}

// Returns the valid contacts plus the total data-row count so callers can report how
// many rows were skipped for a blank/invalid phone (rather than dropping them silently).
interface ParseResult { valid: ParsedContact[]; total: number }

function parseCSV(text: string): ParseResult {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { valid: [], total: 0 };
  // normalise header: lowercase, strip spaces/underscores so "Lead Temp" == "leadtemp"
  const header = parseCSVLine(lines[0] ?? '').map((h) => h.toLowerCase().replace(/[\s_]/g, ''));
  const idx = (col: string) => header.indexOf(col);
  const dataRows = lines.slice(1);
  const valid = dataRows.map((line) => {
    const cols = parseCSVLine(line);
    const phone = toE164(idx('phone') >= 0 ? cols[idx('phone')] : cols[0]);
    const name = (idx('name') >= 0 ? cols[idx('name')] : cols[1]) || undefined;
    const city = (idx('city') >= 0 ? cols[idx('city')] : cols[2]) || undefined;
    const interest = idx('interest') >= 0 ? cols[idx('interest')] || undefined : undefined;
    const notes = idx('notes') >= 0 ? cols[idx('notes')] || undefined : undefined;
    const rawT = idx('leadtemp') >= 0 ? cols[idx('leadtemp')]?.toUpperCase() : undefined;
    const leadTemp: LeadTemp | undefined = (['HOT','WARM','COLD'] as string[]).includes(rawT ?? '') ? rawT as LeadTemp : undefined;
    return { phone, name, city, interest, notes, leadTemp };
  }).filter((c) => c.phone.length > 0);
  return { valid, total: dataRows.length };
}

function parseExcel(buffer: ArrayBuffer): ParseResult {
  const wb = XLSX.read(buffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' });
  const valid = rows.map((row) => {
    const get = (...keys: string[]) => {
      for (const k of keys) {
        const found = Object.entries(row).find(([rk]) => rk.toLowerCase().includes(k.toLowerCase()));
        if (found && found[1] !== '') return String(found[1]);
      }
      return '';
    };
    const phone = toE164(get('sender phone', 'phone', 'mobile', 'sender mobile'));
    const name  = get('sender name', 'name', 'full name');
    const city  = get('location', 'city', 'area');
    const interest = get('category', 'interest', 'product');
    const email    = get('email', 'sender email');
    const price    = get('price', 'budget');
    const subLoc   = get('sub location', 'sublocation', 'sub_location');
    const country  = get('sender country', 'country');
    const noteParts = [email && `Email: ${email}`, price && `Budget: ${price}`, subLoc && `Area: ${subLoc}`, country && `Country: ${country}`].filter(Boolean);
    return {
      phone,
      name: name || undefined,
      city: city || undefined,
      interest: interest || undefined,
      notes: noteParts.length ? noteParts.join(' | ') : undefined,
    };
  }).filter((c) => c.phone.length > 0);
  return { valid, total: rows.length };
}

function ImportModal({ onClose, onDone, smartListId, listName }: { onClose: () => void; onDone: () => void; smartListId?: string; listName?: string }) {
  const [csvText, setCsvText] = useState('');
  const [parsed, setParsed] = useState<ParsedContact[] | null>(null);
  const [parseSkipped, setParseSkipped] = useState(0);
  const [fileName, setFileName] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const isExcel = file.name.match(/\.xlsx?$/i);
    if (isExcel) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const data = ev.target?.result as ArrayBuffer;
        try {
          const { valid, total } = parseExcel(data);
          setParsed(valid);
          setParseSkipped(total - valid.length);
          setCsvText('');
          const dropped = total - valid.length;
          toast(
            `${valid.length} valid contacts parsed${dropped > 0 ? ` — ${dropped} skipped (blank/invalid phone)` : ''}`,
            dropped > 0 ? 'warning' : 'success',
          );
        } catch { toast('Failed to parse Excel file', 'error'); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = (ev) => { setCsvText((ev.target?.result as string) ?? ''); setParsed(null); setParseSkipped(0); };
      reader.readAsText(file);
    }
  };

  const getContacts = (): ParsedContact[] => parsed ?? parseCSV(csvText).valid;

  const handleImport = async () => {
    setLoading(true);
    try {
      const contacts = getContacts();
      if (!contacts.length) { toast('No valid rows found', 'error'); return; }
      const CHUNK = 500;
      let totalImported = 0;
      let totalDuplicates = 0;
      let totalSkipped = parseSkipped; // rows already dropped at parse for a bad phone
      const total = contacts.length;
      for (let i = 0; i < contacts.length; i += CHUNK) {
        const slice = contacts.slice(i, i + CHUNK);
        const done = Math.min(i + CHUNK, total);
        setProgress(`Importing ${done} / ${total}…`);
        const r = await apiFetch<{ imported: number; skipped: number; duplicates: number }>('/contacts/import', {
          method: 'POST',
          body: JSON.stringify({ contacts: slice, ...(smartListId ? { smartListId } : {}) }),
        });
        totalImported += r.imported;
        totalDuplicates += r.duplicates ?? 0;
        totalSkipped += r.skipped;
      }
      setProgress('');
      const parts = [`Imported ${totalImported} new`];
      if (totalDuplicates) parts.push(`${totalDuplicates} already existed`);
      if (totalSkipped) parts.push(`${totalSkipped} skipped (invalid phone)`);
      toast(parts.join(' · '), 'success');
      onDone();
      onClose();
    } catch (err) { toast(String(err), 'error'); setProgress(''); }
    finally { setLoading(false); }
  };

  const rowCount = parsed ? parsed.length : Math.max(0, csvText.split(/\r?\n/).filter((l) => l.trim()).length - 1);
  const hasData = parsed !== null || csvText.trim().length > 0;

  return (
    <Modal open onClose={onClose} title={listName ? `Import to "${listName}"` : 'Import Contacts'} width={580}>
      {listName && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14, padding: '8px 12px', background: 'rgba(212,175,55,0.05)', border: '1px solid rgba(212,175,55,0.15)', borderRadius: 8 }}>
          Contacts will be imported and automatically added to <span style={{ color: '#D4AF37', fontWeight: 600 }}>{listName}</span>.
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, alignItems: 'center' }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', flex: 1 }}>
          {fileName
            ? <span style={{ color: '#25d366' }}>{fileName}</span>
            : <>Supports <code style={{ color: '#25d366', fontSize: 11 }}>.xlsx</code> Excel files and <code style={{ color: '#25d366', fontSize: 11 }}>.csv</code> text</>}
        </div>
        <button onClick={() => fileRef.current?.click()} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 7, color: 'var(--text-primary)', cursor: 'pointer', padding: '6px 12px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' }}>
          <IcUpload /> Upload File
        </button>
        <input ref={fileRef} type="file" accept=".csv,.txt,.xlsx,.xls" style={{ display: 'none' }} onChange={handleFile} />
      </div>

      {parsed !== null ? (
        <div style={{ background: 'rgba(37,211,102,0.04)', border: '1px solid rgba(37,211,102,0.12)', borderRadius: 10, padding: '12px 14px', maxHeight: 220, overflowY: 'auto' }}>
          <div style={{ fontSize: 10, color: '#25d366', fontWeight: 600, letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: 8 }}>Excel preview — {parsed.length} rows</div>
          {parsed.slice(0, 8).map((c, i) => (
            <div key={i} style={{ fontSize: 11, color: 'var(--text-muted)', padding: '3px 0', borderBottom: '1px solid rgba(255,255,255,0.04)', display: 'flex', gap: 10 }}>
              <span style={{ color: 'var(--text-primary)', minWidth: 130 }}>{c.phone}</span>
              <span>{c.name ?? '—'}</span>
              {c.city && <span style={{ color: '#60a5fa' }}>{c.city}</span>}
              {c.interest && <span style={{ color: '#f59e0b' }}>{c.interest}</span>}
            </div>
          ))}
          {parsed.length > 8 && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>…and {parsed.length - 8} more</div>}
        </div>
      ) : (
        <textarea
          value={csvText}
          onChange={(e) => { setCsvText(e.target.value); setParsed(null); }}
          rows={10}
          placeholder={`phone,name,city,interest,notes,leadTemp\n+923001234567,Ahmed,Karachi,Solar panels,,HOT\n+923009876543,Sara,Lahore,Real estate,,WARM`}
          style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '10px 14px', color: 'var(--text-primary)', fontSize: 12, fontFamily: 'monospace', resize: 'vertical', outline: 'none' }}
        />
      )}

      {hasData && !progress && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
          {rowCount} row{rowCount !== 1 ? 's' : ''} ready to import
        </div>
      )}
      {progress && <div style={{ marginTop: 8, fontSize: 11, color: '#25d366' }}>{progress}</div>}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 14 }}>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button loading={loading} onClick={handleImport} disabled={!hasData}>Import {rowCount > 0 ? `${rowCount} contacts` : ''}</Button>
      </div>
    </Modal>
  );
}

/* ── Main page ──────────────────────────────────────────────── */
type TempFilter = 'ALL' | LeadTemp;
const TAKE = 50;

interface ContactsPageData {
  data: Contact[];
  total: number;
  skip: number;
  take: number;
}

function ContactsContent() {
  const searchParams = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [validFilter, setValidFilter] = useState<'ALL' | 'VALID' | 'INVALID'>('ALL');
  const [tempFilter, setTempFilter] = useState<TempFilter>('ALL');
  const [activeSmartListId, setActiveSmartListId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [notesContact, setNotesContact] = useState<Contact | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importSmartListId, setImportSmartListId] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [saveListOpen, setSaveListOpen] = useState(false);
  const [assignListOpen, setAssignListOpen] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [validateLoading, setValidateLoading] = useState(false);
  const { toast } = useToast();

  // Smart lists
  const { data: smartLists = [], mutate: mutateLists } = useSWR<SmartList[]>(
    '/smart-lists',
    (url: string) => apiFetch<SmartList[]>(url),
  );

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [search, validFilter, tempFilter, activeSmartListId]);

  const queryParts: string[] = [];
  if (search) queryParts.push(`search=${encodeURIComponent(search)}`);
  if (validFilter === 'VALID') queryParts.push('valid=true');
  if (validFilter === 'INVALID') queryParts.push('valid=false');
  if (tempFilter !== 'ALL') queryParts.push(`leadTemp=${tempFilter}`);
  if (activeSmartListId) queryParts.push(`smartListId=${activeSmartListId}`);
  queryParts.push(`skip=${page * TAKE}`);
  queryParts.push(`take=${TAKE}`);
  const query = `?${queryParts.join('&')}`;

  const { data, isLoading, mutate } = useSWR<ContactsPageData>(
    `/contacts${query}`,
    (url: string) => apiFetch<ContactsPageData>(url),
    { keepPreviousData: true },
  );

  // Total contacts (unfiltered) for sidebar badge
  const { data: totalData } = useSWR<ContactsPageData>(
    '/contacts?take=1',
    (url: string) => apiFetch<ContactsPageData>(url),
  );

  const contacts = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / TAKE);
  const valid = contacts.filter((c) => c.valid).length;
  const hot = contacts.filter((c) => c.leadTemp === 'HOT').length;

  const toggleSelect = (id: string) => setSelected((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this contact?')) return;
    try {
      await apiFetch(`/contacts/${id}`, { method: 'DELETE' });
      toast('Contact deleted', 'success');
      mutate();
    } catch (err) { toast(String(err), 'error'); }
  };

  const handleBulkDelete = async () => {
    if (!selected.size) return;
    if (!confirm(`Delete ${selected.size} contacts?`)) return;
    try {
      const result = await apiFetch<{ deleted: number }>('/contacts/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: [...selected] }) });
      toast(`Deleted ${result.deleted} contacts`, 'success');
      setSelected(new Set());
      setPage(0);
      mutate();
    } catch (err) { toast(String(err), 'error'); }
  };

  const handleValidate = async () => {
    setValidateLoading(true);
    try {
      const r = await apiFetch<{ valid: number; invalid: number }>('/contacts/validate', { method: 'POST' });
      toast(`${r.valid} valid, ${r.invalid} invalid`, 'success');
      mutate();
    } catch (err) { toast(String(err), 'error'); }
    finally { setValidateLoading(false); }
  };

  const handleAddSave = async (data: Partial<Contact>) => {
    setFormLoading(true);
    try {
      await apiFetch('/contacts', { method: 'POST', body: JSON.stringify(data) });
      toast('Contact added', 'success');
      setAddOpen(false);
      mutate();
    } catch (err) { toast(String(err), 'error'); }
    finally { setFormLoading(false); }
  };

  const handleEditSave = async (data: Partial<Contact>) => {
    if (!editContact) return;
    setFormLoading(true);
    try {
      await apiFetch(`/contacts/${editContact.id}`, { method: 'PATCH', body: JSON.stringify(data) });
      toast('Contact updated', 'success');
      setEditContact(null);
      mutate();
    } catch (err) { toast(String(err), 'error'); }
    finally { setFormLoading(false); }
  };

  const handleTempChange = async (contact: Contact, leadTemp: LeadTemp) => {
    try {
      await apiFetch(`/contacts/${contact.id}`, { method: 'PATCH', body: JSON.stringify({ leadTemp }) });
      mutate();
    } catch (err) { toast(String(err), 'error'); }
  };

  // Smart list actions
  const handleSaveAsList = async (name: string) => {
    try {
      await apiFetch('/smart-lists', {
        method: 'POST',
        body: JSON.stringify({ name, contactIds: [...selected] }),
      });
      toast(`Smart List "${name}" created with ${selected.size} contacts`, 'success');
      setSaveListOpen(false);
      setSelected(new Set());
      mutateLists();
    } catch (err) { toast(String(err), 'error'); }
  };

  const handleAssignToExistingList = async (listId: string) => {
    try {
      const r = await apiFetch<{ added: number }>(`/smart-lists/${listId}/contacts`, {
        method: 'POST',
        body: JSON.stringify({ contactIds: [...selected] }),
      });
      toast(`Added ${r.added} contact(s) to list`, 'success');
      setAssignListOpen(false);
      setSelected(new Set());
      mutateLists();
      mutate();
    } catch (err) { toast(String(err), 'error'); }
  };

  const handleAssignAsNewList = async (name: string) => {
    try {
      await apiFetch('/smart-lists', {
        method: 'POST',
        body: JSON.stringify({ name, contactIds: [...selected] }),
      });
      toast(`Smart List "${name}" created with ${selected.size} contacts`, 'success');
      setAssignListOpen(false);
      setSelected(new Set());
      mutateLists();
    } catch (err) { toast(String(err), 'error'); }
  };

  const handleRemoveFromList = async () => {
    if (!activeSmartListId || !selected.size) return;
    if (!confirm(`Remove ${selected.size} contact(s) from this list?`)) return;
    try {
      const r = await apiFetch<{ removed: number }>(`/smart-lists/${activeSmartListId}/contacts`, {
        method: 'DELETE',
        body: JSON.stringify({ contactIds: [...selected] }),
      });
      toast(`Removed ${r.removed} contact(s) from list`, 'success');
      setSelected(new Set());
      mutateLists();
      mutate();
    } catch (err) { toast(String(err), 'error'); }
  };

  const handleDeleteList = async (id: string) => {
    if (!confirm('Delete this Smart List? Contacts are not deleted.')) return;
    try {
      await apiFetch(`/smart-lists/${id}`, { method: 'DELETE' });
      toast('Smart List deleted', 'success');
      if (activeSmartListId === id) setActiveSmartListId(null);
      mutateLists();
    } catch (err) { toast(String(err), 'error'); }
  };

  const activeList = smartLists.find((l) => l.id === activeSmartListId) ?? null;

  return (
    <DashLayout title="Contacts" onRefresh={() => { mutate(); mutateLists(); }}>
      {/* Top bar */}
      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginBottom: 20 }}>
        <Button variant="outline" loading={validateLoading} onClick={handleValidate}>Validate All</Button>
        <Button variant="outline" onClick={() => { setImportSmartListId(activeSmartListId); setImportOpen(true); }}>Import Excel / CSV</Button>
        <Button onClick={() => setAddOpen(true)}>+ Add Contact</Button>
      </div>

      {/* Two-column layout: Smart Lists sidebar + Contact table */}
      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start' }}>

        {/* ── Smart Lists Sidebar ── */}
        <div className="glass" style={{ borderRadius: 14, padding: '16px 14px', position: 'sticky', top: 24 }}>
          <SmartListsSidebar
            lists={smartLists}
            activeId={activeSmartListId}
            totalContacts={totalData?.total ?? 0}
            onSelect={(id) => { setActiveSmartListId(id); setSelected(new Set()); }}
            onDelete={handleDeleteList}
            onNewList={() => setSaveListOpen(true)}
            onImportToList={(id) => { setImportSmartListId(id); setImportOpen(true); }}
          />
        </div>

        {/* ── Right: Contacts Table ── */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Stat cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
            {[
              { label: activeList ? activeList.name : 'Total', value: total, color: activeList ? '#25d366' : 'var(--text-primary)' },
              { label: 'Valid', value: valid, color: '#25d366' },
              { label: 'Hot leads', value: hot, color: '#ef4444' },
              { label: 'Selected', value: selected.size, color: '#f59e0b' },
            ].map(({ label, value, color }) => (
              <div key={label} className="glass" style={{ borderRadius: 12, padding: '14px 16px' }}>
                <div style={{ fontSize: 26, fontWeight: 600, color, letterSpacing: '-0.5px', lineHeight: 1 }}>{value}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.8px', marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</div>
              </div>
            ))}
          </div>

          {/* Filters row */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 160, position: 'relative' }}>
              <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}><IcSearch /></span>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search…" style={{ width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '8px 14px 8px 34px', color: 'var(--text-primary)', fontSize: 13, fontFamily: 'inherit', outline: 'none' }} />
            </div>
            {(['ALL', 'VALID', 'INVALID'] as const).map((f) => (
              <button key={f} onClick={() => setValidFilter(f)} style={{ background: validFilter === f ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)', color: validFilter === f ? 'var(--text-primary)' : 'var(--text-muted)', border: `1px solid ${validFilter === f ? 'rgba(255,255,255,0.1)' : 'transparent'}`, borderRadius: 8, padding: '7px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
                {f}
              </button>
            ))}
            {(['ALL', 'HOT', 'WARM', 'COLD'] as const).map((t) => {
              const cfg = t !== 'ALL' ? TEMP_CFG[t] : null;
              return (
                <button key={t} onClick={() => setTempFilter(t)} style={{ background: tempFilter === t ? (cfg?.bg ?? 'rgba(255,255,255,0.07)') : 'rgba(255,255,255,0.03)', color: tempFilter === t ? (cfg?.color ?? 'var(--text-primary)') : 'var(--text-muted)', border: `1px solid ${tempFilter === t ? (cfg?.color ?? 'rgba(255,255,255,0.1)') + '40' : 'transparent'}`, borderRadius: 8, padding: '7px 12px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', fontWeight: tempFilter === t ? 600 : 400, textTransform: 'uppercase', letterSpacing: '0.4px' }}>
                  {t}
                </button>
              );
            })}
          </div>

          {/* Bulk action bar */}
          {selected.size > 0 && (
            <div style={{ background: 'rgba(37,211,102,0.06)', border: '1px solid rgba(37,211,102,0.12)', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: '#25d366', fontWeight: 500 }}>{selected.size} selected</span>
              <Button size="sm" onClick={() => setSaveListOpen(true)}>📋 Save as New List</Button>
              <Button size="sm" variant="outline" onClick={() => setAssignListOpen(true)}>+ Add to List</Button>
              {activeSmartListId && (
                <Button size="sm" variant="outline" onClick={handleRemoveFromList}>— Remove from List</Button>
              )}
              <Button size="sm" onClick={() => setScheduleOpen(true)}>Schedule to Campaign</Button>
              <Button size="sm" variant="danger" onClick={handleBulkDelete}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
            </div>
          )}

          {/* Table */}
          <div className="glass" style={{ borderRadius: 14, overflow: 'hidden' }}>
            {isLoading ? (
              <div style={{ padding: '20px 22px' }}><SkeletonRows rows={8} cols={7} /></div>
            ) : contacts.length === 0 ? (
              <EmptyState
                icon={<IcUsers />}
                title={activeList ? `No contacts in "${activeList.name}"` : 'No contacts'}
                subtitle={activeList ? 'Select contacts from All Contacts and add them to this list' : 'Add contacts or import a CSV to start your outreach'}
                action={<Button onClick={() => setAddOpen(true)}>Add Contact</Button>}
              />
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      <th style={thStyle}>
                        <input type="checkbox" onChange={(e) => { if (e.target.checked) setSelected(new Set(contacts.map((c) => c.id))); else setSelected(new Set()); }} checked={selected.size === contacts.length && contacts.length > 0} style={{ accentColor: '#25d366' }} />
                      </th>
                      {['Phone', 'Name', 'City', 'Interest', 'Temperature', 'Notes', 'Tags', 'Valid', ''].map((h) => (
                        <th key={h} style={thStyle}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((c) => (
                      <tr key={c.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={tdStyle}><input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleSelect(c.id)} style={{ accentColor: '#25d366' }} /></td>
                        <td style={{ ...tdStyle, fontWeight: 500 }}>{c.phone}</td>
                        <td style={{ ...tdStyle, color: 'var(--text-muted)' }}>{c.name ?? '—'}</td>
                        <td style={{ ...tdStyle, color: 'var(--text-muted)' }}>{c.city ?? '—'}</td>
                        <td style={{ ...tdStyle, color: 'var(--text-muted)', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.interest ?? '—'}</td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', gap: 3 }}>
                            {(['HOT','WARM','COLD'] as LeadTemp[]).map((t) => {
                              const cfg = TEMP_CFG[t];
                              const active = c.leadTemp === t;
                              return (
                                <button key={t} onClick={() => handleTempChange(c, t)} title={cfg.label} style={{ background: active ? cfg.bg : 'transparent', border: `1px solid ${active ? cfg.color + '50' : 'rgba(255,255,255,0.06)'}`, color: active ? cfg.color : 'var(--text-muted)', borderRadius: 5, width: 26, height: 22, fontSize: 9, cursor: 'pointer', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px', fontFamily: 'inherit', transition: 'all 0.1s' }}>
                                  {t[0]}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                        <td style={tdStyle}>
                          <button onClick={() => setNotesContact(c)} title={c.notes ? c.notes.slice(0, 80) : 'Add notes'} style={{ background: c.notes ? 'rgba(96,165,250,0.1)' : 'transparent', border: `1px solid ${c.notes ? 'rgba(96,165,250,0.2)' : 'rgba(255,255,255,0.06)'}`, color: c.notes ? '#60a5fa' : 'var(--text-muted)', borderRadius: 6, width: 28, height: 26, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <IcNote />
                          </button>
                        </td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                            {c.tags.map((t) => (
                              <span key={t} style={{ background: `${tagColor(t)}18`, color: tagColor(t), borderRadius: 20, padding: '1px 7px', fontSize: 10, fontWeight: 500 }}>{t}</span>
                            ))}
                          </div>
                        </td>
                        <td style={tdStyle}>{c.valid ? <IcCheck /> : <IcX />}</td>
                        <td style={tdStyle}>
                          <div style={{ display: 'flex', gap: 5 }}>
                            <button onClick={() => setEditContact(c)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: 'var(--text-muted)', cursor: 'pointer', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IcEdit /></button>
                            <button onClick={() => handleDelete(c.id)} style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.1)', borderRadius: 6, color: '#ef4444', cursor: 'pointer', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><IcTrash /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 14 }}>
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: page === 0 ? 'var(--text-muted)' : 'var(--text-primary)', cursor: page === 0 ? 'default' : 'pointer', padding: '6px 16px', fontSize: 13, fontFamily: 'inherit' }}>
                ← Prev
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Page {page + 1} of {totalPages} · {total} contacts</span>
              <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, color: page >= totalPages - 1 ? 'var(--text-muted)' : 'var(--text-primary)', cursor: page >= totalPages - 1 ? 'default' : 'pointer', padding: '6px 16px', fontSize: 13, fontFamily: 'inherit' }}>
                Next →
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {addOpen && <ContactForm title="Add Contact" onSave={handleAddSave} onClose={() => setAddOpen(false)} loading={formLoading} />}
      {editContact && <ContactForm title="Edit Contact" initial={editContact} onSave={handleEditSave} onClose={() => setEditContact(null)} loading={formLoading} />}
      {notesContact && <NotesModal contact={notesContact} onClose={() => setNotesContact(null)} onSaved={() => mutate()} />}
      {importOpen && <ImportModal
        onClose={() => { setImportOpen(false); setImportSmartListId(null); }}
        onDone={() => { mutate(); mutateLists(); }}
        smartListId={importSmartListId ?? undefined}
        listName={importSmartListId ? (smartLists.find((l) => l.id === importSmartListId)?.name) : undefined}
      />}
      {scheduleOpen && <ScheduleModal contactIds={[...selected]} onClose={() => setScheduleOpen(false)} onDone={() => setSelected(new Set())} />}
      {saveListOpen && (
        <SaveListModal
          contactCount={selected.size || 0}
          onSave={handleSaveAsList}
          onClose={() => setSaveListOpen(false)}
        />
      )}
      {assignListOpen && (
        <AssignToListModal
          contactCount={selected.size}
          lists={smartLists}
          onAssignExisting={handleAssignToExistingList}
          onCreateNew={handleAssignAsNewList}
          onClose={() => setAssignListOpen(false)}
        />
      )}
    </DashLayout>
  );
}

const thStyle: React.CSSProperties = { textAlign: 'left', padding: '11px 12px', fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', letterSpacing: '0.8px', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.05)', whiteSpace: 'nowrap' };
const tdStyle: React.CSSProperties = { padding: '9px 12px', verticalAlign: 'middle' };

export default function ContactsPage() {
  return (
    <ToastProvider>
      <Suspense fallback={null}>
        <ContactsContent />
      </Suspense>
    </ToastProvider>
  );
}
