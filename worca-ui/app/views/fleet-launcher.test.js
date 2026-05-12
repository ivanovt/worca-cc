import { describe, expect, it } from 'vitest';
import { fleetLauncherView, resetLauncherState } from './fleet-launcher.js';

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

// ── project multi-select ────────────────────────────────────────────────────

describe('fleetLauncherView — project multi-select', () => {
  it('renders a multi-select for project selection', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('fleet-launcher-projects');
    expect(out).toContain('multiple');
  });

  it('populates options for each registered project', () => {
    resetLauncherState();
    const projects = [
      { id: 'p1', name: 'repo-alpha', path: '/path/repo-alpha' },
      { id: 'p2', name: 'repo-beta', path: '/path/repo-beta' },
    ];
    const out = renderToString(fleetLauncherView({ projects }, {}));
    expect(out).toContain('repo-alpha');
    expect(out).toContain('repo-beta');
  });

  it('renders select-all button', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('btn-select-all-projects');
  });

  it('renders project filter input', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-project-filter');
  });
});

// ── work request tabs ───────────────────────────────────────────────────────

describe('fleetLauncherView — work request tabs', () => {
  it('renders prompt tab', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    // sl-tab-group renders <sl-tab panel="prompt">
    expect(out).toMatch(/panel="prompt"/);
  });

  it('renders source tab', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toMatch(/panel="source"/);
  });

  it('shows prompt textarea when prompt tab is active', () => {
    resetLauncherState({ promptTab: 'prompt' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('textarea-fleet-prompt');
  });

  it('shows source input when source tab is active', () => {
    resetLauncherState({ promptTab: 'source' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-fleet-source');
  });
});

// ── guide upload ────────────────────────────────────────────────────────────

describe('fleetLauncherView — guide upload', () => {
  it('renders guide upload widget with drop zone', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('guide-drop-zone');
    expect(out).toContain('Browse');
  });

  it('shows uploaded guide files as tags', () => {
    resetLauncherState({
      guides: [
        { name: 'migration.md', size: 2048 },
        { name: 'spec.md', size: 1024 },
      ],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('migration.md');
    expect(out).toContain('spec.md');
  });

  it('shows guide size readout', () => {
    resetLauncherState({ guides: [{ name: 'f.md', size: 1024 }] });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('Total guide size');
  });
});

// ── branch inputs — separate head template and base branch ─────────────────

describe('fleetLauncherView — branch inputs', () => {
  it('renders head template input separately from base branch input', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-head-template');
    expect(out).toContain('input-base-branch');
  });

  it('shows head template preview panel when projects are selected', () => {
    resetLauncherState({
      headTemplate: 'fix/{project}',
      selectedProjects: ['/repos/my-app'],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('head-template-preview');
    expect(out).toContain('my-app');
  });

  it('base branch input has helper text about default branch', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain("each repo's default");
  });
});

// ── head-template collision detection ──────────────────────────────────────

describe('fleetLauncherView — collision detection', () => {
  it('shows collision when template has no {project} placeholder and multiple projects selected', () => {
    resetLauncherState({
      headTemplate: 'migration/fixed',
      selectedProjects: ['/path/repo-a', '/path/repo-b'],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('collision');
  });

  it('marks submit as disabled when collision exists', () => {
    resetLauncherState({
      headTemplate: 'migration/fixed',
      selectedProjects: ['/path/repo-a', '/path/repo-b'],
      tokenEstimate: {
        guide_tokens_est: 100,
        total_overhead_est: 700,
        fleet_size: 2,
        prompt_stages: 7,
      },
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('btn-launch-disabled');
  });

  it('no collision when template differentiates projects', () => {
    resetLauncherState({
      headTemplate: 'migration/{project}',
      selectedProjects: ['/path/repo-a', '/path/repo-b'],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('head-template-collision-alert');
  });
});

// ── base branch pre-flight ──────────────────────────────────────────────────

describe('fleetLauncherView — base branch validation', () => {
  it('shows missing repos when base branch pre-flight fails', () => {
    resetLauncherState({
      baseBranch: 'develop',
      baseBranchError: { missing_in: ['/path/repo-b'] },
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('base-branch-error');
    expect(out).toContain('repo-b');
  });

  it('marks submit disabled when base branch is missing in some repos', () => {
    resetLauncherState({
      baseBranch: 'develop',
      baseBranchError: { missing_in: ['/path/repo-b'] },
      tokenEstimate: {
        guide_tokens_est: 100,
        total_overhead_est: 700,
        fleet_size: 2,
        prompt_stages: 7,
      },
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('btn-launch-disabled');
  });

  it('no error shown when base branch is empty (use default branch)', () => {
    resetLauncherState({ baseBranch: '', baseBranchError: null });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('base-branch-error');
  });
});

// ── plan mode ───────────────────────────────────────────────────────────────

describe('fleetLauncherView — plan mode', () => {
  it('renders plan mode radio group', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('plan-mode-group');
  });

  it('reveals path input when plan mode is explicit', () => {
    resetLauncherState({ planMode: 'explicit' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-plan-path');
  });

  it('reveals reference project select when plan mode is plan-first', () => {
    resetLauncherState({
      planMode: 'plan-first',
      selectedProjects: ['/repos/app-a'],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('select-plan-first-project');
  });

  it('shows divergence warning when plan mode is independent', () => {
    resetLauncherState({ planMode: 'none' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('plan-mode-independent-warning');
  });
});

// ── advanced options ────────────────────────────────────────────────────────

describe('fleetLauncherView — advanced options', () => {
  it('renders advanced options in a collapsed sl-details section', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    // The section is wrapped in .new-run-section labelled "Advanced", with
    // an sl-details inside (summary: "Concurrency & failure handling").
    expect(out).toContain('fleet-launcher-advanced');
    expect(out).toContain('input-max-parallel');
    expect(out).toContain('input-failure-threshold');
  });
});

// ── token overhead gate ─────────────────────────────────────────────────────

describe('fleetLauncherView — token overhead gate', () => {
  it('renders the token overhead gate section', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('token-overhead-gate');
    expect(out).toContain('Estimate cost');
  });

  it('requires I-understand checkbox when estimate is above threshold', () => {
    resetLauncherState({
      tokenEstimate: {
        guide_tokens_est: 200_000,
        total_overhead_est: 2_000_000,
        fleet_size: 10,
        prompt_stages: 7,
      },
      tokenConfirmed: false,
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('token-confirm-checkbox');
    expect(out).toContain('I understand the cost');
    expect(out).toContain('btn-launch-disabled');
  });

  it('enables launch button when above-threshold estimate is confirmed', () => {
    resetLauncherState({
      tokenEstimate: {
        guide_tokens_est: 200_000,
        total_overhead_est: 2_000_000,
        fleet_size: 10,
        prompt_stages: 7,
      },
      tokenConfirmed: true,
      selectedProjects: ['/path/repo-a'],
      prompt: 'migrate to v2',
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('btn-launch-disabled');
  });
});
