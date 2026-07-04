import { spinText, isValidE164, countSpinVariants } from '@wa-engine/shared';

describe('spinText', () => {
  // ── basic spin ────────────────────────────────────────────────────────────

  describe('basic spin syntax', () => {
    it('picks one option from a spin group', () => {
      const options = ['Hello', 'Hi', 'Hey'];
      const result = spinText('{Hello|Hi|Hey}');
      expect(options).toContain(result);
    });

    it('produces at least 2 distinct outputs across 50 calls (probabilistic)', () => {
      const outputs = new Set<string>();
      for (let i = 0; i < 50; i++) {
        outputs.add(spinText('{Hello|Hi|Hey}'));
      }
      expect(outputs.size).toBeGreaterThanOrEqual(2);
    });

    it('returns the sole option when there is no pipe', () => {
      // A spin group with one option has no pipe; treated as empty-var fallback
      // (no pipe → it's a variable lookup, not spin)
      const result = spinText('{name}', { name: 'Alice' });
      expect(result).toBe('Alice');
    });

    it('drops a missing variable and trims the trailing space', () => {
      const result = spinText('Hello {unknown}');
      // unknown var → empty string; the trailing space is then collapsed/trimmed
      expect(result).toBe('Hello');
    });
  });

  // ── variable injection ───────────────────────────────────────────────────

  describe('variable injection', () => {
    it('substitutes {name} with vars.name', () => {
      expect(spinText('Hello {name}', { name: 'Alice' })).toBe('Hello Alice');
    });

    it('substitutes multiple variables', () => {
      const result = spinText('{greeting} {name}, you are in {city}', {
        greeting: 'Hi',
        name: 'Bob',
        city: 'London',
      });
      expect(result).toBe('Hi Bob, you are in London');
    });

    it('leaves text outside braces untouched', () => {
      expect(spinText('plain text', {})).toBe('plain text');
    });

    it('handles vars with spaces when trimmed', () => {
      // The key is trimmed before lookup
      const result = spinText('{ name }', { name: 'Carol' });
      expect(result).toBe('Carol');
    });
  });

  // ── nested spin ───────────────────────────────────────────────────────────

  describe('nested spin', () => {
    it('resolves inner groups before outer groups', () => {
      // {Hello {there|friend}|Hi} → one of: "Hello there", "Hello friend", "Hi"
      const validOutputs = new Set(['Hello there', 'Hello friend', 'Hi']);
      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        results.add(spinText('{Hello {there|friend}|Hi}'));
      }
      for (const r of results) {
        expect(validOutputs).toContain(r);
      }
      // Probabilistically expect more than 1 distinct output
      expect(results.size).toBeGreaterThanOrEqual(2);
    });

    it('resolves variable inside nested spin', () => {
      // {Hi {name}|Hello} where name=Alice → "Hi Alice" or "Hello"
      const result = spinText('{Hi {name}|Hello}', { name: 'Alice' });
      expect(['Hi Alice', 'Hello']).toContain(result);
    });

    it('handles double-level nesting', () => {
      // {{a|b}|{c|d}} → one of a, b, c, d
      const outputs = new Set<string>();
      for (let i = 0; i < 100; i++) {
        outputs.add(spinText('{{a|b}|{c|d}}'));
      }
      for (const o of outputs) {
        expect(['a', 'b', 'c', 'd']).toContain(o);
      }
    });
  });

  // ── edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles empty template', () => {
      expect(spinText('')).toBe('');
    });

    it('handles template with no spin groups', () => {
      expect(spinText('plain text without braces')).toBe('plain text without braces');
    });

    it('handles adjacent spin groups', () => {
      const result = spinText('{a|b}{c|d}');
      expect(['ac', 'ad', 'bc', 'bd']).toContain(result);
    });
  });
});

// ── countSpinVariants ─────────────────────────────────────────────────────────

describe('countSpinVariants', () => {
  it.each<[string, number]>([
    ['plain text with no spin', 1],
    ['{Hello|Hi|Hey}', 3],
    ['{a|b}{c|d}', 4],
    ['{Hello {there|friend}|Hi}', 3], // "Hello there", "Hello friend", "Hi"
    ['{{a|b}|{c|d}}', 4],
    ['{name}', 1], // single-option group = variable placeholder, not variance
    ['Hi {name}, {50% off|half price} this {week|month}', 4], // 1 × 2 × 2
    ['', 1],
    ['{a|}', 2], // empty option still counts
  ])('counts %s → %i variants', (template, expected) => {
    expect(countSpinVariants(template)).toBe(expected);
  });
});

// ── isValidE164 ───────────────────────────────────────────────────────────────

describe('isValidE164', () => {
  const valid = [
    '+12025550191',  // US 10-digit
    '+447911123456', // UK
    '+918888888888', // India
    '+55119876543210', // Brazil max length
    '+1234567',      // min 7 digits after country code
  ];

  const invalid = [
    '12025550191',    // missing leading +
    '+0123456789',   // country code starts with 0
    '+1234',          // too short (< 7 digits)
    '+1234567890123456', // too long (> 15 digits)
    '+1234 567 890', // spaces
    '+123-456-7890',  // dashes
    'not-a-phone',
    '',
  ];

  it.each(valid)('accepts valid E.164: %s', (phone) => {
    expect(isValidE164(phone)).toBe(true);
  });

  it.each(invalid)('rejects invalid phone: %s', (phone) => {
    expect(isValidE164(phone)).toBe(false);
  });
});
