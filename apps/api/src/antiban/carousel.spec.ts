import { validateCarousel, parseCarouselCards, type CarouselCardDef } from '@wa-engine/shared';

function makeCard(overrides: Partial<CarouselCardDef> = {}): CarouselCardDef {
  return {
    id: overrides.id ?? 'card1',
    mediaUrl: overrides.mediaUrl ?? 'https://example.com/img.jpg',
    mediaType: overrides.mediaType,
    body: overrides.body ?? 'Card body',
    buttons: overrides.buttons ?? [],
  };
}

describe('validateCarousel', () => {
  it('rejects fewer than 2 cards', () => {
    const result = validateCarousel([makeCard()], 'ANY');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('between 2 and 10 cards'))).toBe(true);
  });

  it('rejects more than 10 cards', () => {
    const cards = Array.from({ length: 11 }, (_, i) => makeCard({ id: `c${i}` }));
    const result = validateCarousel(cards, 'ANY');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('between 2 and 10 cards'))).toBe(true);
  });

  it('accepts exactly 2 and exactly 10 cards', () => {
    expect(validateCarousel([makeCard({ id: 'a' }), makeCard({ id: 'b' })], 'ANY').valid).toBe(true);
    const ten = Array.from({ length: 10 }, (_, i) => makeCard({ id: `c${i}` }));
    expect(validateCarousel(ten, 'ANY').valid).toBe(true);
  });

  it('rejects a card with no media', () => {
    const result = validateCarousel([makeCard({ id: 'a', mediaUrl: '' }), makeCard({ id: 'b' })], 'ANY');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Card 1: media is required'))).toBe(true);
  });

  it('rejects a card with no body', () => {
    const result = validateCarousel([makeCard({ id: 'a', body: '' }), makeCard({ id: 'b' })], 'ANY');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Card 1: body text is required'))).toBe(true);
  });

  it('rejects a card with more than 2 buttons', () => {
    const buttons = [1, 2, 3].map((n) => ({ id: `b${n}`, type: 'QUICK_REPLY' as const, label: `B${n}` }));
    const result = validateCarousel([makeCard({ id: 'a', buttons }), makeCard({ id: 'b' })], 'ANY');
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Card 1: at most 2 buttons'))).toBe(true);
  });

  it('allows MIXED button types on a single card in CLOUD_API mode — unlike single-card XOR rule', () => {
    const buttons = [
      { id: 'q1', type: 'QUICK_REPLY' as const, label: 'Yes' },
      { id: 'u1', type: 'URL' as const, label: 'Visit', url: 'https://example.com' },
    ];
    const result = validateCarousel([makeCard({ id: 'a', buttons }), makeCard({ id: 'b' })], 'CLOUD_API');
    expect(result.valid).toBe(true);
  });

  it('propagates per-button field errors with the card number prefixed', () => {
    const result = validateCarousel(
      [makeCard({ id: 'a', buttons: [{ id: '', type: 'QUICK_REPLY', label: '' }] }), makeCard({ id: 'b' })],
      'ANY',
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('Card 1:'))).toBe(true);
  });
});

describe('parseCarouselCards', () => {
  it('returns undefined for null/undefined/non-array/empty', () => {
    expect(parseCarouselCards(null)).toBeUndefined();
    expect(parseCarouselCards(undefined)).toBeUndefined();
    expect(parseCarouselCards({ id: 'a' })).toBeUndefined();
    expect(parseCarouselCards([])).toBeUndefined();
  });

  it('returns undefined when array items are missing required fields', () => {
    expect(parseCarouselCards([{ id: 'a', mediaUrl: 'x' }])).toBeUndefined();
  });

  it('returns the parsed array when every item is a well-formed CarouselCardDef', () => {
    const cards = [makeCard({ id: 'a' }), makeCard({ id: 'b' })];
    expect(parseCarouselCards(cards)).toEqual(cards);
  });
});
