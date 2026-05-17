import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { elapsed, formatDuration, formatTimestamp } from '../utils/duration.js';
import { iconSvg, RotateCcw, Trash2 } from '../utils/icons.js';
import { statusClass, statusIcon } from '../utils/status-badge.js';
import { WORKSPACE_TERMINAL } from '../utils/status-constants.js';
import { projectBadgesView } from './fleet-card.js';

// Workspace-run status → sl-badge variant. Mirrors fleetStatusVariant so
// the two card types share their semantic colour grammar — primary for
// active, success for completed, danger for failed, warning for halted or
// integration-failed, neutral when blocked/paused.
const WS_STATUS_VARIANT = {
  planning: 'primary',
  running: 'primary',
  integration_testing: 'primary',
  completed: 'success',
  failed: 'danger',
  integration_failed: 'warning',
  halted: 'warning',
  blocked: 'neutral',
  paused: 'neutral',
};

const _FAILURE_CHILD_STATES = new Set([
  'failed',
  'setup_failed',
  'unrecoverable',
  'blocked',
]);

function _statusVariant(status) {
  return WS_STATUS_VARIANT[status] || 'neutral';
}

function _isTerminal(status) {
  return WORKSPACE_TERMINAL.has(status);
}

function _failedCount(children) {
  return (children || []).filter((c) => _FAILURE_CHILD_STATES.has(c.status))
    .length;
}

/**
 * Card-per-workspace-run component. Structural mirror of fleetCardView:
 *
 *   1. .run-card-top         — status icon + title + status badge
 *   2. .fleet-card-progress  — "Projects:" + per-child name badges
 *                              (reuses fleet's projectBadgesView for
 *                              identical chip styling) + failed count
 *   3. .run-card-meta        — Started · Last activity · Duration
 *   4. .run-card-actions     — Re-run / Cleanup (terminal only)
 *
 * No prompt row — prompts can be arbitrarily long and we don't surface
 * them on the fleet card or the pipeline run card either. The prompt
 * lives on the workspace detail page's Work Request section.
 *
 * @param {{
 *   workspace_id: string,
 *   workspace_id_short?: string,
 *   workspace_name?: string,
 *   workspace_root?: string,
 *   status: string,
 *   halt_reason?: string | null,
 *   work_request?: { title?: string, description?: string },
 *   children?: Array<{project?: string, project_path?: string, status?: string}>,
 *   children_count?: number,
 *   dag?: { tiers?: object[] },
 *   created_at?: string | null,
 *   updated_at?: string | null,
 * }} ws
 * @param {{
 *   onClick?: (workspaceId: string) => void,
 *   onRerun?: (workspaceId: string) => void,
 *   onCleanup?: (workspaceId: string) => void,
 * }} options
 */
export function workspaceCardView(ws, options = {}) {
  const { onClick, onRerun, onCleanup } = options;

  const status = ws.status || 'planning';
  const variant = _statusVariant(status);
  // workspace_id_short is the stable identifier in the title (mirrors
  // fleet's `Fleet <id_short>` fallback). Derive it client-side from the
  // trailing hex segment when the server doesn't emit it.
  const idShort =
    ws.workspace_id_short || ws.workspace_id?.split('_').pop() || '';
  const title = `Workspace ${idShort}`;
  const startedAt = ws.created_at || null;
  const lastActivityAt = ws.updated_at || null;
  // For active runs we pass `null` as end → `elapsed` ticks against
  // Date.now() so the displayed duration grows live. For terminal runs
  // we freeze at `finished_at` (synthesized server-side from max child
  // completed_at) falling back to `updated_at` for older manifests.
  const terminalEndedAt = _isTerminal(status)
    ? ws.finished_at || lastActivityAt
    : null;
  const duration = startedAt
    ? formatDuration(elapsed(startedAt, terminalEndedAt))
    : null;

  const children = ws.children || [];
  const failedCount = _failedCount(children);

  const terminal = _isTerminal(status);
  const showRerun = onRerun && terminal;
  const showCleanup = onCleanup && terminal;

  const handleCardClick = onClick
    ? (e) => {
        if (e.target.closest('button, a, sl-button')) return;
        onClick(ws.workspace_id);
      }
    : null;

  return html`
    <div
      class="run-card workspace-run-card ${statusClass(status)}"
      data-workspace-id="${ws.workspace_id || ''}"
      @click=${handleCardClick}
    >
      <div class="run-card-top">
        <span class="run-card-status">
          ${unsafeHTML(statusIcon(status, 16))}
        </span>
        <span class="run-card-title">${title}</span>
        <sl-badge
          variant="${variant}"
          pill
          class="workspace-card-status-badge status-badge-${status}"
        >${status}</sl-badge>
      </div>

      <div class="fleet-card-progress">
        <span class="meta-label fleet-card-children-label">Projects:</span>
        ${
          children.length > 0
            ? projectBadgesView(children)
            : html`<span class="fleet-card-children-empty">No projects dispatched yet</span>`
        }
        ${
          failedCount > 0
            ? html`<span class="fleet-card-failed-count">${failedCount} failed</span>`
            : nothing
        }
      </div>

      <div class="run-card-meta">
        ${
          startedAt
            ? html`<span class="run-card-meta-item">
                <span class="meta-label">Started:</span>
                <span class="meta-value">${formatTimestamp(startedAt)}</span>
              </span>`
            : nothing
        }
        ${
          lastActivityAt && lastActivityAt !== startedAt
            ? html`<span class="run-card-meta-item">
                <span class="meta-label">Last activity:</span>
                <span class="meta-value">${formatTimestamp(lastActivityAt)}</span>
              </span>`
            : nothing
        }
        ${
          duration
            ? html`<span class="run-card-meta-item">
                <span class="meta-label">Duration:</span>
                <span class="meta-value">${duration}</span>
              </span>`
            : nothing
        }
      </div>

      ${
        showRerun || showCleanup
          ? html`
            <div class="run-card-actions">
              ${
                showRerun
                  ? html`
                    <sl-button size="small" variant="primary" outline class="btn-workspace-rerun" @click=${(
                      e,
                    ) => {
                      e.stopPropagation();
                      onRerun(ws.workspace_id);
                    }}>
                      ${unsafeHTML(iconSvg(RotateCcw, 12))} Re-run
                    </sl-button>
                  `
                  : nothing
              }
              ${
                showCleanup
                  ? html`
                    <sl-button size="small" variant="danger" outline class="btn-workspace-cleanup" @click=${(
                      e,
                    ) => {
                      e.stopPropagation();
                      onCleanup(ws.workspace_id);
                    }}>
                      ${unsafeHTML(iconSvg(Trash2, 12))} Cleanup
                    </sl-button>
                  `
                  : nothing
              }
            </div>
          `
          : nothing
      }
    </div>
  `;
}
