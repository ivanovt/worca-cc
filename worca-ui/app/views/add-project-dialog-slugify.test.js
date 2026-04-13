/**
 * Tests for slugify() and resolveCollisions() helpers in add-project-dialog.
 * Plan cases 31–32.
 */

import { describe, expect, it } from 'vitest';
import { resolveCollisions, slugify } from './add-project-dialog.js';

describe('slugify', () => {
  it('lowercases the name', () => {
    expect(slugify('MyApp')).toBe('myapp');
  });

  it('replaces non-[a-z0-9_-] chars with dashes and strips leading/trailing dashes', () => {
    expect(slugify('my app!')).toBe('my-app');
  });

  it('strips leading dashes', () => {
    expect(slugify('-myrepo')).toBe('myrepo');
  });

  it('strips trailing dashes', () => {
    expect(slugify('...')).toBe('');
  });

  it('collapses consecutive dashes', () => {
    // double space → two dashes → collapsed to one
    expect(slugify('my  app')).toBe('my-app');
  });

  it('truncates to 64 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long)).toHaveLength(64);
  });

  it('preserves underscores and dashes', () => {
    expect(slugify('my_app-v2')).toBe('my_app-v2');
  });
});

describe('resolveCollisions — case 31: collision with existing project', () => {
  it('appends -2 when scanned name matches an existing project name', () => {
    const scanned = ['my-app'];
    const existing = ['my-app'];
    const result = resolveCollisions(scanned, existing);
    expect(result).toEqual(['my-app-2']);
  });

  it('increments suffix until unique when -2 is also taken', () => {
    const scanned = ['my-app'];
    const existing = ['my-app', 'my-app-2'];
    const result = resolveCollisions(scanned, existing);
    expect(result).toEqual(['my-app-3']);
  });
});

describe('resolveCollisions — case 32: collision within batch', () => {
  it('gives first occurrence the base name and second occurrence -2', () => {
    const scanned = ['utils', 'utils'];
    const existing = [];
    const result = resolveCollisions(scanned, existing);
    expect(result).toEqual(['utils', 'utils-2']);
  });

  it('handles three identical names in batch', () => {
    const scanned = ['lib', 'lib', 'lib'];
    const existing = [];
    const result = resolveCollisions(scanned, existing);
    expect(result).toEqual(['lib', 'lib-2', 'lib-3']);
  });

  it('combines batch and existing collisions', () => {
    const scanned = ['my-app', 'my-app'];
    const existing = ['my-app'];
    const result = resolveCollisions(scanned, existing);
    expect(result).toEqual(['my-app-2', 'my-app-3']);
  });
});

describe('resolveCollisions — no collision', () => {
  it('returns names unchanged when no collisions', () => {
    const scanned = ['alpha', 'beta', 'gamma'];
    const existing = ['delta'];
    expect(resolveCollisions(scanned, existing)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });
});
