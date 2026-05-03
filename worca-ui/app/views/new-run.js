import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { FileText, iconSvg } from '../utils/icons.js';
import { getDefaults } from './settings.js';

// Module-level state
let sourceType = 'none';
let submitStatus = null; // null | 'submitting' | 'error'
let submitError = '';
let planFiles = null; // cached response
let planFilter = '';
let planDropdownOpen = false;
let selectedPlan = '';
let branches = null; // null = not fetched, [] = fetched but empty
let selectedBranch = ''; // empty = new branch
let templates = null; // null = not fetched
let selectedTemplate = 'default'; // 'default' = built-in worca pipeline
let prBaseBranch = '';
let prBaseBranchError = '';

// Dismissable worktree info banner — persisted via localStorage
let bannerDismissed = (() => {
  try {
    return localStorage.getItem('worca.worktree-banner-dismissed') === '1';
  } catch {
    return false;
  }
})();

/**
 * Reset module state for testing or re-initialization.
 */
export function resetNewRunState(overrides = {}) {
  sourceType = overrides.sourceType ?? 'none';
  submitStatus = null;
  submitError = '';
  selectedPlan = overrides.selectedPlan ?? '';
  planFilter = overrides.selectedPlan ?? '';
  selectedBranch = '';
  prBaseBranch = overrides.prBaseBranch ?? '';
  prBaseBranchError = overrides.prBaseBranchError ?? '';
  selectedTemplate = overrides.selectedTemplate ?? 'default';
  if ('bannerDismissed' in overrides)
    bannerDismissed = overrides.bannerDismissed;
}

function sourceLabel(type) {
  if (type === 'source') return 'GitHub Issue URL';
  if (type === 'spec') return 'Spec File Path';
  return '';
}

let _lastProjectId = null; // track project switches to invalidate cache

function fetchBranches(projectId) {
  if (branches !== null && _lastProjectId === projectId)
    return Promise.resolve(branches);
  _lastProjectId = projectId;
  const url = projectId
    ? `/api/projects/${projectId}/branches`
    : '/api/branches';
  return fetch(url)
    .then((r) => r.json())
    .then((data) => {
      branches = (data.ok && data.branches) || [];
      return branches;
    })
    .catch(() => {
      branches = [];
      return [];
    });
}

function fetchPlanFiles(projectId) {
  if (planFiles && _lastProjectId === projectId)
    return Promise.resolve(planFiles);
  const url = projectId
    ? `/api/projects/${projectId}/plan-files`
    : '/api/plan-files';
  return fetch(url)
    .then((r) => r.json())
    .then((data) => {
      if (data.ok) planFiles = data.files;
      return planFiles || [];
    })
    .catch(() => []);
}

function filteredPlanFiles() {
  if (!planFiles) return [];
  if (!planFilter) return planFiles;
  const term = planFilter.toLowerCase();
  return planFiles.filter(
    (f) =>
      f.name.toLowerCase().includes(term) ||
      f.path.toLowerCase().includes(term),
  );
}

function groupedPlanFiles(files) {
  const groups = {};
  for (const f of files) {
    if (!groups[f.dir]) groups[f.dir] = [];
    groups[f.dir].push(f);
  }
  return groups;
}

function fetchTemplates(projectId) {
  if (templates !== null && _lastProjectId === projectId)
    return Promise.resolve(templates);
  const url = projectId
    ? `/api/projects/${projectId}/templates`
    : '/api/templates';
  return fetch(url)
    .then((r) => r.json())
    .then((data) => {
      if (data.ok) templates = data.templates;
      return templates || [];
    })
    .catch(() => {
      templates = [];
      return [];
    });
}

function templatesByTier() {
  const result = { worca: [], project: [], user: [] };
  for (const t of templates || []) {
    const tier = t.tier;
    if (result[tier]) result[tier].push(t);
  }
  return result;
}

export function getNewRunSubmitState() {
  return { submitStatus, isSubmitting: submitStatus === 'submitting' };
}

export async function submitNewRun({ rerender, onStarted, projectId }) {
  const sourceValueEl = document.getElementById('new-run-source-value');
  const promptEl = document.getElementById('new-run-prompt');
  const msizeEl = document.getElementById('new-run-msize');
  const mloopsEl = document.getElementById('new-run-mloops');

  const sourceValue = sourceValueEl?.value?.trim() || '';
  const promptValue = promptEl?.value?.trim() || '';

  const hasSource = sourceType !== 'none' && sourceValue.length > 0;
  const hasPlan = !!selectedPlan;
  const hasPrompt = promptValue.length > 0;

  // Validation: sourceType requires a sourceValue
  if (sourceType !== 'none' && !sourceValue) {
    submitStatus = 'error';
    submitError = `Please enter a ${sourceLabel(sourceType).toLowerCase()}.`;
    rerender();
    return;
  }

  // Validation: at least one of source, plan, or prompt required
  if (!hasSource && !hasPlan && !hasPrompt) {
    submitStatus = 'error';
    submitError =
      'Please provide at least one of: a work source, a plan file, or a prompt.';
    rerender();
    return;
  }

  const msize = msizeEl ? parseInt(msizeEl.value, 10) || 1 : 1;
  const mloops = mloopsEl ? parseInt(mloopsEl.value, 10) || 1 : 1;

  const PR_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;
  if (prBaseBranch && !PR_BRANCH_RE.test(prBaseBranch)) {
    submitStatus = 'error';
    submitError = 'PR base branch contains invalid characters.';
    rerender();
    return;
  }

  submitStatus = 'submitting';
  submitError = '';
  rerender();

  try {
    const body = {
      sourceType,
      msize: Math.max(1, Math.min(10, msize)),
      mloops: Math.max(1, Math.min(10, mloops)),
    };
    if (hasSource) body.sourceValue = sourceValue;
    if (hasPrompt) body.prompt = promptValue;
    if (hasPlan) body.planFile = selectedPlan;
    if (prBaseBranch) body.branch = prBaseBranch;
    else if (selectedBranch) body.branch = selectedBranch;
    if (selectedTemplate && selectedTemplate !== 'default')
      body.template = selectedTemplate;

    const url = projectId ? `/api/projects/${projectId}/runs` : '/api/runs';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (res.status === 409 && data.code === 'max_concurrent_exceeded') {
      submitStatus = 'error';
      submitError = data.error || 'Concurrent pipeline limit reached.';
      rerender();
      return;
    }
    if (data.ok) {
      submitStatus = null;
      // Don't call refreshRuns() here — the Python process hasn't written
      // status files yet, so discoverRuns() returns stale data that wipes
      // state.runs. The 'run-started' WS event + its 2s retry handles it.
      onStarted();
    } else {
      submitStatus = 'error';
      submitError = data.error || 'Failed to start pipeline';
      rerender();
    }
  } catch (err) {
    submitStatus = 'error';
    submitError = err.message || 'Network error';
    rerender();
  }
}

/**
 * Check if any pipeline is currently active (running).
 */
export function hasActivePipeline(state) {
  const runs = state?.runs;
  if (!runs) return false;
  return Object.values(runs).some((r) => r.active === true);
}

export function isAtCapacity(state) {
  const cap = state?.maxConcurrentPipelines ?? 10;
  const running = state?.totalRunning ?? 0;
  return running >= cap;
}

export function newRunView(_state, { rerender }) {
  const projectId = _state.currentProjectId || null;
  const atCapacity = isAtCapacity(_state);

  function handleSourceTypeChange(e) {
    sourceType = e.target.value;
    rerender();
  }

  // Reset caches when project changes (before fetchBranches updates _lastProjectId)
  if (_lastProjectId !== projectId) {
    templates = null;
  }

  // Fetch branches once (null = not yet fetched, or project changed)
  if (branches === null || _lastProjectId !== projectId) {
    fetchBranches(projectId).then(() => rerender());
  }

  // Fetch templates once
  if (templates === null) {
    fetchTemplates(projectId).then(() => rerender());
  }

  function handleTemplateChange(e) {
    selectedTemplate = e.target.value;
    rerender();
  }

  function handleBranchChange(e) {
    selectedBranch = e.target.value;
    rerender();
  }

  function handlePlanFocus() {
    fetchPlanFiles(projectId).then(() => {
      planDropdownOpen = true;
      rerender();
    });
  }

  function handlePlanInput(e) {
    planFilter = e.target.value;
    selectedPlan = '';
    planDropdownOpen = true;
    rerender();
  }

  function handlePlanBlur() {
    // Delay to allow click events on dropdown items
    setTimeout(() => {
      planDropdownOpen = false;
      rerender();
    }, 200);
  }

  function handlePlanSelect(file) {
    selectedPlan = file.path;
    planFilter = file.path;
    planDropdownOpen = false;
    rerender();
  }

  function handlePlanClear() {
    selectedPlan = '';
    planFilter = '';
    rerender();
  }

  function handleBannerDismiss() {
    bannerDismissed = true;
    try {
      localStorage.setItem('worca.worktree-banner-dismissed', '1');
    } catch {}
    rerender();
  }

  const PR_BRANCH_RE = /^[a-zA-Z0-9._/-]+$/;
  function handlePrBaseBranchInput(e) {
    prBaseBranch = e.target.value;
    prBaseBranchError =
      prBaseBranch && !PR_BRANCH_RE.test(prBaseBranch)
        ? 'Invalid characters. Use letters, numbers, dots, hyphens, underscores, or slashes.'
        : '';
    rerender();
  }

  const filtered = filteredPlanFiles();
  const grouped = groupedPlanFiles(filtered);

  const hasSource = sourceType !== 'none';
  const hasPlan = !!selectedPlan;
  const promptRequired = !hasSource && !hasPlan;
  const promptLabel = promptRequired
    ? 'Prompt (required)'
    : 'Additional Instructions (optional)';

  return html`
    <div class="new-run-page">
      ${
        bannerDismissed
          ? nothing
          : html`
        <sl-alert variant="primary" open closable @sl-after-hide=${handleBannerDismiss}>
          Each pipeline now runs in its own git worktree — parallel runs no longer collide on the working tree.
        </sl-alert>
      `
      }
      ${
        atCapacity
          ? html`
        <sl-alert variant="warning" open class="capacity-warning">
          Pipeline limit reached — ${_state.totalRunning ?? 0} of ${_state.maxConcurrentPipelines ?? 10} slots in use. Stop a running pipeline or increase the limit in Settings.
        </sl-alert>
      `
          : nothing
      }
      ${submitStatus === 'error' ? html`<div class="new-run-error">${submitError}</div>` : nothing}

      <div class="new-run-form">
        <!-- Section 1: Work Source -->
        <div class="new-run-section">
          <h3 class="new-run-section-title">Work Source</h3>
          <div class="settings-field">
            <label class="settings-label">Source Type</label>
            <sl-select id="new-run-source-type" value=${sourceType} @sl-change=${handleSourceTypeChange}>
              <sl-option value="none">None</sl-option>
              <sl-option value="source">GitHub Issue</sl-option>
              <sl-option value="spec">Spec File</sl-option>
            </sl-select>
          </div>

          ${
            sourceType !== 'none'
              ? html`
            <div class="settings-field">
              <label class="settings-label">${sourceLabel(sourceType)}</label>
              <sl-input id="new-run-source-value" placeholder=${sourceType === 'source' ? 'https://github.com/...' : 'path/to/spec.md'}></sl-input>
            </div>
          `
              : nothing
          }

          <div class="settings-field">
            <label class="settings-label">Plan File (optional)</label>
            <div class="plan-autocomplete">
              <sl-input
                id="new-run-plan"
                placeholder="Type to search plan files..."
                .value=${planFilter}
                @sl-input=${handlePlanInput}
                @sl-focus=${handlePlanFocus}
                @sl-blur=${handlePlanBlur}
                clearable
                @sl-clear=${handlePlanClear}
              >
                <span slot="prefix">${unsafeHTML(iconSvg(FileText, 14))}</span>
              </sl-input>
              ${
                planDropdownOpen && filtered.length > 0
                  ? html`
                <div class="plan-dropdown">
                  ${Object.entries(grouped).map(
                    ([dir, files]) => html`
                    <div class="plan-group-header">${dir}/</div>
                    ${files.map(
                      (f) => html`
                      <div class="plan-item" @mousedown=${() => handlePlanSelect(f)}>
                        ${f.name}
                      </div>
                    `,
                    )}
                  `,
                  )}
                </div>
              `
                  : nothing
              }
            </div>
            <span class="settings-field-hint">Skips the planning stage. Relative to project root.</span>
          </div>
        </div>

        <!-- Section 2: Pipeline -->
        ${(() => {
          const tiers = templatesByTier();
          return html`
          <div class="new-run-section">
            <h3 class="new-run-section-title">Pipeline</h3>
            <div class="settings-field">
              <label class="settings-label">Pipeline Template</label>
              <sl-select value=${selectedTemplate} @sl-change=${handleTemplateChange}>
                <sl-option value="default">Project Default (settings.json)</sl-option>
                ${
                  tiers.worca.length > 0
                    ? html`
                  <sl-divider></sl-divider>
                  <small class="template-group-label">WORCA</small>
                  ${tiers.worca.map(
                    (
                      t,
                    ) => html`<sl-option class="template-grouped" value=${t.id}>
                    ${t.name}
                    ${t.description ? html`<span slot="suffix">${t.description}</span>` : nothing}
                  </sl-option>`,
                  )}
                `
                    : nothing
                }
                ${
                  tiers.project.length > 0
                    ? html`
                  <sl-divider></sl-divider>
                  <small class="template-group-label">PROJECT</small>
                  ${tiers.project.map(
                    (
                      t,
                    ) => html`<sl-option class="template-grouped" value=${t.id}>
                    ${t.name}
                    ${t.description ? html`<span slot="suffix">${t.description}</span>` : nothing}
                  </sl-option>`,
                  )}
                `
                    : nothing
                }
                ${
                  tiers.user.length > 0
                    ? html`
                  <sl-divider></sl-divider>
                  <small class="template-group-label">USER</small>
                  ${tiers.user.map(
                    (
                      t,
                    ) => html`<sl-option class="template-grouped" value=${t.id}>
                    ${t.name}
                    ${t.description ? html`<span slot="suffix">${t.description}</span>` : nothing}
                  </sl-option>`,
                  )}
                `
                    : nothing
                }
              </sl-select>
              <span class="settings-field-hint">Customize stages and agent behavior. Groups: worca (built-in), project, user.</span>
              ${(() => {
                const sel = (templates || []).find(
                  (t) => t.id === selectedTemplate,
                );
                return sel?.description
                  ? html`<div class="template-description"><strong>Selected template:</strong><br>${sel.description}</div>`
                  : nothing;
              })()}
            </div>
          </div>
        `;
        })()}

        <!-- Section 3: Prompt -->
        <div class="new-run-section">
          <h3 class="new-run-section-title">Prompt</h3>
          <div class="settings-field">
            <label class="settings-label">${promptLabel}</label>
            <sl-textarea id="new-run-prompt" rows="8" placeholder="Describe what the pipeline should do..."></sl-textarea>
          </div>
        </div>

        <!-- Section 3: Advanced Options -->
        <div class="new-run-section">
          <h3 class="new-run-section-title">Advanced Options</h3>
          <div class="new-run-advanced">
            <div class="settings-field">
              <label class="settings-label">PR base branch (optional)</label>
              <sl-input
                id="new-run-pr-base-branch"
                placeholder="main"
                .value=${prBaseBranch}
                @sl-input=${handlePrBaseBranchInput}
              ></sl-input>
              <span class="settings-field-hint">Branch the worktree forks from and the PR will target. Defaults to repo's default branch.</span>
              ${prBaseBranchError ? html`<span class="settings-field-error">${prBaseBranchError}</span>` : nothing}
            </div>

            <div class="new-run-grid">
              <div class="settings-field">
                <label class="settings-label">Size Multiplier (msize)</label>
                <sl-input id="new-run-msize" type="number" min="1" max="10" value="${getDefaults().msize}"></sl-input>
                <span class="settings-field-hint">Scales max_turns per stage (1-10)</span>
              </div>

              <div class="settings-field">
                <label class="settings-label">Loop Multiplier (mloops)</label>
                <sl-input id="new-run-mloops" type="number" min="1" max="10" value="${getDefaults().mloops}"></sl-input>
                <span class="settings-field-hint">Scales max loop iterations (1-10)</span>
              </div>
            </div>

            <div class="settings-field">
              <label class="settings-label">Branch</label>
              <sl-select value=${selectedBranch} @sl-change=${handleBranchChange}>
                <sl-option value="">&lt;New branch&gt;</sl-option>
                ${(branches || []).map(
                  (b) => html`
                  <sl-option value=${b}>${b}</sl-option>
                `,
                )}
              </sl-select>
              <span class="settings-field-hint">Use an existing branch instead of creating a new one</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
