import { describe, expect, it } from 'vitest';
import { actionAllowed, STATES } from './state-actions.js';

const EXPECTED = {
  stop: { running: true, planning: true, integration_testing: true },
  pause: { running: true, planning: true, integration_testing: true },
  resume: {
    paused: true,
    failed: true,
    interrupted: true,
    halted: true,
    integration_failed: true,
    blocked: true,
  },
  cancel: {
    pending: true,
    running: true,
    paused: true,
    failed: true,
    interrupted: true,
    halted: true,
    setup_failed: true,
    integration_failed: true,
    blocked: true,
  },
  archive: {
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
    halted: true,
    setup_failed: true,
    unrecoverable: true,
    integration_failed: true,
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
    integration_failed: true,
    blocked: true,
  },
  learn: {
    paused: true,
    completed: true,
    failed: true,
    interrupted: true,
    cancelled: true,
    halted: true,
    integration_failed: true,
    blocked: true,
  },
};

const ACTIONS = Object.keys(EXPECTED);

describe('state-actions', () => {
  it('exports all canonical states including workspace statuses', () => {
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
      'planning',
      'integration_testing',
      'integration_failed',
      'blocked',
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

  // pending: only cancel/delete allowed (per W-040 §13.7 — no PID exists yet)
  it('pending allows cancel', () =>
    expect(actionAllowed('cancel', 'pending')).toBe(true));
  it('pending allows delete', () =>
    expect(actionAllowed('delete', 'pending')).toBe(true));
  it('pending does NOT allow archive', () =>
    expect(actionAllowed('archive', 'pending')).toBe(false));
  it('pending does NOT allow resume', () =>
    expect(actionAllowed('resume', 'pending')).toBe(false));
  it('pending does NOT allow stop', () =>
    expect(actionAllowed('stop', 'pending')).toBe(false));
  it('pending does NOT allow pause', () =>
    expect(actionAllowed('pause', 'pending')).toBe(false));
  it('pending does NOT allow learn', () =>
    expect(actionAllowed('learn', 'pending')).toBe(false));

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

  // workspace statuses (W-047 §10.7)
  it('STATES includes workspace statuses', () => {
    expect(STATES).toContain('planning');
    expect(STATES).toContain('integration_testing');
    expect(STATES).toContain('integration_failed');
    expect(STATES).toContain('blocked');
  });

  // planning: active state — stop/pause allowed
  it('planning allows stop', () =>
    expect(actionAllowed('stop', 'planning')).toBe(true));
  it('planning allows pause', () =>
    expect(actionAllowed('pause', 'planning')).toBe(true));
  it('planning does NOT allow resume', () =>
    expect(actionAllowed('resume', 'planning')).toBe(false));
  it('planning does NOT allow archive', () =>
    expect(actionAllowed('archive', 'planning')).toBe(false));

  // integration_testing: active state — stop/pause allowed
  it('integration_testing allows stop', () =>
    expect(actionAllowed('stop', 'integration_testing')).toBe(true));
  it('integration_testing allows pause', () =>
    expect(actionAllowed('pause', 'integration_testing')).toBe(true));
  it('integration_testing does NOT allow resume', () =>
    expect(actionAllowed('resume', 'integration_testing')).toBe(false));
  it('integration_testing does NOT allow archive', () =>
    expect(actionAllowed('archive', 'integration_testing')).toBe(false));

  // integration_failed: terminal failure — resume/cancel/archive/delete/learn
  it('integration_failed allows resume', () =>
    expect(actionAllowed('resume', 'integration_failed')).toBe(true));
  it('integration_failed allows cancel', () =>
    expect(actionAllowed('cancel', 'integration_failed')).toBe(true));
  it('integration_failed allows archive', () =>
    expect(actionAllowed('archive', 'integration_failed')).toBe(true));
  it('integration_failed allows delete', () =>
    expect(actionAllowed('delete', 'integration_failed')).toBe(true));
  it('integration_failed allows learn', () =>
    expect(actionAllowed('learn', 'integration_failed')).toBe(true));
  it('integration_failed does NOT allow stop', () =>
    expect(actionAllowed('stop', 'integration_failed')).toBe(false));
  it('integration_failed does NOT allow pause', () =>
    expect(actionAllowed('pause', 'integration_failed')).toBe(false));

  // blocked: waiting state — resume/cancel/delete/learn (like paused)
  it('blocked allows resume', () =>
    expect(actionAllowed('resume', 'blocked')).toBe(true));
  it('blocked allows cancel', () =>
    expect(actionAllowed('cancel', 'blocked')).toBe(true));
  it('blocked allows delete', () =>
    expect(actionAllowed('delete', 'blocked')).toBe(true));
  it('blocked allows learn', () =>
    expect(actionAllowed('learn', 'blocked')).toBe(true));
  it('blocked does NOT allow stop', () =>
    expect(actionAllowed('stop', 'blocked')).toBe(false));
  it('blocked does NOT allow pause', () =>
    expect(actionAllowed('pause', 'blocked')).toBe(false));
});
