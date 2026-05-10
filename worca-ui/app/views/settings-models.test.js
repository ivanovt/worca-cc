import { describe, expect, it } from 'vitest';

describe('getModelKeys', () => {
  it('returns configured keys in insertion order', async () => {
    const { getModelKeys } = await import('./settings.js');
    const result = getModelKeys({
      models: { opus: 'x', 'alt-fast': { id: 'y' } },
    });
    expect(result).toEqual(['opus', 'alt-fast']);
  });

  it('falls back to defaults when models is empty object', async () => {
    const { getModelKeys } = await import('./settings.js');
    expect(getModelKeys({})).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('falls back to defaults when worca is undefined', async () => {
    const { getModelKeys } = await import('./settings.js');
    expect(getModelKeys(undefined)).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('falls back to defaults when worca is null', async () => {
    const { getModelKeys } = await import('./settings.js');
    expect(getModelKeys(null)).toEqual(['opus', 'sonnet', 'haiku']);
  });

  it('falls back to defaults when models key is absent', async () => {
    const { getModelKeys } = await import('./settings.js');
    expect(getModelKeys({ agents: {} })).toEqual(['opus', 'sonnet', 'haiku']);
  });
});

describe('modelsTab export', () => {
  it('is exported as a function', async () => {
    const { modelsTab } = await import('./settings.js');
    expect(typeof modelsTab).toBe('function');
  });
});
