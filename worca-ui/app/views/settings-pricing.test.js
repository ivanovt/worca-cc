import { describe, expect, it } from 'vitest';

describe('Pricing Editor constants and readPricingFromDom', () => {
  it('exports PRICING_MODELS with opus, sonnet, and haiku', async () => {
    const { PRICING_MODELS } = await import('./settings.js');
    expect(PRICING_MODELS).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('exports PRICING_FIELDS with 5 cost columns', async () => {
    const { PRICING_FIELDS } = await import('./settings.js');
    expect(PRICING_FIELDS).toHaveLength(5);
    const keys = PRICING_FIELDS.map((f) => f.key);
    expect(keys).toContain('input_per_mtok');
    expect(keys).toContain('output_per_mtok');
    expect(keys).toContain('cache_write_per_mtok');
    expect(keys).toContain('cache_write_1h_per_mtok');
    expect(keys).toContain('cache_read_per_mtok');
    // Each field has a label
    for (const f of PRICING_FIELDS) {
      expect(typeof f.label).toBe('string');
      expect(f.label.length).toBeGreaterThan(0);
    }
  });

  it('exports readPricingFromDom as a function', async () => {
    const { readPricingFromDom } = await import('./settings.js');
    expect(typeof readPricingFromDom).toBe('function');
  });
});
