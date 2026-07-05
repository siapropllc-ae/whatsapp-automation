import type { ButtonDef } from '@/types/api';

/** Small mock of how buttons attached to a message will render. Shared by the
 * Templates page editor and the campaign creation wizard's preview. */
export function ButtonPreview({ buttons }: { buttons: ButtonDef[] }) {
  if (!buttons.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
      {buttons.map((b) => (
        <div
          key={b.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            background: 'rgba(37,211,102,0.06)',
            border: '1px solid rgba(37,211,102,0.15)',
            borderRadius: 8,
            padding: '8px 12px',
            fontSize: 12,
            color: '#25d366',
            fontWeight: 500,
          }}
        >
          {b.type === 'URL' && '🔗 '}
          {b.type === 'CALL' && '📞 '}
          {b.label || <span style={{ color: 'var(--text-muted)' }}>(no label)</span>}
        </div>
      ))}
    </div>
  );
}
