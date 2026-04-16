import { describe, expect, it } from 'vitest';
import {
  addTag,
  filterSuggestions,
  isCustomized,
  KNOWN_TYPES,
  removeTag,
  SUBAGENT_DENYLIST,
} from './dispatch-tag-state.js';

describe('dispatch-tag-state', () => {
  describe('addTag', () => {
    it('adds a new type to the list', () => {
      const result = addTag(['Explore'], 'foo', SUBAGENT_DENYLIST);
      expect(result.tags).toEqual(['Explore', 'foo']);
      expect(result.rejected).toBe(false);
    });

    it('rejects duplicate', () => {
      const result = addTag(['Explore'], 'Explore', SUBAGENT_DENYLIST);
      expect(result.tags).toEqual(['Explore']);
      expect(result.rejected).toBe(false);
    });

    it('rejects denied type', () => {
      const result = addTag([], 'general-purpose', SUBAGENT_DENYLIST);
      expect(result.tags).toEqual([]);
      expect(result.rejected).toBe(true);
      expect(result.reason).toBeTruthy();
    });
  });

  describe('removeTag', () => {
    it('removes existing type', () => {
      const result = removeTag(['Explore', 'foo'], 'foo');
      expect(result).toEqual(['Explore']);
    });
  });

  describe('filterSuggestions', () => {
    it('excludes already-added types', () => {
      const result = filterSuggestions(
        '',
        KNOWN_TYPES,
        ['Explore'],
        SUBAGENT_DENYLIST,
      );
      expect(result.map((r) => r.name)).not.toContain('Explore');
    });

    it('filters by input prefix', () => {
      // filterSuggestions takes knownTypes as a parameter — use a local fixture
      // representing a discovery response (mix of builtins and plugin agents).
      const discovered = [
        ...KNOWN_TYPES,
        {
          name: 'feature-dev:code-reviewer',
          label: '(plugin)',
          group: 'Plugin',
        },
        {
          name: 'feature-dev:code-architect',
          label: '(plugin)',
          group: 'Plugin',
        },
      ];
      const result = filterSuggestions(
        'feat',
        discovered,
        [],
        SUBAGENT_DENYLIST,
      );
      expect(result.length).toBeGreaterThan(0);
      expect(result.every((r) => r.name.startsWith('feature-dev:'))).toBe(true);
    });

    it('marks denied types', () => {
      const result = filterSuggestions(
        'general',
        KNOWN_TYPES,
        [],
        SUBAGENT_DENYLIST,
      );
      const denied = result.find((r) => r.name === 'general-purpose');
      expect(denied).toBeDefined();
      expect(denied.denied).toBe(true);
    });
  });

  describe('isCustomized', () => {
    it('returns false when matching defaults', () => {
      expect(isCustomized(['Explore'], ['Explore'])).toBe(false);
    });

    it('returns true when different from defaults', () => {
      expect(isCustomized(['Explore', 'foo'], ['Explore'])).toBe(true);
    });
  });
});
