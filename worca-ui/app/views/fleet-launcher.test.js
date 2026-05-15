import { describe, expect, it } from 'vitest';
import {
  fleetLauncherView,
  getFleetLauncherSubmitState,
  resetLauncherState,
} from './fleet-launcher.js';

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

// ── work source (mirrors new-run.js Source Type select pattern) ─────────────

describe('fleetLauncherView — work source', () => {
  it('renders the Source Type select with default None', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('select-fleet-source-type');
    expect(out).toContain('>None<');
    expect(out).toContain('>GitHub Issue<');
    expect(out).toContain('>Spec File<');
  });

  it('does not show source value input when type is None', () => {
    resetLauncherState({ sourceType: 'none' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('input-fleet-source');
  });

  it('shows source value input when type is GitHub Issue', () => {
    resetLauncherState({ sourceType: 'source' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-fleet-source');
  });

  it('shows source value input when type is Spec File', () => {
    resetLauncherState({ sourceType: 'spec' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-fleet-source');
  });

  it('always renders the prompt textarea', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('textarea-fleet-prompt');
  });

  it('always renders the Plan File input alongside the source picker', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-fleet-plan-file');
    expect(out).toContain('Plan File (optional)');
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

  it('reports canLaunch=false on getFleetLauncherSubmitState when collision exists', () => {
    resetLauncherState({
      headTemplate: 'migration/fixed',
      selectedProjects: ['/path/repo-a', '/path/repo-b'],
      prompt: 'do the thing',
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(false);
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

  it('reports canLaunch=false when base branch is missing in some repos', () => {
    resetLauncherState({
      baseBranch: 'develop',
      baseBranchError: { missing_in: ['/path/repo-b'] },
      selectedProjects: ['/path/repo-a', '/path/repo-b'],
      prompt: 'do the thing',
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(false);
  });

  it('no error shown when base branch is empty (use default branch)', () => {
    resetLauncherState({ baseBranch: '', baseBranchError: null });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('base-branch-error');
  });
});

// ── plan strategy ──────────────────────────────────────────────────────────

describe('fleetLauncherView — plan strategy', () => {
  it('renders the per-project planning strategy radio when no Plan File is set', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('plan-mode-group');
    expect(out).toContain('Per-project planning strategy');
  });

  it('hides the per-project planning radio when a Plan File is set', () => {
    // A Plan File overrides the per-child strategy with `explicit` at submit
    // time, so the radio is suppressed to avoid a misleading control.
    resetLauncherState({ planFile: 'docs/plans/W-040.md' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('Per-project planning strategy');
    expect(out).not.toContain('plan-mode-group');
  });

  it('reveals reference project select when plan-first is chosen', () => {
    resetLauncherState({
      planMode: 'plan-first',
      selectedProjects: ['/repos/app-a'],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('select-plan-first-project');
  });

  it('shows divergence warning when independent (none) is chosen', () => {
    resetLauncherState({ planMode: 'none' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('plan-mode-independent-warning');
  });
});

// ── advanced options ────────────────────────────────────────────────────────

describe('fleetLauncherView — advanced options', () => {
  it('renders the Advanced Options section always-shown (no sl-details collapse)', () => {
    // The Pipeline launcher always shows Advanced Options inline; the fleet
    // launcher mirrors that pattern for consistency.
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('Advanced Options');
    expect(out).not.toContain('fleet-launcher-advanced');
    expect(out).toContain('input-max-parallel');
    expect(out).toContain('input-failure-threshold');
    expect(out).toContain('input-base-branch');
    expect(out).toContain('input-head-template');
  });
});

// ── header submit-state (powers the page-header Launch button) ──────────────

describe('fleetLauncherView — getFleetLauncherSubmitState', () => {
  it('canLaunch=false when no projects are selected', () => {
    resetLauncherState({ prompt: 'do the thing' });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(false);
  });

  it('canLaunch=false when neither prompt nor source is provided', () => {
    resetLauncherState({ selectedProjects: ['/path/repo-a'] });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(false);
  });

  it('canLaunch=true when projects + prompt are present', () => {
    resetLauncherState({
      selectedProjects: ['/path/repo-a'],
      prompt: 'migrate to v2',
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(true);
  });

  it('canLaunch=true when projects + Source are present (no prompt)', () => {
    resetLauncherState({
      selectedProjects: ['/path/repo-a'],
      sourceType: 'source',
      sourceValue: 'gh:issue:42',
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(true);
  });

  it('isSubmitting reflects an in-flight submit (initially false)', () => {
    resetLauncherState();
    expect(getFleetLauncherSubmitState().isSubmitting).toBe(false);
  });
});
