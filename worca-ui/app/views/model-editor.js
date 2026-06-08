/**
 * Model editor view — mirrors pipelines-editor.js patterns.
 *
 * Layout:
 *   - Subheader with Alias pill, ID-collision pill, Storage badge
 *   - Optional "Resolves to" preview banner
 *   - Optional secret-placeholder banner when env contains SECRET_PLACEHOLDER
 *   - Form sections (Identity, Environment, Pricing accordion, Applied by)
 *
 * Built-in tier opens read-only: every input disabled, no Save button, only
 * "Duplicate" surfaces — same as the read-only built-in template editor.
 */

import { html, nothing } from 'lit-html';
import { ifDefined } from 'lit-html/directives/if-defined.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { helpFor } from '../utils/help-links.js';
import {
  ClipboardCopy,
  Copy,
  Cpu,
  iconSvg,
  Lock,
  Plus,
  Trash2,
} from '../utils/icons.js';
import { isSecretPlaceholder } from '../utils/secret-placeholders.js';

const ALIAS_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const PRICING_FIELDS = [
  { key: 'input_per_mtok', label: 'Input ($/MTok)', step: '0.01' },
  { key: 'cache_read_per_mtok', label: 'Cache read ($/MTok)', step: '0.01' },
  { key: 'cache_write_per_mtok', label: 'Cache write ($/MTok)', step: '0.01' },
  { key: 'output_per_mtok', label: 'Output ($/MTok)', step: '0.01' },
];
const ALT_ENDPOINT_HINT_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
];
const RESERVED_KEYS = new Set([
  'PATH',
  'CLAUDECODE',
  'WORCA_AGENT',
  'WORCA_PROJECT_ROOT',
  'WORCA_RUN_ID',
  'WORCA_RUN_DIR',
  'WORCA_PLAN_FILE',
  'WORCA_EVENTS_PATH',
  'WORCA_TARGET_BRANCH',
  'WORCA_COVERAGE',
  'WORCA_SKIP_BEADS',
  'WORCA_CLAUDE_BIN',
]);

function isReservedKey(key) {
  if (!key) return false;
  if (RESERVED_KEYS.has(key)) return true;
  return key.startsWith('WORCA_');
}

// ────────────────────────────────────────────────────────────────────────
// Editor state — module-level, mirrors editorState in pipelines-editor.js
// ────────────────────────────────────────────────────────────────────────

export const modelEditorState = {
  loading: false,
  saving: false,
  error: null,
  tier: 'project',
  alias: null, // original alias (URL slug); rename target is in aliasDraft
  isNew: false,
  // Draft fields the user can edit
  aliasDraft: '',
  aliasDirty: false,
  idDraft: '',
  envRows: [], // [{ key, value }]
  pricingDraft: {}, // { input_per_mtok: number|string, ... }
  // Server state for "Applied by" + initial values
  appliedBy: [],
  serverModel: null,
  // Pricing accordion open by default when alt-endpoint env present.
  pricingOpen: false,
};

let _editorRerenderFn = null;

export function resetModelEditor() {
  modelEditorState.loading = false;
  modelEditorState.saving = false;
  modelEditorState.error = null;
  modelEditorState.tier = 'project';
  modelEditorState.alias = null;
  modelEditorState.isNew = false;
  modelEditorState.aliasDraft = '';
  modelEditorState.aliasDirty = false;
  modelEditorState.idDraft = '';
  modelEditorState.envRows = [];
  modelEditorState.pricingDraft = {};
  modelEditorState.appliedBy = [];
  modelEditorState.serverModel = null;
  modelEditorState.pricingOpen = false;
}

function modelsApi(projectId, suffix = '') {
  if (projectId) return `/api/projects/${projectId}/models${suffix}`;
  return `/api/models${suffix}`;
}

/**
 * Load a model entry for editing. For new entries, pre-populate with empty
 * fields at the given tier.
 */
export async function loadModelForEdit({ tier, alias, projectId, rerender }) {
  _editorRerenderFn = rerender;
  resetModelEditor();
  modelEditorState.tier = tier || 'project';
  modelEditorState.alias = alias === 'new' ? null : alias;
  modelEditorState.isNew = alias === 'new';
  modelEditorState.loading = true;
  rerender?.();

  if (modelEditorState.isNew) {
    modelEditorState.loading = false;
    modelEditorState.aliasDraft = '';
    modelEditorState.idDraft = '';
    modelEditorState.envRows = [];
    modelEditorState.pricingDraft = {};
    rerender?.();
    return;
  }

  try {
    const res = await fetch(
      modelsApi(projectId, `/${tier}/${encodeURIComponent(alias)}`),
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    const model = data.model || {};
    modelEditorState.serverModel = model;
    modelEditorState.aliasDraft = model.alias || '';
    modelEditorState.idDraft = model.id || '';
    modelEditorState.envRows = Object.entries(model.env || {}).map(
      ([key, value]) => ({ key, value }),
    );
    modelEditorState.pricingDraft = { ...(model.pricing || {}) };
    modelEditorState.appliedBy = data.applied_by || [];
    modelEditorState.pricingOpen = ALT_ENDPOINT_HINT_KEYS.some(
      (k) => model.env?.[k],
    );
  } catch (err) {
    modelEditorState.error = err.message;
  } finally {
    modelEditorState.loading = false;
    rerender?.();
  }
}

function _collectEnvForPayload() {
  const env = {};
  for (const { key, value } of modelEditorState.envRows) {
    const k = (key || '').trim();
    if (!k) continue;
    env[k] = value ?? '';
  }
  return env;
}

function _collectPricingForPayload() {
  const out = {};
  for (const field of PRICING_FIELDS) {
    const v = modelEditorState.pricingDraft[field.key];
    if (v === '' || v == null) continue;
    const num = Number(v);
    if (Number.isFinite(num) && num >= 0) {
      out[field.key] = num;
    }
  }
  return out;
}

function _showToast(message, variant = 'success') {
  try {
    const alert = Object.assign(document.createElement('sl-alert'), {
      variant,
      closable: true,
      duration: 4000,
      innerHTML: `<sl-icon slot="icon" name="${
        variant === 'success'
          ? 'check2-circle'
          : variant === 'danger'
            ? 'exclamation-octagon'
            : 'info-circle'
      }"></sl-icon>${message}`,
    });
    document.body.appendChild(alert);
    alert.toast();
  } catch {
    /* tests / non-browser */
  }
}

export async function saveModel({ projectId, onSaved, allModels }) {
  if (modelEditorState.saving) return;

  const tier = modelEditorState.tier;
  if (tier === 'builtin') {
    _showToast('Built-in models are read-only — duplicate to edit.', 'danger');
    return;
  }

  const aliasDraft = (modelEditorState.aliasDraft || '').trim();
  if (!ALIAS_RE.test(aliasDraft)) {
    modelEditorState.error = 'Alias must match [a-zA-Z0-9_-], 1-64 chars.';
    _editorRerenderFn?.();
    _showToast(modelEditorState.error, 'danger');
    return;
  }
  const idDraft = (modelEditorState.idDraft || '').trim();
  if (!idDraft) {
    modelEditorState.error = 'Model ID is required.';
    _editorRerenderFn?.();
    _showToast(modelEditorState.error, 'danger');
    return;
  }

  // Inline collision check against the cached full list.
  const list = Array.isArray(allModels) ? allModels : [];
  const collision = list.find(
    (m) =>
      m.tier === tier &&
      m.alias === aliasDraft &&
      !(modelEditorState.alias && m.alias === modelEditorState.alias),
  );
  if (collision) {
    modelEditorState.error = `An alias "${aliasDraft}" already exists in the ${tier} scope.`;
    _editorRerenderFn?.();
    _showToast(modelEditorState.error, 'danger');
    return;
  }

  modelEditorState.saving = true;
  modelEditorState.error = null;
  _editorRerenderFn?.();

  const env = _collectEnvForPayload();
  // Lightweight reserved-key check — server will reject too but inline beats
  // an HTTP round-trip for an obvious typo.
  for (const k of Object.keys(env)) {
    if (isReservedKey(k)) {
      modelEditorState.saving = false;
      modelEditorState.error = `Env key "${k}" is reserved and cannot be set on a model.`;
      _editorRerenderFn?.();
      _showToast(modelEditorState.error, 'danger');
      return;
    }
  }

  const payload = {
    alias: aliasDraft,
    id: idDraft,
    env,
    pricing: _collectPricingForPayload(),
  };

  const targetAlias = modelEditorState.isNew
    ? aliasDraft
    : modelEditorState.alias;

  try {
    const res = await fetch(
      modelsApi(projectId, `/${tier}/${encodeURIComponent(targetAlias)}`),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    modelEditorState.serverModel = data.model || null;
    modelEditorState.alias = data.model?.alias || aliasDraft;
    modelEditorState.isNew = false;
    _showToast(`Model "${aliasDraft}" saved`, 'success');
    if (onSaved) onSaved({ tier, alias: data.model?.alias || aliasDraft });
  } catch (err) {
    modelEditorState.error = `Failed to save: ${err.message}`;
    _showToast(modelEditorState.error, 'danger');
  } finally {
    modelEditorState.saving = false;
    _editorRerenderFn?.();
  }
}

// ────────────────────────────────────────────────────────────────────────
// View
// ────────────────────────────────────────────────────────────────────────

export function modelEditorView(_state, options) {
  // onCancel is handled by main.js (header buttons drive saveModel + nav).
  // projectId is needed for the Applied-by template links so they resolve
  // to /project/<id>/templates/... rather than the global short-form URL.
  const { projectId, rerender, allModels, onTierChange } = options || {};
  if (rerender) _editorRerenderFn = rerender;

  const { loading, error, tier, isNew, aliasDraft, idDraft } = modelEditorState;

  if (loading) {
    return html`
      <div class="pipelines-editor model-editor">
        <div class="editor-subheader">
          <h2 class="editor-subheader-title">Loading model…</h2>
        </div>
        <div class="editor-content">
          <sl-spinner></sl-spinner>
        </div>
      </div>
    `;
  }

  const isBuiltinTier = tier === 'builtin';
  const readOnly = isBuiltinTier;
  const tierDisplay = tier.charAt(0).toUpperCase() + tier.slice(1);

  // Collision check against the cached list — inline so the badge shows
  // before the user hits Save.
  const list = Array.isArray(allModels) ? allModels : [];
  const trimmedAlias = (aliasDraft || '').trim();
  const srcAlias = isNew ? null : modelEditorState.alias;
  const aliasCollision = !!(
    trimmedAlias &&
    list.find(
      (m) =>
        m.alias === trimmedAlias &&
        m.tier === tier &&
        !(m.alias === srcAlias && m.tier === tier),
    )
  );
  const aliasHelpText = aliasCollision
    ? `An alias "${trimmedAlias}" already exists in the ${tier} scope.`
    : '';

  const env = _collectEnvForPayload();
  const hasAltEndpoint = ALT_ENDPOINT_HINT_KEYS.some((k) => env[k]);
  const placeholders = Object.entries(env).filter(([, v]) =>
    isSecretPlaceholder(v),
  );

  const onAliasInput = (e) => {
    modelEditorState.aliasDraft = e.target.value;
    modelEditorState.aliasDirty = true;
    rerender?.();
  };
  const onIdInput = (e) => {
    modelEditorState.idDraft = e.target.value;
    rerender?.();
  };

  return html`
    <div class="pipelines-editor model-editor">
      <div class="editor-subheader">
        ${helpFor('models')}
        <div class="editor-subheader-title-group">
          <sl-tooltip content="Alias name (used in templates as the model identifier)">
            <span class="editor-field-pill editor-name-pill">
              <span class="editor-field-pill-label">Alias:</span>
              <sl-input
                class="editor-name-input model-editor-alias-input"
                size="small"
                placeholder="e.g. opus"
                .value=${aliasDraft || ''}
                ?disabled=${isBuiltinTier}
                @sl-input=${onAliasInput}
              ></sl-input>
            </span>
          </sl-tooltip>
          ${
            aliasCollision
              ? html`<sl-tooltip content=${aliasHelpText}>
                  <sl-badge
                    variant="warning"
                    pill
                    class="editor-id-collision-badge"
                    >Alias already exists</sl-badge
                  >
                </sl-tooltip>`
              : ''
          }
          ${
            isNew
              ? html`<sl-tooltip content="Pick a destination tier for this new alias. Project entries live in the repo's settings.json (versioned); User entries are shared across all your projects (~/.worca/settings.json).">
                  <span class="editor-field-pill editor-storage-pill">
                    <span class="editor-field-pill-label">Storage:</span>
                    <sl-select
                      class="model-editor-tier-select"
                      size="small"
                      hoist
                      .value=${tier}
                      @sl-change=${(e) => {
                        const next = e.target.value;
                        if (next === tier) return;
                        modelEditorState.tier = next;
                        // Keep editor state, but flip the URL so refresh /
                        // back-button work and the header New stays at the
                        // new tier on cancel.
                        onTierChange?.(next);
                        rerender?.();
                      }}
                    >
                      <sl-option value="project">Project</sl-option>
                      <sl-option value="user">User</sl-option>
                    </sl-select>
                  </span>
                </sl-tooltip>`
              : html`<sl-tooltip content="Where this entry lives (immutable for existing entries — use Duplicate to move tiers)">
                  <sl-badge
                    variant="primary"
                    pill
                    class="editor-storage-badge"
                    >Storage: ${tierDisplay}</sl-badge
                  >
                </sl-tooltip>`
          }
          ${
            isBuiltinTier
              ? html`<sl-tooltip content="Built-in entries are immutable — Duplicate to a writable tier to edit">
                  <sl-badge variant="neutral" pill class="editor-readonly-badge">
                    ${unsafeHTML(iconSvg(Lock, 12))} Read-only
                  </sl-badge>
                </sl-tooltip>`
              : ''
          }
        </div>
      </div>

      ${
        error
          ? html`<sl-alert variant="danger" open class="editor-validation-alert">
              <strong>Error</strong>
              ${error}
            </sl-alert>`
          : nothing
      }

      ${_resolvesToBanner(idDraft, env)}
      ${_importedFromBanner(modelEditorState.serverModel?.imported_from)}
      ${_secretPlaceholderBanner(placeholders.length)}

      <div
        class="editor-content${readOnly ? ' editor-content--readonly' : ''}"
        aria-disabled=${ifDefined(readOnly ? 'true' : undefined)}
      >
        ${_identitySection(idDraft, onIdInput, isBuiltinTier)}
        ${_envSection(rerender, isBuiltinTier)}
        ${_pricingSection(rerender, isBuiltinTier, hasAltEndpoint)}
        ${_appliedBySection(modelEditorState.appliedBy, projectId)}
      </div>
    </div>
  `;
}

function _resolvesToBanner(idDraft, env) {
  const envCount = Object.keys(env).length;
  return html`
    <sl-alert variant="neutral" open class="model-editor-resolves-banner">
      <strong>Resolves to:</strong>
      <code class="model-editor-resolves-id">${idDraft || '(unset)'}</code>
      ${envCount > 0 ? html`<span class="settings-muted">+ ${envCount} env var${envCount === 1 ? '' : 's'}</span>` : ''}
    </sl-alert>
  `;
}

function _importedFromBanner(label) {
  if (!label) return nothing;
  return html`
    <sl-alert variant="neutral" open class="model-editor-imported-banner">
      <strong>Imported from bundle:</strong>
      <code>${label}</code>
      <span class="settings-muted"> — the attribution badge drops the first time you save this entry from the UI (ownership transfer).</span>
    </sl-alert>
  `;
}

function _secretPlaceholderBanner(count) {
  if (!count) return nothing;
  return html`
    <sl-alert variant="warning" open class="model-editor-secret-banner">
      <strong slot="header">${count} secret${count === 1 ? '' : 's'} need value${count === 1 ? '' : 's'}</strong>
      One or more env values are placeholders left by a template-bundle
      import. Replace them with real credentials before running the pipeline.
    </sl-alert>
  `;
}

function _identitySection(idDraft, onIdInput, disabled) {
  return html`
    <div class="editor-description-section model-editor-section">
      <h3 class="settings-section-title">Model ID</h3>
      <p class="settings-section-desc">
        The full Claude model id (e.g. <code>claude-opus-4-7</code>) or any
        identifier your alt-endpoint accepts. Stored in <code>settings.json</code>
        (committed).
      </p>
      <sl-input
        class="model-editor-id-input"
        size="small"
        placeholder="e.g. claude-opus-4-7"
        .value=${idDraft || ''}
        ?disabled=${disabled}
        @sl-input=${onIdInput}
      ></sl-input>
    </div>
  `;
}

function _envSection(rerender, disabled) {
  const rows = modelEditorState.envRows;

  const onKeyInput = (idx, e) => {
    rows[idx] = { ...rows[idx], key: e.target.value };
    rerender?.();
  };
  const onValueInput = (idx, e) => {
    rows[idx] = { ...rows[idx], value: e.target.value };
    rerender?.();
  };
  const onRemove = (idx) => {
    rows.splice(idx, 1);
    rerender?.();
  };
  const onAdd = () => {
    rows.push({ key: '', value: '' });
    rerender?.();
  };

  return html`
    <div class="editor-description-section model-editor-section">
      <div class="model-editor-section-head">
        <div>
          <h3 class="settings-section-title">Environment variables</h3>
          <p class="settings-section-desc">
            Passed to the Claude CLI subprocess when this alias runs. Stored in
            <code>settings.local.json</code> (gitignored — safe for secrets).
            Reserved keys (<code>WORCA_*</code>, <code>PATH</code>,
            <code>CLAUDECODE</code>) are rejected.
          </p>
        </div>
        <button
          class="action-btn action-btn--secondary"
          ?disabled=${disabled}
          @click=${onAdd}
        >
          ${unsafeHTML(iconSvg(Plus, 14))}
          Add row
        </button>
      </div>
      ${
        rows.length === 0
          ? html`<p class="settings-muted model-editor-env-empty">No env vars set.</p>`
          : html`
              <table class="model-editor-env-table">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Value</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${rows.map((row, idx) => {
                    const reserved = isReservedKey((row.key || '').trim());
                    const isPlaceholder = isSecretPlaceholder(row.value);
                    return html`
                      <tr class="model-editor-env-row${reserved ? ' model-editor-env-row--invalid' : ''}${isPlaceholder ? ' model-editor-env-row--placeholder' : ''}">
                        <td>
                          <sl-input
                            class="model-editor-env-key"
                            size="small"
                            placeholder="ANTHROPIC_BASE_URL"
                            .value=${row.key || ''}
                            ?disabled=${disabled}
                            @sl-input=${(e) => onKeyInput(idx, e)}
                          ></sl-input>
                          ${
                            reserved
                              ? html`<span class="model-editor-env-error">Reserved key</span>`
                              : ''
                          }
                        </td>
                        <td>
                          <sl-input
                            class="model-editor-env-value"
                            size="small"
                            placeholder="value"
                            .value=${row.value || ''}
                            ?disabled=${disabled}
                            @sl-input=${(e) => onValueInput(idx, e)}
                          ></sl-input>
                          ${
                            isPlaceholder
                              ? html`<span class="model-editor-env-warn">Placeholder — replace with real value</span>`
                              : ''
                          }
                        </td>
                        <td class="model-editor-env-actions">
                          <button
                            class="action-btn action-btn--danger"
                            ?disabled=${disabled}
                            @click=${() => onRemove(idx)}
                            title="Remove this env var"
                          >
                            ${unsafeHTML(iconSvg(Trash2, 14))}
                          </button>
                        </td>
                      </tr>
                    `;
                  })}
                </tbody>
              </table>
            `
      }
    </div>
  `;
}

function _pricingSection(rerender, disabled, hasAltEndpoint) {
  // Auto-open when alt-endpoint env present — those are the runs where the
  // worca-supplied rates are authoritative (Claude CLI's reported cost is for
  // Anthropic prices, which don't apply to a non-Anthropic endpoint).
  const wantOpen = modelEditorState.pricingOpen || hasAltEndpoint;

  const onPricingInput = (key, e) => {
    // Empty input → leave the key absent in the draft (vs. `0` which is a
    // valid "free" rate for unmetered proxies). _collectPricingForPayload
    // turns an absent draft key into a missing field on save.
    const raw = e.target.value;
    const next = { ...modelEditorState.pricingDraft };
    if (raw === '' || raw == null) {
      delete next[key];
    } else {
      next[key] = raw;
    }
    modelEditorState.pricingDraft = next;
    rerender?.();
  };
  const onClearAll = () => {
    modelEditorState.pricingDraft = {};
    rerender?.();
  };
  const onToggle = (e) => {
    modelEditorState.pricingOpen = e.target.open;
  };

  const hasAnyRate = PRICING_FIELDS.some(
    (f) =>
      modelEditorState.pricingDraft[f.key] != null &&
      modelEditorState.pricingDraft[f.key] !== '',
  );
  // Badge taxonomy describes WHERE the cost number comes from, not the
  // worca-vs-CLI relationship. Three states:
  //   "explicit"   — user has entered rates; worca uses them
  //                  (authoritative on alt-endpoint, fallback on default)
  //   "Claude CLI" — default endpoint, no rates set; CLI reports the cost
  //   (no badge)   — alt-endpoint with no rates; the alt-endpoint card
  //                  badge already flags the missing-pricing risk
  const showExplicit = hasAnyRate;
  const showCliBadge = !hasAnyRate && !hasAltEndpoint;

  return html`
    <div class="editor-description-section model-editor-section">
      <sl-details
        class="model-editor-pricing-accordion"
        ?open=${wantOpen}
        @sl-show=${onToggle}
        @sl-hide=${onToggle}
      >
        <div slot="summary" class="model-editor-pricing-summary">
          <h3 class="settings-section-title" style="margin:0">Pricing</h3>
          ${
            showExplicit
              ? html`<sl-badge variant="primary" pill title="Worca uses these rates. On alt-endpoint runs they override Claude CLI's number; on default-endpoint runs they fall back in when the CLI doesn't report a cost.">explicit</sl-badge>`
              : showCliBadge
                ? html`<sl-badge variant="neutral" pill title="Default Anthropic endpoint — Claude CLI's reported total_cost_usd is the source of truth. Set rates here only if you want a fallback for runs that end without a reported cost.">Claude CLI</sl-badge>`
                : ''
          }
        </div>
        <p class="settings-section-desc">
          ${
            hasAltEndpoint
              ? html`Set rates for accurate cost tracking on this alt-endpoint
                 alias — Claude CLI's <code>total_cost_usd</code> reflects
                 Anthropic prices, which don't apply to a non-Anthropic endpoint.
                 An empty field means "unset" (worca skips that component); a
                 literal <code>0</code> means "free" (e.g. unmetered cache reads
                 on some proxies).`
              : html`Optional. Used as a fallback only when Claude CLI ends a run
                 without reporting a cost. An empty field means "unset"; a literal
                 <code>0</code> means "free."`
          }
        </p>
        <table class="pricing-table">
          <thead>
            <tr>
              ${PRICING_FIELDS.map((f) => html`<th>${f.label}</th>`)}
            </tr>
          </thead>
          <tbody>
            <tr>
              ${PRICING_FIELDS.map(
                (f) => html`
                  <td>
                    <sl-input
                      class="pricing-input"
                      size="small"
                      type="number"
                      step=${f.step}
                      min="0"
                      placeholder="—"
                      .value=${modelEditorState.pricingDraft[f.key] != null ? String(modelEditorState.pricingDraft[f.key]) : ''}
                      ?disabled=${disabled}
                      @sl-input=${(e) => onPricingInput(f.key, e)}
                    ></sl-input>
                  </td>
                `,
              )}
            </tr>
          </tbody>
        </table>
        ${
          hasAnyRate && !disabled
            ? html`<div class="model-editor-pricing-actions">
                <button
                  class="action-btn action-btn--secondary"
                  title="Clear all pricing fields — on save this removes worca.pricing.models.<alias> entirely"
                  @click=${onClearAll}
                >
                  ${unsafeHTML(iconSvg(Trash2, 14))}
                  Clear pricing
                </button>
              </div>`
            : ''
        }
      </sl-details>
    </div>
  `;
}

function _appliedBySection(appliedBy, projectId) {
  // Group references by (tier, template_id) so a template that uses the
  // alias for multiple agents collapses into one row instead of N copies.
  // The server returns the flat list because that's its natural shape;
  // grouping client-side keeps the API simple.
  const groups = new Map();
  for (const ref of appliedBy || []) {
    const key = `${ref.tier}:${ref.template_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        tier: ref.tier,
        template_id: ref.template_id,
        agents: [],
      });
    }
    if (ref.agent) groups.get(key).agents.push(ref.agent);
  }
  const groupList = Array.from(groups.values());
  const totalAgents = (appliedBy || []).length;

  // Per-tier badge variant — Project = primary (blue, "yours"),
  // User = neutral (shared across all your projects).
  const tierVariant = (tier) =>
    tier === 'project' ? 'primary' : tier === 'user' ? 'neutral' : 'warning';

  const templateHref = (tier, tid) =>
    projectId
      ? `#/project/${projectId}/templates/${tier}/${encodeURIComponent(tid)}/edit`
      : `#/templates/${tier}/${encodeURIComponent(tid)}/edit`;

  return html`
    <div class="editor-description-section model-editor-section">
      <div class="model-editor-section-head">
        <div>
          <h3 class="settings-section-title">Applied by</h3>
          <p class="settings-section-desc">
            Templates in <strong>this project</strong> and your
            <strong>user-tier</strong> templates that reference this alias.
            Built-in templates aren't walked (they live inside the
            <code>worca-cc</code> Python package); other projects'
            templates aren't walked either.
          </p>
        </div>
        ${
          groupList.length > 0
            ? html`<sl-badge variant="neutral" pill class="model-editor-applied-count">
                ${groupList.length} template${groupList.length === 1 ? '' : 's'}
                · ${totalAgents} agent${totalAgents === 1 ? '' : 's'}
              </sl-badge>`
            : ''
        }
      </div>
      ${
        groupList.length === 0
          ? html`<p class="settings-muted">(none discovered)</p>`
          : html`
              <div class="model-editor-applied-groups">
                ${groupList.map(
                  (g) => html`
                    <div class="model-editor-applied-row">
                      <div class="model-editor-applied-row-head">
                        <sl-badge variant=${tierVariant(g.tier)} pill>
                          ${g.tier}
                        </sl-badge>
                        <a
                          class="model-editor-applied-link"
                          href=${templateHref(g.tier, g.template_id)}
                          title="Open template editor"
                        >${g.template_id}</a>
                      </div>
                      ${
                        g.agents.length > 0
                          ? html`<div class="model-editor-applied-agents">
                              ${g.agents.map(
                                (a) =>
                                  html`<code class="model-editor-applied-agent">${a}</code>`,
                              )}
                            </div>`
                          : ''
                      }
                    </div>
                  `,
                )}
              </div>
            `
      }
    </div>
  `;
}

// Re-exports for main.js convenience
export { Cpu, ClipboardCopy, Copy, Lock };
