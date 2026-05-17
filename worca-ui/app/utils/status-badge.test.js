import { describe, expect, it } from 'vitest';
import {
  resolveStatus,
  statusClass,
  statusDotClass,
  statusIcon,
} from './status-badge.js';

describe('status-badge', () => {
  it('maps pending to correct class', () => {
    expect(statusClass('pending')).toBe('status-pending');
  });
  it('maps in_progress', () => {
    expect(statusClass('in_progress')).toBe('status-in-progress');
  });
  it('maps completed', () => {
    expect(statusClass('completed')).toBe('status-completed');
  });
  it('maps error', () => {
    expect(statusClass('error')).toBe('status-error');
  });
  it('maps skipped', () => {
    expect(statusClass('skipped')).toBe('status-skipped');
  });
  it('returns fallback for unknown', () => {
    expect(statusClass('whatever')).toBe('status-unknown');
  });
  it('statusIcon returns SVG strings for known statuses', () => {
    expect(statusIcon('completed')).toContain('<svg');
    expect(statusIcon('completed')).toContain('</svg>');
    expect(statusIcon('error')).toContain('<svg');
    expect(statusIcon('pending')).toContain('<svg');
    expect(statusIcon('skipped')).toContain('<svg');
  });
  it('statusIcon returns ? for unknown', () => {
    expect(statusIcon('whatever')).toBe('?');
  });
  it('statusIcon adds icon-spin class for in_progress', () => {
    expect(statusIcon('in_progress')).toContain('class="icon-spin"');
  });

  // New lifecycle states
  it('maps running to status-running', () => {
    expect(statusClass('running')).toBe('status-running');
  });
  it('maps paused to status-paused', () => {
    expect(statusClass('paused')).toBe('status-paused');
  });
  it('maps failed to status-failed', () => {
    expect(statusClass('failed')).toBe('status-failed');
  });
  it('statusIcon returns SVG for running', () => {
    expect(statusIcon('running')).toContain('<svg');
  });
  it('statusIcon adds icon-spin class for running', () => {
    expect(statusIcon('running')).toContain('class="icon-spin"');
  });
  it('statusIcon returns SVG for paused', () => {
    expect(statusIcon('paused')).toContain('<svg');
  });
  it('statusIcon returns SVG for failed', () => {
    expect(statusIcon('failed')).toContain('<svg');
  });
  // interrupted status
  it('maps interrupted to status-interrupted', () => {
    expect(statusClass('interrupted')).toBe('status-interrupted');
  });
  it('statusIcon returns SVG for interrupted', () => {
    expect(statusIcon('interrupted')).toContain('<svg');
  });
  it('statusIcon does NOT add icon-spin for interrupted', () => {
    expect(statusIcon('interrupted')).not.toContain('icon-spin');
  });
  it('resolveStatus returns interrupted for in_progress when not active', () => {
    expect(resolveStatus('in_progress', false)).toBe('interrupted');
  });
  it('resolveStatus preserves in_progress when active', () => {
    expect(resolveStatus('in_progress', true)).toBe('in_progress');
  });
  it('resolveStatus passes through interrupted unchanged', () => {
    expect(resolveStatus('interrupted', false)).toBe('interrupted');
  });

  // cancelled status
  it('maps cancelled to status-cancelled', () => {
    expect(statusClass('cancelled')).toBe('status-cancelled');
  });
  it('statusIcon returns SVG for cancelled', () => {
    expect(statusIcon('cancelled')).toContain('<svg');
  });
  it('statusIcon does NOT add icon-spin for cancelled', () => {
    expect(statusIcon('cancelled')).not.toContain('icon-spin');
  });

  // fleet child states: halted, setup_failed, unrecoverable
  it('maps halted to status-halted', () => {
    expect(statusClass('halted')).toBe('status-halted');
  });
  it('statusIcon returns SVG for halted', () => {
    expect(statusIcon('halted')).toContain('<svg');
  });
  it('statusIcon does NOT add icon-spin for halted', () => {
    expect(statusIcon('halted')).not.toContain('icon-spin');
  });

  it('maps setup_failed to status-setup-failed', () => {
    expect(statusClass('setup_failed')).toBe('status-setup-failed');
  });
  it('statusIcon returns SVG for setup_failed', () => {
    expect(statusIcon('setup_failed')).toContain('<svg');
  });
  it('statusIcon does NOT add icon-spin for setup_failed', () => {
    expect(statusIcon('setup_failed')).not.toContain('icon-spin');
  });

  it('maps unrecoverable to status-unrecoverable', () => {
    expect(statusClass('unrecoverable')).toBe('status-unrecoverable');
  });
  it('statusIcon returns SVG for unrecoverable', () => {
    expect(statusIcon('unrecoverable')).toContain('<svg');
  });
  it('statusIcon does NOT add icon-spin for unrecoverable', () => {
    expect(statusIcon('unrecoverable')).not.toContain('icon-spin');
  });

  // workspace statuses (W-047 §10.7)
  it('maps planning to status-planning', () => {
    expect(statusClass('planning')).toBe('status-planning');
  });
  it('statusIcon returns SVG for planning', () => {
    expect(statusIcon('planning')).toContain('<svg');
  });
  it('statusIcon adds icon-spin for planning (active state)', () => {
    expect(statusIcon('planning')).toContain('class="icon-spin"');
  });

  it('maps integration_testing to status-integration-testing', () => {
    expect(statusClass('integration_testing')).toBe(
      'status-integration-testing',
    );
  });
  it('statusIcon returns SVG for integration_testing', () => {
    expect(statusIcon('integration_testing')).toContain('<svg');
  });
  it('statusIcon adds icon-spin for integration_testing (active state)', () => {
    expect(statusIcon('integration_testing')).toContain('class="icon-spin"');
  });

  it('maps integration_failed to status-integration-failed', () => {
    expect(statusClass('integration_failed')).toBe('status-integration-failed');
  });
  it('statusIcon returns SVG for integration_failed', () => {
    expect(statusIcon('integration_failed')).toContain('<svg');
  });
  it('statusIcon does NOT add icon-spin for integration_failed', () => {
    expect(statusIcon('integration_failed')).not.toContain('icon-spin');
  });

  it('maps blocked to status-blocked', () => {
    expect(statusClass('blocked')).toBe('status-blocked');
  });
  it('statusIcon returns SVG for blocked', () => {
    expect(statusIcon('blocked')).toContain('<svg');
  });
  it('statusIcon does NOT add icon-spin for blocked', () => {
    expect(statusIcon('blocked')).not.toContain('icon-spin');
  });

  // statusDotClass — project-level aggregate status dot
  describe('statusDotClass', () => {
    it('maps running to project-status-running', () => {
      expect(statusDotClass('running')).toBe('project-status-running');
    });
    it('maps error to project-status-error', () => {
      expect(statusDotClass('error')).toBe('project-status-error');
    });
    it('maps paused to project-status-paused', () => {
      expect(statusDotClass('paused')).toBe('project-status-paused');
    });
    it('returns project-status-idle for idle', () => {
      expect(statusDotClass('idle')).toBe('project-status-idle');
    });
    it('returns project-status-idle for unknown status', () => {
      expect(statusDotClass('whatever')).toBe('project-status-idle');
    });
  });
});
