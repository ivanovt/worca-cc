import { describe, expect, it, vi } from 'vitest';

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

describe('_isCardSaveDisabled (Save button gate)', () => {
  // The Save button is intentionally NOT gated on state.dirty — re-saving
  // identical config is harmless (idempotent PUT to settings.local.json),
  // and the dirty flag is unreliable (a type-then-undo leaves dirty=true
  // while values match the server). Validity is the only gate.

  it('returns false when card has no buffer yet (post-load clean state)', async () => {
    const { _isCardSaveDisabled, _modelsEditState } = await import(
      './settings.js'
    );
    _modelsEditState.clear();
    // No entry in _modelsEditState — card just rendered against server state.
    // Old behavior: button was disabled (dirty=false). New behavior: enabled.
    expect(_isCardSaveDisabled('opus')).toBe(false);
  });

  it('returns false when card is clean (dirty=false, all keys valid)', async () => {
    const { _isCardSaveDisabled, _getOrInitModelState, _modelsEditState } =
      await import('./settings.js');
    _modelsEditState.clear();
    _getOrInitModelState('alt-fast', {
      id: 'x',
      env: { ANTHROPIC_BASE_URL: 'http://x' },
    });
    // dirty defaults to false; only valid keys; Save must NOT be disabled.
    // This is the core change: pre-fix, this returned true.
    expect(_isCardSaveDisabled('alt-fast')).toBe(false);
  });

  it('returns false when card is dirty and all keys are valid', async () => {
    const { _isCardSaveDisabled, _getOrInitModelState, _modelsEditState } =
      await import('./settings.js');
    _modelsEditState.clear();
    const state = _getOrInitModelState('alt-fast', {
      id: 'x',
      env: { ANTHROPIC_BASE_URL: 'http://x' },
    });
    state.dirty = true;
    state.env[0].v = 'http://changed';
    expect(_isCardSaveDisabled('alt-fast')).toBe(false);
  });

  it('returns true when any env key is invalid (reserved key)', async () => {
    const { _isCardSaveDisabled, _getOrInitModelState, _modelsEditState } =
      await import('./settings.js');
    _modelsEditState.clear();
    const state = _getOrInitModelState('alt-fast', {
      id: 'x',
      env: { ANTHROPIC_BASE_URL: 'http://x' },
    });
    state.env.push({ k: 'PATH', v: '/sneaky', _id: 'r1' });
    // PATH is a reserved key (denylist via reserved-env-keys.json).
    // Validity gate fires regardless of dirty state.
    expect(_isCardSaveDisabled('alt-fast')).toBe(true);
  });

  it('returns true when an env key has a reserved prefix', async () => {
    const { _isCardSaveDisabled, _getOrInitModelState, _modelsEditState } =
      await import('./settings.js');
    _modelsEditState.clear();
    const state = _getOrInitModelState('alt-fast', {
      id: 'x',
      env: { OK: 'v' },
    });
    state.env.push({ k: 'WORCA_AGENT', v: 'guardian', _id: 'r1' });
    expect(_isCardSaveDisabled('alt-fast')).toBe(true);
  });
});

describe('_modelsRecentlySaved (post-save "Saved" indicator)', () => {
  // The per-card "Saved" pill replaces the old dirty-gated semantic. After a
  // successful _saveModelEnv the model's name lives in this Map for
  // MODEL_SAVED_INDICATOR_MS (2s), then a timer clears it and rerenders.

  it('is exported as a Map', async () => {
    const { _modelsRecentlySaved } = await import('./settings.js');
    expect(_modelsRecentlySaved).toBeInstanceOf(Map);
  });

  it('is populated after a successful _saveModelEnv and cleared after the window', async () => {
    const {
      _saveModelEnv,
      _getOrInitModelState,
      _modelsEditState,
      _modelsRecentlySaved,
    } = await import('./settings.js');
    _modelsEditState.clear();
    _modelsRecentlySaved.clear();

    _getOrInitModelState('alt-fast', { id: 'x', env: { K: 'v' } });

    // Stub global fetch with a 200 response so _saveModelEnv's PUT succeeds.
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    vi.useFakeTimers();
    try {
      const rerender = vi.fn();
      await _saveModelEnv('alt-fast', rerender);
      // Right after success: the name is in the Map with a pending timer.
      expect(_modelsRecentlySaved.has('alt-fast')).toBe(true);
      // After the 2s window, the timer clears the entry and rerenders.
      vi.advanceTimersByTime(2100);
      expect(_modelsRecentlySaved.has('alt-fast')).toBe(false);
      expect(rerender).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      globalThis.fetch = origFetch;
    }
  });

  it('replaces an existing timer on back-to-back saves to the same card', async () => {
    const {
      _saveModelEnv,
      _getOrInitModelState,
      _modelsEditState,
      _modelsRecentlySaved,
    } = await import('./settings.js');
    _modelsEditState.clear();
    _modelsRecentlySaved.clear();

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    vi.useFakeTimers();
    try {
      const rerender = vi.fn();
      _getOrInitModelState('alt-fast', { id: 'x', env: { K: 'v' } });
      await _saveModelEnv('alt-fast', rerender);
      const firstTimer = _modelsRecentlySaved.get('alt-fast');

      // Trigger a second save before the first timer fires
      vi.advanceTimersByTime(500);
      _getOrInitModelState('alt-fast', { id: 'x', env: { K: 'v2' } });
      await _saveModelEnv('alt-fast', rerender);
      const secondTimer = _modelsRecentlySaved.get('alt-fast');

      // Old timer was cleared, new one took its place.
      expect(secondTimer).not.toBe(firstTimer);
      // The entry persists through the original 2s window (would have fired
      // at 2000ms total but we replaced it at 500ms with a fresh 2s timer).
      vi.advanceTimersByTime(1600); // total 2100ms — past the original deadline
      expect(_modelsRecentlySaved.has('alt-fast')).toBe(true);
      // Past the new timer deadline (500 + 2000 = 2500ms total).
      vi.advanceTimersByTime(500);
      expect(_modelsRecentlySaved.has('alt-fast')).toBe(false);
    } finally {
      vi.useRealTimers();
      globalThis.fetch = origFetch;
    }
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
