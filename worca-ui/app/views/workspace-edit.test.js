import { describe, expect, it } from 'vitest';
import {
  getWorkspaceEditSubmitState,
  resetWorkspaceEditState,
  workspaceEditView,
} from './workspace-edit.js';

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

// ── loading state ─────────────────────────────────────────────────────

describe('workspaceEditView — loading', () => {
  it('shows loading spinner while workspace is being fetched', () => {
    resetWorkspaceEditState({ loadStatus: 'loading' });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('ws-edit-loading');
  });

  it('shows load error when fetch fails', () => {
    resetWorkspaceEditState({
      loadStatus: 'error',
      loadError: 'Not found',
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('ws-edit-load-error');
    expect(out).toContain('Not found');
  });

  it('shows the form when workspace is loaded', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'backend', path: 'backend', role: 'service', depends_on: [] },
      ],
      selectedRepos: ['backend'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('workspace-edit-page');
    expect(out).toContain('input-workspace-name');
  });
});

// ── pre-fill from workspace.json ──────────────────────────────────────

describe('workspaceEditView — pre-fill', () => {
  it('displays workspace name as read-only', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [{ name: 'lib', path: 'lib', role: 'library', depends_on: [] }],
      selectedRepos: ['lib'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('my-ws');
    expect(out).toContain('input-workspace-name');
  });

  it('pre-fills repo checklist from loaded workspace', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'backend', path: 'backend', role: 'service', depends_on: [] },
        {
          name: 'frontend',
          path: 'frontend',
          role: 'frontend',
          depends_on: ['backend'],
        },
      ],
      selectedRepos: ['backend', 'frontend'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('repo-checklist');
    expect(out).toContain('backend');
    expect(out).toContain('frontend');
  });

  it('pre-fills dependency editor from loaded workspace', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'lib', path: 'lib', role: 'library', depends_on: [] },
        { name: 'api', path: 'api', role: 'service', depends_on: ['lib'] },
      ],
      selectedRepos: ['lib', 'api'],
      dependencies: { api: ['lib'] },
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('dep-editor');
    expect(out).toContain('dep-row-api');
  });

  it('pre-fills integration test fields', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [{ name: 'lib', path: 'lib', role: 'default', depends_on: [] }],
      selectedRepos: ['lib'],
      integrationCmd: 'npm test',
      integrationCwd: '/work',
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('input-integration-cmd');
    expect(out).toContain('npm test');
  });

  it('pre-fills umbrella repo', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [{ name: 'lib', path: 'lib', role: 'default', depends_on: [] }],
      selectedRepos: ['lib'],
      umbrellaRepo: 'org/umbrella',
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('input-umbrella-repo');
    expect(out).toContain('org/umbrella');
  });
});

// ── repo checklist editing ────────────────────────────────────────────

describe('workspaceEditView — repo editing', () => {
  it('renders role select for each repo', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'backend', path: 'backend', role: 'service', depends_on: [] },
      ],
      selectedRepos: ['backend'],
      repoRoles: { backend: 'service' },
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('select-repo-role-backend');
  });

  it('does not render parent dir section (already set)', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [{ name: 'lib', path: 'lib', role: 'default', depends_on: [] }],
      selectedRepos: ['lib'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).not.toContain('input-parent-dir');
    expect(out).not.toContain('btn-scan');
  });
});

// ── dependency editor ─────────────────────────────────────────────────

describe('workspaceEditView — dependency editor', () => {
  it('shows dependency editor when 2+ repos exist', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'lib', path: 'lib', role: 'library', depends_on: [] },
        { name: 'api', path: 'api', role: 'service', depends_on: [] },
      ],
      selectedRepos: ['lib', 'api'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('dep-editor');
  });

  it('does not show dependency editor with fewer than 2 repos', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [{ name: 'lib', path: 'lib', role: 'library', depends_on: [] }],
      selectedRepos: ['lib'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).not.toContain('dep-editor');
  });

  it('shows DAG preview when dependencies exist', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'lib', path: 'lib', role: 'library', depends_on: [] },
        { name: 'api', path: 'api', role: 'service', depends_on: ['lib'] },
      ],
      selectedRepos: ['lib', 'api'],
      dependencies: { api: ['lib'] },
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('dag-preview');
  });
});

// ── cycle detection ───────────────────────────────────────────────────

describe('workspaceEditView — cycle detection', () => {
  it('shows cycle warning when dependencies form a cycle', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'a', path: 'a', role: 'default', depends_on: ['b'] },
        { name: 'b', path: 'b', role: 'default', depends_on: ['a'] },
      ],
      selectedRepos: ['a', 'b'],
      dependencies: { a: ['b'], b: ['a'] },
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('cycle-warning');
  });

  it('no cycle warning when dependencies are acyclic', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'a', path: 'a', role: 'default', depends_on: [] },
        { name: 'b', path: 'b', role: 'default', depends_on: ['a'] },
      ],
      selectedRepos: ['a', 'b'],
      dependencies: { b: ['a'] },
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).not.toContain('cycle-warning');
  });
});

// ── snapshot semantics banner ─────────────────────────────────────────

describe('workspaceEditView — snapshot semantics banner', () => {
  it('shows snapshot banner when active runs exist', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [{ name: 'lib', path: 'lib', role: 'default', depends_on: [] }],
      selectedRepos: ['lib'],
      hasActiveRuns: true,
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('ws-edit-snapshot-banner');
  });

  it('does not show snapshot banner when no active runs', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [{ name: 'lib', path: 'lib', role: 'default', depends_on: [] }],
      selectedRepos: ['lib'],
      hasActiveRuns: false,
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).not.toContain('ws-edit-snapshot-banner');
  });
});

// ── additive diff — init action ───────────────────────────────────────

describe('workspaceEditView — worca init action', () => {
  it('shows init action when new repos are added', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      originalRepoNames: ['lib'],
      repos: [
        { name: 'lib', path: 'lib', role: 'default', depends_on: [] },
        { name: 'api', path: 'api', role: 'service', depends_on: [] },
      ],
      selectedRepos: ['lib', 'api'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('ws-edit-init-action');
  });

  it('does not show init action when no new repos added', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      originalRepoNames: ['lib', 'api'],
      repos: [
        { name: 'lib', path: 'lib', role: 'default', depends_on: [] },
        { name: 'api', path: 'api', role: 'service', depends_on: [] },
      ],
      selectedRepos: ['lib', 'api'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).not.toContain('ws-edit-init-action');
  });

  it('does not show init action when repos are only removed', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      originalRepoNames: ['lib', 'api', 'frontend'],
      repos: [
        { name: 'lib', path: 'lib', role: 'default', depends_on: [] },
        { name: 'api', path: 'api', role: 'service', depends_on: [] },
      ],
      selectedRepos: ['lib', 'api'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).not.toContain('ws-edit-init-action');
  });
});

// ── submit state ──────────────────────────────────────────────────────

describe('getWorkspaceEditSubmitState', () => {
  it('canSubmit=false when no repos are selected', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
    });
    expect(getWorkspaceEditSubmitState().canSubmit).toBe(false);
  });

  it('canSubmit=false when dependencies have a cycle', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'a', path: 'a', role: 'default', depends_on: [] },
        { name: 'b', path: 'b', role: 'default', depends_on: [] },
      ],
      selectedRepos: ['a', 'b'],
      dependencies: { a: ['b'], b: ['a'] },
    });
    expect(getWorkspaceEditSubmitState().canSubmit).toBe(false);
  });

  it('canSubmit=false when workspace is not loaded', () => {
    resetWorkspaceEditState({ loadStatus: 'loading' });
    expect(getWorkspaceEditSubmitState().canSubmit).toBe(false);
  });

  it('canSubmit=true when workspace is loaded with valid repos and no cycle', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [
        { name: 'lib', path: 'lib', role: 'library', depends_on: [] },
        { name: 'api', path: 'api', role: 'service', depends_on: ['lib'] },
      ],
      selectedRepos: ['lib', 'api'],
      dependencies: { api: ['lib'] },
    });
    expect(getWorkspaceEditSubmitState().canSubmit).toBe(true);
  });

  it('isSubmitting is initially false', () => {
    resetWorkspaceEditState();
    expect(getWorkspaceEditSubmitState().isSubmitting).toBe(false);
  });
});

// ── submit error ──────────────────────────────────────────────────────

describe('workspaceEditView — submit error', () => {
  it('shows submit error when status is error', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [{ name: 'lib', path: 'lib', role: 'default', depends_on: [] }],
      selectedRepos: ['lib'],
      submitStatus: 'error',
      submitError: 'Cannot edit while active',
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).toContain('ws-edit-error');
    expect(out).toContain('Cannot edit while active');
  });

  it('does not show error when status is null', () => {
    resetWorkspaceEditState({
      loadStatus: 'done',
      workspaceName: 'my-ws',
      repos: [{ name: 'lib', path: 'lib', role: 'default', depends_on: [] }],
      selectedRepos: ['lib'],
    });
    const out = renderToString(workspaceEditView({}, {}));
    expect(out).not.toContain('ws-edit-error');
  });
});
