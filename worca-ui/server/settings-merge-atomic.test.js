/**
 * Tests for the cross-tier whole-entry replace semantics in
 * `readEffectiveSettings` — model aliases and per-model pricing replace
 * wholesale across tiers (Project shadows User shadows Built-in), while
 * other paths keep their normal deep-merge behavior.
 *
 * Mirrors the Python coverage in
 * `tests/test_settings_model_atomic_replace.py`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deepMerge, readEffectiveSettings } from './settings-merge.js';

describe('readEffectiveSettings — cross-tier whole-entry replace', () => {
  let dir;
  let projectPath;
  let projectLocalPath;
  let globalPath;
  let globalLocalPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'settings-merge-atomic-'));
    projectPath = join(dir, 'project', 'settings.json');
    projectLocalPath = join(dir, 'project', 'settings.local.json');
    globalPath = join(dir, 'global', 'settings.json');
    globalLocalPath = join(dir, 'global', 'settings.local.json');
    mkdirSync(join(dir, 'project'), { recursive: true });
    mkdirSync(join(dir, 'global'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('project models.<alias> replaces user-global entry entirely', () => {
    writeFileSync(
      globalPath,
      JSON.stringify({
        worca: {
          models: {
            opus: {
              id: 'claude-opus-4-7',
              env: { ANTHROPIC_BASE_URL: 'https://proxy/' },
            },
          },
        },
      }),
    );
    writeFileSync(
      projectPath,
      JSON.stringify({
        worca: { models: { opus: { id: 'claude-opus-4-8' } } },
      }),
    );

    const result = readEffectiveSettings(projectPath, globalPath);
    expect(result.worca.models.opus).toEqual({ id: 'claude-opus-4-8' });
  });

  it('user-only alias survives unchanged when project does not define it', () => {
    writeFileSync(
      globalPath,
      JSON.stringify({
        worca: {
          models: {
            glmds: {
              id: 'zai-glm-4.6',
              env: { ANTHROPIC_BASE_URL: 'https://glm/' },
            },
          },
        },
      }),
    );
    writeFileSync(projectPath, JSON.stringify({ worca: {} }));

    const result = readEffectiveSettings(projectPath, globalPath);
    expect(result.worca.models.glmds).toEqual({
      id: 'zai-glm-4.6',
      env: { ANTHROPIC_BASE_URL: 'https://glm/' },
    });
  });

  it('within-tier .local.json still composes (id+env merge inside one tier)', () => {
    writeFileSync(
      projectPath,
      JSON.stringify({
        worca: { models: { opus: { id: 'claude-opus-4-8' } } },
      }),
    );
    writeFileSync(
      projectLocalPath,
      JSON.stringify({
        worca: { models: { opus: { env: { CUSTOM_KEY: 'v' } } } },
      }),
    );

    const result = readEffectiveSettings(projectPath, globalPath);
    // Within the project tier, the .json id and .local.json env compose
    // into one entry. Cross-tier replace only kicks in between tiers.
    expect(result.worca.models.opus).toEqual({
      id: 'claude-opus-4-8',
      env: { CUSTOM_KEY: 'v' },
    });
  });

  it('worca.pricing.models.<alias> also replaces wholesale across tiers', () => {
    writeFileSync(
      globalPath,
      JSON.stringify({
        worca: {
          pricing: {
            models: {
              opus: {
                input_per_mtok: 10,
                output_per_mtok: 50,
                cache_read_per_mtok: 1.5,
              },
            },
          },
        },
      }),
    );
    writeFileSync(
      projectPath,
      JSON.stringify({
        worca: { pricing: { models: { opus: { input_per_mtok: 7.5 } } } },
      }),
    );

    const result = readEffectiveSettings(projectPath, globalPath);
    // output_per_mtok and cache_read_per_mtok from global are dropped.
    expect(result.worca.pricing.models.opus).toEqual({ input_per_mtok: 7.5 });
  });

  it('non-atomic worca.* keys still deep-merge across tiers', () => {
    writeFileSync(
      globalPath,
      JSON.stringify({
        worca: {
          pricing: {
            currency: 'USD',
            server_tools: { web_search_per_request: 0.01 },
          },
        },
      }),
    );
    writeFileSync(
      projectPath,
      JSON.stringify({
        worca: {
          pricing: {
            server_tools: { web_fetch_per_request: 0.02 },
          },
        },
      }),
    );

    const result = readEffectiveSettings(projectPath, globalPath);
    expect(result.worca.pricing.currency).toBe('USD');
    expect(result.worca.pricing.server_tools).toEqual({
      web_search_per_request: 0.01,
      web_fetch_per_request: 0.02,
    });
  });

  it('user .local layer composes into the user tier before cross-tier replace', () => {
    // user-global .json carries id, user-global .local carries env — together
    // they form one user-tier entry. Then project shadows entirely.
    writeFileSync(
      globalPath,
      JSON.stringify({ worca: { models: { x: { id: 'user-id' } } } }),
    );
    writeFileSync(
      globalLocalPath,
      JSON.stringify({ worca: { models: { x: { env: { U: '1' } } } } }),
    );
    writeFileSync(
      projectPath,
      JSON.stringify({ worca: { models: { x: { id: 'proj-id' } } } }),
    );

    const result = readEffectiveSettings(projectPath, globalPath);
    // Cross-tier replace wins — project's `{id: 'proj-id'}` shadows the
    // composed user-tier `{id: 'user-id', env: {U:'1'}}` entirely.
    expect(result.worca.models.x).toEqual({ id: 'proj-id' });
  });
});

describe('deepMerge — sanity (unchanged by atomic-replace work)', () => {
  it('still recursively merges objects', () => {
    const a = { x: { y: 1, z: 2 } };
    const b = { x: { z: 99, w: 3 } };
    const r = deepMerge(a, b);
    expect(r).toEqual({ x: { y: 1, z: 99, w: 3 } });
    // Inputs not mutated.
    expect(a).toEqual({ x: { y: 1, z: 2 } });
    expect(b).toEqual({ x: { z: 99, w: 3 } });
  });
});
