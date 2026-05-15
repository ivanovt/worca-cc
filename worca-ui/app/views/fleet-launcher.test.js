import { describe, expect, it } from 'vitest';
import {
  fleetLauncherView,
  getFleetLauncherSubmitState,
  resetLauncherState,
  submitFleetLauncher,
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

// ── workspace mode toggle ──────────────────────────────────────────────────

describe('fleetLauncherView — workspace mode toggle', () => {
  it('renders a mode toggle with Fleet and Workspace options', () => {
    resetLauncherState();
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('launcher-mode-toggle');
    expect(out).toContain('Fleet');
    expect(out).toContain('Workspace');
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
      { name: 'my-ws', repos: [{ name: 'lib', depends_on: [] }] },
      { name: 'other-ws', repos: [] },
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
        repos: [
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
        repos: [
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

describe('fleetLauncherView — workspace gh auth check', () => {
  it('shows auth error alerts when auth check fails', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        repos: [{ name: 'lib', depends_on: [] }],
      },
      ghAuthStatus: 'failed',
      ghAuthErrors: [
        {
          org: 'acme-corp',
          command: 'gh auth login --hostname github.com --scopes repo',
        },
      ],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('gh-auth-error');
    expect(out).toContain('acme-corp');
    expect(out).toContain('gh auth login');
  });

  it('shows skip auth checkbox', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        repos: [{ name: 'lib', depends_on: [] }],
      },
      ghAuthStatus: 'failed',
      ghAuthErrors: [{ org: 'acme', command: 'gh auth login' }],
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('checkbox-skip-auth');
    expect(out).toContain('Skip auth check');
  });

  it('shows success indicator when auth check passes', () => {
    resetLauncherState({
      launcherMode: 'workspace',
      selectedWorkspace: 'my-ws',
      workspaceData: {
        name: 'my-ws',
        repos: [{ name: 'lib', depends_on: [] }],
      },
      ghAuthStatus: 'ok',
    });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('gh-auth-ok');
  });
});

// ── workspace head template default ────────────────────────────────────────

describe('fleetLauncherView — workspace head template', () => {
  it('defaults to workspace/{slug}/{repo} in workspace mode', () => {
    resetLauncherState({ launcherMode: 'workspace' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('workspace/{slug}/{repo}');
  });

  it('defaults to migration/{slug}/{project} in fleet mode', () => {
    resetLauncherState({ launcherMode: 'fleet' });
    const out = renderToString(fleetLauncherView({ projects: [] }, {}));
    expect(out).toContain('migration/{slug}/{project}');
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
        repos: [{ name: 'lib', depends_on: [] }],
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
        repos: [{ name: 'lib', depends_on: [] }],
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
        repos: [{ name: 'lib', depends_on: [] }],
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
        repos: [{ name: 'lib', depends_on: [] }],
      },
      sourceType: 'source',
      sourceValue: 'gh:issue:42',
    });
    expect(getFleetLauncherSubmitState().canLaunch).toBe(true);
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
