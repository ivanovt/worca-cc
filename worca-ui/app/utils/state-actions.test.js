import { describe, expect, it } from 'vitest';
import { actionAllowed, STATES } from './state-actions.js';

const EXPECTED = {
  stop: { running: true },
  pause: { running: true },
  resume: { paused: true, failed: true, interrupted: true, halted: true },
  cancel: {
    pending: true,
    running: true,
    paused: true,
    failed: true,
    interrupted: true,
    halted: true,
    setup_failed: true,
  },
  archive: {
    pending: true,
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
    halted: true,
    setup_failed: true,
    unrecoverable: true,
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
    halted: true,
    setup_failed: true,
    unrecoverable: true,
  },
  learn: {
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
    halted: true,
  },
};

const ACTIONS = Object.keys(EXPECTED);

describe('state-actions', () => {
  it('exports all ten canonical states', () => {
    expect(STATES).toEqual([
      'pending',
      'running',
      'paused',
      'completed',
      'failed',
      'interrupted',
      'cancelled',
      'halted',
      'setup_failed',
      'unrecoverable',
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

  // halted: resume/cancel/archive/delete/learn allowed; stop/pause/unarchive not
  it('halted allows resume', () =>
    expect(actionAllowed('resume', 'halted')).toBe(true));
  it('halted allows cancel', () =>
    expect(actionAllowed('cancel', 'halted')).toBe(true));
  it('halted allows archive', () =>
    expect(actionAllowed('archive', 'halted')).toBe(true));
  it('halted allows delete', () =>
    expect(actionAllowed('delete', 'halted')).toBe(true));
  it('halted allows learn', () =>
    expect(actionAllowed('learn', 'halted')).toBe(true));
  it('halted does NOT allow stop', () =>
    expect(actionAllowed('stop', 'halted')).toBe(false));
  it('halted does NOT allow pause', () =>
    expect(actionAllowed('pause', 'halted')).toBe(false));
  it('halted does NOT allow unarchive', () =>
    expect(actionAllowed('unarchive', 'halted')).toBe(false));

  // setup_failed: cancel/archive/delete allowed; resume/stop/pause/unarchive/learn not
  it('setup_failed allows cancel', () =>
    expect(actionAllowed('cancel', 'setup_failed')).toBe(true));
  it('setup_failed allows archive', () =>
    expect(actionAllowed('archive', 'setup_failed')).toBe(true));
  it('setup_failed allows delete', () =>
    expect(actionAllowed('delete', 'setup_failed')).toBe(true));
  it('setup_failed does NOT allow resume', () =>
    expect(actionAllowed('resume', 'setup_failed')).toBe(false));
  it('setup_failed does NOT allow stop', () =>
    expect(actionAllowed('stop', 'setup_failed')).toBe(false));
  it('setup_failed does NOT allow pause', () =>
    expect(actionAllowed('pause', 'setup_failed')).toBe(false));
  it('setup_failed does NOT allow learn', () =>
    expect(actionAllowed('learn', 'setup_failed')).toBe(false));

  // unrecoverable: archive/delete allowed (terminal cleanup only)
  it('unrecoverable allows archive', () =>
    expect(actionAllowed('archive', 'unrecoverable')).toBe(true));
  it('unrecoverable allows delete', () =>
    expect(actionAllowed('delete', 'unrecoverable')).toBe(true));
  it('unrecoverable does NOT allow resume', () =>
    expect(actionAllowed('resume', 'unrecoverable')).toBe(false));
  it('unrecoverable does NOT allow cancel', () =>
    expect(actionAllowed('cancel', 'unrecoverable')).toBe(false));
  it('unrecoverable does NOT allow stop', () =>
    expect(actionAllowed('stop', 'unrecoverable')).toBe(false));
  it('unrecoverable does NOT allow learn', () =>
    expect(actionAllowed('learn', 'unrecoverable')).toBe(false));
});
