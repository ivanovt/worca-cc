/**
 * Pipelines list view — card grid grouped by tier.
 *
 * Features:
 * - Card grid grouped by tier (Built-in/User/Project)
 * - Tier badges using badge color language
 * - Name/desc/tags display
 * - ★ Default badges
 * - Action row (Edit/Duplicate/Set default/Export/Delete)
 * - Shadows hint when effectiveTier !== "builtin"
 * - Empty states
 * - 30s polling for updates
 */

import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import {
  Copy,
  Download,
  FileText,
  iconSvg,
  Pencil,
  Plus,
  Star,
  Trash2,
  Upload,
} from '../utils/icons.js';

// Tier variant mapping per badge-color-language guide
// Blue (primary) = active/foreground, Orange (warning) = caution, Grey (neutral) = inactive
const TIER_VARIANT = {
  project: 'primary', // project templates are the most relevant
  user: 'warning', // user templates are global but need attention
  worca: 'neutral', // built-in templates are immutable defaults
};

// Backwards compat: alias effectiveTier to tier for old code that reads "tier"
function normalizeTier(effectiveTier) {
  if (!effectiveTier || effectiveTier === 'worca') return 'builtin';
  return effectiveTier;
}

/**
 * Export a template as a downloadable JSON bundle.
 *
 * Fetches the redacted bundle from the server and triggers a browser download.
 * Shows an error toast if the export fails.
 *
 * @param {string} projectId - Project ID for API scoping
 * @param {string} templateId - Template ID to export
 * @param {string} templateName - Optional template name for filename
 */
export async function exportTemplate(projectId, templateId, templateName) {
  try {
    const baseUrl = projectId
      ? `/api/projects/${projectId}/templates`
      : '/api/templates';

    const response = await fetch(`${baseUrl}/${templateId}/bundle`);
    const data = await response.json();

    if (!data.ok) {
      throw new Error(data.error || 'Failed to export template');
    }

    // Create a blob from the bundle data
    const blob = new Blob([JSON.stringify(data.bundle, null, 2)], {
      type: 'application/json',
    });

    // Generate filename with template name or ID
    const filename = `${templateName || templateId}-bundle.json`;

    // Create download link and trigger click
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // Cleanup
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    // Dispatch success toast
    window.dispatchEvent(
      new CustomEvent('worca:toast', {
        detail: {
          message: `Template "${templateName || templateId}" exported successfully`,
          variant: 'success',
        },
      }),
    );

    return { success: true, filename };
  } catch (err) {
    // Dispatch error toast
    window.dispatchEvent(
      new CustomEvent('worca:toast', {
        detail: {
          message: `Failed to export template: ${err.message}`,
          variant: 'danger',
        },
      }),
    );

    return { success: false, error: err.message };
  }
}

/**
 * Copy a gist URL for a template when gh CLI is available.
 *
 * Creates a public gist via the server and copies the URL to clipboard.
 * Shows an error toast if gh CLI is not available or the operation fails.
 *
 * @param {string} projectId - Project ID for API scoping
 * @param {string} templateId - Template ID to gist
 * @param {string} templateName - Optional template name for toast message
 */
export async function copyGistUrl(projectId, templateId, templateName) {
  try {
    const baseUrl = projectId
      ? `/api/projects/${projectId}/templates`
      : '/api/templates';

    // Check if gh CLI is available by trying to create gist
    const response = await fetch(
      `${baseUrl}/${templateId}/bundle?format=gist`,
      {
        method: 'POST',
      },
    );

    if (!response.ok) {
      const data = await response.json();
      if (data.error?.includes('gh') || data.error?.includes('gist')) {
        throw new Error('GitHub CLI (gh) is not available on the server');
      }
      throw new Error(data.error || 'Failed to create gist');
    }

    const data = await response.json();

    if (!data.gist_url) {
      throw new Error('No gist URL returned from server');
    }

    // Copy to clipboard
    await navigator.clipboard.writeText(data.gist_url);

    // Dispatch success toast
    window.dispatchEvent(
      new CustomEvent('worca:toast', {
        detail: {
          message: `Gist URL copied to clipboard`,
          variant: 'success',
        },
      }),
    );

    return { success: true, gistUrl: data.gist_url };
  } catch (err) {
    // Dispatch error toast
    const message = err.message.includes('gh')
      ? 'GitHub CLI is not available on the server'
      : `Failed to create gist: ${err.message}`;

    window.dispatchEvent(
      new CustomEvent('worca:toast', {
        detail: { message, variant: 'danger' },
      }),
    );

    return { success: false, error: message };
  }
}

/**
 * Check if the GitHub CLI (gh) is available on the server.
 *
 * Caches the result to avoid repeated API calls.
 *
 * @param {string} projectId - Project ID for API scoping
 * @returns {Promise<boolean>} True if gh CLI is available
 */
export async function checkGistAvailability(projectId) {
  // Cache the result at module level
  if (this._ghAvailable !== undefined) {
    return this._ghAvailable;
  }

  try {
    const baseUrl = projectId ? `/api/projects/${projectId}` : '/api';
    const response = await fetch(`${baseUrl}/system/gh-cli-available`);

    if (!response.ok) {
      this._ghAvailable = false;
      return false;
    }

    const data = await response.json();
    this._ghAvailable = !!data.available;
    return this._ghAvailable;
  } catch {
    this._ghAvailable = false;
    return false;
  }
}

/**
 * Main pipelines list view.
 * @param {object} state - store state
 * @param {object} options - { rerender, onCreate, onEdit, onDuplicate, onSetDefault, onDelete, onExport, defaultTemplate }
 */
export function pipelinesView(state, options) {
  const {
    onCreate,
    onEdit,
    onDuplicate,
    onSetDefault,
    onDelete,
    onExport,
    defaultTemplate,
  } = options || {};
  const {
    templates = [],
    templatesLoaded = false,
    templatesError = null,
    worcaCliStatus = null,
  } = state;

  // Read-only / degraded mode: triggered when the worca-cc CLI is
  // missing or too old. The Pipelines list still renders (read paths
  // use the filesystem directly), but write actions are disabled and
  // a banner explains what to do.
  const degraded = worcaCliStatus && worcaCliStatus.ok === false;
  const handlers = {
    onEdit: degraded ? null : onEdit,
    onDuplicate: degraded ? null : onDuplicate,
    onSetDefault: degraded ? null : onSetDefault,
    onDelete: degraded ? null : onDelete,
    onExport, // export is read-only — always available
  };

  // Group templates by tier
  const templatesList = templates || [];
  const grouped = {
    project: templatesList.filter(
      (t) => t.effectiveTier === 'project' || t.tier === 'project',
    ),
    user: templatesList.filter(
      (t) => t.effectiveTier === 'user' || t.tier === 'user',
    ),
    builtins: templatesList.filter(
      (t) =>
        t.effectiveTier === 'builtin' ||
        t.effectiveTier === 'worca' ||
        t.tier === 'worca' ||
        t.tier === 'builtin',
    ),
  };

  const hasTemplates = templatesList.length > 0;
  const isLoaded = templatesLoaded;
  const hasError = templatesError !== null;

  return html`
    <div class="pipelines-view">
      <div class="pipelines-content">
        ${_degradedBanner(worcaCliStatus)}

        ${
          hasError
            ? html`
              <sl-alert variant="danger" open>
                <strong>Error loading templates</strong>
                ${templatesError}
              </sl-alert>
            `
            : ''
        }

        ${
          !isLoaded
            ? html`<sl-spinner class="pipelines-loading-spinner"></sl-spinner>`
            : html`
              ${
                !hasTemplates
                  ? _emptyState(degraded ? null : onCreate, degraded)
                  : html`
                    ${
                      grouped.builtins.length > 0
                        ? _tierSection(
                            'Built-in',
                            grouped.builtins,
                            defaultTemplate,
                            handlers,
                          )
                        : ''
                    }
                    ${
                      grouped.user.length > 0
                        ? _tierSection(
                            'User',
                            grouped.user,
                            defaultTemplate,
                            handlers,
                          )
                        : ''
                    }
                    ${
                      grouped.project.length > 0
                        ? _tierSection(
                            'Project',
                            grouped.project,
                            defaultTemplate,
                            handlers,
                          )
                        : ''
                    }
                  `
              }
            `
        }
      </div>
    </div>
  `;
}

/**
 * Render the worca-cc version-mismatch / not-installed banner.
 *
 * Returns nothing when the CLI is compatible (or status hasn't loaded
 * yet — staying quiet is better than flashing a banner that vanishes
 * once the probe lands).
 */
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
        template create / edit / delete / duplicate. ${installed} is installed.
      </div>
      <div class="pipelines-cli-banner-hint">
        Upgrade with <code>pip install --upgrade 'worca-cc>=${status.minimum}'</code>,
        then reload this page. List, view, and export keep working in the meantime.
      </div>
    </sl-alert>
  `;
}

/**
 * Render a tier section header with cards.
 */
function _tierSection(title, templates, defaultTemplateId, handlers) {
  if (!templates || templates.length === 0) return nothing;

  const { onEdit, onDuplicate, onSetDefault, onDelete, onExport } =
    handlers || {};

  return html`
    <section class="pipelines-tier-section">
      <h2 class="tier-section-header">${title}</h2>
      <div class="pipelines-grid">
        ${templates.map((t) =>
          _templateCard(t, defaultTemplateId, {
            onEdit,
            onDuplicate,
            onSetDefault,
            onDelete,
            onExport,
          }),
        )}
      </div>
    </section>
  `;
}

/**
 * Render a single template card.
 */
function _templateCard(template, defaultTemplateId, handlers) {
  const { onEdit, onDuplicate, onSetDefault, onDelete, onExport } =
    handlers || {};
  const {
    id,
    name,
    description,
    tags = [],
    effectiveTier,
    tier,
    shadows = [],
    builtin = false,
  } = template;

  const resolvedTier = normalizeTier(effectiveTier || tier);
  const isDefault = id === defaultTemplateId;
  const tierVariant = TIER_VARIANT[resolvedTier] || 'neutral';

  // Built-ins show "Duplicate" instead of "Edit"
  const isBuiltin = resolvedTier === 'builtin' || builtin;

  return html`
    <div class="run-card template-card">
      <div class="run-card-top">
        <span class="run-card-status">${unsafeHTML(iconSvg(FileText, 16))}</span>
        <span class="run-card-title">${name || id}</span>
        ${
          isDefault
            ? html`<sl-badge variant="primary" pill class="template-default-badge" title="Default template"
              >★ Default</sl-badge
            >`
            : ''
        }
        <sl-badge variant=${tierVariant} pill class="template-tier-badge">${resolvedTier}</sl-badge>
      </div>

      ${
        description
          ? html`<div class="run-card-meta">
          <span class="run-card-meta-item">
            <span class="meta-value">${description}</span>
          </span>
        </div>`
          : ''
      }

      ${
        tags && tags.length > 0
          ? html`<div class="run-card-stages">
            ${tags.map((tag) => html`<sl-tag size="small">${tag}</sl-tag>`)}
          </div>`
          : ''
      }

      ${
        shadows && shadows.length > 0 && resolvedTier !== 'builtin'
          ? html`<div class="run-card-meta">
            <span class="run-card-meta-item">
              <span class="meta-label">Shadows:</span>
              <span class="meta-value">${shadows.join(', ')}</span>
            </span>
          </div>`
          : ''
      }

      <div class="run-card-actions">
        ${
          isBuiltin
            ? html`<button
              class="action-btn action-btn--secondary"
              ?disabled=${!onDuplicate}
              @click=${() => onDuplicate?.(id)}
              title=${
                onDuplicate
                  ? 'Duplicate to project or user scope'
                  : 'Upgrade worca-cc to enable duplicate'
              }
            >
              ${unsafeHTML(iconSvg(Copy, 14))}
              Duplicate
            </button>`
            : html`<button
              class="action-btn action-btn--secondary"
              ?disabled=${!onEdit}
              @click=${() => onEdit?.(id)}
              title=${onEdit ? 'Edit template' : 'Upgrade worca-cc to enable edit'}
            >
              ${unsafeHTML(iconSvg(Pencil, 14))}
              Edit
            </button>`
        }
        ${
          !isDefault && !isBuiltin
            ? html`<button
              class="action-btn action-btn--secondary"
              ?disabled=${!onSetDefault}
              @click=${() => onSetDefault?.(id)}
              title=${
                onSetDefault
                  ? 'Set as default template'
                  : 'Upgrade worca-cc to enable Set Default'
              }
            >
              ${unsafeHTML(iconSvg(Star, 14))}
              Set Default
            </button>`
            : ''
        }
        <button
          class="action-btn action-btn--secondary"
          @click=${() => onExport?.(id)}
          title="Export template bundle"
        >
          ${unsafeHTML(iconSvg(Download, 14))}
          Export
        </button>
        ${
          !isBuiltin
            ? html`<button
              class="action-btn action-btn--danger"
              ?disabled=${!onDelete}
              @click=${() => onDelete?.(id, resolvedTier)}
              title=${
                onDelete
                  ? 'Delete template'
                  : 'Upgrade worca-cc to enable delete'
              }
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
 * Empty state for pipelines view.
 *
 * `onCreate` is passed `null` in degraded mode so the Create / Import
 * buttons render disabled. Disabling rather than hiding keeps the
 * affordance discoverable (and the banner above explains why).
 */
function _emptyState(onCreate, degraded = false) {
  const createDisabled = !onCreate || degraded;
  return html`
    <div class="empty-state pipelines-empty">
      <div class="empty-state-icon">${unsafeHTML(iconSvg(FileText, 48))}</div>
      <h2>No templates yet</h2>
      <p>Get started by importing a template or creating one from scratch.</p>
      <div class="empty-state-actions">
        <sl-button
          variant="primary"
          ?disabled=${createDisabled}
          @click=${() => onCreate?.()}
        >
          ${unsafeHTML(iconSvg(Plus, 16))} Create Template
        </sl-button>
        <sl-button variant="default" ?disabled=${degraded}>
          ${unsafeHTML(iconSvg(Upload, 16))} Import Bundle
        </sl-button>
      </div>
      <div class="empty-state-hint">
        <p>Or start from a built-in template by duplicating it to your project or user scope.</p>
      </div>
    </div>
  `;
}

/**
 * Fetch templates from the server.
 */
export function fetchTemplates(projectId) {
  const url = projectId
    ? `/api/projects/${projectId}/templates`
    : '/api/templates';
  return fetch(url).then(async (res) => {
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to fetch templates');
    return data.templates || [];
  });
}

/**
 * Create a template polling interval.
 * Call this from main.js to set up polling with access to store and rerender.
 * Returns a cleanup function.
 */
export function setupTemplatePolling(
  state,
  store,
  rerender,
  intervalMs = 30000,
) {
  // Helper to fetch and update state
  const fetchAndUpdate = async () => {
    try {
      const templates = await fetchTemplates(state.currentProjectId || null);
      store.setState({
        templates,
        templatesLoaded: true,
        templatesError: null,
      });
      rerender();
    } catch (err) {
      console.error('Failed to fetch templates:', err);
      store.setState({ templatesError: err.message, templatesLoaded: true });
      rerender();
    }
  };

  // Initial fetch
  fetchAndUpdate();

  // Set up polling
  const interval = setInterval(fetchAndUpdate, intervalMs);
  return () => clearInterval(interval);
}
