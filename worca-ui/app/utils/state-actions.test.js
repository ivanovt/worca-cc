import { describe, expect, it } from 'vitest';
import { actionAllowed, STATES } from './state-actions.js';

const EXPECTED = {
  stop: { running: true },
  pause: { running: true },
  resume: { paused: true, failed: true, interrupted: true },
  cancel: {
    pending: true,
    running: true,
    paused: true,
    failed: true,
    interrupted: true,
  },
  archive: {
    pending: true,
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
  },
  unarchive: {
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
  },
  delete: {
    pending: true,
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
  },
  learn: {
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
  },
};

const ACTIONS = Object.keys(EXPECTED);

describe('state-actions', () => {
  it('exports all seven canonical states', () => {
    expect(STATES).toEqual([
      'pending',
      'running',
      'paused',
      'completed',
      'failed',
      'interrupted',
      'cancelled',
    ]);
  });

  for (const action of ACTIONS) {
    for (const state of STATES) {
      const expected = Boolean(EXPECTED[action][state]);
      it(`${action} × ${state} → ${expected}`, () => {
        expect(actionAllowed(action, state)).toBe(expected);
      });
    }
  }

  it('returns false for unknown action', () => {
    expect(actionAllowed('explode', 'running')).toBe(false);
  });

  it('returns false for unknown state', () => {
    expect(actionAllowed('stop', 'exploding')).toBe(false);
  });
});
