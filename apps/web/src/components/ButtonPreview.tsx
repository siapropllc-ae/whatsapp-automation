import type { ButtonDef } from '@/types/api';

const IcReply = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </svg>
);
const IcExternalLink = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);
const IcPhone = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
  </svg>
);

function buttonIcon(type: ButtonDef['type']) {
  if (type === 'URL') return <IcExternalLink />;
  if (type === 'CALL') return <IcPhone />;
  return <IcReply />;
}

/** Real WhatsApp button-list chrome: full-width rows stacked directly under the message,
 * separated by hairline dividers — matches how WhatsApp actually renders template buttons
 * (confirmed against a real Cloud API business message screenshot), not independent pills. */
export function ButtonPreview({ buttons }: { buttons: ButtonDef[] }) {
  if (!buttons.length) return null;
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid rgba(37,211,102,0.15)', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
      {buttons.map((b, i) => (
        <div
          key={b.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            padding: '10px 12px',
            fontSize: 12,
            fontWeight: 500,
            color: '#25d366',
            borderTop: i === 0 ? 'none' : '1px solid rgba(37,211,102,0.1)',
            background: 'rgba(37,211,102,0.03)',
          }}
        >
          {buttonIcon(b.type)}
          {b.label || <span style={{ color: 'var(--text-muted)' }}>(no label)</span>}
        </div>
      ))}
    </div>
  );
}
