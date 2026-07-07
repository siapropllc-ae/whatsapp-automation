'use client';

import { useRef, useState } from 'react';
import { ButtonPreview } from '@/components/ButtonPreview';
import type { CarouselCardDef } from '@/types/api';

const CARD_WIDTH = 240;
const CARD_GAP = 10;

/** Horizontally-swipeable mock of a carousel template's cards — scroll-snap, real card
 * proportions, and dot pagination. Used by both the Templates workspace's live preview
 * and the campaign wizard's template-selection preview. */
export function CarouselPreview({ cards }: { cards: CarouselCardDef[] }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  if (!cards.length) return null;

  const handleScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const index = Math.round(el.scrollLeft / (CARD_WIDTH + CARD_GAP));
    setActiveIndex(Math.max(0, Math.min(cards.length - 1, index)));
  };

  return (
    <div>
      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        style={{
          display: 'flex',
          gap: CARD_GAP,
          overflowX: 'auto',
          marginTop: 10,
          paddingBottom: 4,
          scrollSnapType: 'x mandatory',
        }}
      >
        {cards.map((card, i) => (
          <div
            key={card.id}
            style={{
              flex: `0 0 ${CARD_WIDTH}px`,
              scrollSnapAlign: 'start',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 10,
              overflow: 'hidden',
              background: 'rgba(255,255,255,0.02)',
            }}
          >
            {card.mediaUrl ? (
              card.mediaType === 'VIDEO' ? (
                <video src={card.mediaUrl} style={{ width: '100%', height: 135, objectFit: 'cover', display: 'block' }} muted />
              ) : (
                <img src={card.mediaUrl} alt={`Card ${i + 1}`} style={{ width: '100%', height: 135, objectFit: 'cover', display: 'block' }} />
              )
            ) : (
              <div style={{ width: '100%', height: 135, background: 'rgba(255,255,255,0.04)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 10 }}>
                No media
              </div>
            )}
            <div style={{ padding: 10 }}>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4, maxHeight: 51, overflow: 'hidden' }}>{card.body}</div>
              <ButtonPreview buttons={card.buttons} />
            </div>
          </div>
        ))}
      </div>
      {cards.length > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: 5, marginTop: 8 }}>
          {cards.map((c, i) => (
            <span
              key={c.id}
              style={{
                width: i === activeIndex ? 14 : 5,
                height: 5,
                borderRadius: 3,
                background: i === activeIndex ? 'var(--gold)' : 'rgba(255,255,255,0.15)',
                transition: 'width 0.2s, background 0.2s',
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
