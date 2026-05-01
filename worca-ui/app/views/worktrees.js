import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { formatDuration } from '../utils/duration.js';
import { FolderOpen, iconSvg, Trash2 } from '../utils/icons.js';
import { sortByStartDesc } from '../utils/sort-runs.js';
import { statusClass, statusIcon } from '../utils/status-badge.js';

function _formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function _formatAge(ageSeconds) {
  return formatDuration((ageSeconds || 0) * 1000);
}

function _groupLabel(wt) {
  if (wt.group_type === 'fleet' && wt.fleet_id) return `fleet:${wt.fleet_id}`;
  if (wt.group_type === 'workspace' && wt.workspace_id)
    return `workspace:${wt.workspace_id}`;
  return null;
}

function _matchesFilter(wt, filter) {
  const q = filter.toLowerCase();
  return (
    (wt.title || '').toLowerCase().includes(q) ||
    (wt.branch || '').toLowerCase().includes(q) ||
    (_groupLabel(wt) || '').toLowerCase().includes(q) ||
    (wt.worktree_path || '').toLowerCase().includes(q)
  );
}

const STATUS_BADGE_VARIANT = {
  running: 'primary',
  completed: 'success',
  failed: 'danger',
  paused: 'warning',
  cancelled: 'neutral',
};

function _statusBadgeVariant(status) {
  return STATUS_BADGE_VARIANT[status] || 'neutral';
}

function _diskSummaryView(worktrees) {
  const total = worktrees.reduce((s, w) => s + (w.disk_bytes || 0), 0);
  const cleanable = worktrees
    .filter((w) => w.status === 'completed')
    .reduce((s, w) => s + (w.disk_bytes || 0), 0);
  const resumable = worktrees.filter((w) => w.resumable);
  const resumableBytes = resumable.reduce((s, w) => s + (w.disk_bytes || 0), 0);
  const over2gb = total > 2_000_000_000;

  // Warning banner only when over the threshold; otherwise a quiet meta line.
  if (over2gb) {
    return html`
      <sl-alert variant="warning" open class="worktrees-disk-alert">
        <strong>Worktree disk usage is high:</strong>
        ${_formatBytes(total)} across ${worktrees.length} worktrees
        (${_formatBytes(cleanable)} cleanable
        ${
          resumable.length > 0
            ? html` · ${_formatBytes(resumableBytes)} held by resumable runs`
            : nothing
        }).
      </sl-alert>
    `;
  }

  return html`
    <div class="worktrees-summary">
      <span class="meta-label">Total disk:</span>
      <span class="meta-value">${_formatBytes(total)}</span>
      <span class="meta-sep">·</span>
      <span class="meta-label">Cleanable:</span>
      <span class="meta-value">${_formatBytes(cleanable)}</span>
      ${
        resumable.length > 0
          ? html`
              <span class="meta-sep">·</span>
              <span class="meta-label">Held by resumable:</span>
              <span class="meta-value">${_formatBytes(resumableBytes)}</span>
            `
          : nothing
      }
    </div>
  `;
}

function _cardView(wt, { onSelectRun, onCleanup } = {}) {
  const isRunning = wt.status === 'running';
  const groupLabel = _groupLabel(wt);
  const status = wt.status || 'unknown';

  return html`
    <div class="run-card worktree-card ${statusClass(status)}">
      <div class="run-card-top">
        <span class="run-card-status">
          ${unsafeHTML(statusIcon(status, 16))}
        </span>
        <span class="run-card-title">${wt.title || wt.run_id}</span>
        <sl-badge
          variant="${_statusBadgeVariant(status)}"
          pill
          class="status-badge-${status}"
        >
          ${status}
        </sl-badge>
      </div>
      <div class="run-card-meta">
        <span class="run-card-meta-item">
          <span class="meta-label">Branch:</span>
          <span class="meta-value">${wt.branch || '—'}</span>
        </span>
        <span class="run-card-meta-item">
          <span class="meta-label">Disk:</span>
          <span class="meta-value">${_formatBytes(wt.disk_bytes)}</span>
        </span>
        <span class="run-card-meta-item">
          <span class="meta-label">Age:</span>
          <span class="meta-value">${_formatAge(wt.age_seconds)}</span>
        </span>
        ${
          groupLabel
            ? html`
                <span class="run-card-meta-item">
                  <span class="meta-label">Group:</span>
                  <span class="meta-value">${groupLabel}</span>
                </span>
              `
            : nothing
        }
      </div>
      <div class="run-card-meta worktree-card-path">
        <span class="meta-label">Path:</span>
        <code class="worktree-path-mono">${wt.worktree_path}</code>
      </div>
      <div class="run-card-actions">
        <sl-button
          size="small"
          variant="default"
          class="btn-open-run"
          @click=${onSelectRun ? () => onSelectRun(wt.run_id) : null}
        >
          ${unsafeHTML(iconSvg(FolderOpen, 12))} Open
        </sl-button>
        <sl-button
          size="small"
          variant="danger"
          outline
          class="btn-cleanup${isRunning ? ' btn-cleanup-disabled' : ''}"
          ?disabled=${isRunning}
          title=${isRunning ? 'Cannot cleanup a running worktree' : nothing}
          @click=${!isRunning && onCleanup ? () => onCleanup(wt) : null}
        >
          ${unsafeHTML(iconSvg(Trash2, 12))} Cleanup
        </sl-button>
      </div>
    </div>
  `;
}

function _cleanupDialogView(
  dialogItem,
  dialogCheckbox,
  { onDialogClose, onDialogConfirm, onDialogCheckboxChange } = {},
) {
  if (!dialogItem) return nothing;

  const needsCheckbox = dialogItem.resumable || !!dialogItem.group_type;
  const isGrouped = !!dialogItem.group_type;
  const confirmDisabled = needsCheckbox && !dialogCheckbox;

  return html`
    <sl-dialog
      label="Cleanup worktree"
      class="worktrees-dialog-cleanup"
      open
      @sl-request-close=${onDialogClose}
    >
      <p>
        Remove worktree for
        <strong>${dialogItem.title || dialogItem.run_id}</strong>?
      </p>
      ${
        isGrouped
          ? html`
              <sl-alert variant="warning" open class="group-warning">
                This worktree belongs to
                <strong>${_groupLabel(dialogItem)}</strong> — removing it will
                block the group's <code>--resume</code> for this child.
              </sl-alert>
            `
          : nothing
      }
      ${
        needsCheckbox
          ? html`
              <sl-checkbox
                class="cleanup-resume-checkbox"
                ?checked=${dialogCheckbox}
                @sl-change=${
                  onDialogCheckboxChange
                    ? (e) => onDialogCheckboxChange(e.target.checked)
                    : null
                }
              >
                I understand resume will be unavailable
              </sl-checkbox>
            `
          : nothing
      }
      <div slot="footer" class="dialog-actions">
        <sl-button variant="default" @click=${onDialogClose}>Cancel</sl-button>
        <sl-button
          variant="danger"
          class="btn-cleanup-confirm${confirmDisabled ? ' btn-cleanup-confirm-disabled' : ''}"
          ?disabled=${confirmDisabled}
          @click=${
            !confirmDisabled && onDialogConfirm && dialogItem
              ? () => onDialogConfirm(dialogItem.run_id, needsCheckbox)
              : null
          }
        >
          ${unsafeHTML(iconSvg(Trash2, 12))} Cleanup
        </sl-button>
      </div>
    </sl-dialog>
  `;
}

function _bulkDialogView(
  worktrees,
  open,
  { onDialogClose, onDialogConfirm } = {},
) {
  const completed = worktrees.filter((w) => w.status === 'completed');
  // No completed → no bulk dialog markup at all (so the toolbar's
  // "Cleanup all completed" button class doesn't leak into the page
  // via the dialog footer).
  if (completed.length === 0) return nothing;
  const totalBytes = completed.reduce((s, w) => s + (w.disk_bytes || 0), 0);

  const standalone = completed.filter((w) => !w.group_type);
  const byFleet = {};
  const byWorkspace = {};
  for (const w of completed) {
    if (w.group_type === 'fleet' && w.fleet_id) {
      if (!byFleet[w.fleet_id]) byFleet[w.fleet_id] = [];
      byFleet[w.fleet_id].push(w);
    } else if (w.group_type === 'workspace' && w.workspace_id) {
      if (!byWorkspace[w.workspace_id]) byWorkspace[w.workspace_id] = [];
      byWorkspace[w.workspace_id].push(w);
    }
  }

  const groupLines = [
    standalone.length > 0 ? `${standalone.length} standalone` : null,
    ...Object.entries(byFleet).map(
      ([id, ws]) => `${ws.length} from fleet ${id}`,
    ),
    ...Object.entries(byWorkspace).map(
      ([id, ws]) => `${ws.length} from workspace ${id}`,
    ),
  ].filter(Boolean);

  return html`
    <sl-dialog
      label="Cleanup all completed worktrees"
      class="worktrees-dialog-bulk"
      ?open=${open}
      @sl-request-close=${onDialogClose}
    >
      <p>
        Clean up ${completed.length} completed worktrees
        (${_formatBytes(totalBytes)} freed)?
      </p>
      ${
        groupLines.length > 0
          ? html`
              <ul class="worktrees-bulk-groups">
                ${groupLines.map((line) => html`<li>${line}</li>`)}
              </ul>
            `
          : nothing
      }
      <div slot="footer" class="dialog-actions">
        <sl-button variant="default" @click=${onDialogClose}>Cancel</sl-button>
        <sl-button
          variant="danger"
          class="btn-bulk-cleanup-confirm"
          @click=${onDialogConfirm ? () => onDialogConfirm(null, true) : null}
        >
          ${unsafeHTML(iconSvg(Trash2, 12))} Cleanup All
        </sl-button>
      </div>
    </sl-dialog>
  `;
}

export function worktreesView(
  worktrees,
  {
    filter = '',
    onFilter,
    onSelectRun,
    onCleanup,
    onBulkCleanup,
    dialogItem = null,
    dialogBulk = false,
    dialogCheckbox = false,
    onDialogClose,
    onDialogConfirm,
    onDialogCheckboxChange,
  } = {},
) {
  if (!worktrees || worktrees.length === 0) {
    return html`
      <div class="worktrees-view">
        <div class="empty-state">
          No worktrees yet. Start a run to create one.
        </div>
      </div>
    `;
  }

  // Sort newest first to match run-list.js. sortByStartDesc keys on
  // started_at and tolerates missing values.
  const filtered = sortByStartDesc(
    filter ? worktrees.filter((wt) => _matchesFilter(wt, filter)) : worktrees,
  );
  const completedCount = worktrees.filter(
    (w) => w.status === 'completed',
  ).length;

  return html`
    <div class="worktrees-view">
      ${_diskSummaryView(worktrees)}
      <div class="worktrees-toolbar">
        <sl-input
          size="small"
          class="worktrees-filter"
          type="text"
          placeholder="Filter by title, branch, path, or group…"
          value="${filter || ''}"
          @sl-input=${onFilter ? (e) => onFilter(e.target.value) : null}
        ></sl-input>
        ${
          completedCount > 0
            ? html`
                <sl-button
                  size="small"
                  variant="danger"
                  outline
                  class="btn-bulk-cleanup"
                  @click=${onBulkCleanup}
                >
                  ${unsafeHTML(iconSvg(Trash2, 12))} Cleanup all completed
                  (${completedCount})
                </sl-button>
              `
            : nothing
        }
      </div>
      ${
        filtered.length === 0
          ? html`<div class="empty-state">No worktrees match the filter.</div>`
          : html`
              <div class="run-list worktrees-list">
                ${filtered.map((wt) =>
                  _cardView(wt, { onSelectRun, onCleanup }),
                )}
              </div>
            `
      }
      ${_bulkDialogView(worktrees, dialogBulk, { onDialogClose, onDialogConfirm })}
      ${_cleanupDialogView(dialogItem, dialogCheckbox, {
        onDialogClose,
        onDialogConfirm,
        onDialogCheckboxChange,
      })}
    </div>
  `;
}
