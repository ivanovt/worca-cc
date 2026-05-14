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

// Shared per-test runs map. The Projects section hydrates fleet children via
// state.runs[child.run_id] and renders runCardView for each — these fixtures
// match the children's run_ids.
const RUNS_BY_ID = {
  'run-1': {
    id: 'run-1',
    pipeline_status: 'completed',
    active: false,
    started_at: '2026-05-12T09:00:00.000Z',
    completed_at: '2026-05-12T09:30:00.000Z',
    branch: 'migration/alpha/v2-api',
    work_request: { title: 'alpha' },
    fleet_id: 'f_202605120900_abc12345',
    group_type: 'fleet',
    stages: {
      planner: {
        status: 'completed',
        iterations: [{ cost_usd: 0.05 }],
      },
      implementer: {
        status: 'completed',
        iterations: [{ cost_usd: 0.1 }],
      },
    },
  },
  'run-2': {
    id: 'run-2',
    pipeline_status: 'running',
    active: true,
    started_at: '2026-05-12T09:00:00.000Z',
    branch: 'migration/beta/v2-api',
    work_request: { title: 'beta' },
    fleet_id: 'f_202605120900_abc12345',
    group_type: 'fleet',
    stages: {
      planner: {
        status: 'running',
        iterations: [{ cost_usd: 0.03 }],
      },
    },
  },
};

// ─── header strip ─────────────────────────────────────────────────────────────

describe('fleetDetailView — overview strip', () => {
  it('renders the flat overview section (no hero card)', () => {
    // The page top used to be a `fleetCardView` hero; it was replaced
    // with a flat overview modelled on `runDetailView`'s top — a
    // projects strip above a single info panel. The hero card is gone.
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-detail-overview');
    expect(out).toContain('run-info-section');
    expect(out).not.toContain('fleet-detail-hero');
  });

  it('embeds the fleet_id on the overview wrapper', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain(`data-fleet-id="${BASE_FLEET.fleet_id}"`);
  });

  it('renders fleet title (work_request.title) somewhere on the page', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('Migrate to v2 API');
  });

  it('renders the "Fleet ID:" label + id chip in the overview', () => {
    // The status badge was removed from the overview's first line — it's
    // already shown in the page header (contentHeaderView). The first row
    // now carries a labelled fleet-id chip instead.
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('>Fleet ID:<');
    expect(out).toContain('fleet-id-chip');
    expect(out).not.toContain('fleet-status-badge');
  });

  it('does not render the projects strip on the overview', () => {
    // The strip was redundant with the per-project run-cards rendered in
    // the Projects section below — pulled out per design feedback.
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).not.toContain('fleet-projects-strip');
  });

  it('renders Base / Plan meta on the overview', () => {
    // Head: row was dropped because head_template isn't actually applied
    // to per-child branches yet — children use their own
    // `worca/<slug>-<run_id>` pattern. Showing the unresolved template
    // here would mislead the user (it doesn't match the branch shown on
    // any project's run-card below).
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('>Base:<');
    expect(out).toContain('>Plan:<');
    expect(out).not.toContain('>Head:<');
  });

  it('renders Started / Duration meta on the overview', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('>Started:<');
    expect(out).toContain('>Duration:<');
  });

  it('renders Cost + Projects count on the overview', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('>Cost:<');
    expect(out).toContain('>Projects:<');
  });

  // The fleet status badge (variant + halt-reason tooltip) now lives in
  // the page header (contentHeaderView in main.js), not in this view —
  // so the per-status variant / halt-text assertions moved out with it.
});

// ─── overview meta (replaces the old manifest panel) ──────────────────────────

describe('fleetDetailView — overview meta', () => {
  // The standalone "Manifest" panel and the hero card were both folded
  // into a single flat overview strip. Base branch lives as a
  // `.meta-value` item on that strip; max-parallel / circuit-breaker
  // threshold / created-at / head_template are no longer surfaced on the
  // detail page top.
  it('does not show the branch template on the overview', () => {
    // head_template (the pattern, e.g. `migration/{slug}/{project}`) is
    // not currently applied to children, so showing it would mislead.
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).not.toContain('migration/{project}/{slug}');
  });

  it('shows plan mode in a meta chip', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('>Plan:<');
    expect(out).toContain('>none<');
  });
});

// ─── work request panel ───────────────────────────────────────────────────────

describe('fleetDetailView — work request panel', () => {
  it('renders work request section', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-wr-title');
    expect(out).toContain('Work Request');
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
  it('renders guide section even without a guide', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, guide: null }, {}),
    );
    expect(out).toContain('Reference Guide');
  });

  it('does not show view guide button when no guide attached', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, guide: null }, {}),
    );
    expect(out).not.toContain('btn-view-guide');
  });

  it('shows the "no guide attached" hint when guide is null', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, guide: null }, {}),
    );
    expect(out).toContain('No guide attached');
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

  it('shows guide size (formatted human-readable)', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(fleetWithGuide, {}));
    // 2048 bytes = 2.0 KB via _formatBytes
    expect(out).toContain('2.0 KB');
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

describe('fleetDetailView — projects grid', () => {
  it('renders projects section with the canonical run-list shell', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(BASE_FLEET, { runsById: RUNS_BY_ID }),
    );
    expect(out).toContain('fleet-children-section');
    expect(out).toContain('fleet-children-list');
  });

  it('uses the user-facing label "Projects"', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(BASE_FLEET, { runsById: RUNS_BY_ID }),
    );
    expect(out).toMatch(/>Projects[ ·]/);
  });

  it('renders a runCardView per project (one .run-card per child)', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(BASE_FLEET, { runsById: RUNS_BY_ID }),
    );
    const count = (out.match(/class="run-card/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('renders the project title (from work_request.title) inside each card', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(BASE_FLEET, { runsById: RUNS_BY_ID }),
    );
    expect(out).toContain('>alpha<');
    expect(out).toContain('>beta<');
  });

  it('renders the head branch via run-card meta', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView(BASE_FLEET, { runsById: RUNS_BY_ID }),
    );
    expect(out).toContain('migration/alpha/v2-api');
    expect(out).toContain('migration/beta/v2-api');
  });

  it('renders a placeholder when the run is not yet in state.runs', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(BASE_FLEET, {}));
    expect(out).toContain('fleet-child-card-placeholder');
    expect(out).toContain('Pipeline registry entry not loaded yet');
  });

  it('renders empty-state hint when no projects dispatched', () => {
    resetFleetDetailState();
    const out = renderToString(
      fleetDetailView({ ...BASE_FLEET, children: [] }, {}),
    );
    expect(out).toContain('No projects dispatched yet');
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

// (re-run button moved to the page header — no longer rendered by
// `fleetDetailView`. Header-level button visibility is exercised by
// browser e2e tests, not this file.)

// ─── null / loading state ─────────────────────────────────────────────────────

describe('fleetDetailView — null fleet', () => {
  it('renders loading state when fleet is null', () => {
    resetFleetDetailState();
    const out = renderToString(fleetDetailView(null, {}));
    expect(out).toContain('fleet-detail-loading');
  });
});
