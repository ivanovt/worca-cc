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

describe('_normalizeModelEntry', () => {
  it('returns { id, env } for a string entry', async () => {
    const { _normalizeModelEntry } = await import('./settings.js');
    expect(_normalizeModelEntry('claude-x')).toEqual({
      id: 'claude-x',
      env: {},
    });
  });

  it('returns { id, env } for an object entry with both fields', async () => {
    const { _normalizeModelEntry } = await import('./settings.js');
    expect(_normalizeModelEntry({ id: 'x', env: { A: '1' } })).toEqual({
      id: 'x',
      env: { A: '1' },
    });
  });

  it('defaults id to empty string when missing', async () => {
    const { _normalizeModelEntry } = await import('./settings.js');
    expect(_normalizeModelEntry({ env: { A: '1' } })).toEqual({
      id: '',
      env: { A: '1' },
    });
  });

  it('returns empty entry for nullish input', async () => {
    const { _normalizeModelEntry } = await import('./settings.js');
    expect(_normalizeModelEntry(null)).toEqual({ id: '', env: {} });
    expect(_normalizeModelEntry(undefined)).toEqual({ id: '', env: {} });
  });
});

describe('_envKeyValidationError', () => {
  it('returns null for ordinary anthropic keys', async () => {
    const { _envKeyValidationError } = await import('./settings.js');
    expect(_envKeyValidationError('ANTHROPIC_BASE_URL')).toBeNull();
    expect(_envKeyValidationError('API_TIMEOUT_MS')).toBeNull();
  });

  it('returns null for empty/whitespace draft rows (not flagged)', async () => {
    const { _envKeyValidationError } = await import('./settings.js');
    expect(_envKeyValidationError('')).toBeNull();
    expect(_envKeyValidationError('   ')).toBeNull();
  });

  it('flags reserved PATH and CLAUDECODE', async () => {
    const { _envKeyValidationError } = await import('./settings.js');
    expect(_envKeyValidationError('PATH')).toMatch(/reserved/i);
    expect(_envKeyValidationError('CLAUDECODE')).toMatch(/reserved/i);
  });

  it('flags WORCA_ prefix', async () => {
    const { _envKeyValidationError } = await import('./settings.js');
    expect(_envKeyValidationError('WORCA_RUN_ID')).toMatch(/reserved/i);
    expect(_envKeyValidationError('WORCA_ANYTHING')).toMatch(/reserved/i);
  });

  it('trims whitespace before checking', async () => {
    const { _envKeyValidationError } = await import('./settings.js');
    expect(_envKeyValidationError('  PATH  ')).toMatch(/reserved/i);
  });
});

describe('_nextDuplicateName', () => {
  it('returns base-01 for an un-suffixed source', async () => {
    const { _nextDuplicateName } = await import('./settings.js');
    expect(_nextDuplicateName('glm-ds', new Set())).toBe('glm-ds-01');
  });

  it('strips an existing -NN suffix before counting', async () => {
    const { _nextDuplicateName } = await import('./settings.js');
    expect(_nextDuplicateName('glm-ds-01', new Set(['glm-ds-01']))).toBe(
      'glm-ds-02',
    );
  });

  it('strips an existing -NNN suffix before counting', async () => {
    const { _nextDuplicateName } = await import('./settings.js');
    expect(_nextDuplicateName('glm-ds-100', new Set(['glm-ds-100']))).toBe(
      'glm-ds-01',
    );
  });

  it('skips taken slots', async () => {
    const { _nextDuplicateName } = await import('./settings.js');
    const taken = new Set(['glm-ds-01', 'glm-ds-02', 'glm-ds-03']);
    expect(_nextDuplicateName('glm-ds', taken)).toBe('glm-ds-04');
  });

  it('transitions from -99 to -100 padding', async () => {
    const { _nextDuplicateName } = await import('./settings.js');
    const taken = new Set();
    for (let i = 1; i <= 99; i++) {
      taken.add(`m-${String(i).padStart(2, '0')}`);
    }
    expect(_nextDuplicateName('m', taken)).toBe('m-100');
  });

  it('returns null when all 999 slots are taken', async () => {
    const { _nextDuplicateName } = await import('./settings.js');
    const taken = new Set();
    for (let i = 1; i <= 99; i++) taken.add(`m-${String(i).padStart(2, '0')}`);
    for (let i = 100; i <= 999; i++) taken.add(`m-${i}`);
    expect(_nextDuplicateName('m', taken)).toBeNull();
  });
});

describe('_getOrInitModelState', () => {
  it('initializes a fresh buffer from the server entry', async () => {
    const { _getOrInitModelState, _modelsEditState } = await import(
      './settings.js'
    );
    _modelsEditState.clear();
    const state = _getOrInitModelState('alt-fast', {
      id: 'x',
      env: { ANTHROPIC_BASE_URL: 'http://x', API_TIMEOUT_MS: '3000' },
    });
    expect(state.id).toBe('x');
    expect(state.env.map((r) => [r.k, r.v])).toEqual([
      ['ANTHROPIC_BASE_URL', 'http://x'],
      ['API_TIMEOUT_MS', '3000'],
    ]);
    expect(state.dirty).toBe(false);
  });

  it('re-syncs on clean render when server data arrives later', async () => {
    // Regression: without re-sync, a card initialized while settings were
    // still loading would stay stuck with the empty-server state forever.
    const { _getOrInitModelState, _modelsEditState } = await import(
      './settings.js'
    );
    _modelsEditState.clear();
    // First render: server is mid-load, returns an empty entry
    const first = _getOrInitModelState('alt-fast', { id: '', env: {} });
    expect(first.id).toBe('');
    expect(first.env).toEqual([]);
    // Second render: real server data arrives
    const second = _getOrInitModelState('alt-fast', {
      id: 'real-id',
      env: { K: 'v' },
    });
    expect(second.id).toBe('real-id');
    expect(second.env[0].k).toBe('K');
    expect(second.env[0].v).toBe('v');
  });

  it('keeps the dirty buffer across renders (preserves user edits)', async () => {
    const { _getOrInitModelState, _modelsEditState } = await import(
      './settings.js'
    );
    _modelsEditState.clear();
    const state = _getOrInitModelState('alt-fast', {
      id: 'x',
      env: { K: 'v' },
    });
    state.dirty = true;
    state.id = 'user-edited-id';
    // Next render with different server data shouldn't clobber the buffer
    const same = _getOrInitModelState('alt-fast', {
      id: 'server-id',
      env: { K: 'server-v' },
    });
    expect(same).toBe(state); // same reference
    expect(same.id).toBe('user-edited-id'); // user's edit preserved
  });
});

describe('_validateRename', () => {
  it('rejects empty / whitespace-only names', async () => {
    const { _validateRename } = await import('./settings.js');
    const cfg = { 'glm-ds': {}, opus: {} };
    expect(_validateRename('', 'glm-ds', cfg)).toMatch(/empty/i);
    expect(_validateRename('   ', 'glm-ds', cfg)).toMatch(/empty/i);
  });

  it('returns null when name is unchanged (same as current)', async () => {
    const { _validateRename } = await import('./settings.js');
    const cfg = { 'glm-ds': {}, opus: {} };
    expect(_validateRename('glm-ds', 'glm-ds', cfg)).toBeNull();
  });

  it('rejects collision with another existing model', async () => {
    const { _validateRename } = await import('./settings.js');
    const cfg = { 'glm-ds': {}, opus: {}, sonnet: {} };
    expect(_validateRename('opus', 'glm-ds', cfg)).toMatch(/already exists/);
  });

  it('accepts a name that is not in the config', async () => {
    const { _validateRename } = await import('./settings.js');
    const cfg = { 'glm-ds': {}, opus: {} };
    expect(_validateRename('alt-fast', 'glm-ds', cfg)).toBeNull();
  });

  it('trims whitespace before checking for collision', async () => {
    const { _validateRename } = await import('./settings.js');
    const cfg = { 'glm-ds': {}, opus: {} };
    expect(_validateRename('  opus  ', 'glm-ds', cfg)).toMatch(
      /already exists/,
    );
  });
});
