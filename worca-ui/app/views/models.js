/**
 * Models list view — tier-aware card grid.
 *
 * Mirrors pipelines.js exactly so the mental model from Pipeline Templates
 * carries over: three stacked `sl-details` sections (Project default-open,
 * User + Built-in collapsed), each with icon/title/count/description, card
 * grid using the run-card pattern, empty states per tier.
 *
 * Resolution rule (mirrors src/worca/utils/settings.py):
 *   For any given alias name, the runtime walks Project → User → Built-in
 *   and uses the first tier that defines it, in entirety. No cross-tier
 *   field merge. To shadow an upper tier, click its card and Duplicate.
 */

import { html, nothing } from 'lit-html';
import { ifDefined } from 'lit-html/directives/if-defined.js';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { helpFor } from '../utils/help-links.js';
import {
  Copy,
  Cpu,
  FolderOpen,
  iconSvg,
  Lock,
  Trash2,
  Users,
} from '../utils/icons.js';
import { envHasPlaceholder } from '../utils/secret-placeholders.js';

/**
 * Per-tier metadata for section headers — copy of the TIER_SECTIONS structure
 * from pipelines.js so the two pages stay visually aligned. Project is the
 * tier users land here to manage, so it's open by default; User and Built-in
 * stay collapsed (their count badge tells you at a glance whether there's
 * anything inside).
 */
const TIER_SECTIONS = [
  {
    key: 'project',
    title: 'Project',
    icon: FolderOpen,
    desc: 'Stored in this repo at .claude/settings.json — versioned with code. Project models shadow User and Built-in by alias name.',
    emptyTitle: 'No project models yet',
    emptyDesc:
      'Click New, or Duplicate a User / Built-in entry to start tracking a project-scoped alias here.',
    defaultOpen: true,
  },
  {
    key: 'user',
    title: 'User',
    icon: Users,
    desc: 'Shared across all your projects from ~/.worca/settings.json. User models shadow Built-in.',
    emptyTitle: 'No user models yet',
    emptyDesc:
      'Duplicate a Built-in into this scope, or click New, to share an alias across every project on this machine.',
    defaultOpen: false,
  },
  {
    key: 'builtin',
    title: 'Built-in',
    icon: Cpu,
    desc: 'Ship with worca-cc (opus, sonnet, haiku shorthands). Immutable — duplicate to edit.',
    emptyTitle: 'No built-in models found',
    emptyDesc:
      'These ship with worca-cc; the runtime would still resolve them but the UI listing is empty.',
    defaultOpen: false,
  },
];

/**
 * Top-level Models view.
 *
 * @param {object} state - { models, modelsLoaded, modelsError, worcaCliStatus }
 * @param {object} options - { onEdit, onDuplicate, onDelete, onCreate }
 */
export function modelsView(state, options) {
  const { onEdit, onDuplicate, onDelete } = options || {};
  const {
    models = [],
    modelsLoaded = false,
    modelsError = null,
    worcaCliStatus = null,
  } = state;

  const degraded = worcaCliStatus && worcaCliStatus.ok === false;
  const handlers = {
    onEdit, // edit is always available (read-only mode handles builtins)
    onDuplicate: degraded ? null : onDuplicate,
    onDelete: degraded ? null : onDelete,
  };

  // Group models by tier — server returns a flat list with `tier` field.
  const grouped = { project: [], user: [], builtin: [] };
  for (const m of models || []) {
    if (grouped[m.tier]) grouped[m.tier].push(m);
  }
  // Stable sort by alias within each tier so the order is deterministic
  // (matches the JSON object key order from settings.json in most cases).
  for (const key of Object.keys(grouped)) {
    grouped[key].sort((a, b) => a.alias.localeCompare(b.alias));
  }

  const isLoaded = modelsLoaded;
  const hasError = modelsError !== null;

  return html`
    <div class="models-view pipelines-view">
      <div class="pipelines-content">
        ${helpFor('models')}
        ${_degradedBanner(worcaCliStatus)}

        ${
          hasError
            ? html`
              <sl-alert variant="danger" open>
                <strong>Error loading models</strong>
                ${modelsError}
              </sl-alert>
            `
            : ''
        }

        ${
          !isLoaded
            ? html`<sl-spinner class="pipelines-loading-spinner"></sl-spinner>`
            : html`
              ${TIER_SECTIONS.map((tier) =>
                _tierSection(tier, grouped[tier.key] || [], handlers),
              )}
            `
        }
      </div>
    </div>
  `;
}

function _degradedBanner(status) {
  if (!status || status.ok !== false) return nothing;
  const installed = status.installed
    ? html`<code>worca-cc ${status.installed}</code>`
    : html`<em>worca CLI not found on PATH</em>`;
  return html`
    <sl-alert
      class="pipelines-cli-banner"
      variant="warning"
      open
      role="status"
    >
      <strong slot="header">Editing is disabled</strong>
      <div>
        This UI needs <code>worca-cc ${status.minimum}</code> or later for
        model alias create / edit / delete / duplicate. ${installed} is installed.
      </div>
      <div class="pipelines-cli-banner-hint">
        Upgrade with <code>pip install --upgrade 'worca-cc>=${status.minimum}'</code>,
        then reload this page. Listing and viewing keeps working in the meantime.
      </div>
    </sl-alert>
  `;
}

/**
 * Render a tier section as a collapsible `sl-details`. Mirrors
 * pipelines.js `_tierSection`. Always rendered — empty tiers keep their
 * header and show a small note so the page structure is consistent.
 */
function _tierSection(tier, models, handlers) {
  const list = models || [];
  const count = list.length;

  return html`
    <sl-details
      class="pipelines-tier-section pipelines-tier-section--${tier.key}"
      ?open=${tier.defaultOpen}
    >
      <div slot="summary" class="tier-section-header">
        <span class="tier-section-icon">
          ${unsafeHTML(iconSvg(tier.icon, 16))}
        </span>
        <span class="tier-section-title">${tier.title}</span>
        <sl-badge variant="neutral" pill class="tier-section-count">${count}</sl-badge>
        <span class="tier-section-desc">${tier.desc}</span>
      </div>
      ${
        count > 0
          ? html`
              <div class="pipelines-grid">
                ${list.map((m) => _modelCard(m, handlers))}
              </div>
            `
          : html`
              <div class="tier-section-empty">
                <div class="tier-section-empty-title">${tier.emptyTitle}</div>
                <p class="tier-section-empty-desc">${tier.emptyDesc}</p>
              </div>
            `
      }
    </sl-details>
  `;
}

/**
 * Render a single model card.
 *
 * Whole-card click opens the editor:
 *   - Project/User tiers: editable.
 *   - Built-in tier: opens read-only; explicit Duplicate button forks it.
 *
 * Action buttons stop event propagation so they don't double-fire as a
 * card click.
 */
function _modelCard(model, handlers) {
  const { onEdit, onDuplicate, onDelete } = handlers || {};
  const {
    tier,
    alias,
    id,
    env,
    env_count,
    pricing,
    has_alt_endpoint,
    builtin,
    imported_from,
  } = model;
  const isBuiltin = tier === 'builtin' || builtin;
  const needsSecret = envHasPlaceholder(env);

  const cardClick = onEdit;
  const cardClickable = Boolean(cardClick);
  const cardClass = `run-card model-tier-card${cardClickable ? ' model-tier-card--clickable' : ''}`;
  const cardTitle = !cardClickable
    ? 'Upgrade worca-cc to enable editing'
    : isBuiltin
      ? 'Click to view model (read-only) — use Duplicate to edit'
      : 'Click to edit model';
  const onCardActivate = cardClickable ? () => cardClick(tier, alias) : null;
  const onCardKeydown = cardClickable
    ? (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          cardClick(tier, alias);
        }
      }
    : null;
  const stop = (e) => e.stopPropagation();

  return html`
    <div
      class=${cardClass}
      role=${ifDefined(cardClickable ? 'button' : undefined)}
      tabindex=${ifDefined(cardClickable ? '0' : undefined)}
      title=${cardTitle}
      aria-disabled=${ifDefined(cardClickable ? undefined : 'true')}
      data-tier=${tier}
      data-alias=${alias}
      @click=${onCardActivate}
      @keydown=${onCardKeydown}
    >
      <div class="run-card-top">
        <span class="run-card-status">${unsafeHTML(iconSvg(isBuiltin ? Lock : Cpu, 16))}</span>
        <span class="run-card-title">${alias}</span>
        ${
          has_alt_endpoint
            ? html`<sl-badge variant="warning" pill class="model-tier-card-alt-badge" title="Alt-endpoint (env routes Claude CLI off the default Anthropic endpoint)">
                alt-endpoint
              </sl-badge>`
            : ''
        }
        ${
          needsSecret
            ? html`<sl-badge variant="danger" pill class="model-tier-card-needs-secret" title="One or more env values are placeholders left by a bundle import — open the model to replace them with a real secret">
                Not configured
              </sl-badge>`
            : ''
        }
      </div>
      <div class="template-card-id-row">
        <span class="template-card-id-badge" title="Model ID">
          <span class="template-card-id-label">ID:</span>
          <code class="template-card-id">${id || '(unset)'}</code>
        </span>
      </div>

      ${
        env_count > 0 ||
        (pricing && Object.keys(pricing).length > 0) ||
        imported_from
          ? html`<div class="run-card-meta model-tier-card-meta">
              ${
                env_count > 0
                  ? html`<span class="run-card-meta-item">
                      <sl-badge variant="neutral" pill>${env_count} env var${env_count === 1 ? '' : 's'}</sl-badge>
                    </span>`
                  : ''
              }
              ${
                pricing && Object.keys(pricing).length > 0
                  ? html`<span class="run-card-meta-item">
                      <sl-badge variant="primary" pill>pricing</sl-badge>
                    </span>`
                  : ''
              }
              ${
                imported_from
                  ? html`<span class="run-card-meta-item" title="Imported via worca templates import — badge drops after the first UI edit">
                      <sl-badge variant="neutral" pill class="model-card-imported-badge">
                        Imported · ${imported_from}
                      </sl-badge>
                    </span>`
                  : ''
              }
            </div>`
          : ''
      }

      <div class="run-card-actions" @click=${stop}>
        <button
          class="action-btn action-btn--secondary"
          ?disabled=${!onDuplicate}
          @click=${() => onDuplicate?.(tier, alias)}
          title=${onDuplicate ? 'Duplicate to another tier or alias' : 'Upgrade worca-cc to enable duplicate'}
        >
          ${unsafeHTML(iconSvg(Copy, 14))}
          Duplicate
        </button>
        ${
          !isBuiltin
            ? html`<button
                class="action-btn action-btn--danger template-card-delete-push"
                ?disabled=${!onDelete}
                @click=${() => onDelete?.(tier, alias)}
                title=${onDelete ? 'Delete model' : 'Upgrade worca-cc to enable delete'}
              >
                ${unsafeHTML(iconSvg(Trash2, 14))}
                Delete
              </button>`
            : ''
        }
      </div>
    </div>
  `;
}

/**
 * Fetch models from the server. Returns the flat list of `{tier, alias, ...}`
 * rows. Mirrors fetchTemplates' shape so the polling helper is symmetric.
 */
export function fetchModels(projectId) {
  const url = projectId ? `/api/projects/${projectId}/models` : '/api/models';
  return fetch(url).then(async (res) => {
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to fetch models');
    return data.models || [];
  });
}

export function setupModelsPolling(state, store, rerender, intervalMs = 30000) {
  const fetchAndUpdate = async () => {
    try {
      const models = await fetchModels(state.currentProjectId || null);
      store.setState({ models, modelsLoaded: true, modelsError: null });
      rerender();
    } catch (err) {
      console.error('Failed to fetch models:', err);
      store.setState({ modelsError: err.message, modelsLoaded: true });
      rerender();
    }
  };
  fetchAndUpdate();
  const interval = setInterval(fetchAndUpdate, intervalMs);
  return () => clearInterval(interval);
}
