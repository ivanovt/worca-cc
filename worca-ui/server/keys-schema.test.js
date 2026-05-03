import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GLOBAL_DEFAULTS,
  GLOBAL_ONLY_KEYS,
  NORMALIZE_SKIP_KEYS,
  PROJECT_DEFAULTS,
} from './keys-schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../src/worca/schemas/keys.json'),
    'utf-8',
  ),
);

describe('keys-schema exports', () => {
  it('GLOBAL_ONLY_KEYS is an array of 2-element arrays', () => {
    expect(Array.isArray(GLOBAL_ONLY_KEYS)).toBe(true);
    for (const entry of GLOBAL_ONLY_KEYS) {
      expect(Array.isArray(entry)).toBe(true);
      expect(entry).toHaveLength(2);
      expect(typeof entry[0]).toBe('string');
      expect(typeof entry[1]).toBe('string');
    }
  });

  it('NORMALIZE_SKIP_KEYS is an array of 2-element arrays', () => {
    expect(Array.isArray(NORMALIZE_SKIP_KEYS)).toBe(true);
    for (const entry of NORMALIZE_SKIP_KEYS) {
      expect(Array.isArray(entry)).toBe(true);
      expect(entry).toHaveLength(2);
    }
  });

  it('GLOBAL_DEFAULTS is a non-empty object', () => {
    expect(typeof GLOBAL_DEFAULTS).toBe('object');
    expect(Object.keys(GLOBAL_DEFAULTS).length).toBeGreaterThan(0);
  });

  it('PROJECT_DEFAULTS is a non-empty object', () => {
    expect(typeof PROJECT_DEFAULTS).toBe('object');
    expect(Object.keys(PROJECT_DEFAULTS).length).toBeGreaterThan(0);
  });
});

describe('drift detection — JS exports match raw JSON', () => {
  it('GLOBAL_ONLY_KEYS matches JSON', () => {
    expect(GLOBAL_ONLY_KEYS).toEqual(raw.global_only_keys);
  });

  it('NORMALIZE_SKIP_KEYS matches JSON', () => {
    expect(NORMALIZE_SKIP_KEYS).toEqual(raw.normalize_skip_keys);
  });

  it('GLOBAL_DEFAULTS matches JSON', () => {
    expect(GLOBAL_DEFAULTS).toEqual(raw.defaults.global);
  });

  it('PROJECT_DEFAULTS matches JSON', () => {
    expect(PROJECT_DEFAULTS).toEqual(raw.defaults.project);
  });

  it('every global-only key has a global default', () => {
    for (const [section, key] of GLOBAL_ONLY_KEYS) {
      expect(GLOBAL_DEFAULTS).toHaveProperty(section);
      expect(GLOBAL_DEFAULTS[section]).toHaveProperty(key);
    }
  });

  it('GLOBAL_ONLY_KEYS count is 4', () => {
    expect(GLOBAL_ONLY_KEYS).toHaveLength(4);
  });

  it('NORMALIZE_SKIP_KEYS count is 1', () => {
    expect(NORMALIZE_SKIP_KEYS).toHaveLength(1);
  });

  it('no overlap between global-only keys and project defaults', () => {
    const projectKeys = new Set();
    for (const [section, sub] of Object.entries(PROJECT_DEFAULTS)) {
      for (const key of Object.keys(sub)) {
        projectKeys.add(`${section}.${key}`);
      }
    }
    for (const [section, key] of GLOBAL_ONLY_KEYS) {
      expect(projectKeys.has(`${section}.${key}`)).toBe(false);
    }
  });
});
