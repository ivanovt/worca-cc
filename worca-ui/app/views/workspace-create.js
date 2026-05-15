import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { dagGraphView } from './dag-graph.js';

let workspaceName = '';
let parentDir = '';
let scannedRepos = [];
let selectedRepos = [];
let repoRoles = {};
let dependencies = {};
let integrationCmd = '';
let integrationCwd = '';
let umbrellaRepo = '';
let scanStatus = null;
let scanError = '';
let submitStatus = null;
let submitError = '';

export function resetWorkspaceCreateState(overrides = {}) {
  workspaceName = overrides.workspaceName ?? '';
  parentDir = overrides.parentDir ?? '';
  scannedRepos = overrides.scannedRepos ?? [];
  selectedRepos = overrides.selectedRepos ?? [];
  repoRoles = overrides.repoRoles ?? {};
  dependencies = overrides.dependencies ?? {};
  integrationCmd = overrides.integrationCmd ?? '';
  integrationCwd = overrides.integrationCwd ?? '';
  umbrellaRepo = overrides.umbrellaRepo ?? '';
  scanStatus = overrides.scanStatus ?? null;
  scanError = overrides.scanError ?? '';
  submitStatus = overrides.submitStatus ?? null;
  submitError = overrides.submitError ?? '';
}

function _detectCycle(repos, deps) {
  const inDegree = {};
  const dependents = {};
  for (const name of repos) {
    inDegree[name] = 0;
    dependents[name] = [];
  }
  for (const name of repos) {
    for (const dep of deps[name] || []) {
      if (!(dep in inDegree)) continue;
      inDegree[name]++;
      dependents[dep].push(name);
    }
  }
  const queue = Object.keys(inDegree).filter((n) => inDegree[n] === 0);
  let processed = 0;
  const next = [...queue];
  while (next.length > 0) {
    const name = next.shift();
    processed++;
    for (const dep of dependents[name] || []) {
      inDegree[dep]--;
      if (inDegree[dep] === 0) next.push(dep);
    }
  }
  return processed !== repos.length;
}

function _hasCycle() {
  return selectedRepos.length >= 2 && _detectCycle(selectedRepos, dependencies);
}

function _parentDirSuggestions(projects) {
  if (!projects || projects.length === 0) return [];
  const parents = new Set();
  for (const p of projects) {
    const path = p.path || '';
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash > 0) parents.add(path.slice(0, lastSlash));
  }
  return [...parents].sort();
}

export function getWorkspaceCreateSubmitState() {
  const hasCycle = _hasCycle();
  return {
    canSubmit:
      workspaceName.trim().length > 0 &&
      parentDir.trim().length > 0 &&
      selectedRepos.length > 0 &&
      !hasCycle,
    isSubmitting: submitStatus === 'submitting',
    submitStatus,
  };
}

export async function submitWorkspaceCreate({ rerender, onCreated } = {}) {
  if (!workspaceName.trim()) {
    submitStatus = 'error';
    submitError = 'Workspace name is required.';
    rerender?.();
    return;
  }
  if (!parentDir.trim()) {
    submitStatus = 'error';
    submitError = 'Parent directory is required.';
    rerender?.();
    return;
  }
  if (selectedRepos.length === 0) {
    submitStatus = 'error';
    submitError = 'Select at least one repository.';
    rerender?.();
    return;
  }
  if (_hasCycle()) {
    submitStatus = 'error';
    submitError = 'Dependency cycle detected. Fix before submitting.';
    rerender?.();
    return;
  }

  submitStatus = 'submitting';
  submitError = '';
  rerender?.();

  const repos = selectedRepos.map((name) => {
    const scanned = scannedRepos.find((r) => r.name === name);
    return {
      name,
      path: scanned?.path || name,
      role: repoRoles[name] || 'default',
      depends_on: dependencies[name] || [],
    };
  });

  const body = {
    name: workspaceName.trim(),
    parent_path: parentDir.trim(),
    repos,
  };
  if (integrationCmd.trim()) {
    body.integration_test = {
      command: integrationCmd.trim(),
      cwd: integrationCwd.trim() || undefined,
    };
  }
  if (umbrellaRepo.trim()) {
    body.umbrella_repo = umbrellaRepo.trim();
  }

  try {
    const resp = await fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();

    if (data.ok) {
      submitStatus = null;
      onCreated?.(workspaceName.trim());
    } else {
      submitStatus = 'error';
      submitError = data.error || 'Creation failed';
      rerender?.();
    }
  } catch (err) {
    submitStatus = 'error';
    submitError = err.message || 'Network error';
    rerender?.();
  }
}

export async function scanParentDir({ rerender } = {}) {
  if (!parentDir.trim()) return;
  scanStatus = 'scanning';
  scanError = '';
  rerender?.();

  try {
    const resp = await fetch('/api/workspaces/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parent_path: parentDir.trim() }),
    });
    const data = await resp.json();
    if (data.ok) {
      scannedRepos = data.repos || [];
      scanStatus = 'done';
    } else {
      scannedRepos = [];
      scanStatus = 'error';
      scanError = data.error || 'Scan failed';
    }
  } catch (err) {
    scannedRepos = [];
    scanStatus = 'error';
    scanError = err.message || 'Network error';
  }
  rerender?.();
}

// ── sub-views ──────────────────────────────────────────────────────────────

function _nameSection({ rerender } = {}) {
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Workspace</h3>
      <div class="settings-field">
        <label class="settings-label">Name</label>
        <sl-input
          class="input-workspace-name"
          placeholder="my-workspace"
          value="${workspaceName}"
          @sl-input=${
            rerender
              ? (e) => {
                  workspaceName = e.target.value;
                  rerender();
                }
              : null
          }
        ></sl-input>
        <span class="settings-field-hint">Unique name for this workspace definition.</span>
      </div>
    </div>
  `;
}

function _parentDirSection(appState, { rerender } = {}) {
  const projects = appState?.projects || [];
  const suggestions = _parentDirSuggestions(projects);

  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Parent Directory</h3>
      ${
        projects.length === 0
          ? html`
            <sl-alert variant="warning" open class="parent-dir-empty-state">
              No registered projects found. Enter a parent directory path manually.
            </sl-alert>
          `
          : nothing
      }
      ${
        suggestions.length > 0
          ? html`
            <div class="parent-dir-suggestions">
              <span class="settings-field-hint">Detected from registered projects:</span>
              ${suggestions.map(
                (s) => html`
                  <sl-tag
                    class="parent-dir-tag"
                    size="small"
                    @click=${
                      rerender
                        ? () => {
                            parentDir = s;
                            rerender();
                          }
                        : null
                    }
                    style="cursor:pointer"
                  >${s}</sl-tag>
                `,
              )}
            </div>
          `
          : nothing
      }
      <div class="settings-field">
        <label class="settings-label">Path</label>
        <div class="parent-dir-row">
          <sl-input
            class="input-parent-dir"
            placeholder="/path/to/repos"
            value="${parentDir}"
            @sl-input=${
              rerender
                ? (e) => {
                    parentDir = e.target.value;
                    rerender();
                  }
                : null
            }
          ></sl-input>
          <sl-button
            class="btn-scan"
            variant="primary"
            size="small"
            ?disabled=${!parentDir.trim() || scanStatus === 'scanning'}
            @click=${rerender ? () => scanParentDir({ rerender }) : null}
          >${scanStatus === 'scanning' ? 'Scanning…' : 'Scan'}</sl-button>
        </div>
        <span class="settings-field-hint">Directory containing all repositories in this workspace.</span>
      </div>
      ${
        scanStatus === 'scanning'
          ? html`<div class="scan-spinner"><sl-spinner></sl-spinner> Scanning for git repositories…</div>`
          : nothing
      }
      ${
        scanStatus === 'error'
          ? html`<div class="scan-error"><sl-alert variant="danger" open>${scanError}</sl-alert></div>`
          : nothing
      }
    </div>
  `;
}

function _repoChecklistSection({ rerender } = {}) {
  if (scannedRepos.length === 0) return nothing;

  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Repositories</h3>
      <div class="repo-checklist">
        ${scannedRepos.map(
          (repo) => html`
            <div class="repo-checklist-item">
              <sl-checkbox
                class="checkbox-repo-${repo.name}"
                ?checked=${selectedRepos.includes(repo.name)}
                @sl-change=${
                  rerender
                    ? (e) => {
                        if (e.target.checked) {
                          selectedRepos = [...selectedRepos, repo.name];
                        } else {
                          selectedRepos = selectedRepos.filter(
                            (n) => n !== repo.name,
                          );
                          const newDeps = { ...dependencies };
                          delete newDeps[repo.name];
                          for (const key of Object.keys(newDeps)) {
                            newDeps[key] = newDeps[key].filter(
                              (d) => d !== repo.name,
                            );
                          }
                          dependencies = newDeps;
                        }
                        rerender();
                      }
                    : null
                }
              >${repo.name}</sl-checkbox>
              ${
                selectedRepos.includes(repo.name)
                  ? html`
                    <sl-select
                      class="select-repo-role-${repo.name}"
                      size="small"
                      value="${repoRoles[repo.name] || 'default'}"
                      @sl-change=${
                        rerender
                          ? (e) => {
                              repoRoles = {
                                ...repoRoles,
                                [repo.name]: e.target.value,
                              };
                              rerender();
                            }
                          : null
                      }
                    >
                      <sl-option value="default">Default</sl-option>
                      <sl-option value="library">Library</sl-option>
                      <sl-option value="service">Service</sl-option>
                      <sl-option value="frontend">Frontend</sl-option>
                    </sl-select>
                  `
                  : nothing
              }
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

function _depEditorSection({ rerender } = {}) {
  if (selectedRepos.length < 2) return nothing;

  const hasCycle = _hasCycle();
  const dagRepos = selectedRepos.map((name) => ({
    name,
    status: 'pending',
    depends_on: dependencies[name] || [],
  }));
  const { svg } = dagGraphView({ repos: dagRepos }, { mode: 'edit' });

  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Dependencies</h3>
      <div class="dep-editor">
        ${selectedRepos.map(
          (name) => html`
            <div class="dep-row dep-row-${name}">
              <span class="dep-repo-name">${name}</span>
              <span class="dep-arrow">depends on</span>
              <sl-select
                class="select-dep-${name}"
                size="small"
                multiple
                clearable
                .value=${dependencies[name] || []}
                @sl-change=${
                  rerender
                    ? (e) => {
                        const v = e.target.value;
                        const vals = Array.isArray(v)
                          ? v.filter(Boolean)
                          : typeof v === 'string' && v
                            ? v.split(' ').filter(Boolean)
                            : [];
                        dependencies = { ...dependencies, [name]: vals };
                        rerender();
                      }
                    : null
                }
              >
                ${selectedRepos
                  .filter((r) => r !== name)
                  .map((r) => html`<sl-option value="${r}">${r}</sl-option>`)}
              </sl-select>
            </div>
          `,
        )}
      </div>
      ${
        hasCycle
          ? html`
            <sl-alert variant="danger" open class="cycle-warning">
              Dependency cycle detected. Remove a dependency to fix.
            </sl-alert>
          `
          : nothing
      }
      ${svg ? html`<div class="dag-preview">${unsafeHTML(svg)}</div>` : nothing}
    </div>
  `;
}

function _integrationSection({ rerender } = {}) {
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Integration Test (optional)</h3>
      <div class="settings-field">
        <label class="settings-label">Command</label>
        <sl-input
          class="input-integration-cmd"
          placeholder="npm test -- --integration"
          value="${integrationCmd}"
          @sl-input=${
            rerender
              ? (e) => {
                  integrationCmd = e.target.value;
                  rerender();
                }
              : null
          }
        ></sl-input>
        <span class="settings-field-hint">Shell command run after all repos complete. Exit 0 = pass.</span>
      </div>
      <div class="settings-field">
        <label class="settings-label">Working directory (optional)</label>
        <sl-input
          class="input-integration-cwd"
          placeholder="Defaults to parent directory"
          value="${integrationCwd}"
          @sl-input=${
            rerender
              ? (e) => {
                  integrationCwd = e.target.value;
                  rerender();
                }
              : null
          }
        ></sl-input>
      </div>
    </div>
  `;
}

function _umbrellaSection({ rerender } = {}) {
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Umbrella Repository (optional)</h3>
      <div class="settings-field">
        <label class="settings-label">Repository</label>
        <sl-input
          class="input-umbrella-repo"
          placeholder="org/umbrella-repo"
          value="${umbrellaRepo}"
          @sl-input=${
            rerender
              ? (e) => {
                  umbrellaRepo = e.target.value;
                  rerender();
                }
              : null
          }
        ></sl-input>
        <span class="settings-field-hint">GitHub repo for the umbrella issue linking all workspace PRs.</span>
      </div>
    </div>
  `;
}

// ── main view ──────────────────────────────────────────────────────────────

export function workspaceCreateView(appState, { rerender } = {}) {
  return html`
    <div class="new-run-page workspace-create-page">
      ${
        submitStatus === 'error'
          ? html`<div class="ws-create-error">${submitError}</div>`
          : nothing
      }
      <div class="new-run-form">
        ${_nameSection({ rerender })}
        ${_parentDirSection(appState, { rerender })}
        ${_repoChecklistSection({ rerender })}
        ${_depEditorSection({ rerender })}
        ${_integrationSection({ rerender })}
        ${_umbrellaSection({ rerender })}
      </div>
    </div>
  `;
}
