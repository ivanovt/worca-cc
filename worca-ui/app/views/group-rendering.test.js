import { html } from 'lit-html';
import { describe, expect, it } from 'vitest';
import {
  fleetHeaderView,
  fleetStatusLabel,
  fleetStatusTooltip,
  fleetStatusVariant,
  groupByFleet,
} from './group-rendering.js';

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

// ─── groupByFleet ─────────────────────────────────────────────────────────────

describe('groupByFleet', () => {
  it('separates fleet runs from standalone runs', () => {
    const fleetRun = {
      id: 'r1',
      fleet_id: 'f_001',
      group_type: 'fleet',
      pipeline_status: 'running',
    };
    const standalone = { id: 'r2', pipeline_status: 'running' };
    const { fleetGroups, standalone: standaloneRuns } = groupByFleet([
      fleetRun,
      standalone,
    ]);
    expect(Object.keys(fleetGroups)).toContain('f_001');
    expect(fleetGroups.f_001).toHaveLength(1);
    expect(standaloneRuns).toHaveLength(1);
  });

  it('groups multiple runs with same fleet_id', () => {
    const r1 = { id: 'r1', fleet_id: 'f_001', group_type: 'fleet' };
    const r2 = { id: 'r2', fleet_id: 'f_001', group_type: 'fleet' };
    const r3 = { id: 'r3', fleet_id: 'f_002', group_type: 'fleet' };
    const { fleetGroups } = groupByFleet([r1, r2, r3]);
    expect(fleetGroups.f_001).toHaveLength(2);
    expect(fleetGroups.f_002).toHaveLength(1);
  });

  it('does not group runs with fleet_id but wrong group_type', () => {
    const r = { id: 'r1', fleet_id: 'f_001', group_type: 'workspace' };
    const { fleetGroups, standalone } = groupByFleet([r]);
    expect(Object.keys(fleetGroups)).toHaveLength(0);
    expect(standalone).toHaveLength(1);
  });

  it('does not group runs with fleet_id but missing group_type', () => {
    const r = { id: 'r1', fleet_id: 'f_001' };
    const { fleetGroups, standalone } = groupByFleet([r]);
    expect(Object.keys(fleetGroups)).toHaveLength(0);
    expect(standalone).toHaveLength(1);
  });

  it('treats run with null fleet_id as standalone', () => {
    const r = { id: 'r1', fleet_id: null, group_type: 'fleet' };
    const { fleetGroups, standalone } = groupByFleet([r]);
    expect(Object.keys(fleetGroups)).toHaveLength(0);
    expect(standalone).toHaveLength(1);
  });

  it('handles empty runs array', () => {
    const { fleetGroups, standalone } = groupByFleet([]);
    expect(Object.keys(fleetGroups)).toHaveLength(0);
    expect(standalone).toHaveLength(0);
  });
});

// ─── fleetStatusVariant ───────────────────────────────────────────────────────

describe('fleetStatusVariant', () => {
  it('returns primary for running', () => {
    expect(fleetStatusVariant('running')).toBe('primary');
  });

  it('returns success for completed', () => {
    expect(fleetStatusVariant('completed')).toBe('success');
  });

  it('returns danger for failed', () => {
    expect(fleetStatusVariant('failed')).toBe('danger');
  });

  it('returns warning for halted with no reason', () => {
    expect(fleetStatusVariant('halted', null)).toBe('warning');
  });

  it('returns warning for halted with circuit_breaker reason', () => {
    expect(fleetStatusVariant('halted', 'circuit_breaker')).toBe('warning');
  });

  it('returns neutral for halted with user reason', () => {
    expect(fleetStatusVariant('halted', 'user')).toBe('neutral');
  });

  it('returns neutral for unknown status', () => {
    expect(fleetStatusVariant('something_unknown')).toBe('neutral');
  });
});

// ─── fleetStatusLabel ────────────────────────────────────────────────────────

describe('fleetStatusLabel', () => {
  it('returns status string unchanged for running', () => {
    expect(fleetStatusLabel('running')).toBe('running');
  });

  it('returns status string unchanged for completed', () => {
    expect(fleetStatusLabel('completed')).toBe('completed');
  });

  it('returns Halted for halted with null reason', () => {
    expect(fleetStatusLabel('halted', null)).toBe('Halted');
  });

  it('returns Halted (circuit breaker) for circuit_breaker reason', () => {
    expect(fleetStatusLabel('halted', 'circuit_breaker')).toBe(
      'Halted (circuit breaker)',
    );
  });

  it('returns Halted for user reason', () => {
    expect(fleetStatusLabel('halted', 'user')).toBe('Halted');
  });
});

// ─── fleetStatusTooltip ───────────────────────────────────────────────────────

describe('fleetStatusTooltip', () => {
  it('returns null for running status', () => {
    expect(fleetStatusTooltip('running')).toBeNull();
  });

  it('returns null for completed status', () => {
    expect(fleetStatusTooltip('completed')).toBeNull();
  });

  it('returns user halt text without timestamp', () => {
    expect(fleetStatusTooltip('halted', 'user')).toBe('Halted by you');
  });

  it('returns user halt text with timestamp', () => {
    expect(
      fleetStatusTooltip('halted', 'user', { haltAt: '2026-05-12T10:30:00Z' }),
    ).toBe('Halted by you on 2026-05-12T10:30:00Z');
  });

  it('returns auto halt text with counts for circuit_breaker', () => {
    expect(
      fleetStatusTooltip('halted', 'circuit_breaker', {
        failedCount: 3,
        totalCount: 10,
      }),
    ).toBe('Halted automatically: 3 of 10 children failed');
  });

  it('returns null for circuit_breaker without counts', () => {
    expect(fleetStatusTooltip('halted', 'circuit_breaker')).toBeNull();
  });

  it('returns null for null halt_reason without counts', () => {
    expect(fleetStatusTooltip('halted', null)).toBeNull();
  });

  it('returns auto halt text for null/legacy halt_reason with counts', () => {
    expect(
      fleetStatusTooltip('halted', null, { failedCount: 2, totalCount: 5 }),
    ).toBe('Halted automatically: 2 of 5 children failed');
  });
});

// ─── fleetHeaderView ─────────────────────────────────────────────────────────

const fleetChildren = [
  {
    id: 'r1',
    fleet_id: 'f_001',
    group_type: 'fleet',
    pipeline_status: 'running',
    active: true,
    work_request: { title: 'Migrate all repos' },
    stages: {},
  },
  {
    id: 'r2',
    fleet_id: 'f_001',
    group_type: 'fleet',
    pipeline_status: 'completed',
    active: false,
    work_request: { title: 'Migrate all repos' },
    stages: {},
  },
  {
    id: 'r3',
    fleet_id: 'f_001',
    group_type: 'fleet',
    pipeline_status: 'failed',
    active: false,
    work_request: { title: 'Migrate all repos' },
    stages: {},
  },
];

describe('fleetHeaderView - structure', () => {
  it('renders fleet-group container', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).toContain('fleet-group');
  });

  it('renders data-fleet-id attribute', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).toContain('data-fleet-id="f_001"');
  });

  it('renders fleet-header element', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).toContain('fleet-header');
  });

  it('renders fleet-toggle icon', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).toContain('fleet-toggle');
  });

  it('renders fleet title from work_request.title of first child', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).toContain('Migrate all repos');
    expect(output).toContain('fleet-title');
  });

  it('renders fleet-status-badge', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).toContain('fleet-status-badge');
  });

  it('renders fleet-progress text with completed/total count', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).toContain('fleet-progress');
    expect(output).toContain('1/3 completed');
  });

  it('includes failed count in progress text when some children failed', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).toContain('1 failed');
  });

  it('renders fleet-progress-bar with value', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).toContain('fleet-progress-bar');
  });
});

describe('fleetHeaderView - expand/collapse', () => {
  it('renders fleet-children when expanded=true', () => {
    const renderChild = (r) => html`<div class="child-card">${r.id}</div>`;
    const output = renderToString(
      fleetHeaderView('f_001', fleetChildren, { expanded: true, renderChild }),
    );
    expect(output).toContain('fleet-children');
    expect(output).toContain('r1');
    expect(output).toContain('r2');
  });

  it('does not render fleet-children when expanded=false', () => {
    const renderChild = (r) => html`<div class="child-card">${r.id}</div>`;
    const output = renderToString(
      fleetHeaderView('f_001', fleetChildren, {
        expanded: false,
        renderChild,
      }),
    );
    expect(output).not.toContain('fleet-children');
  });

  it('adds fleet-group-expanded class when expanded', () => {
    const output = renderToString(
      fleetHeaderView('f_001', fleetChildren, { expanded: true }),
    );
    expect(output).toContain('fleet-group-expanded');
  });

  it('adds fleet-group-collapsed class when collapsed', () => {
    const output = renderToString(
      fleetHeaderView('f_001', fleetChildren, { expanded: false }),
    );
    expect(output).toContain('fleet-group-collapsed');
  });
});

describe('fleetHeaderView - navigation', () => {
  it('marks the header clickable when onNavigate is provided', () => {
    // The whole header row is the click target now — no separate Details
    // button. The .fleet-header-clickable class signals the affordance
    // (cursor:pointer + hover background).
    const output = renderToString(
      fleetHeaderView('f_001', fleetChildren, { onNavigate: () => {} }),
    );
    expect(output).toContain('fleet-header-clickable');
    expect(output).not.toContain('fleet-detail-btn');
  });

  it('header is not marked clickable when onNavigate is omitted', () => {
    const output = renderToString(fleetHeaderView('f_001', fleetChildren));
    expect(output).not.toContain('fleet-header-clickable');
    expect(output).not.toContain('fleet-detail-btn');
  });
});

describe('fleetHeaderView - aggregate cost', () => {
  it('renders cost when children have stages with cost', () => {
    const costChildren = [
      {
        id: 'r1',
        fleet_id: 'f_001',
        group_type: 'fleet',
        pipeline_status: 'completed',
        work_request: { title: 'Task' },
        stages: {
          planner: { iterations: [{ cost_usd: 0.05 }] },
        },
      },
    ];
    const output = renderToString(fleetHeaderView('f_001', costChildren));
    expect(output).toContain('fleet-cost');
    expect(output).toContain('$0.05');
  });

  it('does not render cost element when cost is zero', () => {
    const zeroChildren = [
      {
        id: 'r1',
        fleet_id: 'f_001',
        group_type: 'fleet',
        pipeline_status: 'running',
        work_request: { title: 'Task' },
        stages: {},
      },
    ];
    const output = renderToString(fleetHeaderView('f_001', zeroChildren));
    expect(output).not.toContain('fleet-cost');
  });
});

describe('fleetHeaderView - status badge variant', () => {
  it('uses primary variant badge when fleet is running', () => {
    const runningChildren = [
      {
        id: 'r1',
        fleet_id: 'f_001',
        group_type: 'fleet',
        pipeline_status: 'running',
        work_request: { title: 'Task' },
        stages: {},
      },
    ];
    const output = renderToString(fleetHeaderView('f_001', runningChildren));
    expect(output).toContain('variant="primary"');
  });

  it('uses success variant badge when all children completed', () => {
    const completedChildren = [
      {
        id: 'r1',
        fleet_id: 'f_001',
        group_type: 'fleet',
        pipeline_status: 'completed',
        work_request: { title: 'Task' },
        stages: {},
      },
    ];
    const output = renderToString(fleetHeaderView('f_001', completedChildren));
    expect(output).toContain('variant="success"');
  });
});

describe('fleetHeaderView - halt reason tooltip', () => {
  const cbChildren = [
    {
      id: 'r1',
      fleet_id: 'f_001',
      group_type: 'fleet',
      pipeline_status: 'completed',
      work_request: { title: 'Migrate' },
      stages: {},
    },
    {
      id: 'r2',
      fleet_id: 'f_001',
      group_type: 'fleet',
      pipeline_status: 'failed',
      work_request: { title: 'Migrate' },
      stages: {},
    },
    {
      id: 'r3',
      fleet_id: 'f_001',
      group_type: 'fleet',
      pipeline_status: 'failed',
      work_request: { title: 'Migrate' },
      stages: {},
    },
  ];

  it('badge shows user halt tooltip with timestamp', () => {
    const output = renderToString(
      fleetHeaderView('f_001', cbChildren, {
        fleetStatus: 'halted',
        haltReason: 'user',
        haltAt: '2026-05-12T10:30:00Z',
      }),
    );
    expect(output).toContain('Halted by you on 2026-05-12T10:30:00Z');
  });

  it('badge shows circuit_breaker tooltip with failure counts from children', () => {
    const output = renderToString(
      fleetHeaderView('f_001', cbChildren, {
        fleetStatus: 'halted',
        haltReason: 'circuit_breaker',
      }),
    );
    expect(output).toContain('Halted automatically: 2 of 3 children failed');
  });

  it('badge has no halt tooltip when fleet is running', () => {
    const output = renderToString(
      fleetHeaderView('f_001', cbChildren, { fleetStatus: 'running' }),
    );
    expect(output).not.toContain('Halted by you');
    expect(output).not.toContain('Halted automatically');
  });

  it('uses fleetStatus override for badge variant instead of derived status', () => {
    const output = renderToString(
      fleetHeaderView('f_001', cbChildren, {
        fleetStatus: 'halted',
        haltReason: 'user',
      }),
    );
    expect(output).toContain('variant="neutral"');
  });
});
