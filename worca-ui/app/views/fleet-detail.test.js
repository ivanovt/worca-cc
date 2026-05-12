import { describe, expect, it } from 'vitest';
import { fleetDetailView, resetFleetDetailState } from './fleet-detail.js';

function renderToString(template) {
  if (!template) return '';
  if (typeof template === 'string') return template;
  if (!template.strings) return String(template);
  let result = '';
  template.strings.forEach((s, i) => {
    result += s;
    if (i < template.values.length) {
      const v = template.values[i];
      if (typeof v === 'string') result += v;
      else if (typeof v === 'number') result += String(v);
      else if (Array.isArray(v)) result += v.map(renderToString).join('');
      else if (v?.strings) result += renderToString(v);
    }
  });
  return result;
}

const BASE_FLEET = {
  fleet_id: 'f_202605120900_abc12345',
  fleet_id_short: 'abc12345',
  created_at: '2026-05-12T09:00:00.000Z',
  status: 'running',
  halt_reason: null,
  work_request: {
    title: 'Migrate to v2 API',
    description: 'Update all repos to use the new v2 API endpoint.',
  },
  head_template: 'migration/{project}/{slug}',
  base_branch: 'main',
  max_parallel: 5,
  fleet_failure_threshold: 0.3,
  plan: { mode: 'none' },
  guide: null,
  children: [
    {
      project_path: '/repos/alpha',
      run_id: 'run-1',
      status: 'completed',
      head_branch: 'migration/alpha/v2-api',
      base_branch: 'main',
      pr_url: 'https://github.com/org/alpha/pull/42',
      stages: {
        planner: { iterations: [{ cost_usd: 0.05 }] },
        implementer: { iterations: [{ cost_usd: 0.1 }] },
      },
    },
    {
      project_path: '/repos/beta',
      run_id: 'run-2',
      status: 'running',
      head_branch: 'migration/beta/v2-api',
      base_branch: 'main',
      pr_url: null,
      stages: {
        planner: { iterations: [{ cost_usd: 0.03 }] },
      },
    },
  ],
};

// ─── header strip ─────────────────────────────────────────────────────────────

describe('fleetDetailView — header strip', () => {
  it('renders fleet-detail-header', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-detail-header');
  });

  it('renders back button to dashboard', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('btn-back-to-dashboard');
  });

  it('renders fleet title from work_request.title', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('Migrate to v2 API');
  });

  it('renders fleet status badge', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-status-badge');
  });

  it('uses primary variant for running status', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'running' }, {}),
    );
    expect(out).toContain('variant="primary"');
  });

  it('uses success variant for completed status', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'completed' }, {}),
    );
    expect(out).toContain('variant="success"');
  });

  it('uses danger variant for failed status', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'failed' }, {}),
    );
    expect(out).toContain('variant="danger"');
  });

  it('uses warning variant for halted circuit_breaker', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(
        { ...BASE_FLEET, status: 'halted', halt_reason: 'circuit_breaker' },
        {},
      ),
    );
    expect(out).toContain('variant="warning"');
  });

  it('uses neutral variant for halted user', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(
        { ...BASE_FLEET, status: 'halted', halt_reason: 'user' },
        {},
      ),
    );
    expect(out).toContain('variant="neutral"');
  });

  it('badge title shows user halt text with timestamp', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(
        {
          ...BASE_FLEET,
          status: 'halted',
          halt_reason: 'user',
          halted_at: '2026-05-12T10:30:00Z',
        },
        {},
      ),
    );
    expect(out).toContain('Halted by you on 2026-05-12T10:30:00Z');
  });

  it('badge title shows auto halt text for circuit_breaker with failure counts', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(
        {
          ...BASE_FLEET,
          status: 'halted',
          halt_reason: 'circuit_breaker',
          children: [
            { ...BASE_FLEET.children[0], status: 'completed' },
            { ...BASE_FLEET.children[1], status: 'failed' },
          ],
        },
        {},
      ),
    );
    expect(out).toContain('Halted automatically: 1 of 2 children failed');
  });

  it('badge title is empty when fleet is running', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).not.toContain('Halted by you');
    expect(out).not.toContain('Halted automatically');
  });
});

// ─── manifest panel ───────────────────────────────────────────────────────────

describe('fleetDetailView — manifest panel', () => {
  it('renders fleet-manifest-panel', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-manifest-panel');
  });

  it('shows branch template', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('migration/{project}/{slug}');
  });

  it('shows plan mode', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('none');
  });

  it('shows max parallel', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('5');
  });

  it('shows circuit breaker threshold as percentage', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('30%');
  });

  it('shows created-at timestamp', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('2026-05-12');
  });
});

// ─── work request panel ───────────────────────────────────────────────────────

describe('fleetDetailView — work request panel', () => {
  it('renders fleet-work-request-panel', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-work-request-panel');
  });

  it('shows work request title', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('Migrate to v2 API');
  });

  it('shows work request description', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('Update all repos to use the new v2 API endpoint.');
  });
});

// ─── guide panel ──────────────────────────────────────────────────────────────

describe('fleetDetailView — guide panel — no guide', () => {
  it('renders fleet-guide-panel even without a guide', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, guide: null }, {}),
    );
    expect(out).toContain('fleet-guide-panel');
  });

  it('does not show view guide button when no guide attached', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, guide: null }, {}),
    );
    expect(out).not.toContain('btn-view-guide');
  });

  it('shows no-guide message when guide is null', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, guide: null }, {}),
    );
    expect(out).toContain('no-guide');
  });
});

describe('fleetDetailView — guide panel — with guide', () => {
  const fleetWithGuide = {
    ...BASE_FLEET,
    guide: {
      bytes: 2048,
      filenames: ['migration.md', 'spec.md'],
      uploaded: true,
    },
  };

  it('shows guide file names', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(fleetWithGuide, {}));
    expect(out).toContain('migration.md');
    expect(out).toContain('spec.md');
  });

  it('shows guide size in bytes', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(fleetWithGuide, {}));
    expect(out).toContain('2048');
  });

  it('renders View guide content button', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(fleetWithGuide, {}));
    expect(out).toContain('btn-view-guide');
    expect(out).toContain('View guide content');
  });

  it('renders guide dialog (initially closed)', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(fleetWithGuide, {}));
    expect(out).toContain('guide-dialog');
  });
});

describe('fleetDetailView — guide panel — loading state', () => {
  it('shows guide-loading indicator when loading', () => {
    resetFleetDetailState({ guideLoading: true });
    const out = renderToString(
      fleetDetailView(
        {
          ...BASE_FLEET,
          guide: { bytes: 1024, filenames: ['spec.md'], uploaded: true },
        },
        {},
      ),
    );
    expect(out).toContain('guide-loading');
  });
});

describe('fleetDetailView — guide panel — not-retrievable fallback', () => {
  it('shows guide-not-retrievable class when error is guide_not_retrievable', () => {
    resetFleetDetailState({
      guideError: 'guide_not_retrievable',
      guideErrorHint:
        'Guide was supplied via CLI from a path the UI server cannot read. View the original file on the launching machine.',
    });
    const out = renderToString(
      fleetDetailView(
        {
          ...BASE_FLEET,
          guide: { bytes: 1024, filenames: ['spec.md'], uploaded: false },
        },
        {},
      ),
    );
    expect(out).toContain('guide-not-retrievable');
  });

  it('shows the hint text for not-retrievable guide', () => {
    resetFleetDetailState({
      guideError: 'guide_not_retrievable',
      guideErrorHint: 'View the original file on the launching machine.',
    });
    const out = renderToString(
      fleetDetailView(
        {
          ...BASE_FLEET,
          guide: { bytes: 1024, filenames: ['spec.md'], uploaded: false },
        },
        {},
      ),
    );
    expect(out).toContain('View the original file on the launching machine.');
  });

  it('shows generic guide error when not guide_not_retrievable', () => {
    resetFleetDetailState({ guideError: 'Server error', guideErrorHint: null });
    const out = renderToString(
      fleetDetailView(
        {
          ...BASE_FLEET,
          guide: { bytes: 1024, filenames: ['spec.md'], uploaded: true },
        },
        {},
      ),
    );
    expect(out).toContain('guide-error');
  });
});

describe('fleetDetailView — guide panel — content loaded', () => {
  it('shows guide content in dialog when loaded', () => {
    resetFleetDetailState({ guideContent: '# Migration Guide\nDo this.' });
    const out = renderToString(
      fleetDetailView(
        {
          ...BASE_FLEET,
          guide: { bytes: 1024, filenames: ['spec.md'], uploaded: true },
        },
        {},
      ),
    );
    expect(out).toContain('guide-content');
    expect(out).toContain('# Migration Guide');
  });
});

// ─── children grid ────────────────────────────────────────────────────────────

describe('fleetDetailView — children grid', () => {
  it('renders fleet-children-grid', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-children-grid');
  });

  it('renders one row per child', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-child-row');
    // Two children = two rows
    const count = (out.match(/fleet-child-row/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('shows project name from path', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('shows child status badge', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-child-status');
  });

  it('shows head branch for each child', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('migration/alpha/v2-api');
    expect(out).toContain('migration/beta/v2-api');
  });

  it('shows base branch for each child', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    // Both children have base_branch: 'main'
    expect(out).toContain('main');
  });

  it('renders PR link when child has pr_url', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('https://github.com/org/alpha/pull/42');
  });

  it('does not render PR link when pr_url is null', () => {
    resetFleetDetailState();
    const fleetNoPr = {
      ...BASE_FLEET,
      children: [{ ...BASE_FLEET.children[1], pr_url: null }],
    };
    const out = renderToString(fleetDetailView(fleetNoPr, {}));
    expect(out).not.toContain('https://github.com');
  });

  it('shows per-child cost', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    // Alpha child costs 0.05 + 0.10 = $0.15
    expect(out).toContain('$0.15');
  });

  it('renders empty children message when no children', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, children: [] }, {}),
    );
    expect(out).toContain('no-children');
  });
});

describe('fleetDetailView — PR aggregation', () => {
  it('shows copy-all-pr-urls button when all children have PR urls', () => {
    resetFleetDetailState();
    const allPrFleet = {
      ...BASE_FLEET,
      children: [
        {
          ...BASE_FLEET.children[0],
          pr_url: 'https://github.com/org/alpha/pull/42',
        },
        {
          ...BASE_FLEET.children[1],
          pr_url: 'https://github.com/org/beta/pull/17',
          status: 'completed',
        },
      ],
    };
    const out = renderToString(fleetDetailView(allPrFleet, {}));
    expect(out).toContain('btn-copy-all-pr-urls');
  });

  it('does not show copy-all-pr-urls button when some children lack PR urls', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).not.toContain('btn-copy-all-pr-urls');
  });
});

// ─── aggregate cost panel ─────────────────────────────────────────────────────

describe('fleetDetailView — aggregate cost panel', () => {
  it('renders fleet-aggregate-cost panel', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-aggregate-cost');
  });

  it('shows total cost summed from all children', () => {
    resetFleetDetailState();
    // alpha: 0.05 + 0.10 = 0.15, beta: 0.03 — total: 0.18
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('$0.18');
  });

  it('shows zero cost when children have no stage costs', () => {
    resetFleetDetailState();
    const zeroCostFleet = {
      ...BASE_FLEET,
      children: [
        {
          project_path: '/repos/alpha',
          run_id: 'r1',
          status: 'running',
          stages: {},
        },
      ],
    };
    const out = renderToString(fleetDetailView(zeroCostFleet, {}));
    expect(out).toContain('$0.00');
  });

  it('formats sub-cent cost with 4 decimal places', () => {
    resetFleetDetailState();
    const microCostFleet = {
      ...BASE_FLEET,
      children: [
        {
          project_path: '/repos/gamma',
          run_id: 'r3',
          status: 'completed',
          stages: { planner: { iterations: [{ cost_usd: 0.001 }] } },
        },
      ],
    };
    const out = renderToString(fleetDetailView(microCostFleet, {}));
    expect(out).toContain('$0.0010');
  });
});

// ─── circuit breaker alert ────────────────────────────────────────────────────

describe('fleetDetailView — circuit breaker alert', () => {
  it('shows fleet-circuit-breaker-alert when fleet is halted', () => {
    resetFleetDetailState();
    const haltedFleet = {
      ...BASE_FLEET,
      status: 'halted',
      halt_reason: 'circuit_breaker',
      circuit_breaker: {
        unstarted_count: 3,
        trip_reason: 'failure_threshold exceeded',
      },
    };
    const out = renderToString(fleetDetailView(haltedFleet, {}));
    expect(out).toContain('fleet-circuit-breaker-alert');
  });

  it('does not show circuit breaker alert when fleet is running', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).not.toContain('fleet-circuit-breaker-alert');
  });

  it('does not show circuit breaker alert when fleet is completed', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'completed' }, {}),
    );
    expect(out).not.toContain('fleet-circuit-breaker-alert');
  });

  it('shows unstarted count in circuit breaker alert', () => {
    resetFleetDetailState();
    const haltedFleet = {
      ...BASE_FLEET,
      status: 'halted',
      halt_reason: 'circuit_breaker',
      circuit_breaker: {
        unstarted_count: 3,
        trip_reason: 'failure_threshold exceeded',
      },
    };
    const out = renderToString(fleetDetailView(haltedFleet, {}));
    expect(out).toContain('3');
  });
});

// ─── actions ─────────────────────────────────────────────────────────────────

describe('fleetDetailView — halt action', () => {
  it('shows halt button when fleet is running', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'running' }, {}),
    );
    expect(out).toContain('btn-halt-fleet');
  });

  it('does not show halt button when fleet is completed', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'completed' }, {}),
    );
    expect(out).not.toContain('btn-halt-fleet');
  });

  it('does not show halt button when fleet is halted', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(
        { ...BASE_FLEET, status: 'halted', halt_reason: 'user' },
        {},
      ),
    );
    expect(out).not.toContain('btn-halt-fleet');
  });

  it('renders halt confirmation dialog', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'running' }, {}),
    );
    expect(out).toContain('halt-confirm-dialog');
  });

  it('halt dialog explains in-flight children continue', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'running' }, {}),
    );
    // The dialog should explain in-flight children won't be killed
    expect(out).toContain('in-flight');
  });
});

describe('fleetDetailView — resume action', () => {
  it('shows resume button when fleet is halted', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(
        { ...BASE_FLEET, status: 'halted', halt_reason: 'user' },
        {},
      ),
    );
    expect(out).toContain('btn-resume-fleet');
  });

  it('shows resume button when fleet is failed', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'failed' }, {}),
    );
    expect(out).toContain('btn-resume-fleet');
  });

  it('does not show resume button when fleet is running', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'running' }, {}),
    );
    expect(out).not.toContain('btn-resume-fleet');
  });

  it('does not show resume button when fleet is completed', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'completed' }, {}),
    );
    expect(out).not.toContain('btn-resume-fleet');
  });
});

describe('fleetDetailView — cleanup action', () => {
  it('shows cleanup button when fleet is completed', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'completed' }, {}),
    );
    expect(out).toContain('btn-cleanup-fleet');
  });

  it('shows cleanup button when fleet is halted', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(
        { ...BASE_FLEET, status: 'halted', halt_reason: 'user' },
        {},
      ),
    );
    expect(out).toContain('btn-cleanup-fleet');
  });

  it('shows cleanup button when fleet is failed', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'failed' }, {}),
    );
    expect(out).toContain('btn-cleanup-fleet');
  });

  it('does not show cleanup button when fleet is running', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'running' }, {}),
    );
    expect(out).not.toContain('btn-cleanup-fleet');
  });

  it('renders cleanup confirmation dialog', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'completed' }, {}),
    );
    expect(out).toContain('cleanup-confirm-dialog');
  });
});

describe('fleetDetailView — cleanup resume-loss warning', () => {
  it('shows resume-loss checkbox for halted fleet cleanup', () => {
    resetFleetDetailState({ cleanupDialogOpen: true });
    const out = renderToString(
      fleetDetailView(
        { ...BASE_FLEET, status: 'halted', halt_reason: 'user' },
        {},
      ),
    );
    expect(out).toContain('cleanup-resume-loss-checkbox');
  });

  it('shows resume-loss checkbox for failed fleet cleanup', () => {
    resetFleetDetailState({ cleanupDialogOpen: true });
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'failed' }, {}),
    );
    expect(out).toContain('cleanup-resume-loss-checkbox');
  });

  it('does not show resume-loss checkbox for completed fleet cleanup', () => {
    resetFleetDetailState({ cleanupDialogOpen: true });
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'completed' }, {}),
    );
    expect(out).not.toContain('cleanup-resume-loss-checkbox');
  });

  it('cleanup confirm button disabled when resume-loss unchecked for halted fleet', () => {
    resetFleetDetailState({
      cleanupDialogOpen: true,
      cleanupResumeLossChecked: false,
    });
    const out = renderToString(
      fleetDetailView(
        { ...BASE_FLEET, status: 'halted', halt_reason: 'user' },
        {},
      ),
    );
    expect(out).toContain('btn-cleanup-confirm-disabled');
  });

  it('cleanup confirm button enabled when resume-loss checked for halted fleet', () => {
    resetFleetDetailState({
      cleanupDialogOpen: true,
      cleanupResumeLossChecked: true,
    });
    const out = renderToString(
      fleetDetailView(
        { ...BASE_FLEET, status: 'halted', halt_reason: 'user' },
        {},
      ),
    );
    expect(out).not.toContain('btn-cleanup-confirm-disabled');
    expect(out).toContain('btn-cleanup-confirm');
  });

  it('cleanup confirm button always enabled for completed fleet', () => {
    resetFleetDetailState({
      cleanupDialogOpen: true,
      cleanupResumeLossChecked: false,
    });
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'completed' }, {}),
    );
    expect(out).not.toContain('btn-cleanup-confirm-disabled');
    expect(out).toContain('btn-cleanup-confirm');
  });
});

// ─── re-run action ────────────────────────────────────────────────────────────

describe('fleetDetailView — re-run fleet', () => {
  it('shows re-run button when fleet is completed', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'completed' }, {}),
    );
    expect(out).toContain('btn-rerun-fleet');
  });

  it('shows re-run button when fleet is failed', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'failed' }, {}),
    );
    expect(out).toContain('btn-rerun-fleet');
  });

  it('shows re-run button when fleet is halted', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(
        { ...BASE_FLEET, status: 'halted', halt_reason: 'user' },
        {},
      ),
    );
    expect(out).toContain('btn-rerun-fleet');
  });

  it('does not show re-run button when fleet is running', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, status: 'running' }, {}),
    );
    expect(out).not.toContain('btn-rerun-fleet');
  });
});

// ─── null / loading state ─────────────────────────────────────────────────────

describe('fleetDetailView — null fleet', () => {
  it('renders loading state when fleet is null', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(null, {}));
    expect(out).toContain('fleet-detail-loading');
  });
});
