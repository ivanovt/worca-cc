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

describe('Pricing source-of-truth explainer', () => {
  it('settings.js source contains the alt-endpoint explainer note', async () => {
    // The note is inside the internal pricingTab() template literal — not
    // exported — so we grep the source rather than try to render the tab.
    // This guards against the explainer being silently removed when the
    // pricing tab is restructured (e.g. moved into a sub-tab).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const here = path.dirname(new URL(import.meta.url).pathname);
    const src = fs.readFileSync(path.join(here, 'settings.js'), 'utf8');
    expect(src).toMatch(/pricing-source-note/);
    expect(src).toMatch(/ANTHROPIC_BASE_URL/);
    expect(src).toMatch(/non-Anthropic endpoint/);
  });
});
