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
      const result = addTag(['explore'], 'foo', SUBAGENT_DENYLIST);
      expect(result.tags).toEqual(['explore', 'foo']);
      expect(result.rejected).toBe(false);
    });

    it('rejects duplicate', () => {
      const result = addTag(['explore'], 'explore', SUBAGENT_DENYLIST);
      expect(result.tags).toEqual(['explore']);
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
      const result = removeTag(['explore', 'foo'], 'foo');
      expect(result).toEqual(['explore']);
    });
  });

  describe('filterSuggestions', () => {
    it('excludes already-added types', () => {
      const result = filterSuggestions(
        '',
        KNOWN_TYPES,
        ['explore'],
        SUBAGENT_DENYLIST,
      );
      expect(result.map((r) => r.name)).not.toContain('explore');
    });

    it('filters by input prefix', () => {
      const result = filterSuggestions(
        'feat',
        KNOWN_TYPES,
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
      expect(isCustomized(['explore'], ['explore'])).toBe(false);
    });

    it('returns true when different from defaults', () => {
      expect(isCustomized(['explore', 'foo'], ['explore'])).toBe(true);
    });
  });
});
