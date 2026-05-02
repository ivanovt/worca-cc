import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  VALID_MODELS,
  validateGlobalSettings,
  validateSettingsPayload,
} from './settings-validator.js';

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

describe('validateSettingsPayload — worca.parallel', () => {
  it('accepts valid parallel with worktree_base_dir and default_base_branch', () => {
    const result = validateSettingsPayload({
      worca: {
        parallel: {
          worktree_base_dir: '.worktrees',
          default_base_branch: 'main',
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-object parallel', () => {
    const result = validateSettingsPayload({ worca: { parallel: 'bad' } });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('worca.parallel must be an object'),
    );
  });

  it('rejects array parallel', () => {
    const result = validateSettingsPayload({ worca: { parallel: [] } });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('worca.parallel must be an object'),
    );
  });

  it('rejects non-string worktree_base_dir', () => {
    const result = validateSettingsPayload({
      worca: { parallel: { worktree_base_dir: 123 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'parallel.worktree_base_dir must be a non-empty string',
      ),
    );
  });

  it('rejects empty string worktree_base_dir', () => {
    const result = validateSettingsPayload({
      worca: { parallel: { worktree_base_dir: '' } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'parallel.worktree_base_dir must be a non-empty string',
      ),
    );
  });

  it('rejects non-string default_base_branch', () => {
    const result = validateSettingsPayload({
      worca: { parallel: { default_base_branch: false } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'parallel.default_base_branch must be a non-empty string',
      ),
    );
  });

  it('rejects empty string default_base_branch', () => {
    const result = validateSettingsPayload({
      worca: { parallel: { default_base_branch: '' } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'parallel.default_base_branch must be a non-empty string',
      ),
    );
  });

  it('accepts parallel with only worktree_base_dir', () => {
    const result = validateSettingsPayload({
      worca: { parallel: { worktree_base_dir: '/tmp/trees' } },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts parallel with only default_base_branch', () => {
    const result = validateSettingsPayload({
      worca: { parallel: { default_base_branch: 'develop' } },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects misplaced global key cleanup_policy in project settings', () => {
    const result = validateSettingsPayload({
      worca: { parallel: { cleanup_policy: 'never' } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'worca.parallel.cleanup_policy is a global preference',
      ),
    );
  });

  it('rejects misplaced global key max_concurrent_pipelines in project settings', () => {
    const result = validateSettingsPayload({
      worca: { parallel: { max_concurrent_pipelines: 5 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'worca.parallel.max_concurrent_pipelines is a global preference',
      ),
    );
  });
});

describe('validateSettingsPayload — worca.circuit_breaker', () => {
  it('accepts valid circuit_breaker with enabled and max_consecutive_failures', () => {
    const result = validateSettingsPayload({
      worca: {
        circuit_breaker: { enabled: true, max_consecutive_failures: 3 },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-object circuit_breaker', () => {
    const result = validateSettingsPayload({
      worca: { circuit_breaker: 'bad' },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('worca.circuit_breaker must be an object'),
    );
  });

  it('rejects array circuit_breaker', () => {
    const result = validateSettingsPayload({
      worca: { circuit_breaker: [] },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('worca.circuit_breaker must be an object'),
    );
  });

  it('rejects non-boolean enabled', () => {
    const result = validateSettingsPayload({
      worca: { circuit_breaker: { enabled: 'yes' } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('circuit_breaker.enabled must be a boolean'),
    );
  });

  it('rejects non-integer max_consecutive_failures', () => {
    const result = validateSettingsPayload({
      worca: { circuit_breaker: { max_consecutive_failures: 2.5 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'circuit_breaker.max_consecutive_failures must be an integer between 1 and 10',
      ),
    );
  });

  it('rejects max_consecutive_failures below 1', () => {
    const result = validateSettingsPayload({
      worca: { circuit_breaker: { max_consecutive_failures: 0 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'circuit_breaker.max_consecutive_failures must be an integer between 1 and 10',
      ),
    );
  });

  it('rejects max_consecutive_failures above 10', () => {
    const result = validateSettingsPayload({
      worca: { circuit_breaker: { max_consecutive_failures: 11 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'circuit_breaker.max_consecutive_failures must be an integer between 1 and 10',
      ),
    );
  });

  it('accepts max_consecutive_failures at boundaries (1 and 10)', () => {
    expect(
      validateSettingsPayload({
        worca: { circuit_breaker: { max_consecutive_failures: 1 } },
      }).valid,
    ).toBe(true);
    expect(
      validateSettingsPayload({
        worca: { circuit_breaker: { max_consecutive_failures: 10 } },
      }).valid,
    ).toBe(true);
  });

  it('rejects misplaced global key classifier_model in project settings', () => {
    const result = validateSettingsPayload({
      worca: { circuit_breaker: { classifier_model: 'haiku' } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'worca.circuit_breaker.classifier_model is a global preference',
      ),
    );
  });
});

describe('validateSettingsPayload — reject misplaced global keys', () => {
  it('rejects ui.worktree_disk_warning_bytes in project settings', () => {
    const result = validateSettingsPayload({
      worca: { ui: { worktree_disk_warning_bytes: 2000000000 } },
    });
    expect(result.valid).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'worca.ui.worktree_disk_warning_bytes is a global preference',
      ),
    );
  });

  it('accepts project payload with no misplaced global keys', () => {
    const result = validateSettingsPayload({
      worca: {
        parallel: { worktree_base_dir: '.wt' },
        circuit_breaker: { enabled: false },
      },
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateGlobalSettings', () => {
  it('returns ok for empty worca object', () => {
    const result = validateGlobalSettings({ worca: {} });
    expect(result.ok).toBe(true);
  });

  it('returns ok when worca is absent', () => {
    const result = validateGlobalSettings({});
    expect(result.ok).toBe(true);
  });

  it('accepts valid worktree_disk_warning_bytes', () => {
    const result = validateGlobalSettings({
      worca: { ui: { worktree_disk_warning_bytes: 2000000000 } },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects worktree_disk_warning_bytes below 500 MB', () => {
    const result = validateGlobalSettings({
      worca: { ui: { worktree_disk_warning_bytes: 499999999 } },
    });
    expect(result.ok).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('worktree_disk_warning_bytes'),
    );
  });

  it('rejects worktree_disk_warning_bytes above 50 GB', () => {
    const result = validateGlobalSettings({
      worca: { ui: { worktree_disk_warning_bytes: 50000000001 } },
    });
    expect(result.ok).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('worktree_disk_warning_bytes'),
    );
  });

  it('rejects non-integer worktree_disk_warning_bytes', () => {
    const result = validateGlobalSettings({
      worca: { ui: { worktree_disk_warning_bytes: 1500000000.5 } },
    });
    expect(result.ok).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('worktree_disk_warning_bytes'),
    );
  });

  it('accepts boundary values for worktree_disk_warning_bytes (500 MB and 50 GB)', () => {
    expect(
      validateGlobalSettings({
        worca: { ui: { worktree_disk_warning_bytes: 500000000 } },
      }).ok,
    ).toBe(true);
    expect(
      validateGlobalSettings({
        worca: { ui: { worktree_disk_warning_bytes: 50000000000 } },
      }).ok,
    ).toBe(true);
  });

  it('accepts valid classifier_model', () => {
    const result = validateGlobalSettings({
      worca: { circuit_breaker: { classifier_model: 'haiku' } },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects invalid classifier_model', () => {
    const result = validateGlobalSettings({
      worca: { circuit_breaker: { classifier_model: 'gpt-4' } },
    });
    expect(result.ok).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('classifier_model must be one of'),
    );
  });

  it('accepts valid cleanup_policy', () => {
    for (const policy of ['never', 'on-success', 'manual-only']) {
      const result = validateGlobalSettings({
        worca: { parallel: { cleanup_policy: policy } },
      });
      expect(result.ok).toBe(true);
    }
  });

  it('rejects invalid cleanup_policy', () => {
    const result = validateGlobalSettings({
      worca: { parallel: { cleanup_policy: 'always' } },
    });
    expect(result.ok).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining('cleanup_policy must be one of'),
    );
  });

  it('accepts valid max_concurrent_pipelines', () => {
    const result = validateGlobalSettings({
      worca: { parallel: { max_concurrent_pipelines: 10 } },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects max_concurrent_pipelines below 1', () => {
    const result = validateGlobalSettings({
      worca: { parallel: { max_concurrent_pipelines: 0 } },
    });
    expect(result.ok).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'max_concurrent_pipelines must be an integer between 1 and 20',
      ),
    );
  });

  it('rejects max_concurrent_pipelines above 20', () => {
    const result = validateGlobalSettings({
      worca: { parallel: { max_concurrent_pipelines: 21 } },
    });
    expect(result.ok).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'max_concurrent_pipelines must be an integer between 1 and 20',
      ),
    );
  });

  it('rejects non-integer max_concurrent_pipelines', () => {
    const result = validateGlobalSettings({
      worca: { parallel: { max_concurrent_pipelines: 5.5 } },
    });
    expect(result.ok).toBe(false);
    expect(result.details).toContainEqual(
      expect.stringContaining(
        'max_concurrent_pipelines must be an integer between 1 and 20',
      ),
    );
  });

  it('accepts max_concurrent_pipelines at boundaries (1 and 20)', () => {
    expect(
      validateGlobalSettings({
        worca: { parallel: { max_concurrent_pipelines: 1 } },
      }).ok,
    ).toBe(true);
    expect(
      validateGlobalSettings({
        worca: { parallel: { max_concurrent_pipelines: 20 } },
      }).ok,
    ).toBe(true);
  });

  it('validates all global fields together', () => {
    const result = validateGlobalSettings({
      worca: {
        ui: { worktree_disk_warning_bytes: 2000000000 },
        circuit_breaker: { classifier_model: 'sonnet' },
        parallel: { cleanup_policy: 'on-success', max_concurrent_pipelines: 5 },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('collects multiple errors', () => {
    const result = validateGlobalSettings({
      worca: {
        ui: { worktree_disk_warning_bytes: -1 },
        circuit_breaker: { classifier_model: 'invalid' },
        parallel: { cleanup_policy: 'bad', max_concurrent_pipelines: 100 },
      },
    });
    expect(result.ok).toBe(false);
    expect(result.details.length).toBeGreaterThanOrEqual(4);
  });
});

describe('VALID_MODELS superset assertion', () => {
  it('includes every alias from the shipped settings.json template', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const template = JSON.parse(
      readFileSync(
        resolve(__dirname, '../../src/worca/settings.json'),
        'utf-8',
      ),
    );
    const aliases = Object.keys(template.worca.models);
    for (const alias of aliases) {
      expect(VALID_MODELS).toContain(alias);
    }
  });
});
