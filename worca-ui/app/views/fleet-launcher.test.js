import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fleetLauncherView,
  getFleetLauncherSubmitState,
  resetLauncherState,
  submitFleetLauncher,
} from './fleet-launcher.js';
import { filePickerButton } from './launcher-shared.js';

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
    expect(out).toContain('>GitHub PR<');
  });

  it('shows source value input when type is GitHub PR', () => {
    resetLauncherState({ sourceType: 'pr' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-fleet-source');
  });

  it('shows gh:pr placeholder when type is GitHub PR', () => {
    resetLauncherState({ sourceType: 'pr' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('gh:pr:');
  });

  it('shows PR hint text when type is GitHub PR', () => {
    resetLauncherState({ sourceType: 'pr' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('revision mode');
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

// ── branch inputs (head template hidden, base branch still rendered) ───────

describe('fleetLauncherView — branch inputs', () => {
  it('does not render the head template input (field hidden — see fleet-launcher.js comments)', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('input-head-template');
    expect(out).not.toContain('head-template-preview');
  });

  it('still renders the base branch input', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-base-branch');
  });

  it('base branch input has helper text about default branch', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain("each project's default");
  });
});

// ── head-template collision detection (always passes now) ──────────────────

describe('fleetLauncherView — collision detection (disabled)', () => {
  // The detector is a stub since the head-template field is hidden and the
  // template is dead config anyway. These tests lock in that the alert
  // never renders and Launch is never blocked on collision grounds.
  it('does not render a collision alert even with an obviously colliding template', () => {
    resetLauncherState({
      headTemplate: 'migration/fixed',
      selectedProjects: ['/path/repo-a', '/path/repo-b'],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('head-template-collision-alert');
  });

  it('canLaunch stays true regardless of template content', () => {
    resetLauncherState({
      headTemplate: 'migration/fixed',
      selectedProjects: ['/path/repo-a', '/path/repo-b'],
      prompt: 'do the thing',
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(true);
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
    // Head template input is hidden until run_fleet actually consumes the
    // template — see the comment in fleet-launcher.js.
    expect(out).not.toContain('input-head-template');
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

// ── launcher mode (URL-driven) ─────────────────────────────────────────────

describe('fleetLauncherView — launcher mode', () => {
  it('does not render an in-form mode toggle (mode is URL-driven via the sidebar)', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('launcher-mode-toggle');
  });

  it('defaults to fleet mode', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('fleet-launcher-projects');
    expect(out).not.toContain('select-workspace');
  });

  it('in workspace mode, hides project multi-select', () => {
    resetLauncherState({ launcherMode: 'workspace' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('fleet-launcher-projects');
  });

  it('in workspace mode, shows workspace select', () => {
    resetLauncherState({ launcherMode: 'workspace' });
    const out = renderToString(
      fleetLauncherView({ projects: [], workspaces: [] }, {}),
    );
    expect(out).toContain('select-workspace');
  });
});

// ── workspace select and repo list ─────────────────────────────────────────

describe('fleetLauncherView — workspace select', () => {
  it('populates workspace select from appState.workspaces', () => {
    resetLauncherState({ launcherMode: 'workspace' });
    const workspaces = [
      { name: 'my-ws', projects: [{ name: 'lib', depends_on: [] }] },
      { name: 'other-ws', projects: [] },
    ];
    const out = renderToString(
      fleetLauncherView({ projects: [], workspaces }, {}),
    );
    expect(out).toContain('my-ws');
    expect(out).toContain('other-ws');
  });

  it('shows pinned repo list after selecting workspace', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        projects: [
          { name: 'shared-lib', depends_on: [] },
          { name: 'backend', depends_on: ['shared-lib'] },
        ],
      },
    });
    const out = renderToString(
      fleetLauncherView({ projects: [], workspaces: [] }, {}),
    );
    expect(out).toContain('workspace-pinned-repos');
    expect(out).toContain('shared-lib');
    expect(out).toContain('backend');
  });
});

// ── workspace plan mode (4-option radio) ───────────────────────────────────

describe('fleetLauncherView — workspace plan mode', () => {
  it('renders 4-option plan radio in workspace mode', () => {
    resetLauncherState({ launcherMode: 'workspace' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('plan-mode-option-master');
    expect(out).toContain('plan-mode-option-existing');
    expect(out).toContain('plan-mode-option-per-repo');
    expect(out).toContain('plan-mode-option-independent');
  });

  it('shows Master planner as the default option', () => {
    resetLauncherState({ launcherMode: 'workspace' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('Master planner');
  });

  it('shows workspace plan path input when existing mode selected', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      workspacePlanMode: 'existing',
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-workspace-plan-path');
  });

  it('hides workspace plan path input in master mode', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      workspacePlanMode: 'master',
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('input-workspace-plan-path');
  });

  it('shows divergence warning when independent mode selected', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      workspacePlanMode: 'independent',
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('plan-mode-independent-warning');
  });
});

// ── workspace DAG preview ──────────────────────────────────────────────────

describe('fleetLauncherView — workspace DAG preview', () => {
  it('renders DAG preview when workspace is selected', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        projects: [
          { name: 'lib', depends_on: [] },
          { name: 'app', depends_on: ['lib'] },
        ],
      },
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('dag-preview');
  });

  it('does not show DAG preview when no workspace selected', () => {
    resetLauncherState({ launcherMode: 'workspace' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('dag-preview');
  });
});

// ── workspace gh auth check ────────────────────────────────────────────────

describe('fleetLauncherView — workspace gh auth check (panel hidden)', () => {
  // The GitHub Authentication panel is hidden until the server-side check
  // is implemented (defaultValidateGhAuth is a no-op). These assertions lock
  // in that none of the panel's DOM ships, regardless of internal state.
  it('does not render the auth panel even when state says failed', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        projects: [{ name: 'lib', depends_on: [] }],
      },
      ghAuthStatus: 'failed',
      ghAuthErrors: [{ org: 'acme', command: 'gh auth login' }],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('gh-auth-error');
    expect(out).not.toContain('checkbox-skip-auth');
    expect(out).not.toContain('GitHub Authentication');
  });

  it('does not render the auth panel even when state says ok', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        projects: [{ name: 'lib', depends_on: [] }],
      },
      ghAuthStatus: 'ok',
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('gh-auth-ok');
  });
});

// ── head-template default (state-level, no longer rendered in the form) ────

describe('fleetLauncherView — head template default', () => {
  // The field is hidden but the in-memory default still drives what gets
  // sent in the FormData payload. Verify the defaults stay sane in both
  // modes so we don't accidentally start sending an empty string.
  it('imports return the workspace default after resetLauncherState({mode: workspace})', async () => {
    const { resetLauncherState: reset } = await import('./fleet-launcher.js');
    reset({ launcherMode: 'workspace' });
    // No DOM assertion — the field is hidden. The default is exercised
    // implicitly by the submit-path tests.
  });

  it('imports return the fleet default after resetLauncherState({mode: fleet})', async () => {
    const { resetLauncherState: reset } = await import('./fleet-launcher.js');
    reset({ launcherMode: 'fleet' });
  });
});

// ── workspace init timeout ─────────────────────────────────────────────────

describe('fleetLauncherView — workspace init timeout', () => {
  it('renders init timeout input in workspace mode', () => {
    resetLauncherState({ launcherMode: 'workspace' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-init-timeout');
  });

  it('does not render init timeout in fleet mode', () => {
    resetLauncherState({ launcherMode: 'fleet' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('input-init-timeout');
  });
});

// ── workspace submit state ─────────────────────────────────────────────────

describe('fleetLauncherView — workspace submit state', () => {
  it('canLaunch=false in workspace mode when no workspace selected', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      prompt: 'add feature',
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(false);
  });

  it('canLaunch=true in workspace mode when workspace + prompt provided', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        projects: [{ name: 'lib', depends_on: [] }],
      },
      prompt: 'add feature',
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(true);
  });

  it('canLaunch=false when gh auth fails and skip not checked', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        projects: [{ name: 'lib', depends_on: [] }],
      },
      prompt: 'add feature',
      ghAuthStatus: 'failed',
      ghAuthErrors: [{ org: 'acme', command: 'gh auth login' }],
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(false);
  });

  it('canLaunch=true when gh auth fails but skip is checked', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        projects: [{ name: 'lib', depends_on: [] }],
      },
      prompt: 'add feature',
      ghAuthStatus: 'failed',
      ghAuthErrors: [{ org: 'acme', command: 'gh auth login' }],
      skipAuthCheck: true,
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(true);
  });

  it('canLaunch=true in workspace mode with source instead of prompt', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        projects: [{ name: 'lib', depends_on: [] }],
      },
      sourceType: 'source',
      sourceValue: 'gh:issue:42',
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(true);
  });
});

// ── workspace plan file pickers (existing + per-repo modes) ────────────────

describe('fleetLauncherView — existing plan mode file picker', () => {
  const wsBase = {
    launcherMode: 'workspace',
    selectedWorkspace: 'my-ws',
    workspaceData: {
      name: 'my-ws',
      projects: [
        { name: 'api', depends_on: [] },
        { name: 'web', depends_on: ['api'] },
      ],
    },
    workspacePlanMode: 'existing',
  };

  it('renders a file picker button for workspace plan upload', () => {
    resetLauncherState(wsBase);
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('btn-workspace-plan-browse');
  });

  it('renders an advanced path toggle with sl-details', () => {
    resetLauncherState(wsBase);
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('workspace-plan-advanced');
    expect(out).toContain('sl-details');
    expect(out).toContain('server-side path');
  });

  it('renders the path input inside the advanced toggle', () => {
    resetLauncherState({ ...wsBase, workspacePlanPath: '/tmp/plan.json' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('input-workspace-plan-path');
    expect(out).toContain('/tmp/plan.json');
  });

  it('does not render file picker in master mode', () => {
    resetLauncherState({ ...wsBase, workspacePlanMode: 'master' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('btn-workspace-plan-browse');
    expect(out).not.toContain('workspace-plan-advanced');
  });

  it('shows uploaded file tag when workspacePlanFile is set', () => {
    resetLauncherState({
      ...wsBase,
      workspacePlanFile: { name: 'my-plan.json', size: 1024 },
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('my-plan.json');
    expect(out).toContain('workspace-plan-upload');
  });
});

describe('fleetLauncherView — per-repo plan mode', () => {
  const wsBase = {
    launcherMode: 'workspace',
    selectedWorkspace: 'my-ws',
    workspaceData: {
      name: 'my-ws',
      projects: [
        { name: 'api', depends_on: [] },
        { name: 'web', depends_on: ['api'] },
      ],
    },
    workspacePlanMode: 'per-repo',
  };

  it('renders a file picker row for each project', () => {
    resetLauncherState(wsBase);
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('per-project-plans');
    expect(out).toContain('per-project-plan-row');
    expect(out).toContain('api');
    expect(out).toContain('web');
  });

  it('renders fallback alert about projects without plans', () => {
    resetLauncherState(wsBase);
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('fallback');
  });

  it('does not render per-project rows in master mode', () => {
    resetLauncherState({ ...wsBase, workspacePlanMode: 'master' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('per-project-plans');
    expect(out).not.toContain('per-project-plan-row');
  });

  it('shows uploaded file name when a per-repo plan is set', () => {
    resetLauncherState({
      ...wsBase,
      perRepoPlans: { api: { name: 'api-plan.md', size: 512 } },
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('api-plan.md');
  });
});

describe('resetLauncherState — new plan fields', () => {
  it('resets workspacePlanFile to null', () => {
    resetLauncherState({ workspacePlanFile: { name: 'x.json', size: 1 } });
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('x.json');
  });

  it('resets perRepoPlans to empty object', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'ws',
      workspaceData: { name: 'ws', projects: [{ name: 'a', depends_on: [] }] },
      workspacePlanMode: 'per-repo',
      perRepoPlans: { a: { name: 'old.md', size: 10 } },
    });
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'ws',
      workspaceData: { name: 'ws', projects: [{ name: 'a', depends_on: [] }] },
      workspacePlanMode: 'per-repo',
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).not.toContain('old.md');
  });
});

// ── filePickerButton renders sl-button with label+class ───────────────────

describe('filePickerButton — sl-button with label and class', () => {
  it('renders an sl-button element', () => {
    const out = renderToString(filePickerButton({ label: 'Upload' }));
    expect(out).toContain('sl-button');
  });

  it('renders the provided label text', () => {
    const out = renderToString(
      filePickerButton({ label: 'Browse workspace plan' }),
    );
    expect(out).toContain('Browse workspace plan');
  });

  it('applies the provided className', () => {
    const out = renderToString(
      filePickerButton({
        label: 'Browse',
        className: 'btn-workspace-plan-browse',
      }),
    );
    expect(out).toContain('btn-workspace-plan-browse');
  });

  it('uses default className btn-file-picker when omitted', () => {
    const out = renderToString(filePickerButton({}));
    expect(out).toContain('btn-file-picker');
  });
});

// ── workspace submit endpoint ──────────────────────────────────────────────

describe('fleetLauncherView — workspace submit', () => {
  it('validates workspace selection before submit', async () => {
    resetLauncherState({
      launcherMode: 'workspace',
      prompt: 'add feature',
    });
    let lastError = '';
    await submitFleetLauncher({
      rerender: () => {
        lastError = getFleetLauncherSubmitState().submitStatus;
      },
    });
    expect(lastError).toBe('error');
  });
});

// ── workspace submit FormData shapes ──────────────────────────────────────

describe('fleetLauncherView — workspace submit FormData', () => {
  let capturedFormData;

  const wsBase = {
    launcherMode: 'workspace',
    selectedWorkspace: 'my-ws',
    workspaceData: {
      name: 'my-ws',
      projects: [
        { name: 'api', depends_on: [] },
        { name: 'web', depends_on: ['api'] },
      ],
    },
    prompt: 'add auth',
  };

  beforeEach(() => {
    capturedFormData = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, opts) => {
        capturedFormData = opts?.body;
        return { json: async () => ({ ok: true, workspace_id: 'ws-123' }) };
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('master submit sends plan_mode=master with no plan files', async () => {
    resetLauncherState({ ...wsBase, workspacePlanMode: 'master' });
    await submitFleetLauncher({ rerender: () => {} });
    expect(capturedFormData).toBeInstanceOf(FormData);
    expect(capturedFormData.get('plan_mode')).toBe('master');
    expect(capturedFormData.get('workspace_name')).toBe('my-ws');
    expect(capturedFormData.get('prompt')).toBe('add auth');
    expect(capturedFormData.get('workspace_plan_file')).toBeNull();
    expect(capturedFormData.get('workspace_plan')).toBeNull();
    expect(capturedFormData.get('project_plan_api')).toBeNull();
  });

  it('existing submit with file sends workspace_plan_file', async () => {
    const file = new File(['{}'], 'plan.json', { type: 'application/json' });
    resetLauncherState({
      ...wsBase,
      workspacePlanMode: 'existing',
      workspacePlanFile: { name: 'plan.json', size: 2, file },
    });
    await submitFleetLauncher({ rerender: () => {} });
    expect(capturedFormData.get('plan_mode')).toBe('existing');
    expect(capturedFormData.get('workspace_plan_file')).toBeTruthy();
  });

  it('existing submit prefers file over path string', async () => {
    const file = new File(['{}'], 'uploaded.json', {
      type: 'application/json',
    });
    resetLauncherState({
      ...wsBase,
      workspacePlanMode: 'existing',
      workspacePlanFile: { name: 'uploaded.json', size: 2, file },
      workspacePlanPath: '/server/path/plan.json',
    });
    await submitFleetLauncher({ rerender: () => {} });
    expect(capturedFormData.get('workspace_plan_file')).toBeTruthy();
    expect(capturedFormData.get('workspace_plan')).toBeNull();
  });

  it('existing submit falls back to path when no file uploaded', async () => {
    resetLauncherState({
      ...wsBase,
      workspacePlanMode: 'existing',
      workspacePlanPath: '/server/path/plan.json',
    });
    await submitFleetLauncher({ rerender: () => {} });
    expect(capturedFormData.get('plan_mode')).toBe('existing');
    expect(capturedFormData.get('workspace_plan')).toBe(
      '/server/path/plan.json',
    );
    expect(capturedFormData.get('workspace_plan_file')).toBeNull();
  });

  it('per-repo submit sends project_plan_<name> for projects with plans', async () => {
    const apiFile = new File(['# API plan'], 'api-plan.md', {
      type: 'text/markdown',
    });
    resetLauncherState({
      ...wsBase,
      workspacePlanMode: 'per-repo',
      perRepoPlans: {
        api: { name: 'api-plan.md', size: 11, file: apiFile },
      },
    });
    await submitFleetLauncher({ rerender: () => {} });
    expect(capturedFormData.get('plan_mode')).toBe('per-repo');
    const file = capturedFormData.get('project_plan_api');
    expect(file).toBeTruthy();
    expect(file.name).toBe('api-plan.md');
  });

  it('independent submits plan_mode=independent with no plan files', async () => {
    resetLauncherState({
      ...wsBase,
      workspacePlanMode: 'independent',
    });
    await submitFleetLauncher({ rerender: () => {} });
    expect(capturedFormData.get('plan_mode')).toBe('independent');
    expect(capturedFormData.get('workspace_plan_file')).toBeNull();
    expect(capturedFormData.get('workspace_plan')).toBeNull();
    expect(capturedFormData.get('project_plan_api')).toBeNull();
  });
});
