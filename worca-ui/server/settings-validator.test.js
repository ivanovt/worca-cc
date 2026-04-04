import { describe, expect, it } from 'vitest';
import { validateSettingsPayload } from './settings-validator.js';

describe('validateSettingsPayload — plan_path_template', () => {
  it('accepts a valid plan_path_template string', () => {
    const result = validateSettingsPayload({
      worca: { plan_path_template: 'docs/plans/{timestamp}-{title_slug}.md' },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-string plan_path_template', () => {
    const result = validateSettingsPayload({
      worca: { plan_path_template: 123 },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('plan_path_template'),
    );
  });

  it('rejects empty string plan_path_template', () => {
    const result = validateSettingsPayload({
      worca: { plan_path_template: '' },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('plan_path_template'),
    );
  });

  it('rejects plan_path_template exceeding 500 characters', () => {
    const result = validateSettingsPayload({
      worca: { plan_path_template: 'a'.repeat(501) },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('plan_path_template'),
    );
  });

  it('accepts plan_path_template of exactly 500 characters', () => {
    const result = validateSettingsPayload({
      worca: { plan_path_template: 'a'.repeat(500) },
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateSettingsPayload — defaults', () => {
  it('accepts valid defaults with msize and mloops integers 1-10', () => {
    const result = validateSettingsPayload({
      worca: { defaults: { msize: 3, mloops: 5 } },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts defaults at boundary values (1 and 10)', () => {
    expect(
      validateSettingsPayload({ worca: { defaults: { msize: 1, mloops: 10 } } })
        .valid,
    ).toBe(true);
    expect(
      validateSettingsPayload({ worca: { defaults: { msize: 10, mloops: 1 } } })
        .valid,
    ).toBe(true);
  });

  it('rejects non-object defaults', () => {
    const result = validateSettingsPayload({ worca: { defaults: 'bad' } });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('defaults must be an object'),
    );
  });

  it('rejects array defaults', () => {
    const result = validateSettingsPayload({ worca: { defaults: [1, 2] } });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('defaults must be an object'),
    );
  });

  it('rejects msize below 1', () => {
    const result = validateSettingsPayload({
      worca: { defaults: { msize: 0 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('msize'));
  });

  it('rejects msize above 10', () => {
    const result = validateSettingsPayload({
      worca: { defaults: { msize: 11 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('msize'));
  });

  it('rejects non-integer msize', () => {
    const result = validateSettingsPayload({
      worca: { defaults: { msize: 2.5 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('msize'));
  });

  it('rejects mloops below 1', () => {
    const result = validateSettingsPayload({
      worca: { defaults: { mloops: 0 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('mloops'));
  });

  it('rejects mloops above 10', () => {
    const result = validateSettingsPayload({
      worca: { defaults: { mloops: 11 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('mloops'));
  });

  it('rejects non-integer mloops', () => {
    const result = validateSettingsPayload({
      worca: { defaults: { mloops: 3.7 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('mloops'));
  });

  it('accepts defaults with only msize', () => {
    const result = validateSettingsPayload({
      worca: { defaults: { msize: 5 } },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts defaults with only mloops', () => {
    const result = validateSettingsPayload({
      worca: { defaults: { mloops: 3 } },
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateSettingsPayload — pricing', () => {
  it('accepts valid pricing with all model fields', () => {
    const result = validateSettingsPayload({
      worca: {
        pricing: {
          models: {
            opus: {
              input_per_mtok: 15,
              output_per_mtok: 75,
              cache_write_per_mtok: 18.75,
              cache_read_per_mtok: 1.5,
            },
            sonnet: {
              input_per_mtok: 3,
              output_per_mtok: 15,
              cache_write_per_mtok: 3.75,
              cache_read_per_mtok: 0.3,
            },
          },
          currency: 'USD',
          last_updated: '2025-05-01',
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-object pricing', () => {
    const result = validateSettingsPayload({ worca: { pricing: 'bad' } });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('pricing must be an object'),
    );
  });

  it('rejects array pricing', () => {
    const result = validateSettingsPayload({ worca: { pricing: [1] } });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('pricing must be an object'),
    );
  });

  it('rejects non-object pricing.models', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { models: 'bad' } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('pricing.models must be an object'),
    );
  });

  it('rejects unknown model names', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { models: { gpt4: { input_per_mtok: 1 } } } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('Unknown pricing model'),
    );
  });

  it('rejects negative cost values', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { models: { opus: { input_per_mtok: -1 } } } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('non-negative'),
    );
  });

  it('rejects non-number cost values', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { models: { opus: { input_per_mtok: 'free' } } } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('non-negative'),
    );
  });

  it('rejects Infinity cost values', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { models: { opus: { output_per_mtok: Infinity } } } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('non-negative'),
    );
  });

  it('rejects NaN cost values', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { models: { opus: { output_per_mtok: NaN } } } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('non-negative'),
    );
  });

  it('accepts zero cost values', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { models: { opus: { input_per_mtok: 0 } } } },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects unknown cost field keys', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { models: { opus: { unknown_field: 5 } } } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('Unknown pricing field'),
    );
  });

  it('rejects non-string currency', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { currency: 123 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('currency'));
  });

  it('rejects non-string last_updated', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { last_updated: 42 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('last_updated'),
    );
  });

  it('accepts pricing with only models (no currency/last_updated)', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { models: { opus: { input_per_mtok: 15 } } } },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts pricing with only currency and last_updated (no models)', () => {
    const result = validateSettingsPayload({
      worca: { pricing: { currency: 'EUR', last_updated: '2026-01-01' } },
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateSettingsPayload — worca.events', () => {
  it('accepts valid events config', () => {
    const result = validateSettingsPayload({
      worca: {
        events: {
          enabled: true,
          agent_telemetry: false,
          hook_events: true,
          rate_limit_ms: 1000,
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-object events', () => {
    const result = validateSettingsPayload({ worca: { events: 'bad' } });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('events must be an object'),
    );
  });

  it('rejects non-boolean enabled', () => {
    const result = validateSettingsPayload({
      worca: { events: { enabled: 'yes' } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('events.enabled'),
    );
  });

  it('rejects non-boolean agent_telemetry', () => {
    const result = validateSettingsPayload({
      worca: { events: { agent_telemetry: 1 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('events.agent_telemetry'),
    );
  });

  it('rejects non-boolean hook_events', () => {
    const result = validateSettingsPayload({
      worca: { events: { hook_events: 0 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('events.hook_events'),
    );
  });

  it('rejects non-integer rate_limit_ms', () => {
    const result = validateSettingsPayload({
      worca: { events: { rate_limit_ms: 1.5 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('rate_limit_ms'),
    );
  });

  it('rejects negative rate_limit_ms', () => {
    const result = validateSettingsPayload({
      worca: { events: { rate_limit_ms: -1 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('rate_limit_ms'),
    );
  });

  it('accepts rate_limit_ms of 0', () => {
    const result = validateSettingsPayload({
      worca: { events: { rate_limit_ms: 0 } },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts partial events config (only enabled)', () => {
    const result = validateSettingsPayload({
      worca: { events: { enabled: false } },
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateSettingsPayload — worca.budget', () => {
  it('accepts valid budget config', () => {
    const result = validateSettingsPayload({
      worca: { budget: { max_cost_usd: 10.0, warning_pct: 80 } },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-object budget', () => {
    const result = validateSettingsPayload({ worca: { budget: 'bad' } });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('budget must be an object'),
    );
  });

  it('rejects max_cost_usd of zero', () => {
    const result = validateSettingsPayload({
      worca: { budget: { max_cost_usd: 0 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('max_cost_usd'),
    );
  });

  it('rejects negative max_cost_usd', () => {
    const result = validateSettingsPayload({
      worca: { budget: { max_cost_usd: -1 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('max_cost_usd'),
    );
  });

  it('rejects non-number max_cost_usd', () => {
    const result = validateSettingsPayload({
      worca: { budget: { max_cost_usd: 'ten' } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('max_cost_usd'),
    );
  });

  it('rejects warning_pct below 0', () => {
    const result = validateSettingsPayload({
      worca: { budget: { warning_pct: -1 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('warning_pct'),
    );
  });

  it('rejects warning_pct above 100', () => {
    const result = validateSettingsPayload({
      worca: { budget: { warning_pct: 101 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('warning_pct'),
    );
  });

  it('accepts warning_pct at boundaries (0 and 100)', () => {
    expect(
      validateSettingsPayload({ worca: { budget: { warning_pct: 0 } } }).valid,
    ).toBe(true);
    expect(
      validateSettingsPayload({ worca: { budget: { warning_pct: 100 } } })
        .valid,
    ).toBe(true);
  });

  it('rejects non-number warning_pct', () => {
    const result = validateSettingsPayload({
      worca: { budget: { warning_pct: '80' } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('warning_pct'),
    );
  });

  it('accepts empty budget object', () => {
    const result = validateSettingsPayload({ worca: { budget: {} } });
    expect(result.valid).toBe(true);
  });
});

describe('validateSettingsPayload — worca.webhooks', () => {
  it('accepts a valid webhook entry with all fields', () => {
    const result = validateSettingsPayload({
      worca: {
        webhooks: [
          {
            url: 'https://example.com/hook',
            secret: 'mysecret',
            events: ['pipeline.run.*'],
            timeout_ms: 5000,
            max_retries: 3,
            rate_limit_ms: 1000,
            control: false,
          },
        ],
      },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts minimal webhook entry with only url', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com/hook' }] },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts an empty webhooks array', () => {
    const result = validateSettingsPayload({ worca: { webhooks: [] } });
    expect(result.valid).toBe(true);
  });

  it('rejects non-array webhooks', () => {
    const result = validateSettingsPayload({ worca: { webhooks: {} } });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('webhooks must be an array'),
    );
  });

  it('rejects webhook missing url', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ secret: 'x' }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('url'));
  });

  it('rejects webhook with non-string url', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 123 }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('url'));
  });

  it('rejects webhook with non-http/https url protocol', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'ftp://example.com/hook' }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('url'));
  });

  it('rejects webhook with invalid URL format', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'not-a-url' }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('url'));
  });

  it('rejects webhook with non-string secret', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com', secret: 123 }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('secret'));
  });

  it('rejects webhook with non-array events', () => {
    const result = validateSettingsPayload({
      worca: {
        webhooks: [{ url: 'https://example.com', events: 'pipeline.*' }],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('events'));
  });

  it('rejects webhook with non-string event pattern', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com', events: [123] }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('events'));
  });

  it('rejects webhook with non-positive timeout_ms', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com', timeout_ms: 0 }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('timeout_ms'),
    );
  });

  it('rejects webhook with non-integer max_retries', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com', max_retries: 1.5 }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('max_retries'),
    );
  });

  it('rejects webhook with max_retries above 10', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com', max_retries: 11 }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('max_retries'),
    );
  });

  it('rejects webhook with negative rate_limit_ms', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com', rate_limit_ms: -1 }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('rate_limit_ms'),
    );
  });

  it('rejects webhook with non-boolean control', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com', control: 'yes' }] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(expect.stringContaining('control'));
  });

  it('includes webhook index in error message', () => {
    const result = validateSettingsPayload({
      worca: {
        webhooks: [{ url: 'https://example.com/hook' }, { url: 'not-valid' }],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.details.some((d) => d.includes('[1]'))).toBe(true);
  });

  it('accepts http (not just https) urls', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'http://example.com/hook' }] },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts max_retries of 0', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com', max_retries: 0 }] },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts rate_limit_ms of 0', () => {
    const result = validateSettingsPayload({
      worca: { webhooks: [{ url: 'https://example.com', rate_limit_ms: 0 }] },
    });
    expect(result.valid).toBe(true);
  });
});
