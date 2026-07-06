import { ButtonPreview } from '@/components/ButtonPreview';
import type { CarouselCardDef } from '@/types/api';

/** Horizontal-scroll mock of a carousel template's cards. Used on both the Templates
 * modal's live preview and the campaign wizard's template-selection preview. */
export function CarouselPreview({ cards }: { cards: CarouselCardDef[] }) {
  if (!cards.length) return null;
  return (
    <div style={{ display: 'flex', gap: 10, overflowX: 'auto', marginTop: 10, paddingBottom: 4 }}>
      {cards.map((card, i) => (
        <div
          key={card.id}
          style={{
            flex: '0 0 160px',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 10,
            overflow: 'hidden',
            background: 'rgba(255,255,255,0.02)',
          }}
        >
          {card.mediaUrl ? (
            <img src={card.mediaUrl} alt={`Card ${i + 1}`} style={{ width: '100%', height: 90, objectFit: 'cover', display: 'block' }} />
          ) : (
            <div style={{ width: '100%', height: 90, background: 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 10 }}>
              No media
            </div>
          )}
          <div style={{ padding: 8 }}>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4, maxHeight: 46, overflow: 'hidden' }}>{card.body}</div>
            <ButtonPreview buttons={card.buttons} />
          </div>
        </div>
      ))}
    </div>
  );
}
