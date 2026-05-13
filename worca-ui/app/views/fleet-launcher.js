import { html, nothing } from 'lit-html';
import {
  guideUploadWidget,
  headTemplateInput,
  planModeRadio,
  tokenOverheadGate,
} from './launcher-shared.js';
import { isAtCapacity } from './new-run.js';

const GUIDE_CAP_BYTES_DEFAULT = 128 * 1024; // matches src/worca/settings.json + GUIDE_MAX_BYTES_DEFAULT in work_request.py

function resolveGuideCap(appState) {
  return (
    appState?.preferences?.worca?.guide?.max_bytes ?? GUIDE_CAP_BYTES_DEFAULT
  );
}
const TOKEN_THRESHOLD = 1_000_000;

// ── module-level form state ─────────────────────────────────────────────────
//
// Naming mirrors `new-run.js` so the two launcher pages share vocabulary:
// `sourceType` (none|source|spec) drives whether a source value is shown,
// `sourceValue` holds the GitHub/spec reference, `prompt` is always
// available, and `planFile` is the optional plan-file path that maps to
// the API's `plan_mode='explicit'` shortcut.

let selectedProjects = [];
let projectFilter = '';
let sourceType = 'none';
let sourceValue = '';
let prompt = '';
let planFile = '';
let guides = [];
let headTemplate = 'migration/{slug}/{project}';
let baseBranch = '';
let baseBranchError = null;
let baseBranchValidating = false;
// `planMode` is only consulted when `planFile` is empty — it picks the
// fleet-specific per-child planning strategy ('none' = independent,
// 'plan-first' = one project plans, others adopt). When `planFile` is set
// the launch handler overrides the wire value to 'explicit'.
let planMode = 'none';
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
  sourceType = overrides.sourceType ?? 'none';
  sourceValue = overrides.sourceValue ?? '';
  prompt = overrides.prompt ?? '';
  planFile = overrides.planFile ?? '';
  guides = overrides.guides ?? [];
  headTemplate = overrides.headTemplate ?? 'migration/{slug}/{project}';
  baseBranch = overrides.baseBranch ?? '';
  baseBranchError = overrides.baseBranchError ?? null;
  baseBranchValidating = overrides.baseBranchValidating ?? false;
  planMode = overrides.planMode ?? 'none';
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

function _sourceLabel(type) {
  if (type === 'source') return 'GitHub Issue or Bead';
  if (type === 'spec') return 'Spec File';
  return '';
}

function _hasSource() {
  return sourceType !== 'none' && sourceValue.trim().length > 0;
}

function _canLaunch() {
  const guidesTotalBytes = guides.reduce((s, g) => s + (g.size || 0), 0);
  // guideCapBytes resolved at view time; submit-state callers pass it via
  // appState through getFleetLauncherSubmitState — see below.
  return (
    selectedProjects.length > 0 &&
    (prompt.trim().length > 0 || _hasSource()) &&
    !_detectCollision(headTemplate, selectedProjects) &&
    !((baseBranchError?.missing_in?.length ?? 0) > 0) &&
    guidesTotalBytes <= GUIDE_CAP_BYTES_DEFAULT
  );
}

// ── exported submit-state used by main.js for the page-header button ─────

export function getFleetLauncherSubmitState() {
  return {
    submitStatus,
    isSubmitting: submitStatus === 'submitting',
    canLaunch: _canLaunch(),
  };
}

export async function estimateFleetTokens({ rerender } = {}) {
  const guidesTotalBytes = guides.reduce((s, g) => s + (g.size || 0), 0);
  tokenEstimating = true;
  rerender?.();
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
    rerender?.();
  }
}

export async function submitFleetLauncher({ rerender, onStarted } = {}) {
  // Validation parity with new-run.js: a Source Type other than "None"
  // requires a value; otherwise prompt or source is required.
  if (sourceType !== 'none' && !sourceValue.trim()) {
    submitStatus = 'error';
    submitError = `Please enter a ${_sourceLabel(sourceType).toLowerCase()}.`;
    rerender?.();
    return;
  }
  if (!prompt.trim() && !_hasSource()) {
    submitStatus = 'error';
    submitError = 'Please provide at least one of: a work source, or a prompt.';
    rerender?.();
    return;
  }
  if (selectedProjects.length === 0) {
    submitStatus = 'error';
    submitError = 'Please select at least one project.';
    rerender?.();
    return;
  }
  if (_detectCollision(headTemplate, selectedProjects)) {
    submitStatus = 'error';
    submitError =
      'Head branch template resolves to the same name across projects. Add {project} for uniqueness.';
    rerender?.();
    return;
  }

  // Above-threshold launches require a confirmation checkbox tick.
  if (
    tokenEstimate &&
    tokenEstimate.total_overhead_est > TOKEN_THRESHOLD &&
    !tokenConfirmed
  ) {
    submitStatus = 'error';
    submitError =
      'Estimated overhead exceeds the threshold — tick the confirmation in the Token Overhead Estimate section, or rerun the estimate after reducing scope.';
    rerender?.();
    return;
  }

  submitStatus = 'submitting';
  submitError = '';
  rerender?.();

  try {
    const formData = new FormData();
    formData.append('projects', JSON.stringify(selectedProjects));
    if (prompt.trim()) formData.append('prompt', prompt);
    if (_hasSource()) formData.append('source', sourceValue);
    if (headTemplate) formData.append('head_template', headTemplate);
    if (baseBranch) formData.append('base_branch', baseBranch);
    // Plan File overrides Plan Mode — when set, every child skips planning.
    const wirePlanMode = planFile ? 'explicit' : planMode;
    formData.append('plan_mode', wirePlanMode);
    if (wirePlanMode === 'explicit' && planFile)
      formData.append('plan', planFile);
    if (wirePlanMode === 'plan-first' && planFirstProject)
      formData.append('plan_first', planFirstProject);
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
      onStarted?.(data.fleet_id);
    } else {
      submitStatus = 'error';
      submitError = data.error || 'Launch failed';
      rerender?.();
    }
  } catch (err) {
    submitStatus = 'error';
    submitError = err.message || 'Network error';
    rerender?.();
  }
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

// Mirrors `new-run.js` "Work Source" section: Source Type select +
// optional Source value + Plan File. Same vocabulary so users moving
// between the two launchers don't have to learn two mental models.
function _workSourceSection({ rerender } = {}) {
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Work Source</h3>
      <div class="settings-field">
        <label class="settings-label">Source Type</label>
        <sl-select
          class="select-fleet-source-type"
          value=${sourceType}
          @sl-change=${
            rerender
              ? (e) => {
                  sourceType = e.target.value;
                  rerender();
                }
              : null
          }
        >
          <sl-option value="none">None</sl-option>
          <sl-option value="source">GitHub Issue</sl-option>
          <sl-option value="spec">Spec File</sl-option>
        </sl-select>
      </div>
      ${
        sourceType !== 'none'
          ? html`
            <div class="settings-field">
              <label class="settings-label">${_sourceLabel(sourceType)}</label>
              <sl-input
                class="input-fleet-source"
                placeholder=${sourceType === 'source' ? 'gh:issue:123 or https://github.com/…' : 'path/to/spec.md'}
                value="${sourceValue}"
                @sl-input=${
                  rerender
                    ? (e) => {
                        sourceValue = e.target.value;
                        rerender();
                      }
                    : null
                }
              ></sl-input>
              <span class="settings-field-hint">${sourceType === 'source' ? 'GitHub issue reference or bead id resolved per project.' : 'Path resolved relative to each project root.'}</span>
            </div>
          `
          : nothing
      }
      <div class="settings-field">
        <label class="settings-label">Plan File (optional)</label>
        <sl-input
          class="input-fleet-plan-file"
          placeholder="docs/plans/W-NNN-short-description.md"
          value="${planFile}"
          @sl-input=${
            rerender
              ? (e) => {
                  planFile = e.target.value;
                  rerender();
                }
              : null
          }
        ></sl-input>
        <span class="settings-field-hint">Skips per-child planning when set. Path resolved relative to each project root.</span>
      </div>
    </div>
  `;
}

function _promptSection({ rerender } = {}) {
  const promptLabel = _hasSource()
    ? 'Additional Instructions (optional)'
    : 'Prompt (required)';
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Prompt</h3>
      <div class="settings-field">
        <label class="settings-label">${promptLabel}</label>
        <sl-textarea
          class="textarea-fleet-prompt"
          rows="8"
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
      </div>
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

function _advancedSection({ rerender } = {}) {
  // Plan-mode controls only matter when there's no Plan File set — a
  // file overrides the per-child strategy with `explicit` at submit time.
  const showPlanModeRadio = !planFile;
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Advanced Options</h3>
      <div class="new-run-advanced">
        <div class="settings-field">
          <label class="settings-label">PR base branch (optional)</label>
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
                        // non-blocking
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

        ${
          showPlanModeRadio
            ? html`
              <div class="settings-field">
                <label class="settings-label">Per-project planning strategy</label>
                ${planModeRadio(
                  {
                    planMode,
                    planPath: '',
                    planFirstProject,
                    selectedProjects,
                  },
                  {
                    options: [
                      { value: 'none', label: 'Independent plans (default)' },
                      {
                        value: 'plan-first',
                        label: 'Plan-first reference project',
                      },
                    ],
                    onChange: rerender
                      ? (ev) => {
                          if (ev.type === 'set-plan-mode') planMode = ev.value;
                          else if (ev.type === 'set-plan-first-project')
                            planFirstProject = ev.value;
                          rerender();
                        }
                      : undefined,
                  },
                )}
                <span class="settings-field-hint">Independent: each project runs its own Planner. Plan-first: one reference project plans, others adopt it. Set a Plan File above to skip planning entirely.</span>
              </div>
            `
            : nothing
        }

        <div class="new-run-grid">
          <div class="settings-field">
            <label class="settings-label">Max parallel runs</label>
            <sl-input
              class="input-max-parallel"
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
      </div>
    </div>
  `;
}

function _tokenEstimateSection({ rerender } = {}) {
  // Inline Launch button is suppressed — submit lives in the page header
  // (mirrors the new-run page's "Start" pattern).
  return html`
    <div class="new-run-section fleet-launcher-token-section">
      <h3 class="new-run-section-title">Token Overhead Estimate</h3>
      ${tokenOverheadGate(
        { tokenEstimate, tokenEstimating, tokenConfirmed },
        {
          onEstimate: () => estimateFleetTokens({ rerender }),
          onLaunch: (ev) => {
            if (ev?.type === 'confirm') {
              tokenConfirmed = ev.confirmed;
              rerender?.();
            }
          },
          threshold: TOKEN_THRESHOLD,
          inlineLaunch: false,
        },
      )}
    </div>
  `;
}

// ── main view ────────────────────────────────────────────────────────────────

export function fleetLauncherView(appState, { rerender } = {}) {
  const appProjects = appState?.projects || [];
  const guideCapBytes = resolveGuideCap(appState);
  const atCapacity = isAtCapacity(appState);

  return html`
    <div class="new-run-page fleet-launcher-page">
      ${
        atCapacity
          ? html`
            <sl-alert variant="warning" open class="capacity-warning">
              Pipeline limit reached — ${appState?.totalRunning ?? 0} of ${appState?.maxConcurrentPipelines ?? 10} slots in use. Stop a running pipeline or increase the limit in Settings.
            </sl-alert>
          `
          : nothing
      }
      ${
        submitStatus === 'error'
          ? html`<div class="new-run-error">${submitError}</div>`
          : nothing
      }
      <div class="new-run-form">
        ${_projectsSection(appProjects, { rerender })}
        ${_workSourceSection({ rerender })}
        ${_promptSection({ rerender })}
        ${_guideSection({ rerender, guideCapBytes })}
        ${_advancedSection({ rerender })}
        ${_tokenEstimateSection({ rerender })}
      </div>
    </div>
  `;
}
