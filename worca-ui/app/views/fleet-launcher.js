import { html, nothing } from 'lit-html';
import {
  guideUploadWidget,
  headTemplateInput,
  planModeRadio,
  tokenOverheadGate,
} from './launcher-shared.js';

const GUIDE_CAP_BYTES = 64 * 1024;
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
    // simplified date fill for collision check
    branch = branch.replace(/\{yyyymmddhhmm\}/g, '202605120900');
    branch = branch.replace(/\{yyyymmdd\}/g, '20260512');
    if (seen.has(branch)) return true;
    seen.add(branch);
  }
  return false;
}

// ── sub-views ────────────────────────────────────────────────────────────────

function _projectSelectView(appProjects, { rerender } = {}) {
  const filtered = appProjects.filter((p) => {
    if (!projectFilter) return true;
    const q = projectFilter.toLowerCase();
    return (
      (p.name || '').toLowerCase().includes(q) ||
      (p.path || '').toLowerCase().includes(q)
    );
  });

  return html`
    <div class="fleet-launcher-section">
      <label class="fleet-launcher-label">Projects</label>
      <div class="project-select-controls">
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
        value="${selectedProjects.join(' ')}"
        @sl-change=${
          rerender
            ? (e) => {
                selectedProjects = e.target.value
                  ? e.target.value.split(' ').filter(Boolean)
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
    </div>
  `;
}

function _workRequestView({ rerender } = {}) {
  return html`
    <div class="fleet-launcher-section">
      <label class="fleet-launcher-label">Work Request</label>
      <div class="work-request-tabs">
        <button
          class="tab-btn tab-prompt${promptTab === 'prompt' ? ' active' : ''}"
          @click=${
            rerender
              ? () => {
                  promptTab = 'prompt';
                  rerender();
                }
              : null
          }
        >Prompt</button>
        <button
          class="tab-btn tab-source${promptTab === 'source' ? ' active' : ''}"
          @click=${
            rerender
              ? () => {
                  promptTab = 'source';
                  rerender();
                }
              : null
          }
        >Source</button>
      </div>
      ${
        promptTab === 'prompt'
          ? html`
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
          `
          : html`
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
          `
      }
    </div>
  `;
}

function _guideSection({ rerender } = {}) {
  return html`
    <div class="fleet-launcher-section">
      <label class="fleet-launcher-label">Guide (optional)</label>
      ${guideUploadWidget(
        { guides },
        {
          maxBytes: GUIDE_CAP_BYTES,
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
    </div>
  `;
}

function _branchSection({ rerender } = {}) {
  return html`
    <div class="fleet-launcher-section fleet-launcher-branches">
      <div class="branch-field">
        ${headTemplateInput(
          { headTemplate },
          {
            selectedProjects,
            onChange: rerender
              ? (ev) => {
                  if (ev.type === 'set-head-template') headTemplate = ev.value;
                  rerender();
                }
              : undefined,
          },
        )}
      </div>
      <div class="branch-field">
        <sl-input
          class="input-base-branch"
          label="PR base branch"
          value="${baseBranch}"
          placeholder="main"
          help-text="Branch the worktrees fork from and PRs target. Leave blank to use each repo's default branch."
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
  `;
}

function _planSection({ rerender } = {}) {
  return html`
    <div class="fleet-launcher-section">
      <label class="fleet-launcher-label">Plan mode</label>
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
    </div>
  `;
}

function _advancedSection({ rerender } = {}) {
  return html`
    <sl-details class="fleet-launcher-advanced">
      <span slot="summary">Advanced options</span>
      <div class="advanced-fields">
        <sl-input
          class="input-max-parallel"
          label="Max parallel runs"
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
        <div class="advanced-field-group">
          <label class="field-label">Circuit-breaker threshold: ${Math.round(failureThreshold * 100)}%</label>
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
        </div>
      </div>
    </sl-details>
  `;
}

// ── main view ────────────────────────────────────────────────────────────────

export function fleetLauncherView(appState, { rerender, onNavigate } = {}) {
  const appProjects = appState?.projects || [];

  const guidesTotalBytes = guides.reduce((s, g) => s + (g.size || 0), 0);
  const overGuideCap = guidesTotalBytes > GUIDE_CAP_BYTES;
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
        if (onNavigate) onNavigate(`#/fleet-runs/${data.fleet_id}`);
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
    <div class="fleet-launcher-view">
      <h2 class="fleet-launcher-heading">New Fleet Run</h2>

      ${_projectSelectView(appProjects, { rerender })}
      ${_workRequestView({ rerender })}
      ${_guideSection({ rerender })}
      ${_branchSection({ rerender })}
      ${_planSection({ rerender })}
      ${_advancedSection({ rerender })}

      ${
        submitStatus === 'error'
          ? html`
            <sl-alert variant="danger" open class="fleet-launch-error">
              ${submitError}
            </sl-alert>
          `
          : nothing
      }

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
  `;
}
