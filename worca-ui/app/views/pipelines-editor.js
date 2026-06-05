/**
 * Pipelines editor view — structured form editor for template configuration.
 *
 * Sections:
 * - Stages — toggle list of every stage with agent picker
 * - Agents — matrix of model/max_turns/effort per agent
 * - Loops — max iteration inputs
 * - Circuit breaker — enabled toggle and max failures
 * - Governance dispatch — per-agent allowlists for tools/skills/subagents
 * - JSON power-user toggle — raw JSON editor with bidirectional sync
 * - Diff vs built-in — for project/user templates with built-in counterpart
 *
 * Route: /pipelines/:tid/edit
 */

import { html, nothing } from 'lit-html';
import { ifDefined } from 'lit-html/directives/if-defined.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { DISPATCH_DEFAULTS } from '../../server/dispatch-defaults.js';
import { helpFor } from '../utils/help-links.js';
import {
  CircleCheck,
  FileText,
  iconSvg,
  RefreshCw,
  Save,
  Settings,
  Shield,
  Users,
  Workflow,
  Zap,
} from '../utils/icons.js';
import {
  diffSummary,
  diffTemplateConfig,
  formatDiffValue,
  getDiffLabel,
  shadowsBuiltin,
} from '../utils/templates.js';
import { AGENT_NAMES } from './agent-names.js';
import { dispatchSectionView } from './dispatch-section.js';
import { overlaysTabView } from './pipelines-editor-overlays.js';
import {
  AUTO_MODES,
  getModelKeys,
  PLAN_REVIEW_ENFORCE_OPTIONS,
  STAGE_AGENT_MAP,
} from './settings.js';

// --- Editor state and validation ---

let editorState = {
  templateId: null,
  tier: null, // 'project' | 'user' | 'builtin' — primary-key half along with templateId
  // Mutable name field — separate from template.name so the user can edit
  // it inline; id stays in templateId. `nameDirty` / `idDirty` track
  // whether the user has manually touched a field, so the Create flow's
  // auto-slug only fires until the user takes manual control.
  nameDraft: '',
  descriptionDraft: '',
  idDraft: '',
  idDirty: false,
  template: null, // { id, name, description, tags, config, params, tier }
  builtinTemplate: null, // Built-in template config for diff view (id exists in builtin tier)
  loading: true,
  error: null,
  saving: false,
  saveMessage: '',
  validationIssues: [],
  // Sync mode: 'form' | 'json' | 'diff'
  viewMode: 'form',
  // Form edit buffer
  formBuffer: null, // deep clone of config on init, accumulates edits
  // JSON edit buffer
  jsonBuffer: '',
  // Diff state
  diffData: null, // Computed diff result
  loadingBuiltin: false,
  // Track if this is a new template (create) or existing (update)
  isNewTemplate: false,
  // Overlays: fetched once on tab activation; null = not yet loaded
  overlays: null,
  overlaysLoaded: false,
  overlaysLoading: false,
};

// Stored rerender callback from pipelinesEditorView — used by async background
// operations (overlay probe, builtin diff) that complete after loadTemplate.
let _rerenderFn = null;

// Debounce timer for validation
let validateDebounceTimer = null;
const VALIDATE_DEBOUNCE_MS = 300;

/**
 * Initialize editor state for a template.
 * Exported so main.js can proactively fetch during navigation.
 */
export function initEditorState() {
  editorState = {
    templateId: null,
    tier: null,
    nameDraft: '',
    descriptionDraft: '',
    idDraft: '',
    idDirty: false,
    template: null,
    builtinTemplate: null,
    loading: true,
    error: null,
    saving: false,
    saveMessage: '',
    validationIssues: [],
    viewMode: 'form',
    formBuffer: null,
    jsonBuffer: '',
    diffData: null,
    loadingBuiltin: false,
    isNewTemplate: false,
    overlays: null,
    overlaysLoaded: false,
    overlaysLoading: false,
  };
  dispatchEditState = { tools: {}, skills: {}, subagents: {} };
  return editorState;
}

/**
 * Access the editor state object (for main.js integration).
 */
export { editorState };

/**
 * Get the current editor state.
 * Exported as a function for main.js integration.
 */
export function getEditorState() {
  return editorState;
}

/**
 * Cleanup editor state on route change.
 */
export function cleanupEditorState() {
  initEditorState();
}

// Default values for form fields
const DEFAULT_MODEL_KEYS = ['opus', 'sonnet', 'haiku'];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

// Stage configuration defaults
const DEFAULT_STAGES = {
  preflight: { agent: 'none', enabled: true },
  plan: { agent: 'planner', enabled: true },
  plan_review: { agent: 'plan_reviewer', enabled: false },
  coordinate: { agent: 'coordinator', enabled: true },
  implement: { agent: 'implementer', enabled: true },
  test: { agent: 'tester', enabled: true },
  review: { agent: 'reviewer', enabled: true },
  pr: { agent: 'guardian', enabled: true },
  learn: { agent: 'learner', enabled: false },
};

// Loop defaults
const DEFAULT_LOOPS = {
  implement_test: 0,
  pr_changes: 0,
  restart_planning: 0,
};

// Circuit breaker defaults
const DEFAULT_CIRCUIT_BREAKER = {
  enabled: true,
  max_consecutive_failures: 3,
};

// Governance defaults — `guards` keys are only here for legacy form
// hydration; they're cross-template (project-owned) and the
// editor never reads or writes them. test_gate_strikes,
// plan_review_enforce, and dispatch ARE template-owned and edited
// in this surface.
const DEFAULT_GOVERNANCE = {
  guards: {
    block_rm_rf: true,
    block_env_write: true,
    block_force_push: true,
    restrict_git_commit: true,
  },
  test_gate_strikes: 2,
  plan_review_enforce: 'auto',
  dispatch: {
    tools: { ...DISPATCH_DEFAULTS.tools },
    skills: { ...DISPATCH_DEFAULTS.skills },
    subagents: { ...DISPATCH_DEFAULTS.subagents },
  },
};

// --- Helper functions ---

/**
 * Deep clone a value, handling undefined/null gracefully.
 */
function deepClone(val) {
  if (val === undefined || val === null) return null;
  return JSON.parse(JSON.stringify(val));
}

/**
 * Get model keys from settings or fall back to built-in list.
 */
function getModelOptions(worca) {
  return getModelKeys(worca || {});
}

/**
 * Normalize stage config to match expected shape.
 */
function normalizeStageConfig(stages) {
  const result = { ...DEFAULT_STAGES, ...(stages || {}) };
  for (const stage of Object.keys(DEFAULT_STAGES)) {
    if (!result[stage]) {
      result[stage] = {
        enabled: false,
        agent: STAGE_AGENT_MAP[stage] || 'none',
      };
    } else {
      result[stage].enabled ??= true;
      result[stage].agent ??= STAGE_AGENT_MAP[stage] || 'none';
    }
  }
  return result;
}

/**
 * Merge template config with built-in defaults for form editing.
 *
 * Exported for tests; lives here so the test surface mirrors the
 * editor's actual entry/exit points.
 */
export function buildFormBuffer(templateConfig, settings) {
  const config = templateConfig || {};
  const form = {};

  // Stages
  form.stages = normalizeStageConfig(config.stages);

  // Agents — stash the original per-agent map so unknown keys
  // (anything beyond model/max_turns/effort) survive the
  // round-trip. formBufferToConfig overlays edited fields on top
  // of _original on save.
  form.agents = {};
  for (const name of AGENT_NAMES) {
    const agentConfig = config.agents?.[name] || {};
    form.agents[name] = {
      _original: { ...agentConfig },
      model: agentConfig.model || 'sonnet',
      max_turns: agentConfig.max_turns || 30,
      effort: agentConfig.effort || null,
    };
  }

  // Loops
  form.loops = { ...DEFAULT_LOOPS, ...(config.loops || {}) };

  // Circuit breaker
  form.circuit_breaker = {
    ...DEFAULT_CIRCUIT_BREAKER,
    ...(config.circuit_breaker || {}),
  };

  // Effort (auto_mode + auto_cap). Seed from the template so the
  // Agents tab dropdowns show the saved value rather than the
  // generic 'adaptive' / 'xhigh' fallback — without this, opening
  // an `auto_mode: disabled` template and touching anything in
  // the Agents tab silently overwrites the template back to
  // 'adaptive' on save.
  form.effort = { ...(config.effort || {}) };

  // Governance — display-time merge of project defaults so the
  // user sees the effective dispatch. The original template
  // dispatch is stashed under _templateOriginalDispatch and a
  // per-section dirty flag tracks user edits; formBufferToConfig
  // emits only template-original + dirty sections, never the
  // project's snapshot.
  form.governance = deepMergeGovernance(
    config.governance,
    settings?.worca?.governance,
  );
  form._templateOriginalDispatch =
    deepClone(config.governance?.dispatch || {}) || {};
  form._dispatchDirty = { tools: false, skills: false, subagents: false };

  // Approval gates — milestones is template-owned. Defaults match
  // the server-side defaults (plan approval required, PR approval
  // off).
  form.milestones = {
    plan_approval: true,
    pr_approval: false,
    ...(config.milestones || {}),
  };

  return form;
}

/**
 * Deep merge governance config with defaults.
 *
 * `dispatch` is rebuilt per-section by buildDisplayDispatch — the
 * remaining keys (guards, test_gate_strikes, plan_review_enforce)
 * fall back to project defaults then the shipped defaults.
 */
function deepMergeGovernance(gov, defaultGov) {
  const guards = {
    ...DEFAULT_GOVERNANCE.guards,
    ...(defaultGov?.guards || {}),
    ...(gov?.guards || {}),
  };

  return {
    guards,
    test_gate_strikes:
      gov?.test_gate_strikes ?? defaultGov?.test_gate_strikes ?? 2,
    plan_review_enforce:
      gov?.plan_review_enforce ?? defaultGov?.plan_review_enforce ?? 'auto',
    dispatch: buildDisplayDispatch(gov?.dispatch),
  };
}

/**
 * Build the per-section dispatch view the editor form binds to.
 *
 * The result is keyed by section (tools / skills / subagents) — the
 * shape `_governanceSection` reads via `dispatch[section]`. Each
 * section's deny tiers (Always Disallowed / Default Denied) are seeded
 * from the SHIPPED floor (DISPATCH_DEFAULTS) so the user can see and
 * edit them even when the template overrides nothing; per_agent_allow
 * carries the template's OWN entries (per-agent display fallback to the
 * defaults happens inside dispatchSectionView).
 *
 * The project's own governance.dispatch is intentionally NOT used as the
 * floor — templates are portable, so the baseline is the shipped default
 * every project inherits, never the current project's tweaks. (An
 * earlier version merged the whole `{tools,skills,subagents}` object as
 * if it were a single tier-set, which collapsed every section to an
 * empty view and silently dropped per_agent_allow on save.)
 */
function buildDisplayDispatch(templateDispatch) {
  const out = {};
  for (const section of ['tools', 'skills', 'subagents']) {
    const t = templateDispatch?.[section] || {};
    const d = DISPATCH_DEFAULTS[section] || {};
    out[section] = {
      always_disallowed: [
        ...(t.always_disallowed ?? d.always_disallowed ?? []),
      ],
      default_denied: [...(t.default_denied ?? d.default_denied ?? [])],
      per_agent_allow: { ...(t.per_agent_allow || {}) },
    };
  }
  return out;
}

/**
 * Order-insensitive membership equality for two string lists.
 */
function _sameMembers(a, b) {
  const aa = a || [];
  const bb = b || [];
  if (aa.length !== bb.length) return false;
  const seen = new Set(bb);
  return aa.every((x) => seen.has(x));
}

/**
 * Strip deny-tier entries that exactly match the shipped DISPATCH_DEFAULTS
 * so a template only persists genuinely-customized tiers. Without this,
 * any edit to a section (even just a per_agent_allow tweak) would freeze
 * the shipped Always Disallowed / Default Denied lists into the template,
 * so a future change to the shipped floor would never reach it.
 */
function _cleanSectionForWrite(section, cfg) {
  const d = DISPATCH_DEFAULTS[section] || {};
  const out = {};
  if (
    cfg.always_disallowed !== undefined &&
    !_sameMembers(cfg.always_disallowed, d.always_disallowed)
  ) {
    out.always_disallowed = cfg.always_disallowed;
  }
  if (
    cfg.default_denied !== undefined &&
    !_sameMembers(cfg.default_denied, d.default_denied)
  ) {
    out.default_denied = cfg.default_denied;
  }
  if (cfg.per_agent_allow && Object.keys(cfg.per_agent_allow).length > 0) {
    out.per_agent_allow = cfg.per_agent_allow;
  }
  return out;
}

/**
 * Convert form buffer back to template config shape.
 *
 * Exported for tests; the round-trip (buildFormBuffer →
 * formBufferToConfig) is the contract the W-062 editor must
 * preserve, so it's worth exercising directly.
 */
export function formBufferToConfig(formBuffer) {
  const config = {};

  // Stages
  config.stages = {};
  for (const [stage, stageConfig] of Object.entries(formBuffer.stages || {})) {
    config.stages[stage] = {
      enabled: stageConfig.enabled,
      agent: stageConfig.agent,
    };
    // Skip mode for plan_review unless it's set (matches Python-side handling)
    if (stage === 'plan_review' && stageConfig.mode) {
      config.stages[stage].mode = stageConfig.mode;
    }
  }

  // Agents — overlay edited fields on top of the original per-agent
  // map so unknown keys (anything beyond model/max_turns/effort)
  // survive round-trip. Without _original, any new key added to the
  // template's agent block would be silently dropped on save.
  config.agents = {};
  for (const name of AGENT_NAMES) {
    const agent = formBuffer.agents[name] || {};
    const merged = {
      ...(agent._original || {}),
      model: agent.model,
      max_turns: agent.max_turns,
    };
    if (agent.effort) {
      merged.effort = agent.effort;
    } else {
      // User explicitly cleared effort — don't carry the original
      // value through.
      delete merged.effort;
    }
    config.agents[name] = merged;
  }

  // Loops
  config.loops = {};
  for (const [key, val] of Object.entries(formBuffer.loops || DEFAULT_LOOPS)) {
    if (val && val > 0) {
      config.loops[key] = val;
    }
  }

  // Circuit breaker
  config.circuit_breaker = formBuffer.circuit_breaker;

  // Governance — strip cross-template keys (guards) before write so
  // the template doesn't capture the project's hook-gate snapshot.
  // `guards` is NOT in TEMPLATE_OWNED_KEYS (see
  // src/worca/orchestrator/templates.py); it stays cross-template
  // and is edited in Project Settings.
  const { guards: _drop_guards, ...templateOwnedGov } =
    formBuffer.governance || {};
  config.governance = templateOwnedGov;

  // Governance dispatch — write template-original entries for
  // sections the user never touched; write the merged form buffer
  // only for sections marked dirty. This prevents a template from
  // silently capturing the project's dispatch snapshot just because
  // it was opened in the editor.
  const dirty = formBuffer._dispatchDirty || {};
  const original = formBuffer._templateOriginalDispatch || {};
  const mergedDispatch = formBuffer.governance?.dispatch || {};
  const writtenDispatch = {};
  let dispatchHasEntries = false;
  for (const section of ['tools', 'skills', 'subagents']) {
    if (dirty[section]) {
      writtenDispatch[section] = _cleanSectionForWrite(
        section,
        mergedDispatch[section] || {},
      );
      dispatchHasEntries = true;
    } else if (original[section] !== undefined) {
      writtenDispatch[section] = original[section];
      dispatchHasEntries = true;
    }
  }
  if (dispatchHasEntries) {
    config.governance.dispatch = writtenDispatch;
  } else {
    delete config.governance.dispatch;
  }

  // Effort (auto_mode + auto_cap). Only persist if the buffer has
  // either field — empty/default templates skip the key entirely so
  // the Python loader uses its own defaults.
  if (formBuffer.effort && Object.keys(formBuffer.effort).length > 0) {
    config.effort = { ...formBuffer.effort };
  }

  // Milestones (approval gates). Always persist; the template's
  // explicit choice (e.g. pr_approval: false) needs to win over any
  // legacy project-Settings value that might still be on disk.
  if (formBuffer.milestones) {
    config.milestones = { ...formBuffer.milestones };
  }

  return config;
}

/**
 * Validate config against server.
 */
async function validateConfig(projectId, config, settingsPath) {
  try {
    const url = projectId
      ? `/api/projects/${projectId}/templates/validate`
      : '/api/templates/validate';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    const data = await res.json();
    return data.ok
      ? data.issues || []
      : [
          {
            field: '',
            severity: 'error',
            message: data.error || 'Validation failed',
          },
        ];
  } catch (err) {
    return [{ field: '', severity: 'error', message: err.message }];
  }
}

/**
 * Validate config with debouncing (for field blur events).
 * Updates editorState.validationIssues in place.
 */
function validateConfigDebounced(projectId, formBuffer, viewMode, rerender) {
  // Cancel any pending validation
  if (validateDebounceTimer) {
    clearTimeout(validateDebounceTimer);
  }

  // Schedule new validation after debounce period
  validateDebounceTimer = setTimeout(async () => {
    try {
      const config =
        viewMode === 'json'
          ? JSON.parse(editorState.jsonBuffer || '{}')
          : formBufferToConfig(formBuffer);

      const hadIssues = (editorState.validationIssues || []).length > 0;
      const issues = await validateConfig(projectId, config);
      editorState.validationIssues = issues;

      // Rerender if the panel needs to show OR HIDE. Without the
      // `hadIssues` half, the panel would re-render in but never
      // re-render out — a fixed field would leave a stale error
      // visible until the next manual rerender.
      if ((issues.length > 0 || hadIssues) && rerender) {
        rerender();
      }
    } catch (err) {
      // Ignore validation errors during typing/debounce
      console.warn('Validation error (debounced):', err.message);
    }
  }, VALIDATE_DEBOUNCE_MS);
}

/**
 * Show toast notification.
 */
function showToast(message, variant = 'success') {
  const evt = new CustomEvent('worca:toast', {
    bubbles: true,
    detail: { message, variant },
  });
  document.dispatchEvent(evt);
}

/**
 * Slugify a name into a template id (mirrors the helper in main.js so
 * tests can use either; same character class as the server-side
 * validator). Used by the editor's auto-id behavior.
 */
export function slugifyId(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Load a template from the server by (tier, id).
 *
 * The editor is now strict about tiers — every call must specify
 * which copy to load. Built-ins are read-only (the route lets them
 * load; save will 405). Project / user are editable.
 */
export async function loadTemplate(tier, tid, projectId) {
  editorState.loading = true;
  editorState.error = null;
  editorState.templateId = tid;
  editorState.tier = tier;
  editorState.template = null;
  editorState.builtinTemplate = null;
  editorState.diffData = null;
  editorState.overlays = null;
  editorState.overlaysLoaded = false;
  editorState.overlaysLoading = false;
  editorState.idDirty = false;
  editorState.nameDraft = '';
  editorState.descriptionDraft = '';
  editorState.idDraft = tid || '';

  try {
    const url = projectId
      ? `/api/projects/${projectId}/templates/${tier}/${tid}`
      : `/api/templates/${tier}/${tid}`;
    const res = await fetch(url);

    // If template doesn't exist (404), it's a new template being created
    if (res.status === 404 || tid === 'new') {
      editorState.isNewTemplate = true;
      editorState.template = {
        id: tid === 'new' ? '' : tid,
        name: 'New Template',
        description: '',
        tags: [],
        params: {},
        config: {},
      };
      editorState.nameDraft = 'New Template';
      editorState.descriptionDraft = '';
      editorState.idDraft = tid === 'new' ? '' : tid;
      editorState.formBuffer = buildFormBuffer({}, { worca: {} });
      editorState.jsonBuffer = JSON.stringify({}, null, 2);
      editorState.validationIssues = [];
    } else {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed to load template');

      editorState.isNewTemplate = false;
      editorState.template = data.template;
      editorState.nameDraft = data.template.name || tid;
      editorState.descriptionDraft = data.template.description || '';
      editorState.idDraft = data.template.id || tid;
      editorState.formBuffer = buildFormBuffer(data.template.config, {
        worca: data.template,
      });
      editorState.jsonBuffer = JSON.stringify(
        data.template.config || {},
        null,
        2,
      );
      editorState.validationIssues = [];

      // Load built-in template for diff if this template shadows a built-in
      if (shadowsBuiltin(data.template || {}))
        await loadBuiltinTemplate(tid, projectId);

      // Eagerly probe overlays so the Overlays tab appears when ≥1 file exists.
      // Fire-and-forget — result populates editorState.overlays after template
      // load completes; the caller's rerender callback is not available here so
      // the outer loadOverlays rerender will be called separately when needed.
      _probeOverlays(tier, tid, projectId);
    }
  } catch (err) {
    editorState.error = err.message;
  } finally {
    editorState.loading = false;
  }
}

/**
 * Probe overlays during template load (no rerender callback available yet).
 * Stores result in editorState so the Overlays tab can appear on next render.
 */
async function _probeOverlays(tier, tid, projectId) {
  if (editorState.overlaysLoaded || editorState.overlaysLoading) return;
  editorState.overlaysLoading = true;
  try {
    const url = projectId
      ? `/api/projects/${projectId}/templates/${tier}/${tid}/overlays`
      : `/api/templates/${tier}/${tid}/overlays`;
    const res = await fetch(url);
    editorState.overlays = res.ok ? (await res.json()).overlays || {} : {};
  } catch {
    editorState.overlays = {};
  } finally {
    editorState.overlaysLoaded = true;
    editorState.overlaysLoading = false;
    _rerenderFn?.();
  }
}

/**
 * Fetch overlays for a template on first Overlays-tab activation.
 * Result cached in editorState.overlays; subsequent calls are no-ops.
 */
export async function loadOverlays(tier, tid, projectId, rerender) {
  if (editorState.overlaysLoaded || editorState.overlaysLoading) return;
  editorState.overlaysLoading = true;
  rerender?.();
  try {
    const url = projectId
      ? `/api/projects/${projectId}/templates/${tier}/${tid}/overlays`
      : `/api/templates/${tier}/${tid}/overlays`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      editorState.overlays = data.overlays || {};
    } else {
      editorState.overlays = {};
    }
  } catch (err) {
    console.warn('Failed to load overlays:', err);
    editorState.overlays = {};
  } finally {
    editorState.overlaysLoaded = true;
    editorState.overlaysLoading = false;
    rerender?.();
  }
}

/**
 * Load built-in template for diff comparison.
 */
async function loadBuiltinTemplate(tid, projectId) {
  editorState.loadingBuiltin = true;
  try {
    // Try fetching the built-in copy directly (404 is expected when the
    // current id has no built-in counterpart — that's fine, diff just
    // stays unavailable).
    const url = projectId
      ? `/api/projects/${projectId}/templates/builtin/${tid}`
      : `/api/templates/builtin/${tid}`;

    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.template) {
        editorState.builtinTemplate = data.template.config || {};
        // Compute diff on load
        computeDiff();
      }
    }
  } catch (err) {
    // Diff is advisory - fail gracefully if we can't fetch built-in
    console.warn('Failed to load built-in template for diff:', err);
  } finally {
    editorState.loadingBuiltin = false;
  }
}

/**
 * Compute diff between current config and built-in template.
 */
function computeDiff() {
  if (!editorState.builtinTemplate) {
    editorState.diffData = null;
    return;
  }

  const currentConfig =
    editorState.viewMode === 'json'
      ? JSON.parse(editorState.jsonBuffer || '{}')
      : formBufferToConfig(editorState.formBuffer);

  editorState.diffData = diffTemplateConfig(
    currentConfig,
    editorState.builtinTemplate,
  );
}

/**
 * Save the template to the server.
 *
 * Three flows under (tier, id):
 *   - NEW: POST /templates/:tier with body { id, name, … }.
 *   - UPDATE in place (id unchanged): PUT /templates/:tier/:id.
 *   - RENAME (id changed in the editor): POST /templates/:tier/:id/rename,
 *     then PUT the edited body against the new (tier, id). This is two
 *     CLI hops — same partial-rename window as the dialog-based rename.
 */
export async function saveTemplate(tid, tier, projectId, onSaved) {
  if (editorState.saving) return;

  editorState.saving = true;
  editorState.saveMessage = '';

  try {
    const config =
      editorState.viewMode === 'json'
        ? JSON.parse(editorState.jsonBuffer)
        : formBufferToConfig(editorState.formBuffer);

    const issues = await validateConfig(projectId, config);
    editorState.validationIssues = issues;
    if (issues.some((i) => i.severity === 'error')) {
      editorState.saveMessage = 'Validation failed — fix errors before saving';
      editorState.saving = false;
      showToast('Validation failed — fix errors before saving', 'danger');
      return;
    }

    const isNew = editorState.isNewTemplate || tid === 'new';
    const srcTier = editorState.tier || tier || 'project';
    const srcId = tid;
    // The Id field in the editor is the destination id — when it
    // differs from srcId we need to rename before PUT.
    const dstId = (editorState.idDraft || srcId || 'new-template').trim();
    const dstName =
      (editorState.nameDraft || '').trim() ||
      editorState.template?.name ||
      dstId;

    const dstDescription =
      (editorState.descriptionDraft || '').trim() ||
      editorState.template?.description ||
      '';
    const payload = {
      name: dstName,
      description: dstDescription,
      tags: editorState.template?.tags || [],
      params: editorState.template?.params || {},
      config,
    };

    let res;
    if (isNew) {
      res = await fetch(
        projectId
          ? `/api/projects/${projectId}/templates/${srcTier}`
          : `/api/templates/${srcTier}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: dstId, ...payload }),
        },
      );
    } else {
      // If the id changed, atomically rename first so the PUT below
      // can target the new (tier, id) slot.
      if (dstId !== srcId) {
        const renameRes = await fetch(
          projectId
            ? `/api/projects/${projectId}/templates/${srcTier}/${srcId}/rename`
            : `/api/templates/${srcTier}/${srcId}/rename`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dst_tier: srcTier, dst_id: dstId }),
          },
        );
        if (!renameRes.ok) {
          const body = await renameRes.json().catch(() => ({}));
          throw new Error(
            body.error || `Rename failed: HTTP ${renameRes.status}`,
          );
        }
      }
      res = await fetch(
        projectId
          ? `/api/projects/${projectId}/templates/${srcTier}/${dstId}`
          : `/api/templates/${srcTier}/${dstId}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }

    editorState.saveMessage = 'Template saved successfully';
    editorState.isNewTemplate = false;
    // Reflect the post-save canonical id back into the editor.
    editorState.templateId = dstId;
    editorState.idDirty = false;
    editorState.template = {
      ...(editorState.template || {}),
      id: dstId,
      name: dstName,
      description: dstDescription,
    };

    showToast(
      isNew
        ? `Template "${dstName}" created successfully`
        : `Template "${dstName}" updated successfully`,
      'success',
    );
    // Tell the parent the canonical (tier, id) post-save so it can
    // either stay on the editor (toast + same page) or update the
    // URL if the id changed (rename). dstTier === srcTier today —
    // the editor doesn't support tier moves — but we pass both so
    // callers can opt to rename-and-redirect uniformly.
    if (onSaved) {
      onSaved({ newId: dstId, newTier: srcTier });
    }
  } catch (err) {
    editorState.saveMessage = `Failed to save: ${err.message}`;
    editorState.validationIssues.push({
      field: '',
      severity: 'error',
      message: err.message,
    });
    showToast(`Failed to save: ${err.message}`, 'danger');
  } finally {
    editorState.saving = false;
  }
}

/**
 * Cancel editing and navigate back to list.
 */
export function cancelEdit(onCancel) {
  // Cancel any pending validation
  if (validateDebounceTimer) {
    clearTimeout(validateDebounceTimer);
    validateDebounceTimer = null;
  }
  if (onCancel) onCancel();
}

/**
 * Switch between form, JSON, and diff view mode.
 */
function switchViewMode(mode, rerender) {
  if (editorState.viewMode === mode) return;

  if (mode === 'json') {
    // Sync form buffer to JSON
    editorState.jsonBuffer = JSON.stringify(
      formBufferToConfig(editorState.formBuffer),
      null,
      2,
    );
  } else if (mode === 'form') {
    // Sync JSON to form buffer
    try {
      const config = JSON.parse(editorState.jsonBuffer);
      const currentTemplate = editorState.template || {};
      editorState.formBuffer = buildFormBuffer(config, {
        worca: currentTemplate,
      });
    } catch (err) {
      editorState.saveMessage =
        'Invalid JSON — fix before switching to form view';
      return;
    }
  } else if (mode === 'diff') {
    // Sync form buffer to JSON for diff comparison
    editorState.jsonBuffer = JSON.stringify(
      formBufferToConfig(editorState.formBuffer),
      null,
      2,
    );
  } else {
    // Switching from diff - sync json buffer to form
    try {
      editorState.formBuffer = buildFormBuffer(
        JSON.parse(editorState.jsonBuffer || '{}'),
        { worca: editorState.template },
      );
    } catch (err) {
      console.error('Failed to parse JSON when leaving diff view:', err);
      return;
    }
  }

  editorState.viewMode = mode;
  editorState.validationIssues = [];
  editorState.saveMessage = '';

  // Update diff when switching to diff mode or when leaving it
  if (mode === 'diff' && editorState.builtinTemplate) {
    computeDiff();
  }

  rerender();
}

/**
 * Reset a specific config path to its built-in value.
 * Used by the diff view's "Reset" button.
 */
function resetToBuiltin(dottPath, rerender) {
  if (!editorState.builtinTemplate || !dottPath) return;

  const builtinValue = getNestedValue(editorState.builtinTemplate, dottPath);

  if (editorState.viewMode === 'json') {
    // Update JSON buffer by parsing, setting value, and re-stringifying
    try {
      const config = JSON.parse(editorState.jsonBuffer);
      setNestedValue(config, dottPath, builtinValue);
      editorState.jsonBuffer = JSON.stringify(config, null, 2);
      // Sync to form buffer
      editorState.formBuffer = buildFormBuffer(config, {
        worca: editorState.template,
      });
    } catch (err) {
      console.error('Failed to reset value:', err);
      return;
    }
  } else {
    // Update form buffer directly
    setNestedValueInFormBuffer(editorState.formBuffer, dottPath, builtinValue);
  }

  // Recompute diff
  computeDiff();
  rerender();
}

/**
 * Get a nested value from an object using dot notation.
 */
function getNestedValue(obj, path) {
  return path
    .split('.')
    .reduce(
      (acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined),
      obj,
    );
}

/**
 * Set a nested value in an object using dot notation.
 * Creates intermediate objects as needed.
 */
function setNestedValue(obj, path, value) {
  const keys = path.split('.');
  let current = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key]) {
      current[key] = {};
    }
    current = current[key];
  }

  current[keys[keys.length - 1]] = value;
  return obj;
}

/**
 * Set a nested value in the form buffer, being aware of its structure.
 * The form buffer has a specific structure; this handles mapping to it.
 */
function setNestedValueInFormBuffer(formBuffer, path, value) {
  const keys = path.split('.');

  // Map config paths to form buffer structure
  if (keys[0] === 'stages') {
    if (keys[1] && keys[2]) {
      // stages.planner.enabled
      formBuffer.stages = formBuffer.stages || {};
      formBuffer.stages[keys[1]] = formBuffer.stages[keys[1]] || {};
      formBuffer.stages[keys[1]][keys[2]] = value;
    }
  } else if (keys[0] === 'agents') {
    if (keys[1] && keys[2]) {
      // agents.planner.model
      formBuffer.agents = formBuffer.agents || {};
      formBuffer.agents[keys[1]] = formBuffer.agents[keys[1]] || {};
      formBuffer.agents[keys[1]][keys[2]] = value;
    }
  } else if (keys[0] === 'loops') {
    if (keys[1]) {
      // loops.implement_test
      formBuffer.loops = formBuffer.loops || {};
      formBuffer.loops[keys[1]] = value;
    }
  } else if (keys[0] === 'circuit_breaker') {
    if (keys[1]) {
      // circuit_breaker.enabled
      formBuffer.circuit_breaker = formBuffer.circuit_breaker || {};
      formBuffer.circuit_breaker[keys[1]] = value;
    }
  } else if (keys[0] === 'governance') {
    formBuffer.governance = formBuffer.governance || {
      guards: {},
      dispatch: {},
    };
    if (keys[1] === 'guards' && keys[2]) {
      // governance.guards.block_rm_rf
      formBuffer.governance.guards[keys[2]] = value;
    } else if (keys[1] === 'dispatch' && keys[2]) {
      // governance.dispatch.tools.<key>
      formBuffer.governance.dispatch = formBuffer.governance.dispatch || {};
      formBuffer.governance.dispatch[keys[2]] = value;
    }
  }
}

/**
 * Dispatch edit state for governance sections.
 */
let dispatchEditState = {
  tools: {},
  skills: {},
  subagents: {},
};

function resetDispatchEditState() {
  dispatchEditState = { tools: {}, skills: {}, subagents: {} };
}

/**
 * Log lifecycle hook for pipelines editor.
 */
export function logLifecycle(hook, ...args) {
  console.log(`[pipelines-editor] ${hook}`, ...args);
}

// --- Render functions ---

/**
 * Main pipelines editor view.
 * @param {object} state - store state (for settings, etc.)
 * @param {object} options - { tid, projectId, scope, onSaved, onCancel, rerender }
 */
export function pipelinesEditorView(state, options) {
  const {
    tid,
    tier = editorState.tier || 'project',
    projectId,
    onSaved,
    onCancel,
    rerender,
  } = options || {};

  // Store rerender for async background tasks (overlay probe, builtin diff).
  if (rerender) _rerenderFn = rerender;

  const {
    formBuffer,
    template,
    loading,
    error,
    saving,
    saveMessage,
    validationIssues,
    viewMode,
    nameDraft,
    descriptionDraft,
    idDraft,
    idDirty,
  } = editorState;
  const settings = state?.settings || {};
  const hasErrors = validationIssues.some((i) => i.severity === 'error');
  const hasWarnings = validationIssues.some((i) => i.severity === 'warning');

  if (loading) {
    return html`
      <div class="pipelines-editor">
        <div class="editor-subheader">
          <h2 class="editor-subheader-title">Loading template…</h2>
        </div>
        <div class="editor-content">
          <sl-spinner></sl-spinner>
        </div>
      </div>
    `;
  }

  if (error) {
    return html`
      <div class="pipelines-editor">
        <div class="editor-subheader">
          <h2 class="editor-subheader-title">Error</h2>
        </div>
        <div class="editor-content">
          <sl-alert variant="danger" open>
            <strong>Failed to load template</strong>
            ${error}
          </sl-alert>
        </div>
      </div>
    `;
  }

  const tierDisplay = tier.charAt(0).toUpperCase() + tier.slice(1);
  // Built-ins open in the same editor view as project/user templates
  // but every input is disabled and Save is hidden — the user can
  // read the config and JSON, but can't save changes. To actually
  // edit a built-in they hit the explicit Duplicate button on the
  // list card; that creates a project copy and routes here in
  // editable mode.
  const isBuiltinTier = tier === 'builtin';
  const readOnly = isBuiltinTier;

  // ID collision check — mirrors the duplicate/rename dialog's
  // _validateActionDialog so the user sees the same warning here
  // (and the Save button blocks) instead of saving and hitting an
  // error toast from the server. The current template's own
  // (tier, id) is excluded so we don't flag "edit in place" as a
  // collision; only a real conflict against a sibling template
  // counts.
  const allTemplates = state?.templates || [];
  const trimmedIdDraft = (idDraft || '').trim();
  const isNewTemplate = editorState.isNewTemplate || tid === 'new';
  // Source tier+id is the template currently on disk; for new
  // templates there is no "self" yet.
  const srcId = isNewTemplate ? null : tid;
  const idCollision = !!(
    trimmedIdDraft &&
    allTemplates.find(
      (t) =>
        t.id === trimmedIdDraft &&
        t.tier === tier &&
        !(t.id === srcId && t.tier === tier),
    )
  );
  const idHelpText = idCollision
    ? `An id "${trimmedIdDraft}" already exists in the ${tier} scope.`
    : '';

  // When the user starts editing Name or ID, drop server-attached
  // save-error issues (entries with empty `field` — the shape we
  // push in saveTemplate's catch). Without this, an error like
  // "dst_id is required" lingers after the user supplies the
  // missing value; the inline panel would still tell them to fix
  // a field they've already fixed.
  function _clearStaleSaveErrors() {
    if (!editorState.validationIssues?.length) return;
    editorState.validationIssues = editorState.validationIssues.filter(
      (issue) => issue.field !== '' || issue.severity !== 'error',
    );
  }
  const onNameInput = (e) => {
    const newName = e.target.value;
    editorState.nameDraft = newName;
    if (!idDirty) {
      editorState.idDraft = slugifyId(newName);
    }
    _clearStaleSaveErrors();
    rerender();
  };
  const onIdInput = (e) => {
    editorState.idDraft = e.target.value.trim();
    editorState.idDirty = true;
    _clearStaleSaveErrors();
    rerender();
  };

  return html`
    <div class="pipelines-editor">
      <div class="editor-subheader">
        ${helpFor('authoring-templates')}
        <div class="editor-subheader-title-group">
          <sl-tooltip content="Template name">
            <span class="editor-field-pill editor-name-pill">
              <span class="editor-field-pill-label">Name:</span>
              <sl-input
                class="editor-name-input"
                size="small"
                placeholder="Display name"
                .value=${nameDraft || ''}
                ?disabled=${isBuiltinTier}
                @sl-input=${onNameInput}
              ></sl-input>
            </span>
          </sl-tooltip>
          <sl-tooltip content=${idCollision ? idHelpText : 'Template ID'}>
            <span
              class="editor-field-pill editor-id-badge${idCollision ? ' editor-field-pill--invalid' : ''}"
            >
              <span class="editor-field-pill-label">ID:</span>
              <sl-input
                class="editor-id-input"
                size="small"
                placeholder="template-id"
                .value=${idDraft || ''}
                ?disabled=${isBuiltinTier}
                @sl-input=${onIdInput}
              ></sl-input>
            </span>
          </sl-tooltip>
          ${
            idCollision
              ? html`<sl-tooltip content=${idHelpText}>
                  <sl-badge
                    variant="warning"
                    pill
                    class="editor-id-collision-badge"
                    >ID already exists</sl-badge
                  >
                </sl-tooltip>`
              : ''
          }
          <sl-tooltip content="Where this template lives (immutable)">
            <sl-badge
              variant="primary"
              pill
              class="editor-storage-badge"
              >Storage: ${tierDisplay}</sl-badge
            >
          </sl-tooltip>
        </div>
      </div>

      ${
        hasErrors || hasWarnings
          ? html`
        <sl-alert
          variant=${hasErrors ? 'danger' : 'warning'}
          open
          class="editor-validation-alert"
        >
          <strong>${hasErrors ? 'Validation errors' : 'Validation warnings'}</strong>
          <ul class="validation-list">
            ${validationIssues.map(
              (issue) => html`
                <li>
                  ${issue.field ? html`<code>${issue.field}</code>: ` : ''} ${issue.message}
                </li>
              `,
            )}
          </ul>
        </sl-alert>
        `
          : nothing
      }

      <div
        class="editor-content${readOnly ? ' editor-content--readonly' : ''}"
        aria-disabled=${ifDefined(readOnly ? 'true' : undefined)}
      >
        <div class="editor-description-section">
          <h3 class="settings-section-title">Description</h3>
          <p class="settings-section-desc">
            Pipeline description text — shown on the template card
            and in the launcher dropdown.
          </p>
          <sl-textarea
            id="editor-description-input"
            class="editor-description-input"
            size="small"
            rows="2"
            placeholder="Optional. e.g. Fast bug-fix pipeline: Opus planner investigates, coordinator slices into focused tasks, implementer fixes."
            resize="auto"
            .value=${descriptionDraft || ''}
            ?disabled=${isBuiltinTier}
            @sl-input=${(e) => {
              editorState.descriptionDraft = e.target.value;
              rerender();
            }}
          ></sl-textarea>
        </div>

        <sl-tab-group class="editor-tab-group" @sl-tab-show=${(e) => {
          if (e.detail?.name === 'overlays' && !editorState.overlaysLoaded) {
            loadOverlays(
              editorState.tier,
              editorState.templateId,
              projectId,
              rerender,
            );
          }
        }}>
          <!--
            Template-editor tabs:
              Agents    → effort policy (auto_mode + auto_cap)
                          + per-agent Model / Turns / Effort
              Pipeline  → stages + loops + circuit_breaker
                          (mirrors Project Settings → Pipeline)
              Governance → dispatch allow/deny lists
              Overlays  → read-only view of agents/*.md overlays
                          (only shown when ≥1 overlay file exists)
          -->
          <sl-tab slot="nav" panel="agents">
            ${unsafeHTML(iconSvg(Users, 14))}
            Agents
            ${helpFor('agents-models')}
          </sl-tab>
          <sl-tab slot="nav" panel="pipeline">
            ${unsafeHTML(iconSvg(Workflow, 14))}
            Pipeline
            ${helpFor('stages-config')}
          </sl-tab>
          <sl-tab slot="nav" panel="governance">
            ${unsafeHTML(iconSvg(Shield, 14))}
            Governance
            ${helpFor('dispatch')}
          </sl-tab>
          ${
            !editorState.isNewTemplate &&
            editorState.overlaysLoaded &&
            Object.keys(editorState.overlays || {}).length > 0
              ? html`<sl-tab slot="nav" panel="overlays">
                  ${unsafeHTML(iconSvg(FileText, 14))}
                  Overlays
                </sl-tab>`
              : nothing
          }

          <sl-tab-panel name="agents">
            ${_agentsTab(formBuffer, settings, projectId, rerender)}
          </sl-tab-panel>
          <sl-tab-panel name="pipeline">
            <div class="editor-pipeline-tab">
              ${_stagesSection(formBuffer, projectId, rerender)}
              ${_milestonesSection(formBuffer, projectId, rerender)}
              ${_loopsSection(formBuffer, projectId, rerender)}
              ${_circuitBreakerSection(formBuffer, projectId, rerender)}
            </div>
          </sl-tab-panel>
          <sl-tab-panel name="governance">
            ${_governanceSection(formBuffer, settings, projectId, rerender)}
          </sl-tab-panel>
          ${
            !editorState.isNewTemplate &&
            editorState.overlaysLoaded &&
            Object.keys(editorState.overlays || {}).length > 0
              ? html`<sl-tab-panel name="overlays">
                  ${
                    editorState.overlaysLoading
                      ? html`<div class="settings-tab-content"><sl-spinner></sl-spinner></div>`
                      : overlaysTabView(editorState.overlays || {})
                  }
                </sl-tab-panel>`
              : nothing
          }
        </sl-tab-group>
      </div>

      <div class="editor-footer">
        ${
          readOnly
            ? nothing
            : html`<sl-button
                variant="primary"
                size="small"
                ?disabled=${saving || hasErrors || idCollision}
                @click=${() => saveTemplate(tid, tier, projectId, onSaved)}
              >
                ${
                  saving
                    ? html`<sl-spinner></sl-spinner>`
                    : unsafeHTML(iconSvg(Save, 14))
                }
                ${saving ? 'Saving…' : 'Save'}
              </sl-button>`
        }
        <sl-button
          variant="default"
          size="small"
          outline
          @click=${() => cancelEdit(onCancel)}
        >
          ${readOnly ? 'Close' : 'Cancel'}
        </sl-button>
      </div>
    </div>
  `;
}

/**
 * Render the Stages configuration tab.
 *
 * One card per stage (matching Project Settings' Pipeline tab pattern):
 * toggle on the left/header, per-stage agent override on the right.
 */
function _stagesSection(formBuffer, projectId, rerender) {
  const stages = formBuffer?.stages || DEFAULT_STAGES;
  const state = editorState;

  return html`
    <div class="settings-tab-content">
      <h3 class="settings-section-title">Stage configuration</h3>
      <p class="settings-section-desc">
        Toggle stages on or off and override which agent runs each one.
        Disabling <code>plan_review</code> / <code>learn</code> is the
        most common customization — both are off by default in the
        shipped defaults.
      </p>
      <div class="settings-cards">
        ${Object.entries(stages).map(([stageKey, stageConfig]) => {
          const isEnabled = stageConfig.enabled !== false;
          return html`
            <div class="settings-card pipeline-stage-node ${isEnabled ? 'pipeline-stage-node--enabled' : 'pipeline-stage-node--disabled'}">
              <div class="settings-card-header">
                <span class="settings-card-title ${isEnabled ? '' : 'pipeline-stage-name--disabled'}">${stageKey}</span>
                <sl-switch
                  id="stage-${stageKey}-enabled"
                  ?checked=${isEnabled}
                  size="small"
                  @sl-change=${(e) => {
                    editorState.formBuffer.stages[stageKey].enabled =
                      e.target.checked;
                    rerender();
                  }}
                  @sl-blur=${() => {
                    validateConfigDebounced(
                      projectId,
                      editorState.formBuffer,
                      state.viewMode,
                      rerender,
                    );
                  }}
                ></sl-switch>
              </div>
              <div class="settings-card-body">
                <div class="settings-field">
                  <label class="settings-label" for="stage-${stageKey}-agent">Agent</label>
                  <sl-select
                    id="stage-${stageKey}-agent"
                    .value=${stageConfig.agent || STAGE_AGENT_MAP[stageKey] || 'none'}
                    size="small"
                    hoist
                    ?disabled=${!isEnabled}
                    @sl-change=${(e) => {
                      editorState.formBuffer.stages[stageKey].agent =
                        e.target.value;
                      rerender();
                    }}
                    @sl-blur=${() => {
                      validateConfigDebounced(
                        projectId,
                        editorState.formBuffer,
                        state.viewMode,
                        rerender,
                      );
                    }}
                  >
                    ${AGENT_NAMES.map((agent) => html`<sl-option value="${agent}">${agent}</sl-option>`)}
                    <sl-option value="none">None</sl-option>
                  </sl-select>
                </div>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

/**
 * Agents tab: per-agent Model / Max turns / Effort.
 *
 * Previously split across two tabs (Models + Agents). Both were per-
 * agent settings, so splitting was arbitrary — collapsed into one
 * three-column card per agent. Matches the Project Settings → Agents
 * tab convention of "one row per agent, all runtime knobs co-located".
 *
 * DOM ids are preserved so `readPipelineFromDom` and any e2e selectors
 * keep working: `agent-<name>-model`, `agent-<name>-turns`,
 * `effort-agent-<name>`.
 */
function _agentsTab(formBuffer, settings, projectId, rerender) {
  const agents = formBuffer?.agents || {};
  const modelOptions = getModelOptions(settings?.worca);
  const effort = formBuffer?.effort || {};
  const autoMode = effort.auto_mode || 'adaptive';
  const autoCap = effort.auto_cap || 'xhigh';
  const state = editorState;

  return html`
    <div class="settings-tab-content">
      <h3 class="settings-section-title">Effort mode</h3>
      <p class="settings-section-desc">
        Pipeline-wide reasoning-effort policy. <code>auto_mode</code>
        controls the per-bead starting point and loopback escalation;
        <code>auto_cap</code> bounds any runtime-resolved level.
        Per-agent effort overrides live in the cards below.
      </p>
      <div class="settings-grid">
        <div class="settings-field">
          <label class="settings-label" for="effort-auto-mode">Auto mode</label>
          <sl-select
            id="effort-auto-mode"
            .value=${autoMode}
            size="small"
            hoist
            @sl-change=${(e) => {
              editorState.formBuffer.effort = {
                ...(editorState.formBuffer.effort || {}),
                auto_mode: e.target.value,
              };
              rerender();
            }}
            @sl-blur=${() => {
              validateConfigDebounced(
                projectId,
                editorState.formBuffer,
                state.viewMode,
                rerender,
              );
            }}
          >
            ${AUTO_MODES.map((m) => html`<sl-option value="${m}">${m}</sl-option>`)}
          </sl-select>
          <span class="settings-field-hint"
            >${_AUTO_MODE_HINTS[autoMode] || ''}</span
          >
        </div>
        <div class="settings-field">
          <label class="settings-label" for="effort-auto-cap">Auto cap</label>
          <sl-select
            id="effort-auto-cap"
            .value=${autoCap}
            size="small"
            hoist
            @sl-change=${(e) => {
              editorState.formBuffer.effort = {
                ...(editorState.formBuffer.effort || {}),
                auto_cap: e.target.value,
              };
              rerender();
            }}
            @sl-blur=${() => {
              validateConfigDebounced(
                projectId,
                editorState.formBuffer,
                state.viewMode,
                rerender,
              );
            }}
          >
            ${EFFORT_LEVELS.map((l) => html`<sl-option value="${l}">${l}</sl-option>`)}
          </sl-select>
          <span class="settings-field-hint"
            >Ceiling for runtime-resolved effort levels</span
          >
        </div>
      </div>

      <h3 class="settings-section-title">Agent runtime</h3>
      <p class="settings-section-desc">
        Per-agent model, execution limits, and reasoning effort. Model
        aliases resolve through <code>worca.models</code> in the project
        settings; effort defaults to the model's setting when left
        blank and the <code>auto_cap</code> above applies on top.
      </p>
      <div class="settings-cards">
        ${AGENT_NAMES.map((name) => {
          const agent = agents[name] || {};
          return html`
            <div class="settings-card">
              <div class="settings-card-header">
                <span class="settings-card-title">${name}</span>
              </div>
              <div class="settings-card-body">
                <div class="settings-field">
                  <label class="settings-label" for="agent-${name}-model">Model</label>
                  <sl-select
                    id="agent-${name}-model"
                    .value=${agent.model || 'sonnet'}
                    size="small"
                    hoist
                    @sl-change=${(e) => {
                      editorState.formBuffer.agents[name].model =
                        e.target.value;
                      rerender();
                    }}
                    @sl-blur=${() => {
                      validateConfigDebounced(
                        projectId,
                        editorState.formBuffer,
                        state.viewMode,
                        rerender,
                      );
                    }}
                  >
                    ${modelOptions.map((m) => html`<sl-option value="${m}">${m}</sl-option>`)}
                  </sl-select>
                </div>
                <div class="settings-field">
                  <label class="settings-label" for="agent-${name}-turns">Max turns</label>
                  <sl-input
                    id="agent-${name}-turns"
                    type="number"
                    .value=${agent.max_turns || 30}
                    size="small"
                    min="1"
                    max="200"
                    @sl-input=${(e) => {
                      editorState.formBuffer.agents[name].max_turns =
                        parseInt(e.target.value, 10) || 30;
                      rerender();
                    }}
                    @sl-blur=${() => {
                      validateConfigDebounced(
                        projectId,
                        editorState.formBuffer,
                        state.viewMode,
                        rerender,
                      );
                    }}
                  ></sl-input>
                  <span class="settings-field-hint">1–200; default 30.</span>
                </div>
                <div class="settings-field">
                  <label class="settings-label" for="effort-agent-${name}">Effort</label>
                  <sl-select
                    id="effort-agent-${name}"
                    .value=${agent.effort || ''}
                    size="small"
                    hoist
                    @sl-change=${(e) => {
                      const val = e.target.value || null;
                      editorState.formBuffer.agents[name].effort = val;
                      rerender();
                    }}
                    @sl-blur=${() => {
                      validateConfigDebounced(
                        projectId,
                        editorState.formBuffer,
                        state.viewMode,
                        rerender,
                      );
                    }}
                  >
                    <sl-option value="">(default)</sl-option>
                    ${EFFORT_LEVELS.map(
                      (level) =>
                        html`<sl-option value="${level}">${level}</sl-option>`,
                    )}
                  </sl-select>
                </div>
              </div>
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

const _AUTO_MODE_HINTS = {
  disabled: 'Per-agent effort only; no runtime escalation on loopbacks.',
  reactive:
    'Per-agent effort as starting point; escalates on test failures and review bounces.',
  adaptive:
    'Coordinator classifies per-bead effort; escalates on loopbacks. Explicit per-agent values override.',
};

/**
 * Approval Gates (milestones) — template-owned. Pipeline pauses at
 * each enabled milestone and waits for an approve/reject event
 * before continuing. The Plan gate is the canonical safety net
 * (no work proceeds without a reviewed plan); PR gate is opt-in
 * because enabling it can hang unattended runs.
 */
function _milestonesSection(formBuffer, projectId, rerender) {
  const milestones = formBuffer?.milestones || {};
  const state = editorState;
  const planApproval = milestones.plan_approval !== false;
  const prApproval = milestones.pr_approval === true;

  function _ensureMilestones() {
    if (!editorState.formBuffer.milestones) {
      editorState.formBuffer.milestones = {};
    }
    return editorState.formBuffer.milestones;
  }

  return html`
    <div class="settings-tab-content">
      <h3 class="settings-section-title">Approval gates</h3>
      <p class="settings-section-desc">
        Pause the pipeline at each enabled milestone and wait for an
        approve/reject control event before continuing. Each
        template owns its own gate posture — an unattended
        nightly-run template might disable PR approval; a regulated
        production template should require both.
      </p>
      <div class="settings-switches">
        <div class="settings-switch-row">
          <sl-switch
            id="milestone-plan-approval"
            ?checked=${planApproval}
            size="small"
            @sl-change=${(e) => {
              _ensureMilestones().plan_approval = e.target.checked;
              rerender();
            }}
            @sl-blur=${() => {
              validateConfigDebounced(
                projectId,
                editorState.formBuffer,
                state.viewMode,
                rerender,
              );
            }}
            >Plan approval required</sl-switch
          >
          <span class="settings-switch-desc"
            >Pipeline pauses after Plan stage; pause-control event
            lets you approve or reject before Coordinate.</span
          >
        </div>
        <div class="settings-switch-row">
          <sl-switch
            id="milestone-pr-approval"
            ?checked=${prApproval}
            size="small"
            @sl-change=${(e) => {
              const m = _ensureMilestones();
              if (e.target.checked) m.pr_approval = true;
              else delete m.pr_approval;
              rerender();
            }}
            @sl-blur=${() => {
              validateConfigDebounced(
                projectId,
                editorState.formBuffer,
                state.viewMode,
                rerender,
              );
            }}
            >PR approval required</sl-switch
          >
          <span class="settings-switch-desc"
            >When enabled, pipeline pauses before guardian creates
            the PR; approve/reject from the run detail view. Off by
            default to avoid hanging unattended runs.</span
          >
        </div>
      </div>
    </div>
  `;
}

/**
 * Render the Loops configuration section as a Settings-style tab.
 */
function _loopsSection(formBuffer, projectId, rerender) {
  const loops = formBuffer?.loops || DEFAULT_LOOPS;
  const state = editorState;
  const fields = [
    {
      key: 'implement_test',
      label: 'Implement ↔ Test',
      hint: 'Max iterations of the implementer/tester back-and-forth before halt.',
    },
    {
      key: 'pr_changes',
      label: 'PR changes',
      hint: 'Max review-revise cycles after the PR is opened.',
    },
    {
      key: 'restart_planning',
      label: 'Restart planning',
      hint: 'Max times the pipeline may rewind to the planner before halting.',
    },
  ];

  return html`
    <div class="settings-tab-content">
      <h3 class="settings-section-title">Loop limits</h3>
      <p class="settings-section-desc">
        Caps on the iterative loops inside a single run. Set to <code>0</code>
        to disable a loop entirely.
      </p>
      <div class="settings-grid">
        ${fields.map(
          (item) => html`
            <div class="settings-field">
              <label class="settings-label" for="loop-${item.key}">${item.label}</label>
              <sl-input
                id="loop-${item.key}"
                type="number"
                .value=${loops[item.key] || 0}
                size="small"
                min="0"
                max="50"
                placeholder="0"
                @sl-input=${(e) => {
                  editorState.formBuffer.loops[item.key] =
                    parseInt(e.target.value, 10) || 0;
                  rerender();
                }}
                @sl-blur=${() => {
                  validateConfigDebounced(
                    projectId,
                    editorState.formBuffer,
                    state.viewMode,
                    rerender,
                  );
                }}
              ></sl-input>
              <span class="settings-field-hint">${item.hint}</span>
            </div>
          `,
        )}
      </div>
    </div>
  `;
}

/**
 * Render the Circuit Breaker configuration section.
 */
function _circuitBreakerSection(formBuffer, projectId, rerender) {
  const cb = formBuffer?.circuit_breaker || DEFAULT_CIRCUIT_BREAKER;
  const state = editorState;
  const enabled = cb.enabled !== false;

  return html`
    <div class="settings-tab-content">
      <h3 class="settings-section-title">Circuit breaker</h3>
      <p class="settings-section-desc">
        Halt a run after a streak of consecutive errors. Useful for catching
        runaway loops without letting them burn through retry budget.
      </p>
      <div class="settings-grid">
        <div class="settings-field">
          <div class="settings-switch-row">
            <sl-switch
              id="cb-enabled"
              ?checked=${enabled}
              size="small"
              @sl-change=${(e) => {
                editorState.formBuffer.circuit_breaker.enabled =
                  e.target.checked;
                rerender();
              }}
              @sl-blur=${() => {
                validateConfigDebounced(
                  projectId,
                  editorState.formBuffer,
                  state.viewMode,
                  rerender,
                );
              }}
            >
              Enable circuit breaker
            </sl-switch>
            <span class="settings-switch-desc">
              When off, the pipeline keeps retrying regardless of the failure streak.
            </span>
          </div>
        </div>
        <div class="settings-field">
          <label class="settings-label" for="cb-max-failures">Max consecutive failures</label>
          <sl-input
            id="cb-max-failures"
            type="number"
            .value=${cb.max_consecutive_failures ?? 3}
            size="small"
            min="1"
            max="10"
            ?disabled=${!enabled}
            @sl-input=${(e) => {
              editorState.formBuffer.circuit_breaker.max_consecutive_failures =
                parseInt(e.target.value, 10) || 3;
              rerender();
            }}
            @sl-blur=${() => {
              validateConfigDebounced(
                projectId,
                editorState.formBuffer,
                state.viewMode,
                rerender,
              );
            }}
          ></sl-input>
          <span class="settings-field-hint">1–10; default 3.</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render the Governance dispatch section.
 */
function _governanceSection(formBuffer, settings, projectId, rerender) {
  const gov = formBuffer?.governance || DEFAULT_GOVERNANCE;
  const dispatch = gov.dispatch || DEFAULT_GOVERNANCE.dispatch;
  const testGateStrikes = gov.test_gate_strikes ?? 2;
  const planReviewEnforce = gov.plan_review_enforce || 'auto';
  const state = editorState;

  // Ensure governance is mutable in the form buffer before binding
  // change handlers — DEFAULT_GOVERNANCE is shared and shouldn't be
  // mutated in place.
  function _ensureGovernance() {
    if (!editorState.formBuffer.governance) {
      editorState.formBuffer.governance = { ...DEFAULT_GOVERNANCE };
    }
    return editorState.formBuffer.governance;
  }

  return html`
    <div class="settings-tab-content">
      <h3 class="settings-section-title">Test gate</h3>
      <p class="settings-section-desc">
        Halt the pipeline after this many consecutive pytest failures.
        Acts like a circuit breaker for test runs — a smaller number
        catches runaway loops sooner at the cost of recovering less
        well from flakes.
      </p>
      <div class="settings-grid">
        <div class="settings-field">
          <label class="settings-label" for="test-gate-strikes">Strike threshold</label>
          <sl-input
            id="test-gate-strikes"
            type="number"
            .value=${String(testGateStrikes)}
            size="small"
            min="1"
            max="10"
            @sl-input=${(e) => {
              _ensureGovernance().test_gate_strikes =
                parseInt(e.target.value, 10) || 2;
              rerender();
            }}
            @sl-blur=${() => {
              validateConfigDebounced(
                projectId,
                editorState.formBuffer,
                state.viewMode,
                rerender,
              );
            }}
          ></sl-input>
          <span class="settings-field-hint">1–10; default 2.</span>
        </div>
      </div>

      <h3 class="settings-section-title">Plan review enforcement</h3>
      <p class="settings-section-desc">
        Controls the minimum plan review mode this template requires.
        <code>auto</code> lets the pipeline decide;
        <code>review_and_edit</code> forces edit capability but loses
        independent verification of the plan.
      </p>
      <div class="settings-grid">
        <div class="settings-field">
          <sl-select
            id="governance-plan-review-enforce"
            aria-label="Plan review enforce mode"
            .value=${planReviewEnforce}
            size="small"
            hoist
            @sl-change=${(e) => {
              _ensureGovernance().plan_review_enforce = e.target.value;
              rerender();
            }}
            @sl-blur=${() => {
              validateConfigDebounced(
                projectId,
                editorState.formBuffer,
                state.viewMode,
                rerender,
              );
            }}
          >
            ${PLAN_REVIEW_ENFORCE_OPTIONS.map(
              (m) => html`<sl-option value="${m}">${m}</sl-option>`,
            )}
          </sl-select>
        </div>
      </div>

      <h3 class="settings-section-title">Governance dispatch</h3>
      <p class="settings-section-desc">
        Allow / deny lists for tools, skills, and subagents, per agent.
        <strong>Always Disallowed</strong> is the hard-deny floor and
        <strong>Default Denied</strong> is blocked under <code>*</code>
        unless an agent opts in — both are seeded from the shipped
        defaults and editable here; a tier left untouched stays inherited
        rather than frozen into the template. The project's
        <code>governance.guards</code> (hook gates) remain cross-template
        and are edited in Project Settings.
      </p>
      <div class="governance-content">
        ${['tools', 'skills', 'subagents'].map((section) => {
          return dispatchSectionView({
            section,
            config: dispatch[section] || {},
            knownItems:
              section === 'tools' ? [] : section === 'skills' ? [] : [],
            agentRoles: AGENT_NAMES,
            defaults: DISPATCH_DEFAULTS[section],
            denyTiersEditable: true,
            onChange: (newConfig) => {
              if (!editorState.formBuffer.governance) {
                editorState.formBuffer.governance = { ...DEFAULT_GOVERNANCE };
              }
              if (!editorState.formBuffer.governance.dispatch) {
                editorState.formBuffer.governance.dispatch = {
                  ...DEFAULT_GOVERNANCE.dispatch,
                };
              }
              editorState.formBuffer.governance.dispatch[section] = newConfig;
              // Mark the section dirty so formBufferToConfig writes the
              // user-edited config rather than the template original.
              if (!editorState.formBuffer._dispatchDirty) {
                editorState.formBuffer._dispatchDirty = {
                  tools: false,
                  skills: false,
                  subagents: false,
                };
              }
              editorState.formBuffer._dispatchDirty[section] = true;
              rerender();
            },
            state: dispatchEditState[section],
            rerender,
            showTitle: true,
          });
        })}
      </div>
    </div>
  `;
}

/**
 * Render the JSON editor section.
 */
function _jsonSection(projectId, rerender) {
  const buffer = editorState.jsonBuffer || '{}';
  const state = editorState;

  return html`
    <section class="editor-section editor-section--json">
      <h2 class="section-title">Configuration JSON</h2>
      <div class="json-editor-wrapper">
        <sl-textarea
          id="template-config-json"
          class="json-editor"
          .value=${buffer}
          rows="25"
          spellcheck="false"
          @sl-input=${(e) => {
            editorState.jsonBuffer = e.target.value;
            rerender();
          }}
          @sl-change=${() => {
            // Update diff if we have a built-in template to compare against
            if (shadowsBuiltin(editorState.template)) {
              computeDiff();
            }
            validateConfigDebounced(
              projectId,
              editorState.formBuffer,
              state.viewMode,
              rerender,
            );
          }}
        ></sl-textarea>
      </div>
      <div class="json-editor-hint">
        Raw JSON configuration. Edits here sync to the form view when you switch back to Form mode.
      </div>
    </section>
  `;
}

/**
 * Render the diff section comparing current config with built-in.
 * Shows a table of differences with reset buttons for each changed key.
 */
function _diffSection(rerender) {
  const diffData = editorState.diffData || [];
  const changedDiffs = diffData.filter((d) => d.changed);

  if (editorState.loadingBuiltin) {
    return html`
      <section class="editor-section editor-section--diff">
        <h2 class="section-title">Diff vs Built-in</h2>
        <div class="diff-loading">
          <sl-spinner></sl-spinner> Loading built-in template for comparison…
        </div>
      </section>
    `;
  }

  if (!editorState.builtinTemplate) {
    return html`
      <section class="editor-section editor-section--diff">
        <h2 class="section-title">Diff vs Built-in</h2>
        <div class="diff-empty">
          <p>Unable to load built-in template for comparison.</p>
          <sl-alert variant="neutral" open>
            Diff view requires the built-in template to be available on the server.
          </sl-alert>
        </div>
      </section>
    `;
  }

  return html`
    <section class="editor-section editor-section--diff">
      <div class="section-header">
        <h2 class="section-title">Diff vs Built-in</h2>
        <sl-badge variant="${changedDiffs.length === 0 ? 'success' : 'neutral'}" pill>
          ${diffSummary(diffData)}
        </sl-badge>
      </div>
      <div class="diff-content">
        <p class="diff-hint">
          This view shows how your template differs from the built-in version.
          Use the <sl-tooltip content="Reset value to built-in"><span class="diff-reset-icon">${unsafeHTML(iconSvg(RefreshCw, 14))}</span></sl-tooltip> button to reset individual keys to their built-in value.
        </p>
        ${
          changedDiffs.length === 0
            ? html`
              <div class="diff-no-changes">
                ${unsafeHTML(iconSvg(CircleCheck, 48))}
                <h3>No differences</h3>
                <p>Your template matches the built-in version exactly.</p>
              </div>
            `
            : html`
              <div class="diff-table-container">
                <table class="diff-table">
                  <thead>
                    <tr>
                      <th>Path</th>
                      <th>Built-in Value</th>
                      <th>Your Value</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${changedDiffs.map(
                      (diff) => html`
                        <tr class="diff-row ${diff.changed ? 'diff-row--changed' : ''}">
                          <td class="diff-path">
                            <code>${diff.dotPath}</code>
                            <span class="diff-label">${getDiffLabel(diff.key) || diff.key}</span>
                          </td>
                          <td class="diff-value diff-value--builtin">
                            ${formatDiffValue(diff.builtinValue)}
                          </td>
                          <td class="diff-value diff-value--current">
                            ${formatDiffValue(diff.currentValue)}
                          </td>
                          <td class="diff-actions">
                            <sl-button
                              size="small"
                              outline
                              @click=${() => resetToBuiltin(diff.dotPath, rerender)}
                            >
                              ${unsafeHTML(iconSvg(RefreshCw, 12))} Reset
                            </sl-button>
                          </td>
                        </tr>
                      `,
                    )}
                  </tbody>
                </table>
              </div>
            `
        }
      </div>
    </section>
  `;
}
