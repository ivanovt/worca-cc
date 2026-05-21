import { describe, expect, it } from 'vitest';
import {
  addTag,
  createDispatchStates,
  createSectionState,
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

  describe('createSectionState', () => {
    it('creates state for _defaults and each agent role', () => {
      const roles = ['planner', 'implementer'];
      const state = createSectionState(
        { _defaults: ['Explore'], implementer: ['Explore', 'Plan'] },
        roles,
      );
      expect(Object.keys(state)).toEqual([
        '_defaults',
        'planner',
        'implementer',
      ]);
      expect(state._defaults.tags).toEqual(['Explore']);
      expect(state.implementer.tags).toEqual(['Explore', 'Plan']);
      expect(state.planner.tags).toEqual([]);
    });

    it('initializes input state fields', () => {
      const state = createSectionState({ _defaults: ['*'] }, ['planner']);
      expect(state._defaults.input).toBe('');
      expect(state._defaults.showSuggestions).toBe(false);
      expect(state._defaults.activeIndex).toBe(-1);
    });

    it('does not share references with input config', () => {
      const perAgent = { _defaults: ['Explore'] };
      const state = createSectionState(perAgent, []);
      state._defaults.tags.push('Plan');
      expect(perAgent._defaults).toEqual(['Explore']);
    });
  });

  describe('createDispatchStates', () => {
    it('creates toolsState, skillsState, and subagentsState', () => {
      const dispatch = {
        tools: { per_agent_allow: { _defaults: ['*'] } },
        skills: { per_agent_allow: { _defaults: ['*'] } },
        subagents: { per_agent_allow: { _defaults: ['Explore'] } },
      };
      const result = createDispatchStates(dispatch, ['planner']);
      expect(result.toolsState._defaults.tags).toEqual(['*']);
      expect(result.skillsState._defaults.tags).toEqual(['*']);
      expect(result.subagentsState._defaults.tags).toEqual(['Explore']);
    });

    it('handles missing dispatch sections', () => {
      const result = createDispatchStates({}, ['planner']);
      expect(result.toolsState._defaults.tags).toEqual([]);
      expect(result.skillsState._defaults.tags).toEqual([]);
      expect(result.subagentsState._defaults.tags).toEqual([]);
    });
  });
});
