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

  it('DEFAULT_PRICING opus uses corrected 4.6 rates', async () => {
    const { DEFAULT_PRICING } = await import('./settings.js');
    expect(DEFAULT_PRICING.models.opus.input_per_mtok).toBe(5);
    expect(DEFAULT_PRICING.models.opus.output_per_mtok).toBe(25);
    expect(DEFAULT_PRICING.models.opus.cache_write_per_mtok).toBe(6.25);
    expect(DEFAULT_PRICING.models.opus.cache_write_1h_per_mtok).toBe(10);
    expect(DEFAULT_PRICING.models.opus.cache_read_per_mtok).toBe(0.5);
  });

  it('DEFAULT_PRICING sonnet includes cache_write_1h_per_mtok', async () => {
    const { DEFAULT_PRICING } = await import('./settings.js');
    expect(DEFAULT_PRICING.models.sonnet.cache_write_1h_per_mtok).toBe(6);
  });

  it('DEFAULT_PRICING includes haiku model with correct rates', async () => {
    const { DEFAULT_PRICING } = await import('./settings.js');
    const haiku = DEFAULT_PRICING.models.haiku;
    expect(haiku).toBeDefined();
    expect(haiku.input_per_mtok).toBe(0.8);
    expect(haiku.output_per_mtok).toBe(4);
    expect(haiku.cache_write_per_mtok).toBe(1);
    expect(haiku.cache_write_1h_per_mtok).toBe(1.6);
    expect(haiku.cache_read_per_mtok).toBe(0.08);
  });

  it('DEFAULT_PRICING.server_tools has web search and fetch rates', async () => {
    const { DEFAULT_PRICING } = await import('./settings.js');
    expect(DEFAULT_PRICING.server_tools).toBeDefined();
    expect(DEFAULT_PRICING.server_tools.web_search_per_request).toBe(0.01);
    expect(DEFAULT_PRICING.server_tools.web_fetch_per_request).toBe(0.01);
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
