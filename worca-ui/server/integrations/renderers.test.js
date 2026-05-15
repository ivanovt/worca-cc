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

function bodyText(msg) {
  return msg.body.map((s) => s.value).join('');
}

describe('TIER1_EVENTS', () => {
  it('exports exactly 17 event type strings (14 pipeline + 3 fleet)', () => {
    expect(TIER1_EVENTS).toHaveLength(17);
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
    expect(TIER1_EVENTS).toContain('pipeline.git.pr_merged');
    expect(TIER1_EVENTS).toContain('pipeline.circuit_breaker.tripped');
    expect(TIER1_EVENTS).toContain('pipeline.cost.budget_warning');
    // Fleet tier-1:
    expect(TIER1_EVENTS).toContain('fleet.halted');
    expect(TIER1_EVENTS).toContain('fleet.completed');
    expect(TIER1_EVENTS).toContain('fleet.failed');
    // fleet.launched is opt-in, NOT here:
    expect(TIER1_EVENTS).not.toContain('fleet.launched');
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
});
