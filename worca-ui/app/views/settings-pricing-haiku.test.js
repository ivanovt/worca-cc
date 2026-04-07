import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Pricing Editor: haiku, 1h cache tier, server tools', () => {
  it('PRICING_MODELS includes haiku (3 models)', async () => {
    const { PRICING_MODELS } = await import('./settings.js');
    expect(PRICING_MODELS).toContain('haiku');
    expect(PRICING_MODELS).toHaveLength(3);
  });

  it('PRICING_FIELDS includes cache_write_1h_per_mtok (5 fields)', async () => {
    const { PRICING_FIELDS } = await import('./settings.js');
    expect(PRICING_FIELDS).toHaveLength(5);
    const keys = PRICING_FIELDS.map((f) => f.key);
    expect(keys).toContain('cache_write_1h_per_mtok');
  });

  it('cache_write_1h_per_mtok has a label', async () => {
    const { PRICING_FIELDS } = await import('./settings.js');
    const field = PRICING_FIELDS.find(
      (f) => f.key === 'cache_write_1h_per_mtok',
    );
    expect(field).toBeDefined();
    expect(typeof field.label).toBe('string');
    expect(field.label.length).toBeGreaterThan(0);
  });

  describe('readPricingFromDom returns server_tools object', () => {
    let origDocument;

    beforeEach(() => {
      origDocument = globalThis.document;
      globalThis.document = { getElementById: () => null };
    });

    afterEach(() => {
      globalThis.document = origDocument;
    });

    it('includes server_tools with numeric rates', async () => {
      const { readPricingFromDom } = await import('./settings.js');
      const result = readPricingFromDom();
      expect(result.server_tools).toBeDefined();
      expect(typeof result.server_tools.web_search_per_request).toBe('number');
      expect(typeof result.server_tools.web_fetch_per_request).toBe('number');
    });

    it('reads server_tools values from DOM inputs', async () => {
      globalThis.document.getElementById = (id) => {
        if (id === 'pricing-server_tools-web_search_per_request')
          return { value: '0.01' };
        if (id === 'pricing-server_tools-web_fetch_per_request')
          return { value: '0.02' };
        return null;
      };
      const { readPricingFromDom } = await import('./settings.js');
      const result = readPricingFromDom();
      expect(result.server_tools.web_search_per_request).toBe(0.01);
      expect(result.server_tools.web_fetch_per_request).toBe(0.02);
    });
  });
});
