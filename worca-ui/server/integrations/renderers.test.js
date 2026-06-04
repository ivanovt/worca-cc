import { describe, expect, it } from 'vitest';
import { isValidMessage } from './adapter.js';
import { OPT_IN_RENDERERS, renderEvent, TIER1_EVENTS } from './renderers.js';

function envelope(event_type, payload, run_id = 'run-abc123') {
  return { event_type, run_id, payload };
}

function fleetEnvelope(
  event_type,
  payload,
  fleet_id = 'f_202605120900_test1234',
) {
  return { event_type, fleet_id, payload };
}

function workspaceEnvelope(
  event_type,
  payload,
  workspace_id = 'ws_202605120900_test1234',
) {
  return { event_type, workspace_id, payload };
}

function bodyText(msg) {
  return msg.body.map((s) => s.value).join('');
}

describe('TIER1_EVENTS', () => {
  it('exports exactly 28 event type strings (15 pipeline + 3 fleet + 10 workspace defaults — workspace.launched is opt-in)', () => {
    expect(TIER1_EVENTS).toHaveLength(28);
    expect(TIER1_EVENTS).toContain('pipeline.run.started');
    expect(TIER1_EVENTS).toContain('pipeline.run.completed');
    expect(TIER1_EVENTS).toContain('pipeline.run.failed');
    expect(TIER1_EVENTS).toContain('pipeline.run.interrupted');
    expect(TIER1_EVENTS).toContain('pipeline.run.paused');
    expect(TIER1_EVENTS).toContain('pipeline.run.resumed');
    expect(TIER1_EVENTS).toContain('pipeline.run.resumed_from_pause');
    expect(TIER1_EVENTS).toContain('pipeline.stage.started');
    expect(TIER1_EVENTS).toContain('pipeline.stage.completed');
    expect(TIER1_EVENTS).toContain('pipeline.stage.interrupted');
    expect(TIER1_EVENTS).toContain('pipeline.git.pr_created');
    expect(TIER1_EVENTS).toContain('pipeline.git.pr_deferred');
    expect(TIER1_EVENTS).toContain('pipeline.git.pr_merged');
    expect(TIER1_EVENTS).toContain('pipeline.circuit_breaker.tripped');
    expect(TIER1_EVENTS).toContain('pipeline.cost.budget_warning');
    // Fleet tier-1:
    expect(TIER1_EVENTS).toContain('fleet.halted');
    expect(TIER1_EVENTS).toContain('fleet.completed');
    expect(TIER1_EVENTS).toContain('fleet.failed');
    // fleet.launched is opt-in, NOT here:
    expect(TIER1_EVENTS).not.toContain('fleet.launched');
    // Workspace tier-1 defaults — terminal and attention events:
    expect(TIER1_EVENTS).toContain('workspace.completed');
    expect(TIER1_EVENTS).toContain('workspace.failed');
    expect(TIER1_EVENTS).toContain('workspace.halted');
    expect(TIER1_EVENTS).toContain('workspace.paused');
    expect(TIER1_EVENTS).toContain('workspace.resumed');
    expect(TIER1_EVENTS).toContain('workspace.tier.failed');
    expect(TIER1_EVENTS).toContain('workspace.integration_test.failed');
    expect(TIER1_EVENTS).toContain('workspace.umbrella_issue.created');
    expect(TIER1_EVENTS).toContain('workspace.circuit_breaker.tripped');
    expect(TIER1_EVENTS).toContain('workspace.guide_conflict');
    // Workspace opt-in (NOT defaults):
    expect(TIER1_EVENTS).not.toContain('workspace.launched');
    expect(TIER1_EVENTS).not.toContain('workspace.plan.started');
    expect(TIER1_EVENTS).not.toContain('workspace.plan.completed');
    expect(TIER1_EVENTS).not.toContain('workspace.plan.failed');
    expect(TIER1_EVENTS).not.toContain('workspace.plan.loaded');
    expect(TIER1_EVENTS).not.toContain('workspace.plan.partial');
    expect(TIER1_EVENTS).not.toContain('workspace.tier.started');
    expect(TIER1_EVENTS).not.toContain('workspace.tier.completed');
    expect(TIER1_EVENTS).not.toContain('workspace.integration_test.started');
    expect(TIER1_EVENTS).not.toContain('workspace.integration_test.passed');
  });
});

describe('renderEvent', () => {
  it('returns null for unknown event type', () => {
    expect(renderEvent(envelope('pipeline.bead.created', {}))).toBeNull();
  });

  it('returns null for missing envelope', () => {
    expect(renderEvent(null)).toBeNull();
    expect(renderEvent(undefined)).toBeNull();
  });

  it('returns null for envelope without event_type', () => {
    expect(renderEvent({ payload: {} })).toBeNull();
  });

  describe('pipeline.run.completed', () => {
    const payload = {
      duration_ms: 754000,
      total_cost_usd: 0.87,
      total_turns: 10,
      total_tokens: 50000,
      stages_completed: ['planner', 'implementer'],
    };

    it('produces a valid NormalizedMessage', () => {
      const msg = renderEvent(envelope('pipeline.run.completed', payload));
      expect(isValidMessage(msg)).toBe(true);
    });

    it('severity is success', () => {
      const msg = renderEvent(envelope('pipeline.run.completed', payload));
      expect(msg.severity).toBe('success');
    });

    it('body includes run_id', () => {
      const msg = renderEvent(envelope('pipeline.run.completed', payload));
      expect(bodyText(msg)).toContain('run-abc123');
    });

    it('body includes formatted duration (12m34s)', () => {
      const msg = renderEvent(envelope('pipeline.run.completed', payload));
      expect(bodyText(msg)).toContain('12m34s');
    });

    it('body includes formatted cost ($0.87)', () => {
      const msg = renderEvent(envelope('pipeline.run.completed', payload));
      expect(bodyText(msg)).toContain('$0.87');
    });

    it('formats sub-minute duration correctly', () => {
      const p = { ...payload, duration_ms: 45000 };
      const msg = renderEvent(envelope('pipeline.run.completed', p));
      expect(bodyText(msg)).toContain('45s');
    });

    it('pads seconds to two digits', () => {
      const p = { ...payload, duration_ms: 65000 }; // 1m05s
      const msg = renderEvent(envelope('pipeline.run.completed', p));
      expect(bodyText(msg)).toContain('1m05s');
    });
  });

  describe('pipeline.run.failed', () => {
    const payload = {
      error: 'SyntaxError: unexpected token',
      failed_stage: 'implementer',
      error_type: 'SyntaxError',
    };

    it('produces a valid NormalizedMessage', () => {
      const msg = renderEvent(envelope('pipeline.run.failed', payload));
      expect(isValidMessage(msg)).toBe(true);
    });

    it('severity is error', () => {
      const msg = renderEvent(envelope('pipeline.run.failed', payload));
      expect(msg.severity).toBe('error');
    });

    it('body includes failed_stage', () => {
      const msg = renderEvent(envelope('pipeline.run.failed', payload));
      expect(bodyText(msg)).toContain('implementer');
    });

    it('body includes error_type', () => {
      const msg = renderEvent(envelope('pipeline.run.failed', payload));
      expect(bodyText(msg)).toContain('SyntaxError');
    });

    it('body includes run_id', () => {
      const msg = renderEvent(envelope('pipeline.run.failed', payload));
      expect(bodyText(msg)).toContain('run-abc123');
    });

    it('falls back to error string when error_type is absent', () => {
      const p = { error: 'something broke', failed_stage: 'tester' };
      const msg = renderEvent(envelope('pipeline.run.failed', p));
      expect(bodyText(msg)).toContain('something broke');
    });
  });

  describe('pipeline.run.interrupted', () => {
    const payload = { interrupted_stage: 'tester', elapsed_ms: 720000 };

    it('produces a valid NormalizedMessage', () => {
      const msg = renderEvent(envelope('pipeline.run.interrupted', payload));
      expect(isValidMessage(msg)).toBe(true);
    });

    it('severity is warning', () => {
      const msg = renderEvent(envelope('pipeline.run.interrupted', payload));
      expect(msg.severity).toBe('warning');
    });

    it('body includes interrupted_stage', () => {
      const msg = renderEvent(envelope('pipeline.run.interrupted', payload));
      expect(bodyText(msg)).toContain('tester');
    });

    it('body includes elapsed time (12m00s)', () => {
      const msg = renderEvent(envelope('pipeline.run.interrupted', payload));
      expect(bodyText(msg)).toContain('12m00s');
    });

    it('body includes run_id', () => {
      const msg = renderEvent(envelope('pipeline.run.interrupted', payload));
      expect(bodyText(msg)).toContain('run-abc123');
    });
  });

  describe('pipeline.git.pr_created', () => {
    const payload = {
      pr_url: 'https://github.com/org/repo/pull/193',
      pr_number: 193,
      title: 'Add user auth',
    };

    it('produces a valid NormalizedMessage', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_created', payload));
      expect(isValidMessage(msg)).toBe(true);
    });

    it('severity is info', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_created', payload));
      expect(msg.severity).toBe('info');
    });

    it('body includes PR number', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_created', payload));
      expect(bodyText(msg)).toContain('193');
    });

    it('body includes PR title', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_created', payload));
      expect(bodyText(msg)).toContain('Add user auth');
    });

    it('includes pr_url as markdown link', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_created', payload));
      expect(bodyText(msg)).toContain('https://github.com/org/repo/pull/193');
      expect(bodyText(msg)).toContain('[#193]');
    });
  });

  describe('pipeline.git.pr_merged', () => {
    const payload = {
      pr_url: 'https://github.com/org/repo/pull/193',
      pr_number: 193,
    };

    it('produces a valid NormalizedMessage', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_merged', payload));
      expect(isValidMessage(msg)).toBe(true);
    });

    it('severity is success', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_merged', payload));
      expect(msg.severity).toBe('success');
    });

    it('body includes PR number', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_merged', payload));
      expect(bodyText(msg)).toContain('193');
    });

    it('includes pr_url as markdown link', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_merged', payload));
      expect(bodyText(msg)).toContain('https://github.com/org/repo/pull/193');
      expect(bodyText(msg)).toContain('[#193]');
    });
  });

  describe('pipeline.git.pr_deferred', () => {
    const payload = {
      pr_title: 'Add user auth',
      base_branch: 'main',
      head_branch: 'worca/w-065-add-auth',
      commit_sha: 'abc1234',
    };

    it('produces a valid NormalizedMessage', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_deferred', payload));
      expect(isValidMessage(msg)).toBe(true);
    });

    it('severity is warning (attention required)', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_deferred', payload));
      expect(msg.severity).toBe('warning');
    });

    it('body includes run_id', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_deferred', payload));
      expect(bodyText(msg)).toContain('run-abc123');
    });

    it('body includes head_branch', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_deferred', payload));
      expect(bodyText(msg)).toContain('worca/w-065-add-auth');
    });

    it('body includes Create PR instruction', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_deferred', payload));
      expect(bodyText(msg)).toContain('Create PR');
    });

    it('body includes pr_title when present', () => {
      const msg = renderEvent(envelope('pipeline.git.pr_deferred', payload));
      expect(bodyText(msg)).toContain('Add user auth');
    });

    it('works without optional commit_sha', () => {
      const p = {
        pr_title: 'Fix bug',
        base_branch: 'main',
        head_branch: 'fix/bug',
      };
      const msg = renderEvent(envelope('pipeline.git.pr_deferred', p));
      expect(isValidMessage(msg)).toBe(true);
    });
  });

  describe('pipeline.circuit_breaker.tripped', () => {
    const payload = {
      reason: 'consecutive api_error failures',
      consecutive_failures: 3,
      category: 'api_error',
    };

    it('produces a valid NormalizedMessage', () => {
      const msg = renderEvent(
        envelope('pipeline.circuit_breaker.tripped', payload),
      );
      expect(isValidMessage(msg)).toBe(true);
    });

    it('severity is error', () => {
      const msg = renderEvent(
        envelope('pipeline.circuit_breaker.tripped', payload),
      );
      expect(msg.severity).toBe('error');
    });

    it('body includes consecutive_failures count', () => {
      const msg = renderEvent(
        envelope('pipeline.circuit_breaker.tripped', payload),
      );
      expect(bodyText(msg)).toContain('3');
    });

    it('body includes category', () => {
      const msg = renderEvent(
        envelope('pipeline.circuit_breaker.tripped', payload),
      );
      expect(bodyText(msg)).toContain('api_error');
    });

    it('body indicates run halted', () => {
      const msg = renderEvent(
        envelope('pipeline.circuit_breaker.tripped', payload),
      );
      expect(bodyText(msg)).toContain('halted');
    });
  });

  describe('pipeline.cost.budget_warning', () => {
    const payload = {
      total_cost_usd: 85.0,
      budget_usd: 100.0,
      pct_used: 0.85,
    };

    it('produces a valid NormalizedMessage', () => {
      const msg = renderEvent(
        envelope('pipeline.cost.budget_warning', payload),
      );
      expect(isValidMessage(msg)).toBe(true);
    });

    it('severity is warning', () => {
      const msg = renderEvent(
        envelope('pipeline.cost.budget_warning', payload),
      );
      expect(msg.severity).toBe('warning');
    });

    it('body includes pct_used as percentage', () => {
      const msg = renderEvent(
        envelope('pipeline.cost.budget_warning', payload),
      );
      expect(bodyText(msg)).toContain('85%');
    });

    it('body includes budget_usd', () => {
      const msg = renderEvent(
        envelope('pipeline.cost.budget_warning', payload),
      );
      expect(bodyText(msg)).toContain('$100.00');
    });

    it('body includes run_id', () => {
      const msg = renderEvent(
        envelope('pipeline.cost.budget_warning', payload),
      );
      expect(bodyText(msg)).toContain('run-abc123');
    });
  });

  describe('pipeline.run.started', () => {
    it('returns valid message', () => {
      const msg = renderEvent(
        envelope('pipeline.run.started', { title: 'Add auth' }),
      );
      expect(isValidMessage(msg)).toBe(true);
      expect(msg.severity).toBe('info');
      expect(bodyText(msg)).toContain('started');
      expect(bodyText(msg)).toContain('Add auth');
    });

    it('truncates long titles', () => {
      const msg = renderEvent(
        envelope('pipeline.run.started', { title: 'A'.repeat(100) }),
      );
      expect(bodyText(msg)).toContain('…');
    });

    it('works without title', () => {
      const msg = renderEvent(envelope('pipeline.run.started', {}));
      expect(isValidMessage(msg)).toBe(true);
    });
  });

  describe('pipeline.run.paused', () => {
    it('returns valid warning', () => {
      const msg = renderEvent(
        envelope('pipeline.run.paused', { stage: 'implement' }),
      );
      expect(msg.severity).toBe('warning');
      expect(bodyText(msg)).toContain('paused');
      expect(bodyText(msg)).toContain('implement');
    });
  });

  describe('pipeline.run.resumed', () => {
    it('returns valid info', () => {
      const msg = renderEvent(envelope('pipeline.run.resumed', {}));
      expect(msg.severity).toBe('info');
      expect(bodyText(msg)).toContain('resumed');
    });
  });

  describe('pipeline.run.resumed_from_pause', () => {
    it('returns valid info', () => {
      const msg = renderEvent(envelope('pipeline.run.resumed_from_pause', {}));
      expect(msg.severity).toBe('info');
      expect(bodyText(msg)).toContain('resumed from pause');
    });
  });

  describe('pipeline.stage.started', () => {
    it('returns valid message with stage name', () => {
      const msg = renderEvent(
        envelope('pipeline.stage.started', { stage: 'plan', iteration: 1 }),
      );
      expect(isValidMessage(msg)).toBe(true);
      expect(bodyText(msg)).toContain('plan');
      expect(bodyText(msg)).toContain('iteration 1');
    });
  });

  describe('pipeline.stage.completed', () => {
    it('returns valid success with duration', () => {
      const msg = renderEvent(
        envelope('pipeline.stage.completed', {
          stage: 'test',
          duration_ms: 65000,
        }),
      );
      expect(msg.severity).toBe('success');
      expect(bodyText(msg)).toContain('test');
      expect(bodyText(msg)).toContain('completed');
      expect(bodyText(msg)).toContain('1m05s');
    });

    it('includes beads tally when beads_total > 0', () => {
      const msg = renderEvent(
        envelope('pipeline.stage.completed', {
          stage: 'implement',
          duration_ms: 120000,
          beads_done: 6,
          beads_total: 8,
        }),
      );
      expect(bodyText(msg)).toContain('Beads');
      expect(bodyText(msg)).toContain('6/8');
    });

    it('omits beads line when beads_total is 0', () => {
      const msg = renderEvent(
        envelope('pipeline.stage.completed', {
          stage: 'implement',
          duration_ms: 120000,
          beads_total: 0,
          beads_done: 0,
        }),
      );
      expect(bodyText(msg)).not.toContain('Beads');
    });

    it('omits beads line when bead fields are absent', () => {
      const msg = renderEvent(
        envelope('pipeline.stage.completed', {
          stage: 'implement',
          duration_ms: 120000,
        }),
      );
      expect(bodyText(msg)).not.toContain('Beads');
    });
  });

  describe('pipeline.stage.interrupted', () => {
    it('returns valid warning', () => {
      const msg = renderEvent(
        envelope('pipeline.stage.interrupted', { stage: 'implement' }),
      );
      expect(msg.severity).toBe('warning');
      expect(bodyText(msg)).toContain('implement');
      expect(bodyText(msg)).toContain('interrupted');
    });
  });

  describe('fleet.halted', () => {
    it('renders user-stopped as warning', () => {
      const msg = renderEvent(
        fleetEnvelope('fleet.halted', {
          halt_reason: 'stopped',
          in_flight_count: 3,
        }),
      );
      expect(isValidMessage(msg)).toBe(true);
      expect(msg.severity).toBe('warning');
      const text = bodyText(msg);
      expect(text).toContain('stopped');
      expect(text).toContain('f_202605120900_test1234');
      expect(text).toContain('3');
    });

    it('renders circuit-breaker as error severity', () => {
      const msg = renderEvent(
        fleetEnvelope('fleet.halted', {
          halt_reason: 'circuit_breaker',
        }),
      );
      expect(msg.severity).toBe('error');
      expect(bodyText(msg)).toContain('circuit_breaker');
    });
  });

  describe('fleet.completed', () => {
    it('renders success with completion ratio', () => {
      const msg = renderEvent(
        fleetEnvelope('fleet.completed', {
          child_count: 5,
          completed_count: 5,
        }),
      );
      expect(isValidMessage(msg)).toBe(true);
      expect(msg.severity).toBe('success');
      expect(bodyText(msg)).toContain('5/5');
    });
  });

  describe('fleet.failed', () => {
    it('renders error with mixed counts', () => {
      const msg = renderEvent(
        fleetEnvelope('fleet.failed', {
          child_count: 5,
          completed_count: 2,
          failed_count: 2,
          interrupted_count: 1,
        }),
      );
      expect(msg.severity).toBe('error');
      const text = bodyText(msg);
      expect(text).toContain('2/5');
      expect(text).toContain('2 failed');
      expect(text).toContain('1 interrupted');
    });
  });

  describe('fleet.launched (opt-in)', () => {
    it('is NOT in the default Tier-1 map', () => {
      // Default renderer ignores fleet.launched; opt-in callers need
      // to wire it explicitly via OPT_IN_RENDERERS.
      const msg = renderEvent(
        fleetEnvelope('fleet.launched', { projects: ['/r/a'] }),
      );
      expect(msg).toBeNull();
    });

    it('is exported via OPT_IN_RENDERERS', () => {
      expect(OPT_IN_RENDERERS['fleet.launched']).toBeTypeOf('function');
    });

    it('OPT_IN_RENDERERS.fleet.launched renders projects + plan mode', () => {
      const render = OPT_IN_RENDERERS['fleet.launched'];
      const msg = render(
        fleetEnvelope('fleet.launched', {
          projects: ['/r/alpha', '/r/beta'],
          plan_mode: 'plan-first',
          guide_attached: true,
          base_branch: 'main',
        }),
      );
      expect(isValidMessage(msg)).toBe(true);
      const text = bodyText(msg);
      expect(text).toContain('alpha');
      expect(text).toContain('beta');
      expect(text).toContain('plan-first');
      expect(text).toContain('Guide');
      expect(text).toContain('main');
    });

    it('truncates project list beyond 5 items', () => {
      const render = OPT_IN_RENDERERS['fleet.launched'];
      const projects = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(
        (p) => `/r/${p}`,
      );
      const msg = render(
        fleetEnvelope('fleet.launched', { projects, plan_mode: 'none' }),
      );
      const text = bodyText(msg);
      expect(text).toContain('+2 more');
    });
  });

  // -------------------------------------------------------------------------
  // Workspace events
  // -------------------------------------------------------------------------

  describe('workspace.completed', () => {
    it('renders success with project count + duration + umbrella URL', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.completed', {
          workspace_name: 'my-platform',
          tier_count: 3,
          child_count: 5,
          integration_passed: true,
          duration_ms: 754000,
          umbrella_issue_url: 'https://github.com/org/platform/issues/42',
        }),
      );
      expect(isValidMessage(msg)).toBe(true);
      expect(msg.severity).toBe('success');
      const text = bodyText(msg);
      expect(text).toContain('my-platform');
      expect(text).toContain('ws_202605120900_test1234');
      expect(text).toContain('5');
      expect(text).toContain('passed');
      expect(text).toContain('12m34s');
      expect(text).toContain('issues/42');
    });
  });

  describe('workspace.failed', () => {
    it('renders error with tier + failed projects + duration', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.failed', {
          workspace_name: 'my-ws',
          tier_count: 3,
          completed_count: 1,
          failed_count: 2,
          duration_ms: 30000,
          failed_tier: 1,
          failed_projects: ['backend', 'worker'],
        }),
      );
      expect(msg.severity).toBe('error');
      const text = bodyText(msg);
      expect(text).toContain('my-ws');
      expect(text).toContain('backend');
      expect(text).toContain('worker');
      expect(text).toContain('30s');
    });
  });

  describe('workspace.halted', () => {
    it('renders user-halt as warning', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.halted', {
          workspace_name: 'my-ws',
          halt_reason: 'user',
          completed_tiers: 1,
          pending_tiers: 2,
        }),
      );
      expect(msg.severity).toBe('warning');
      const text = bodyText(msg);
      expect(text).toContain('user');
      expect(text).toContain('2 tier');
    });

    it('renders circuit_breaker as error', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.halted', {
          workspace_name: 'my-ws',
          halt_reason: 'circuit_breaker',
        }),
      );
      expect(msg.severity).toBe('error');
      expect(bodyText(msg)).toContain('circuit_breaker');
    });
  });

  describe('workspace.paused', () => {
    it('renders warning with reason', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.paused', {
          workspace_name: 'my-ws',
          reason: 'user',
        }),
      );
      expect(msg.severity).toBe('warning');
      expect(bodyText(msg)).toContain('paused');
    });
  });

  describe('workspace.resumed', () => {
    it('renders info with from_state + counts', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.resumed', {
          workspace_name: 'my-ws',
          from_state: 'halted',
          redispatch_count: 2,
          skip_count: 1,
        }),
      );
      expect(msg.severity).toBe('info');
      const text = bodyText(msg);
      expect(text).toContain('resumed');
      expect(text).toContain('halted');
      expect(text).toContain('2 project');
    });
  });

  describe('workspace.tier.failed', () => {
    it('renders error with failed + blocked projects', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.tier.failed', {
          workspace_name: 'my-ws',
          tier: 1,
          failed_projects: ['backend'],
          blocked_projects: ['frontend'],
          duration_ms: 12000,
        }),
      );
      expect(msg.severity).toBe('error');
      const text = bodyText(msg);
      expect(text).toContain('backend');
      expect(text).toContain('frontend');
      expect(text).toContain('Blocked');
    });
  });

  describe('workspace.integration_test.failed', () => {
    it('renders error with exit code + log tail', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.integration_test.failed', {
          workspace_name: 'my-ws',
          exit_code: 1,
          duration_ms: 4500,
          log_path: '/abs/log.txt',
          log_tail: 'FAIL: test_user_auth\n',
        }),
      );
      expect(msg.severity).toBe('error');
      const text = bodyText(msg);
      expect(text).toContain('Exit code');
      expect(text).toContain('1');
      expect(text).toContain('FAIL: test_user_auth');
    });
  });

  describe('workspace.umbrella_issue.created', () => {
    it('renders info with nwo + issue number + child count', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.umbrella_issue.created', {
          workspace_name: 'my-ws',
          issue_url: 'https://github.com/org/platform/issues/42',
          issue_number: 42,
          nwo: 'org/platform',
          child_pr_count: 3,
        }),
      );
      expect(msg.severity).toBe('info');
      const text = bodyText(msg);
      expect(text).toContain('org/platform#42');
      expect(text).toContain('3');
    });
  });

  describe('workspace.circuit_breaker.tripped', () => {
    it('renders error with failure ratio + threshold', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.circuit_breaker.tripped', {
          workspace_name: 'my-ws',
          failed_count: 3,
          terminal_count: 4,
          total_count: 5,
          threshold: 0.3,
          failure_ratio: 0.75,
        }),
      );
      expect(msg.severity).toBe('error');
      const text = bodyText(msg);
      expect(text).toContain('3/4');
      expect(text).toContain('75%');
      expect(text).toContain('30%');
    });
  });

  describe('workspace.guide_conflict', () => {
    it('renders warning with stage + run_id + message', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.guide_conflict', {
          workspace_name: 'my-ws',
          run_id: 'run-789',
          stage: 'plan',
          source: 'description',
          message: 'Description requests X but guide forbids it',
        }),
      );
      expect(msg.severity).toBe('warning');
      const text = bodyText(msg);
      expect(text).toContain('plan');
      expect(text).toContain('run-789');
      expect(text).toContain('Description requests X');
    });
  });

  describe('pipeline.bead.next (opt-in)', () => {
    it('is NOT in the default Tier-1 map', () => {
      const msg = renderEvent(
        envelope('pipeline.bead.next', {
          next_bead_id: 'beads-abc',
          bead_iteration: 3,
          max_beads: 8,
        }),
      );
      expect(msg).toBeNull();
    });

    it('is NOT in TIER1_EVENTS', () => {
      expect(TIER1_EVENTS).not.toContain('pipeline.bead.next');
    });

    it('is exported via OPT_IN_RENDERERS', () => {
      expect(OPT_IN_RENDERERS['pipeline.bead.next']).toBeTypeOf('function');
    });

    it('renders bead_iteration/max_beads', () => {
      const render = OPT_IN_RENDERERS['pipeline.bead.next'];
      const msg = render(
        envelope('pipeline.bead.next', {
          next_bead_id: 'beads-abc',
          bead_iteration: 3,
          max_beads: 8,
        }),
      );
      expect(isValidMessage(msg)).toBe(true);
      expect(msg.severity).toBe('info');
      const text = bodyText(msg);
      expect(text).toContain('run-abc123');
      expect(text).toContain('3/8');
    });

    it('renders without max_beads', () => {
      const render = OPT_IN_RENDERERS['pipeline.bead.next'];
      const msg = render(
        envelope('pipeline.bead.next', {
          next_bead_id: 'beads-xyz',
          bead_iteration: 2,
        }),
      );
      expect(isValidMessage(msg)).toBe(true);
      const text = bodyText(msg);
      expect(text).toContain('2');
      expect(text).not.toContain('/');
    });
  });

  describe('workspace opt-in renderers', () => {
    it('workspace.launched is NOT in the default map', () => {
      const msg = renderEvent(
        workspaceEnvelope('workspace.launched', {
          workspace_name: 'my-ws',
          projects: ['a', 'b'],
        }),
      );
      expect(msg).toBeNull();
    });

    it('exports workspace.launched via OPT_IN_RENDERERS', () => {
      expect(OPT_IN_RENDERERS['workspace.launched']).toBeTypeOf('function');
    });

    it('OPT_IN_RENDERERS.workspace.launched renders projects + tier count', () => {
      const render = OPT_IN_RENDERERS['workspace.launched'];
      const msg = render(
        workspaceEnvelope('workspace.launched', {
          workspace_name: 'my-ws',
          projects: ['a', 'b', 'c'],
          tier_count: 2,
          guide_attached: true,
        }),
      );
      expect(isValidMessage(msg)).toBe(true);
      const text = bodyText(msg);
      expect(text).toContain('a, b, c');
      expect(text).toContain('Tiers');
      expect(text).toContain('Guide');
    });

    it('OPT_IN_RENDERERS.workspace.tier.started includes tier index', () => {
      const render = OPT_IN_RENDERERS['workspace.tier.started'];
      const msg = render(
        workspaceEnvelope('workspace.tier.started', {
          workspace_name: 'my-ws',
          tier: 1,
          projects: ['backend', 'worker'],
        }),
      );
      expect(isValidMessage(msg)).toBe(true);
      const text = bodyText(msg);
      expect(text).toContain('Tier:');
      expect(text).toContain('1');
      expect(text).toContain('backend');
    });

    it('OPT_IN_RENDERERS.workspace.tier.completed shows duration', () => {
      const render = OPT_IN_RENDERERS['workspace.tier.completed'];
      const msg = render(
        workspaceEnvelope('workspace.tier.completed', {
          workspace_name: 'my-ws',
          tier: 0,
          projects: ['shared-lib'],
          status: 'completed',
          duration_ms: 90000,
        }),
      );
      expect(msg.severity).toBe('success');
      expect(bodyText(msg)).toContain('1m30s');
    });

    it('OPT_IN_RENDERERS.workspace.plan.started/completed/failed all export', () => {
      expect(OPT_IN_RENDERERS['workspace.plan.started']).toBeTypeOf('function');
      expect(OPT_IN_RENDERERS['workspace.plan.completed']).toBeTypeOf(
        'function',
      );
      expect(OPT_IN_RENDERERS['workspace.plan.failed']).toBeTypeOf('function');
    });

    it('OPT_IN_RENDERERS.workspace.plan.loaded/partial export', () => {
      expect(OPT_IN_RENDERERS['workspace.plan.loaded']).toBeTypeOf('function');
      expect(OPT_IN_RENDERERS['workspace.plan.partial']).toBeTypeOf('function');
    });

    it('workspace.plan.loaded renders info with mode and project count', () => {
      const renderer = OPT_IN_RENDERERS['workspace.plan.loaded'];
      const msg = renderer({
        event_type: 'workspace.plan.loaded',
        payload: {
          workspace_name: 'my-ws',
          mode: 'existing',
          project_count: 3,
          covered_projects: ['api', 'web', 'lib'],
        },
      });
      expect(msg).not.toBeNull();
      expect(msg.severity).toBe('info');
      expect(bodyText(msg)).toContain('my-ws');
      expect(bodyText(msg)).toContain('existing');
      expect(bodyText(msg)).toContain('3');
    });

    it('workspace.plan.partial renders warning with uncovered projects', () => {
      const renderer = OPT_IN_RENDERERS['workspace.plan.partial'];
      const msg = renderer({
        event_type: 'workspace.plan.partial',
        payload: {
          workspace_name: 'my-ws',
          mode: 'per-repo',
          project_count: 4,
          covered_projects: ['api', 'web'],
          uncovered_projects: ['lib', 'cli'],
        },
      });
      expect(msg).not.toBeNull();
      expect(msg.severity).toBe('warning');
      expect(bodyText(msg)).toContain('my-ws');
      expect(bodyText(msg)).toContain('per-repo');
      expect(bodyText(msg)).toContain('lib');
      expect(bodyText(msg)).toContain('cli');
    });

    it('OPT_IN_RENDERERS.workspace.integration_test.started/passed export', () => {
      expect(OPT_IN_RENDERERS['workspace.integration_test.started']).toBeTypeOf(
        'function',
      );
      expect(OPT_IN_RENDERERS['workspace.integration_test.passed']).toBeTypeOf(
        'function',
      );
    });
  });
});
