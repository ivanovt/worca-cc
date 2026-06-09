/**
 * Unit tests for the advisory effort-recommendations helpers.
 *
 * The helpers are UI-only — the pipeline runtime never reads them, and there
 * is no per-template override. The map is the single source of truth.
 */

import { describe, expect, it } from 'vitest';
import {
  effortBelowFloor,
  RECOMMENDED_MIN_EFFORT,
} from './effort-recommendations.js';

describe('RECOMMENDED_MIN_EFFORT', () => {
  it('ships high floor for heavy-reasoning roles', () => {
    expect(RECOMMENDED_MIN_EFFORT.planner).toBe('high');
    expect(RECOMMENDED_MIN_EFFORT.plan_reviewer).toBe('high');
    expect(RECOMMENDED_MIN_EFFORT.reviewer).toBe('high');
    expect(RECOMMENDED_MIN_EFFORT.workspace_planner).toBe('high');
  });

  it('ships medium floor for tighter-scope judgment roles', () => {
    expect(RECOMMENDED_MIN_EFFORT.coordinator).toBe('medium');
    expect(RECOMMENDED_MIN_EFFORT.guardian).toBe('medium');
  });

  it('ships low floor for mechanical / adaptive-driven roles', () => {
    expect(RECOMMENDED_MIN_EFFORT.implementer).toBe('low');
    expect(RECOMMENDED_MIN_EFFORT.tester).toBe('low');
    expect(RECOMMENDED_MIN_EFFORT.learner).toBe('low');
  });

  it('covers every agent name in the roster', () => {
    // Drift guard — if a new agent is added to AGENT_NAMES, this test fails
    // and forces an explicit decision on the floor (or an opt-out by adding
    // the name here with a documented null/skip).
    const expectedAgents = [
      'planner',
      'plan_reviewer',
      'coordinator',
      'implementer',
      'tester',
      'reviewer',
      'guardian',
      'learner',
      'workspace_planner',
    ];
    for (const name of expectedAgents) {
      expect(
        RECOMMENDED_MIN_EFFORT[name],
        `missing floor for ${name}`,
      ).toBeDefined();
    }
  });

  it('is frozen to discourage mutation from callers', () => {
    expect(Object.isFrozen(RECOMMENDED_MIN_EFFORT)).toBe(true);
  });
});

describe('effortBelowFloor', () => {
  it('returns true when level is strictly below floor', () => {
    expect(effortBelowFloor('low', 'medium')).toBe(true);
    expect(effortBelowFloor('medium', 'high')).toBe(true);
    expect(effortBelowFloor('high', 'max')).toBe(true);
  });

  it('returns false when level equals floor', () => {
    expect(effortBelowFloor('medium', 'medium')).toBe(false);
    expect(effortBelowFloor('max', 'max')).toBe(false);
  });

  it('returns false when level is above floor', () => {
    expect(effortBelowFloor('high', 'medium')).toBe(false);
    expect(effortBelowFloor('max', 'low')).toBe(false);
  });

  it('returns false for any unknown / falsy input (no false positives)', () => {
    expect(effortBelowFloor(null, 'medium')).toBe(false);
    expect(effortBelowFloor('low', null)).toBe(false);
    expect(effortBelowFloor('', 'high')).toBe(false);
    expect(effortBelowFloor('low', '')).toBe(false);
    expect(effortBelowFloor('bogus', 'medium')).toBe(false);
    expect(effortBelowFloor('low', 'bogus')).toBe(false);
  });
});
