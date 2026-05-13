import { html, nothing } from 'lit-html';
import {
  guideUploadWidget,
  headTemplateInput,
  planModeRadio,
  tokenOverheadGate,
} from './launcher-shared.js';

const GUIDE_CAP_BYTES_DEFAULT = 128 * 1024; // matches src/worca/settings.json + GUIDE_MAX_BYTES_DEFAULT in work_request.py

function resolveGuideCap(appState) {
  return (
    appState?.preferences?.worca?.guide?.max_bytes ?? GUIDE_CAP_BYTES_DEFAULT
  );
}
const TOKEN_THRESHOLD = 1_000_000;

// ── module-level form state ─────────────────────────────────────────────────

let selectedProjects = [];
let projectFilter = '';
let promptTab = 'prompt';
let prompt = '';
let source = '';
let guides = [];
let headTemplate = 'migration/{slug}/{project}';
let baseBranch = '';
let baseBranchError = null;
let baseBranchValidating = false;
let planMode = 'none';
let planPath = '';
let planFirstProject = '';
let maxParallel = 5;
let failureThreshold = 0.3;
let tokenEstimate = null;
let tokenEstimating = false;
let tokenConfirmed = false;
let submitStatus = null;
let submitError = '';

export function resetLauncherState(overrides = {}) {
  selectedProjects = overrides.selectedProjects ?? [];
  projectFilter = overrides.projectFilter ?? '';
  promptTab = overrides.promptTab ?? 'prompt';
  prompt = overrides.prompt ?? '';
  source = overrides.source ?? '';
  guides = overrides.guides ?? [];
  headTemplate = overrides.headTemplate ?? 'migration/{slug}/{project}';
  baseBranch = overrides.baseBranch ?? '';
  baseBranchError = overrides.baseBranchError ?? null;
  baseBranchValidating = overrides.baseBranchValidating ?? false;
  planMode = overrides.planMode ?? 'none';
  planPath = overrides.planPath ?? '';
  planFirstProject = overrides.planFirstProject ?? '';
  maxParallel = overrides.maxParallel ?? 5;
  failureThreshold = overrides.failureThreshold ?? 0.3;
  tokenEstimate = overrides.tokenEstimate ?? null;
  tokenEstimating = overrides.tokenEstimating ?? false;
  tokenConfirmed = overrides.tokenConfirmed ?? false;
  submitStatus = null;
  submitError = '';
}

// ── helpers ─────────────────────────────────────────────────────────────────

function _resolveProjectSlug(projectPath) {
  return (
    (projectPath.split('/').pop() || projectPath)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

function _detectCollision(template, projects) {
  if (projects.length < 2) return false;
  const seen = new Set();
  for (const p of projects) {
    const slug = _resolveProjectSlug(p);
    let branch = template || 'migration/{slug}/{project}';
    branch = branch.replace(/\{project\}/g, slug);
    branch = branch.replace(/\{fleet_id\}/g, 'f_preview');
    branch = branch.replace(/\{slug\}/g, 'slug');
    branch = branch.replace(/\{yyyymmddhhmm\}/g, '202605120900');
    branch = branch.replace(/\{yyyymmdd\}/g, '20260512');
    if (seen.has(branch)) return true;
    seen.add(branch);
  }
  return false;
}

// ── sub-views ────────────────────────────────────────────────────────────────

function _projectsSection(appProjects, { rerender } = {}) {
  const filtered = appProjects.filter((p) => {
    if (!projectFilter) return true;
    const q = projectFilter.toLowerCase();
    return (
      (p.name || '').toLowerCase().includes(q) ||
      (p.path || '').toLowerCase().includes(q)
    );
  });

  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Projects</h3>
      <div class="settings-field">
        <label class="settings-label">Targets</label>
        <div class="fleet-launcher-projects-controls">
          <sl-input
            class="input-project-filter"
            size="small"
            placeholder="Filter projects…"
            value="${projectFilter}"
            @sl-input=${
              rerender
                ? (e) => {
                    projectFilter = e.target.value;
                    rerender();
                  }
                : null
            }
          ></sl-input>
          <sl-button
            size="small"
            variant="default"
            class="btn-select-all-projects"
            @click=${
              rerender
                ? () => {
                    selectedProjects =
                      selectedProjects.length === appProjects.length
                        ? []
                        : appProjects.map((p) => p.path);
                    rerender();
                  }
                : null
            }
          >
            ${selectedProjects.length === appProjects.length ? 'Deselect all' : 'Select all'}
          </sl-button>
        </div>
        <sl-select
          class="fleet-launcher-projects"
          multiple
          clearable
          .value=${selectedProjects}
          @sl-change=${
            rerender
              ? (e) => {
                  const v = e.target.value;
                  selectedProjects = Array.isArray(v)
                    ? v.filter(Boolean)
                    : typeof v === 'string' && v
                      ? v.split(' ').filter(Boolean)
                      : [];
                  rerender();
                }
              : null
          }
        >
          ${filtered.map(
            (p) => html`
              <sl-option value="${p.path}">${p.name || p.path.split('/').pop()} — ${p.path}</sl-option>
            `,
          )}
        </sl-select>
        <span class="settings-field-hint">Choose 2+ registered projects. Fleet runs apply one work-request to each, isolated per repo.</span>
      </div>
    </div>
  `;
}

function _workRequestSection({ rerender } = {}) {
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Work Request</h3>
      <sl-tab-group
        class="fleet-launcher-wr-tabs"
        @sl-tab-show=${
          rerender
            ? (e) => {
                promptTab = e.detail.name;
                rerender();
              }
            : null
        }
      >
        <sl-tab slot="nav" panel="prompt" ?active=${promptTab === 'prompt'}>Prompt</sl-tab>
        <sl-tab slot="nav" panel="source" ?active=${promptTab === 'source'}>Source</sl-tab>
        <sl-tab-panel name="prompt">
          <div class="settings-field">
            <label class="settings-label">Prompt</label>
            <sl-textarea
              class="textarea-fleet-prompt"
              rows="6"
              placeholder="Describe the change to apply across all selected projects…"
              value="${prompt}"
              @sl-input=${
                rerender
                  ? (e) => {
                      prompt = e.target.value;
                      rerender();
                    }
                  : null
              }
            ></sl-textarea>
            <span class="settings-field-hint">Plain-text description sent to every child's Planner / Coordinator / Implementer.</span>
          </div>
        </sl-tab-panel>
        <sl-tab-panel name="source">
          <div class="settings-field">
            <label class="settings-label">Source reference</label>
            <sl-input
              class="input-fleet-source"
              placeholder="gh:issue:123 or path/to/spec.md"
              value="${source}"
              @sl-input=${
                rerender
                  ? (e) => {
                      source = e.target.value;
                      rerender();
                    }
                  : null
              }
            ></sl-input>
            <span class="settings-field-hint">GitHub issue reference (gh:issue:N) or spec file path resolved relative to each project root.</span>
          </div>
        </sl-tab-panel>
      </sl-tab-group>
    </div>
  `;
}

function _guideSection({ rerender, guideCapBytes } = {}) {
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Reference Guide</h3>
      <div class="settings-field">
        <label class="settings-label">Optional normative material</label>
        ${guideUploadWidget(
          { guides },
          {
            maxBytes: guideCapBytes,
            onChange: rerender
              ? (ev) => {
                  if (ev.type === 'add-files') {
                    for (const f of ev.files) {
                      guides = [
                        ...guides,
                        { name: f.name, size: f.size, file: f },
                      ];
                    }
                  } else if (ev.type === 'remove-file') {
                    guides = guides.filter((_, i) => i !== ev.index);
                  }
                  rerender();
                }
              : undefined,
          },
        )}
        <span class="settings-field-hint">Attached guides are pinned to every stage's user message and treated as authoritative over the prompt.</span>
      </div>
    </div>
  `;
}

function _branchesSection({ rerender } = {}) {
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Branches</h3>
      <div class="new-run-grid">
        <div class="settings-field">
          <label class="settings-label">Head branch template</label>
          ${headTemplateInput(
            { headTemplate },
            {
              selectedProjects,
              onChange: rerender
                ? (ev) => {
                    if (ev.type === 'set-head-template')
                      headTemplate = ev.value;
                    rerender();
                  }
                : undefined,
            },
          )}
          <span class="settings-field-hint">Placeholders: <code>{project}</code>, <code>{fleet_id}</code>, <code>{slug}</code>, <code>{yyyymmdd}</code>, <code>{yyyymmddhhmm}</code>.</span>
        </div>
        <div class="settings-field">
          <label class="settings-label">PR base branch</label>
          <sl-input
            class="input-base-branch"
            placeholder="main"
            value="${baseBranch}"
            @sl-change=${
              rerender
                ? async (e) => {
                    baseBranch = e.target.value.trim();
                    baseBranchError = null;
                    if (baseBranch && selectedProjects.length > 0) {
                      baseBranchValidating = true;
                      rerender();
                      try {
                        const resp = await fetch(
                          '/api/fleet-runs/validate-base',
                          {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              projects: selectedProjects,
                              base_branch: baseBranch,
                            }),
                          },
                        );
                        const data = await resp.json();
                        baseBranchError =
                          !data.ok && data.missing_in?.length
                            ? { missing_in: data.missing_in }
                            : null;
                      } catch {
                        // ignore network errors — non-blocking
                      } finally {
                        baseBranchValidating = false;
                        rerender();
                      }
                    } else {
                      rerender();
                    }
                  }
                : null
            }
          ></sl-input>
          <span class="settings-field-hint">Branch the worktrees fork from and PRs target. Leave blank to use each repo's default.</span>
          ${
            baseBranchValidating
              ? html`<div class="base-branch-validating"><sl-spinner></sl-spinner> Checking…</div>`
              : nothing
          }
          ${
            baseBranchError?.missing_in?.length
              ? html`
                <div class="base-branch-error">
                  Branch not found in:
                  <ul class="base-branch-missing-list">
                    ${baseBranchError.missing_in.map(
                      (p) => html`<li>${p.split('/').pop() || p}</li>`,
                    )}
                  </ul>
                </div>
              `
              : nothing
          }
        </div>
      </div>
    </div>
  `;
}

function _planSection({ rerender } = {}) {
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Plan Mode</h3>
      <div class="settings-field">
        <label class="settings-label">Planning strategy</label>
        ${planModeRadio(
          { planMode, planPath, planFirstProject, selectedProjects },
          {
            onChange: rerender
              ? (ev) => {
                  if (ev.type === 'set-plan-mode') planMode = ev.value;
                  else if (ev.type === 'set-plan-path') planPath = ev.value;
                  else if (ev.type === 'set-plan-first-project')
                    planFirstProject = ev.value;
                  rerender();
                }
              : undefined,
          },
        )}
        <span class="settings-field-hint">Independent: each project runs its own Planner. Use existing plan: every child skips planning. Plan-first: one reference project plans, others adopt it.</span>
      </div>
    </div>
  `;
}

function _advancedSection({ rerender } = {}) {
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Advanced</h3>
      <sl-details class="fleet-launcher-advanced">
        <span slot="summary">Concurrency &amp; failure handling</span>
        <div class="new-run-grid">
          <div class="settings-field">
            <label class="settings-label">Max parallel runs</label>
            <sl-input
              class="input-max-parallel"
              size="small"
              type="number"
              min="1"
              max="20"
              value="${maxParallel}"
              @sl-input=${
                rerender
                  ? (e) => {
                      maxParallel = Number(e.target.value) || 5;
                      rerender();
                    }
                  : null
              }
            ></sl-input>
            <span class="settings-field-hint">Maximum concurrent child pipelines. Higher = faster but more API spend.</span>
          </div>
          <div class="settings-field">
            <label class="settings-label">Circuit-breaker threshold: ${Math.round(failureThreshold * 100)}%</label>
            <sl-range
              class="input-failure-threshold"
              min="0"
              max="1"
              step="0.05"
              value="${failureThreshold}"
              @sl-input=${
                rerender
                  ? (e) => {
                      failureThreshold = Number(e.target.value);
                      rerender();
                    }
                  : null
              }
            ></sl-range>
            <span class="settings-field-hint">Failure ratio that halts unstarted children after at least 3 have completed.</span>
          </div>
        </div>
      </sl-details>
    </div>
  `;
}

// ── main view ────────────────────────────────────────────────────────────────

export function fleetLauncherView(appState, { rerender, onNavigate } = {}) {
  const appProjects = appState?.projects || [];
  const guideCapBytes = resolveGuideCap(appState);

  const guidesTotalBytes = guides.reduce((s, g) => s + (g.size || 0), 0);
  const overGuideCap = guidesTotalBytes > guideCapBytes;
  const hasPrompt =
    promptTab === 'prompt'
      ? prompt.trim().length > 0
      : source.trim().length > 0;
  const hasCollision = _detectCollision(headTemplate, selectedProjects);
  const hasBaseBranchError = (baseBranchError?.missing_in?.length ?? 0) > 0;

  const canLaunch =
    selectedProjects.length > 0 &&
    hasPrompt &&
    !hasCollision &&
    !hasBaseBranchError &&
    !overGuideCap;

  async function handleEstimate() {
    tokenEstimating = true;
    if (rerender) rerender();
    try {
      const resp = await fetch('/api/fleet-runs/estimate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          guide_bytes: guidesTotalBytes,
          projects: selectedProjects,
        }),
      });
      const data = await resp.json();
      if (data.ok) {
        tokenEstimate = data;
        tokenConfirmed = false;
      }
    } catch {
      // non-blocking
    } finally {
      tokenEstimating = false;
      if (rerender) rerender();
    }
  }

  async function handleLaunch(ev) {
    if (ev?.type === 'confirm') {
      tokenConfirmed = ev.confirmed;
      if (rerender) rerender();
      return;
    }

    submitStatus = 'submitting';
    if (rerender) rerender();

    try {
      const formData = new FormData();
      formData.append('projects', JSON.stringify(selectedProjects));
      if (promptTab === 'prompt') {
        formData.append('prompt', prompt);
      } else {
        formData.append('source', source);
      }
      if (headTemplate) formData.append('head_template', headTemplate);
      if (baseBranch) formData.append('base_branch', baseBranch);
      formData.append('plan_mode', planMode);
      if (planMode === 'explicit' && planPath)
        formData.append('plan', planPath);
      formData.append('max_parallel', String(maxParallel));
      formData.append('fleet_failure_threshold', String(failureThreshold));
      for (const g of guides) {
        if (g.file) formData.append('guide_files', g.file, g.name);
      }

      const resp = await fetch('/api/fleet-runs', {
        method: 'POST',
        body: formData,
      });
      const data = await resp.json();

      if (data.ok && data.fleet_id) {
        submitStatus = null;
        if (onNavigate) onNavigate('fleet-runs', data.fleet_id);
      } else {
        submitStatus = 'error';
        submitError = data.error || 'Launch failed';
        if (rerender) rerender();
      }
    } catch (err) {
      submitStatus = 'error';
      submitError = err.message || 'Network error';
      if (rerender) rerender();
    }
  }

  return html`
    <div class="new-run-page fleet-launcher-page">
      ${
        submitStatus === 'error'
          ? html`<div class="new-run-error">${submitError}</div>`
          : nothing
      }
      <div class="new-run-form">
        ${_projectsSection(appProjects, { rerender })}
        ${_workRequestSection({ rerender })}
        ${_guideSection({ rerender, guideCapBytes })}
        ${_branchesSection({ rerender })}
        ${_planSection({ rerender })}
        ${_advancedSection({ rerender })}

        <div class="new-run-section fleet-launcher-launch-section">
          <h3 class="new-run-section-title">Launch</h3>
          ${tokenOverheadGate(
            { tokenEstimate, tokenEstimating, tokenConfirmed },
            {
              onEstimate: handleEstimate,
              onLaunch: handleLaunch,
              threshold: TOKEN_THRESHOLD,
              canLaunch,
            },
          )}
        </div>
      </div>
    </div>
  `;
}
