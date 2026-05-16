import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { elapsed, formatDuration, formatTimestamp } from '../utils/duration.js';
import { iconSvg, RotateCcw, Trash2 } from '../utils/icons.js';
import { statusClass, statusIcon } from '../utils/status-badge.js';

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

function _statusVariant(status) {
  return WS_STATUS_VARIANT[status] || 'neutral';
}

function _isTerminal(status) {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'integration_failed' ||
    status === 'halted'
  );
}

function _tierCount(dag) {
  return Array.isArray(dag?.tiers) ? dag.tiers.length : 0;
}

/**
 * Card-per-workspace-run component. Same shape as fleetCardView so the
 * two list views look like siblings: status stripe on the left
 * (via .run-card + statusClass), status icon + bold title on top, pill
 * status badge in the top-right, label:value meta rows, and a small
 * action row at the bottom.
 *
 * @param {{
 *   workspace_id: string,
 *   workspace_id_short?: string,
 *   workspace_name?: string,
 *   workspace_root?: string,
 *   status: string,
 *   halt_reason?: string | null,
 *   work_request?: { title?: string, description?: string },
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
  const title =
    ws.workspace_name ||
    `Workspace ${ws.workspace_id_short || ws.workspace_id || ''}`;
  const prompt = ws.work_request?.title || ws.work_request?.description || '';
  const startedAt = ws.created_at || null;
  const lastActivityAt = ws.updated_at || null;
  const duration =
    startedAt && lastActivityAt
      ? formatDuration(elapsed(startedAt, lastActivityAt))
      : startedAt
        ? formatDuration(elapsed(startedAt, null))
        : null;

  const tiers = _tierCount(ws.dag);
  const repoCount = ws.children_count ?? 0;
  const repoSummary =
    tiers > 1 ? `${repoCount} (${tiers} tiers)` : `${repoCount}`;

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

      ${
        prompt
          ? html`
            <div class="workspace-card-prompt" title="${prompt}">
              ${prompt}
            </div>
          `
          : nothing
      }

      <div class="run-card-meta">
        <span class="run-card-meta-item">
          <span class="meta-label">Repos:</span>
          <span class="meta-value">${repoSummary}</span>
        </span>
        ${
          ws.workspace_root
            ? html`<span class="run-card-meta-item">
                <span class="meta-label">Root:</span>
                <span class="meta-value workspace-card-root">${ws.workspace_root}</span>
              </span>`
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
        <span class="run-card-meta-item workspace-card-id">
          <span class="meta-label">ID:</span>
          <code class="meta-value">${ws.workspace_id || '—'}</code>
        </span>
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
