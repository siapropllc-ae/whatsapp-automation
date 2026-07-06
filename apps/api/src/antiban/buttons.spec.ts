import { validateButtons, validateSingleButton, parseButtonDefs, type ButtonDef } from '@wa-engine/shared';

describe('validateButtons', () => {
  describe('structural checks (all modes)', () => {
    it('rejects a button with no id', () => {
      const result = validateButtons([{ id: '', type: 'QUICK_REPLY', label: 'Yes' }], 'ANY');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('id'))).toBe(true);
    });

    it('rejects a button with no label', () => {
      const result = validateButtons([{ id: 'b1', type: 'QUICK_REPLY', label: '' }], 'ANY');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('label'))).toBe(true);
    });

    it('rejects a label longer than 20 characters', () => {
      const result = validateButtons(
        [{ id: 'b1', type: 'QUICK_REPLY', label: 'This label is way too long' }],
        'ANY',
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('exceeds 20 characters'))).toBe(true);
    });

    it('rejects a URL button with no url', () => {
      const result = validateButtons([{ id: 'u1', type: 'URL', label: 'Visit' }], 'ANY');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('missing a url'))).toBe(true);
    });

    it('rejects a CALL button with an invalid phone number', () => {
      const result = validateButtons(
        [{ id: 'c1', type: 'CALL', label: 'Call us', phoneNumber: 'not-a-phone' }],
        'ANY',
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('E.164'))).toBe(true);
    });

    it('accepts a CALL button with a valid E.164 phone number', () => {
      const result = validateButtons(
        [{ id: 'c1', type: 'CALL', label: 'Call us', phoneNumber: '+14155552671' }],
        'ANY',
      );
      expect(result.valid).toBe(true);
    });

    it('rejects a QUICK_REPLY button that also carries a url', () => {
      const result = validateButtons(
        [{ id: 'q1', type: 'QUICK_REPLY', label: 'Yes', url: 'https://example.com' }],
        'ANY',
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('must not have a url'))).toBe(true);
    });
  });

  describe('CLOUD_API mode', () => {
    it('accepts up to 3 quick-reply buttons', () => {
      const buttons: ButtonDef[] = [1, 2, 3].map((n) => ({ id: `b${n}`, type: 'QUICK_REPLY', label: `B${n}` }));
      expect(validateButtons(buttons, 'CLOUD_API').valid).toBe(true);
    });

    it('rejects more than 3 quick-reply buttons', () => {
      const buttons: ButtonDef[] = [1, 2, 3, 4].map((n) => ({ id: `b${n}`, type: 'QUICK_REPLY', label: `B${n}` }));
      const result = validateButtons(buttons, 'CLOUD_API');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('at most 3 quick-reply'))).toBe(true);
    });

    it('accepts up to 2 URL/CALL buttons', () => {
      const buttons: ButtonDef[] = [
        { id: 'u1', type: 'URL', label: 'Visit', url: 'https://example.com' },
        { id: 'c1', type: 'CALL', label: 'Call us', phoneNumber: '+14155552671' },
      ];
      expect(validateButtons(buttons, 'CLOUD_API').valid).toBe(true);
    });

    it('rejects more than 2 URL/CALL buttons', () => {
      const buttons: ButtonDef[] = [
        { id: 'u1', type: 'URL', label: 'Visit', url: 'https://example.com' },
        { id: 'c1', type: 'CALL', label: 'Call us', phoneNumber: '+14155552671' },
        { id: 'u2', type: 'URL', label: 'More', url: 'https://example.com/more' },
      ];
      const result = validateButtons(buttons, 'CLOUD_API');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('at most 2 URL/Call'))).toBe(true);
    });

    it('rejects mixing quick-reply and URL/CALL buttons', () => {
      const buttons: ButtonDef[] = [
        { id: 'q1', type: 'QUICK_REPLY', label: 'Yes' },
        { id: 'u1', type: 'URL', label: 'Visit', url: 'https://example.com' },
      ];
      const result = validateButtons(buttons, 'CLOUD_API');
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('cannot mix'))).toBe(true);
    });
  });

  describe('BAILEYS and ANY modes (lenient cap only)', () => {
    it('allows a mixed combo of up to 3 buttons', () => {
      const buttons: ButtonDef[] = [
        { id: 'q1', type: 'QUICK_REPLY', label: 'Yes' },
        { id: 'u1', type: 'URL', label: 'Visit', url: 'https://example.com' },
        { id: 'c1', type: 'CALL', label: 'Call us', phoneNumber: '+14155552671' },
      ];
      expect(validateButtons(buttons, 'BAILEYS').valid).toBe(true);
      expect(validateButtons(buttons, 'ANY').valid).toBe(true);
    });

    it('rejects more than 3 buttons total', () => {
      const buttons: ButtonDef[] = [1, 2, 3, 4].map((n) => ({ id: `b${n}`, type: 'QUICK_REPLY', label: `B${n}` }));
      const bResult = validateButtons(buttons, 'BAILEYS');
      const aResult = validateButtons(buttons, 'ANY');
      expect(bResult.valid).toBe(false);
      expect(aResult.valid).toBe(false);
      expect(bResult.errors.some((e) => e.includes('At most 3 buttons'))).toBe(true);
    });
  });

  it('is valid for an empty button list', () => {
    expect(validateButtons([], 'CLOUD_API').valid).toBe(true);
    expect(validateButtons([], 'BAILEYS').valid).toBe(true);
  });
});

describe('validateSingleButton', () => {
  // Extracted out of validateButtons so validateCarousel can reuse the same per-button
  // field checks without pulling in validateButtons' mode-aggregate (XOR) rules.
  it('is the same field-level check validateButtons uses — no id/label/url/phone', () => {
    expect(validateSingleButton({ id: '', type: 'QUICK_REPLY', label: 'Yes' }).some((e) => e.includes('id'))).toBe(true);
    expect(validateSingleButton({ id: 'b1', type: 'QUICK_REPLY', label: '' }).some((e) => e.includes('label'))).toBe(true);
    expect(validateSingleButton({ id: 'u1', type: 'URL', label: 'Visit' }).some((e) => e.includes('missing a url'))).toBe(true);
    expect(validateSingleButton({ id: 'c1', type: 'CALL', label: 'Call', phoneNumber: 'bad' }).some((e) => e.includes('E.164'))).toBe(true);
  });

  it('returns no errors for a well-formed button', () => {
    expect(validateSingleButton({ id: 'q1', type: 'QUICK_REPLY', label: 'Yes' })).toEqual([]);
  });
});

describe('parseButtonDefs', () => {
  it('returns undefined for null', () => {
    expect(parseButtonDefs(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseButtonDefs(undefined)).toBeUndefined();
  });

  it('returns undefined for a non-array value', () => {
    expect(parseButtonDefs({ id: 'b1', type: 'QUICK_REPLY', label: 'Yes' })).toBeUndefined();
  });

  it('returns undefined for an empty array', () => {
    expect(parseButtonDefs([])).toBeUndefined();
  });

  it('returns undefined when array items are missing required fields', () => {
    expect(parseButtonDefs([{ id: 'b1', type: 'QUICK_REPLY' }])).toBeUndefined();
  });

  it('returns the parsed array when every item is a well-formed ButtonDef', () => {
    const buttons = [{ id: 'b1', type: 'QUICK_REPLY', label: 'Yes' }];
    expect(parseButtonDefs(buttons)).toEqual(buttons);
  });
});
