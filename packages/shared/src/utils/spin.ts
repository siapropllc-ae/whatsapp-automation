/**
 * Renders a spin-syntax template into a single string.
 *
 * Spin syntax:  {option A|option B|option C}  → picks one at random
 * Nested spin:  {Hello {there|friend}|Hi {name}}  → resolved inside-out
 * Variable substitution: {name}, {city} → replaced with vars[key]
 *
 * Unknown variables are left as-is (empty string if key absent and group
 * has no pipe character). The loop terminates when no innermost {} remain.
 */
export function spinText(
  template: string,
  vars: Record<string, string> = {},
): string {
  let result = template;
  const MAX_PASSES = 50;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const prev = result;
    // Match only innermost {} groups — no nested braces inside
    result = result.replace(/\{([^{}]*)\}/g, (_match, group: string) => {
      const options = group.split('|');
      if (options.length > 1) {
        return options[Math.floor(Math.random() * options.length)] ?? '';
      }
      const key = group.trim();
      return vars[key] !== undefined ? vars[key] : '';
    });
    if (result === prev) break;
  }

  // Collapse multiple consecutive spaces left by empty variable substitutions
  return result.replace(/ {2,}/g, ' ').trim();
}

/**
 * Estimates how many distinct messages a spin-syntax template can produce.
 *
 * Counting rules (recursive over nested braces):
 *  - literal text contributes a factor of 1
 *  - a spin group `{a|b|c}` contributes the SUM of its options' variant counts
 *  - adjacent groups multiply: `{a|b}{c|d}` → 2 × 2 = 4
 *  - a single-option group `{name}` is a variable placeholder → 1 variant (no variance)
 *
 * Used as an anti-ban guard: low-variation templates send every recipient a near-identical
 * message, a strong spam signal. Callers can warn/block below a threshold.
 */
export function countSpinVariants(template: string): number {
  let i = 0;

  function parseSequence(): number {
    // Product of variant-counts until end-of-string or an unconsumed '|'/'}' at this level.
    let product = 1;
    while (i < template.length) {
      const ch = template[i];
      if (ch === '|' || ch === '}') break;
      if (ch === '{') {
        i++; // consume '{'
        product *= parseGroup();
      } else {
        i++; // literal character
      }
    }
    return product;
  }

  function parseGroup(): number {
    // i is just past '{'. Sum options separated by '|' until the matching '}'.
    let sum = parseSequence();
    let optionCount = 1;
    while (i < template.length && template[i] === '|') {
      i++; // consume '|'
      sum += parseSequence();
      optionCount++;
    }
    if (i < template.length && template[i] === '}') {
      i++; // consume '}'
    }
    // A single-option group is a variable placeholder, not a choice → exactly 1 variant.
    return optionCount > 1 ? sum : 1;
  }

  return Math.max(1, parseSequence());
}

/**
 * Returns true when phone passes the E.164 format check.
 * E.164: + followed by 7–15 digits, first digit non-zero.
 */
export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone);
}
