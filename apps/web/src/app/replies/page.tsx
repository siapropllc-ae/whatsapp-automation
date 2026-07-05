'use client';

import React, { useEffect, useState } from 'react';
import useSWR from 'swr';
import { formatDistanceToNow } from 'date-fns';
import { DashLayout } from '@/components/DashLayout';
import { Button } from '@/components/Button';
import { SkeletonRows } from '@/components/Skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useToast, ToastProvider } from '@/components/Toast';
import { apiFetch } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import type { Reply } from '@/types/api';

type SentimentFilter = 'ALL' | 'HOT' | 'WARM' | 'COLD' | 'NEGATIVE';
type HandledFilter = 'ALL' | 'unhandled' | 'handled';

const SENTIMENT_COLORS: Record<string, string> = {
  HOT: '#ef4444',
  WARM: '#f59e0b',
  COLD: '#60a5fa',
  NEGATIVE: '#6b7280',
};

const IcReply = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
  </svg>
);

function SentimentBadge({ sentiment }: { sentiment: string | null }) {
  if (!sentiment) return <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>pending</span>;
  const color = SENTIMENT_COLORS[sentiment] ?? '#888';
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color, background: `${color}18`, border: `1px solid ${color}30`, borderRadius: 6, padding: '2px 8px', letterSpacing: '0.6px' }}>
      {sentiment}
    </span>
  );
}

function ButtonTapBadge({ label }: { label: string }) {
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color: '#25d366', background: 'rgba(37,211,102,0.1)', border: '1px solid rgba(37,211,102,0.2)', borderRadius: 6, padding: '2px 8px', letterSpacing: '0.4px', marginRight: 6, whiteSpace: 'nowrap' }}>
      🔘 {label}
    </span>
  );
}

interface NewReplyEvent { contactId: string; phone: string; text: string; campaignId: string | null; at: string }

function RepliesContent() {
  const { toast } = useToast();
  const [sentiment, setSentiment] = useState<SentimentFilter>('ALL');
  const [handledFilter, setHandledFilter] = useState<HandledFilter>('ALL');
  const [liveCount, setLiveCount] = useState(0);

  const qs = new URLSearchParams();
  if (sentiment !== 'ALL') qs.set('sentiment', sentiment);
  if (handledFilter !== 'ALL') qs.set('handled', handledFilter === 'handled' ? 'true' : 'false');
  qs.set('take', '50');

  const { data, isLoading, mutate } = useSWR<Reply[]>(
    `/replies?${qs.toString()}`,
    (url: string) => apiFetch<Reply[]>(url),
    { refreshInterval: 15000 },
  );

  useEffect(() => {
    const socket = getSocket();
    const handler = (_payload: NewReplyEvent) => {
      setLiveCount((n) => n + 1);
      void mutate();
    };
    socket.on('reply:new', handler);
    return () => { socket.off('reply:new', handler); };
  }, [mutate]);

  const handleMarkHandled = async (id: string, handled: boolean) => {
    try {
      await apiFetch(`/replies/${id}`, { method: 'PATCH', body: JSON.stringify({ handled }) });
      toast(handled ? 'Marked as handled' : 'Reopened', 'success');
      void mutate();
    } catch (err) { toast(String(err), 'error'); }
  };

  const SENTIMENT_TABS: { label: string; value: SentimentFilter; color?: string }[] = [
    { label: 'All', value: 'ALL' },
    { label: 'Hot', value: 'HOT', color: '#ef4444' },
    { label: 'Warm', value: 'WARM', color: '#f59e0b' },
    { label: 'Cold', value: 'COLD', color: '#60a5fa' },
    { label: 'Negative', value: 'NEGATIVE', color: '#6b7280' },
  ];

  const replies = data ?? [];

  return (
    <DashLayout title="Replies" onRefresh={() => mutate()}>
      {liveCount > 0 && (
        <div
          onClick={() => { setLiveCount(0); void mutate(); }}
          style={{ background: 'rgba(37,211,102,0.1)', border: '1px solid rgba(37,211,102,0.2)', borderRadius: 10, padding: '10px 16px', marginBottom: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#25d366', display: 'inline-block', boxShadow: '0 0 8px #25d366' }} />
          <span style={{ color: '#25d366', fontWeight: 500 }}>{liveCount} new {liveCount === 1 ? 'reply' : 'replies'} received</span>
          <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontSize: 11 }}>Click to refresh</span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {SENTIMENT_TABS.map((tab) => {
            const active = sentiment === tab.value;
            return (
              <button
                key={tab.value}
                onClick={() => setSentiment(tab.value)}
                style={{
                  background: active ? (tab.color ? `${tab.color}18` : 'rgba(255,255,255,0.07)') : 'rgba(255,255,255,0.03)',
                  color: active ? (tab.color ?? 'var(--text-primary)') : 'var(--text-muted)',
                  border: `1px solid ${active ? (tab.color ? `${tab.color}30` : 'rgba(255,255,255,0.1)') : 'transparent'}`,
                  borderRadius: 8, padding: '6px 14px', fontSize: 12, fontWeight: active ? 500 : 400,
                  cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}
              >
                {tab.color && <span style={{ width: 5, height: 5, borderRadius: '50%', background: tab.color, display: 'inline-block' }} />}
                {tab.label}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['ALL', 'unhandled', 'handled'] as HandledFilter[]).map((h) => (
            <button
              key={h}
              onClick={() => setHandledFilter(h)}
              style={{
                background: handledFilter === h ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.03)',
                color: handledFilter === h ? 'var(--text-primary)' : 'var(--text-muted)',
                border: `1px solid ${handledFilter === h ? 'rgba(255,255,255,0.1)' : 'transparent'}`,
                borderRadius: 8, padding: '6px 14px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s',
              }}
            >
              {h === 'ALL' ? 'All' : h === 'unhandled' ? 'Open' : 'Handled'}
            </button>
          ))}
        </div>
      </div>

      <div className="glass" style={{ borderRadius: 14, overflow: 'hidden' }}>
        {isLoading ? (
          <div style={{ padding: '20px 22px' }}><SkeletonRows rows={6} cols={5} /></div>
        ) : replies.length === 0 ? (
          <EmptyState icon={<IcReply />} title="No replies yet" subtitle="Replies from contacts will appear here in real-time" />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Contact', 'Message', 'Sentiment', 'Intent', 'Received', 'Action'].map((h) => (
                  <th key={h} style={{ textAlign: 'left', padding: '14px 18px', fontSize: 10, fontWeight: 500, color: 'var(--text-muted)', letterSpacing: '0.8px', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {replies.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: !r.handled ? 'rgba(37,211,102,0.02)' : 'transparent', transition: 'background 0.1s' }}>
                  <td style={{ padding: '13px 18px', fontSize: 12 }}>
                    <div style={{ fontWeight: 500, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                      {r.contactPhone}
                      {!r.handled && <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#25d366', display: 'inline-block', flexShrink: 0, boxShadow: '0 0 5px #25d366' }} />}
                    </div>
                    {r.contactName && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{r.contactName}</div>}
                  </td>
                  <td style={{ padding: '13px 18px', color: 'var(--text-secondary)', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                    {r.buttonId && <ButtonTapBadge label={r.buttonLabel ?? r.buttonId} />}
                    {r.text}
                  </td>
                  <td style={{ padding: '13px 18px' }}><SentimentBadge sentiment={r.sentiment} /></td>
                  <td style={{ padding: '13px 18px', color: 'var(--text-muted)', fontSize: 11 }}>{r.intent ?? '—'}</td>
                  <td style={{ padding: '13px 18px', color: 'var(--text-muted)', fontSize: 11 }}>{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</td>
                  <td style={{ padding: '13px 18px' }}>
                    <Button size="sm" variant="outline" onClick={() => void handleMarkHandled(r.id, !r.handled)}>
                      {r.handled ? 'Reopen' : 'Mark handled'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </DashLayout>
  );
}

export default function RepliesPage() {
  return (
    <ToastProvider>
      <RepliesContent />
    </ToastProvider>
  );
}
