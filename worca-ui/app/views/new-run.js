import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { helpFor } from '../utils/help-links.js';
import { FileText, iconSvg } from '../utils/icons.js';
import { statusDotClass } from '../utils/status-badge.js';
import { getDefaults } from './settings.js';
import { projectStatus } from './sidebar.js';

// Module-level state
export let sourceType = 'none';
export let submitStatus = null; // null | 'submitting' | 'error'
export let submitError = '';
export let planFiles = null; // cached response
export let planFilter = '';
export let planDropdownOpen = false;
export let selectedPlan = '';
export let branches = null; // null = not fetched, [] = fetched but empty
export let selectedBranch = ''; // empty = new branch
export let templates = null; // null = not fetched
export let selectedTemplate = 'default'; // 'default' = worca.default_template (if set) or raw settings.json
export let defaultTemplateId = ''; // worca.default_template from project settings ('' = unset)
export let prBaseBranch = '';
export let prBaseBranchError = '';
export let selectedProject = null; // project picked in All Projects mode
export let projectEditable = false; // Change link toggles read-only → editable
export let maxBeads = 0; // 0 = Auto (no cap)

// Dismissable worktree info banner — persisted via localStorage
export let bannerDismissed = (() => {
  try {
    return localStorage.getItem('worca.worktree-banner-dismissed') === '1';
  } catch {
    return false;
  }
})();

/**
 * Reset module state for testing or re-initialization.
 */
export function invalidateTemplateCache() {
  templates = null;
  defaultTemplateId = '';
}

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
  defaultTemplateId = overrides.defaultTemplateId ?? '';
  if ('templates' in overrides) templates = overrides.templates;
  selectedProject = overrides.selectedProject ?? null;
  projectEditable = overrides.projectEditable ?? false;
  if ('bannerDismissed' in overrides)
    bannerDismissed = overrides.bannerDismissed;
  if ('planDropdownOpen' in overrides)
    planDropdownOpen = overrides.planDropdownOpen;
  if ('branches' in overrides) branches = overrides.branches;
  maxBeads = overrides.maxBeads ?? 0;
}

export function seedMaxBeadsFromTemplate(templateId) {
  const tmpl = (templates || []).find((t) => t.id === templateId);
  maxBeads = tmpl?.config?.agents?.coordinator?.max_beads ?? 0;
}

function sourceLabel(type) {
  if (type === 'source') return 'GitHub Issue URL';
  if (type === 'spec') return 'Spec File Path';
  if (type === 'pr') return 'GitHub PR URL or Number';
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
      if (data.ok) {
        templates = data.templates;

        // The /templates response also carries the project's
        // `default_template` pointer (added so the Pipeline Templates
        // page doesn't flicker between renders). Pick it up here too
        // so the launcher's "default" option is correctly annotated
        // even before the separate /settings round-trip lands.
        // Accept both the legacy bare-string form and the new
        // `{tier, id}` object form.
        const rawDefault = data.default_template;
        const bundledId =
          typeof rawDefault === 'string'
            ? rawDefault
            : rawDefault && typeof rawDefault === 'object'
              ? rawDefault.id || ''
              : '';
        if (bundledId) {
          defaultTemplateId = bundledId;
        }

        // Auto-select the default template if it's present in the templates list
        if (defaultTemplateId) {
          const found = templates.find((t) => t.id === defaultTemplateId);
          if (found && selectedTemplate === 'default') {
            selectedTemplate = defaultTemplateId;
          }
        }

        // Seed maxBeads from the currently selected template's config
        seedMaxBeadsFromTemplate(selectedTemplate);
      }
      return templates || [];
    })
    .catch(() => {
      templates = [];
      return [];
    });
}

// Phase 1: fetch the project's worca.default_template so the "default" option
// in the dropdown can name what will actually run when no explicit template
// is picked at launch.
function fetchDefaultTemplate(projectId) {
  const url = projectId
    ? `/api/projects/${projectId}/settings`
    : '/api/settings';
  return fetch(url)
    .then((r) => r.json())
    .then((data) => {
      // Accept both forms: legacy bare-string `"bugfix"` and the
      // new structured `{tier: "project", id: "bugfix"}` shape.
      const raw = data?.worca?.default_template;
      defaultTemplateId =
        typeof raw === 'string'
          ? raw
          : raw && typeof raw === 'object'
            ? raw.id || ''
            : '';

      // Auto-select the default template if it's present in the templates list
      if (defaultTemplateId && templates) {
        const found = templates.find((t) => t.id === defaultTemplateId);
        if (found && selectedTemplate === 'default') {
          selectedTemplate = defaultTemplateId;
        }
      }

      return defaultTemplateId;
    })
    .catch(() => {
      defaultTemplateId = '';
      return '';
    });
}

// Build the label for the "default" dropdown option. With Phase 1 in play,
// picking this option does not always mean "raw settings.json" — if
// worca.default_template is set, the runtime resolves it and applies that
// template instead. Show the resolved template name so users know.
export function defaultOptionLabel() {
  if (!defaultTemplateId) {
    return 'No template (raw settings.json)';
  }
  const tmpl = (templates || []).find((t) => t.id === defaultTemplateId);
  const name = tmpl ? tmpl.name || tmpl.id : `${defaultTemplateId} (missing)`;
  return `★ Default template: ${name}`;
}

function templatesByTier() {
  // Tier names are `project`, `user`, `builtin` (was `worca` in an
  // earlier iteration of the resolver; the bucket name was never
  // updated, so anything with `tier: "builtin"` was silently dropped
  // and the "Built-in" group never rendered in the launcher).
  const result = { builtin: [], project: [], user: [] };
  for (const t of templates || []) {
    const tier = t.tier === 'worca' ? 'builtin' : t.tier;
    if (result[tier]) result[tier].push(t);
  }
  return result;
}

export function getNewRunSubmitState(appState) {
  const effectiveCurrentProject =
    !projectEditable && appState?.currentProjectId;
  const noProject =
    appState?.hasProjects && !selectedProject && !effectiveCurrentProject;
  return {
    submitStatus,
    isSubmitting: submitStatus === 'submitting',
    noProject: !!noProject,
  };
}

export function getEffectiveProjectId(state) {
  if (selectedProject) return selectedProject;
  if (!projectEditable && state.currentProjectId) return state.currentProjectId;
  return null;
}

export async function submitNewRun({
  rerender,
  onStarted,
  projectId,
  hasProjects,
}) {
  if (hasProjects && !projectId) {
    submitStatus = 'error';
    submitError = 'Please select a project.';
    rerender();
    return;
  }

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

  const maxBeadsEl = document.getElementById('new-run-max-beads');
  const msize = msizeEl ? parseInt(msizeEl.value, 10) || 1 : 1;
  const mloops = mloopsEl ? parseInt(mloopsEl.value, 10) || 1 : 1;
  const maxBeadsValue = maxBeadsEl
    ? parseInt(maxBeadsEl.value, 10) || 0
    : maxBeads;

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
      maxBeads: maxBeadsValue,
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
      if (projectId) {
        try {
          localStorage.setItem('worca.lastLaunchedProject', projectId);
        } catch {}
      }
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
  const atCapacity = isAtCapacity(_state);

  // Seed selectedProject from localStorage in All Projects mode
  if (
    !_state.currentProjectId &&
    !selectedProject &&
    _state.projects?.length > 0
  ) {
    try {
      const last = localStorage.getItem('worca.lastLaunchedProject');
      if (last && _state.projects.some((p) => p.name === last)) {
        selectedProject = last;
      }
    } catch {}
  }

  const effectiveId = getEffectiveProjectId(_state);

  function handleSourceTypeChange(e) {
    sourceType = e.target.value;
    rerender();
  }

  function handleProjectChange(e) {
    selectedProject = e.target.value || null;
    branches = null;
    templates = null;
    defaultTemplateId = '';
    planFiles = null;
    const newId = selectedProject;
    if (newId) {
      fetchBranches(newId).then(() => rerender());
      fetchTemplates(newId).then(() => rerender());
      fetchDefaultTemplate(newId).then(() => rerender());
    }
    rerender();
  }

  function handleProjectChangeLink(e) {
    e.preventDefault();
    projectEditable = true;
    selectedProject = _state.currentProjectId;
    rerender();
  }

  // Reset caches when effective project changes (before fetchBranches updates _lastProjectId)
  if (_lastProjectId !== effectiveId) {
    templates = null;
  }

  // Fetch branches once (null = not yet fetched, or project changed)
  if (branches === null || _lastProjectId !== effectiveId) {
    fetchBranches(effectiveId).then(() => rerender());
  }

  // Fetch templates once
  if (templates === null) {
    fetchTemplates(effectiveId).then(() => rerender());
    fetchDefaultTemplate(effectiveId).then(() => rerender());
  }

  function handleTemplateChange(e) {
    selectedTemplate = e.target.value;
    seedMaxBeadsFromTemplate(selectedTemplate);
    rerender();
  }

  function handleBranchChange(e) {
    selectedBranch = e.target.value;
    rerender();
  }

  function handleMaxBeadsChange(e) {
    // Persist the choice to module state so a rerender (async branch/template
    // fetch resolving before submit) doesn't snap the select back to the
    // template-seeded value via the `value=${String(maxBeads)}` binding.
    maxBeads = parseInt(e.target.value, 10) || 0;
    rerender();
  }

  function handlePlanFocus() {
    fetchPlanFiles(effectiveId).then(() => {
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
        ${helpFor('launching')}
        <!-- Section 0: Project -->
        ${
          _state.projects && _state.projects.length > 0
            ? html`
          <div class="new-run-section new-run-project-section">
            <h3 class="new-run-section-title">Project</h3>
            ${
              _state.currentProjectId && !projectEditable
                ? html`
                <div class="project-readonly">
                  <span>${_state.currentProjectId}</span>
                  <a class="project-change-link" href="#" @click=${handleProjectChangeLink}>Change</a>
                </div>
                <span class="settings-field-hint">Pipeline will run against this project's <code>.claude/worca/</code> runtime.</span>
              `
                : html`
                <div class="settings-field">
                  <sl-select id="new-run-project" placeholder="Select a project..." value=${selectedProject || ''} @sl-change=${handleProjectChange}>
                    ${_state.projects.map((p) => {
                      const pStatus = projectStatus(
                        p.name,
                        _state.runs,
                        _state.currentProjectId,
                      );
                      const dotClass = statusDotClass(pStatus);
                      return html`
                        <sl-option value=${p.name}>
                          <span class="project-option-label">
                            <span class="project-status-dot ${dotClass}"></span>
                            ${p.name}
                          </span>
                        </sl-option>
                      `;
                    })}
                  </sl-select>
                  <span class="settings-field-hint">Pipeline will run against this project's <code>.claude/worca/</code> runtime.</span>
                </div>
              `
            }
          </div>
        `
            : nothing
        }

        <!-- Section 1: Work Source -->
        <div class="new-run-section">
          <h3 class="new-run-section-title">Work Source</h3>
          <div class="settings-field">
            <label class="settings-label">Source Type</label>
            <sl-select id="new-run-source-type" value=${sourceType} @sl-change=${handleSourceTypeChange}>
              <sl-option value="none">Prompt</sl-option>
              <sl-option value="source">GitHub Issue</sl-option>
              <sl-option value="spec">Spec File</sl-option>
              <sl-option value="pr">GitHub PR</sl-option>
            </sl-select>
          </div>

          ${
            sourceType !== 'none'
              ? html`
            <div class="settings-field">
              <label class="settings-label">${sourceLabel(sourceType)}</label>
              <sl-input id="new-run-source-value" placeholder=${sourceType === 'source' ? 'https://github.com/...' : sourceType === 'pr' ? 'gh:pr:123 or https://github.com/owner/repo/pull/123' : 'path/to/spec.md'}></sl-input>
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
                <sl-option value="default">${defaultOptionLabel()}</sl-option>
                ${
                  tiers.user.length > 0
                    ? html`
                  <sl-divider></sl-divider>
                  <small class="template-group-label">USER</small>
                  ${tiers.user.map(
                    (
                      t,
                    ) => html`<sl-option class="template-grouped" value=${t.id}>
                    ${t.name}${t.id === defaultTemplateId ? html` ★` : nothing}
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
                    ${t.name}${t.id === defaultTemplateId ? html` ★` : nothing}
                    ${t.description ? html`<span slot="suffix">${t.description}</span>` : nothing}
                  </sl-option>`,
                  )}
                `
                    : nothing
                }
                ${
                  tiers.builtin.length > 0
                    ? html`
                  <sl-divider></sl-divider>
                  <small class="template-group-label">BUILT-IN</small>
                  ${tiers.builtin.map(
                    (
                      t,
                    ) => html`<sl-option class="template-grouped" value=${t.id}>
                    ${t.name}${t.id === defaultTemplateId ? html` ★` : nothing}
                    ${t.description ? html`<span slot="suffix">${t.description}</span>` : nothing}
                  </sl-option>`,
                  )}
                `
                    : nothing
                }
              </sl-select>
              <span class="settings-field-hint">Customize stages and agent behavior. Groups: user, project, built-in.</span>
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

              <div class="settings-field">
                <label class="settings-label">Max Beads</label>
                <sl-select id="new-run-max-beads" value=${String(maxBeads)} @sl-change=${handleMaxBeadsChange}>
                  <sl-option value="0">Auto</sl-option>
                  ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(
                    (n) => html`<sl-option value=${String(n)}>${n}</sl-option>`,
                  )}
                </sl-select>
                <span class="settings-field-hint">Cap on coordinator beads (0 = no cap)</span>
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
