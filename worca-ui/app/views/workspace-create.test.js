import { describe, expect, it } from 'vitest';
import {
  getWorkspaceCreateSubmitState,
  resetWorkspaceCreateState,
  workspaceCreateView,
} from './workspace-create.js';

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

// ── parent dir picker ──────────────────────────────────────────────────────

describe('workspaceCreateView — parent dir picker', () => {
  it('renders the parent directory input', () => {
    resetWorkspaceCreateState();
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('input-parent-dir');
  });

  it('renders a Scan button', () => {
    resetWorkspaceCreateState();
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('btn-scan');
  });

  it('auto-detects parent dirs from projects when available', () => {
    resetWorkspaceCreateState();
    const appState = {
      projects: [
        { name: 'repo-a', path: '/work/repos/repo-a' },
        { name: 'repo-b', path: '/work/repos/repo-b' },
      ],
    };
    const out = renderToString(workspaceCreateView(appState, {}));
    expect(out).toContain('parent-dir-suggestions');
    expect(out).toContain('/work/repos');
  });

  it('shows empty-state alert when no projects are registered', () => {
    resetWorkspaceCreateState();
    const out = renderToString(workspaceCreateView({ projects: [] }, {}));
    expect(out).toContain('parent-dir-empty-state');
  });

  it('allows free-form parent dir input', () => {
    resetWorkspaceCreateState({ parentDir: '/custom/path' });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('input-parent-dir');
  });
});

// ── scan results & repo checklist ──────────────────────────────────────────

describe('workspaceCreateView — repo selection', () => {
  it('shows scanned repos as a checklist', () => {
    resetWorkspaceCreateState({
      scannedRepos: [
        { name: 'backend', path: 'backend', role_hint: null },
        { name: 'frontend', path: 'frontend', role_hint: null },
      ],
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('repo-checklist');
    expect(out).toContain('backend');
    expect(out).toContain('frontend');
  });

  it('shows scanning spinner when scan is in progress', () => {
    resetWorkspaceCreateState({ scanStatus: 'scanning' });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('scan-spinner');
  });

  it('shows scan error when scan fails', () => {
    resetWorkspaceCreateState({
      scanStatus: 'error',
      scanError: 'Path does not exist',
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('scan-error');
    expect(out).toContain('Path does not exist');
  });

  it('does not show repo checklist when no scan has been run', () => {
    resetWorkspaceCreateState({ scannedRepos: [] });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).not.toContain('repo-checklist');
  });

  it('no longer renders a per-repo role select (role field removed)', () => {
    resetWorkspaceCreateState({
      scannedRepos: [{ name: 'backend', path: 'backend', role_hint: null }],
      selectedRepos: ['backend'],
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).not.toContain('select-repo-role-');
  });
});

// ── dependency editor ──────────────────────────────────────────────────────

describe('workspaceCreateView — dependency editor', () => {
  it('shows dependency editor when 2+ repos are selected', () => {
    resetWorkspaceCreateState({
      scannedRepos: [
        { name: 'shared-lib', path: 'shared-lib', role_hint: null },
        { name: 'backend', path: 'backend', role_hint: null },
      ],
      selectedRepos: ['shared-lib', 'backend'],
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('dep-editor');
  });

  it('does not show dependency editor with fewer than 2 repos', () => {
    resetWorkspaceCreateState({
      scannedRepos: [{ name: 'backend', path: 'backend', role_hint: null }],
      selectedRepos: ['backend'],
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).not.toContain('dep-editor');
  });

  it('renders add-dependency controls for each selected repo', () => {
    resetWorkspaceCreateState({
      scannedRepos: [
        { name: 'lib', path: 'lib', role_hint: null },
        { name: 'api', path: 'api', role_hint: null },
      ],
      selectedRepos: ['lib', 'api'],
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('dep-row-api');
  });

  it('shows live DAG preview container when dependencies are set', () => {
    resetWorkspaceCreateState({
      scannedRepos: [
        { name: 'lib', path: 'lib', role_hint: null },
        { name: 'api', path: 'api', role_hint: null },
      ],
      selectedRepos: ['lib', 'api'],
      dependencies: { api: ['lib'] },
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('dag-preview');
  });
});

// ── cycle detection ────────────────────────────────────────────────────────

describe('workspaceCreateView — cycle detection', () => {
  it('shows cycle warning when dependencies form a cycle', () => {
    resetWorkspaceCreateState({
      scannedRepos: [
        { name: 'a', path: 'a', role_hint: null },
        { name: 'b', path: 'b', role_hint: null },
      ],
      selectedRepos: ['a', 'b'],
      dependencies: { a: ['b'], b: ['a'] },
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('cycle-warning');
  });

  it('no cycle warning when dependencies are acyclic', () => {
    resetWorkspaceCreateState({
      scannedRepos: [
        { name: 'a', path: 'a', role_hint: null },
        { name: 'b', path: 'b', role_hint: null },
      ],
      selectedRepos: ['a', 'b'],
      dependencies: { b: ['a'] },
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).not.toContain('cycle-warning');
  });
});

// ── integration test fields ────────────────────────────────────────────────

describe('workspaceCreateView — integration test', () => {
  it('renders integration test command input', () => {
    resetWorkspaceCreateState();
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('input-integration-cmd');
  });

  it('renders integration test working dir input', () => {
    resetWorkspaceCreateState();
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('input-integration-cwd');
  });
});

// ── umbrella repo ──────────────────────────────────────────────────────────

describe('workspaceCreateView — umbrella repo', () => {
  it('renders umbrella repo input', () => {
    resetWorkspaceCreateState();
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('input-umbrella-repo');
  });
});

// ── workspace name ─────────────────────────────────────────────────────────

describe('workspaceCreateView — name', () => {
  it('renders workspace name input', () => {
    resetWorkspaceCreateState();
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('input-workspace-name');
  });
});

// ── submit state ───────────────────────────────────────────────────────────

describe('getWorkspaceCreateSubmitState', () => {
  it('canSubmit=false when no name is set', () => {
    resetWorkspaceCreateState({
      selectedRepos: ['lib'],
      parentDir: '/work',
    });
    expect(getWorkspaceCreateSubmitState().canSubmit).toBe(false);
  });

  it('canSubmit=false when no repos are selected', () => {
    resetWorkspaceCreateState({
      workspaceName: 'my-ws',
      parentDir: '/work',
    });
    expect(getWorkspaceCreateSubmitState().canSubmit).toBe(false);
  });

  it('canSubmit=false when no parent dir is set', () => {
    resetWorkspaceCreateState({
      workspaceName: 'my-ws',
      selectedRepos: ['lib'],
    });
    expect(getWorkspaceCreateSubmitState().canSubmit).toBe(false);
  });

  it('canSubmit=false when dependencies have a cycle', () => {
    resetWorkspaceCreateState({
      workspaceName: 'my-ws',
      parentDir: '/work',
      scannedRepos: [
        { name: 'a', path: 'a', role_hint: null },
        { name: 'b', path: 'b', role_hint: null },
      ],
      selectedRepos: ['a', 'b'],
      dependencies: { a: ['b'], b: ['a'] },
    });
    expect(getWorkspaceCreateSubmitState().canSubmit).toBe(false);
  });

  it('canSubmit=true when name, parent dir, and repos are valid with no cycle', () => {
    resetWorkspaceCreateState({
      workspaceName: 'my-ws',
      parentDir: '/work',
      scannedRepos: [
        { name: 'lib', path: 'lib', role_hint: null },
        { name: 'api', path: 'api', role_hint: null },
      ],
      selectedRepos: ['lib', 'api'],
      dependencies: { api: ['lib'] },
    });
    expect(getWorkspaceCreateSubmitState().canSubmit).toBe(true);
  });

  it('isSubmitting is initially false', () => {
    resetWorkspaceCreateState();
    expect(getWorkspaceCreateSubmitState().isSubmitting).toBe(false);
  });
});

// ── error display ──────────────────────────────────────────────────────────

describe('workspaceCreateView — submit error', () => {
  it('shows submit error when status is error', () => {
    resetWorkspaceCreateState({
      submitStatus: 'error',
      submitError: 'Server failed',
    });
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).toContain('ws-create-error');
    expect(out).toContain('Server failed');
  });

  it('does not show error when status is null', () => {
    resetWorkspaceCreateState();
    const out = renderToString(workspaceCreateView({}, {}));
    expect(out).not.toContain('ws-create-error');
  });
});
