import { html, nothing } from 'lit-html';
import { formatDuration } from '../utils/duration.js';

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
  return '—';
}

function _matchesFilter(wt, filter) {
  const q = filter.toLowerCase();
  return (
    (wt.title || '').toLowerCase().includes(q) ||
    (wt.branch || '').toLowerCase().includes(q) ||
    _groupLabel(wt).toLowerCase().includes(q)
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

function _diskHeaderView(worktrees) {
  const total = worktrees.reduce((s, w) => s + (w.disk_bytes || 0), 0);
  const cleanable = worktrees
    .filter((w) => w.status === 'completed')
    .reduce((s, w) => s + (w.disk_bytes || 0), 0);
  const resumable = worktrees.filter((w) => w.resumable);
  const resumableBytes = resumable.reduce((s, w) => s + (w.disk_bytes || 0), 0);
  const over2gb = total > 2_000_000_000;

  return html`
    <div class="worktrees-disk-header${over2gb ? ' disk-warning' : ''}">
      <span class="worktrees-disk-total">
        Total worktree disk: ${_formatBytes(total)} across ${worktrees.length} worktrees · ${_formatBytes(cleanable)} cleanable
      </span>
      ${
        resumable.length > 0
          ? html`<span class="worktrees-disk-resumable">Resumable: ${_formatBytes(resumableBytes)} across ${resumable.length} worktrees (cleanup blocks resume)</span>`
          : nothing
      }
    </div>
  `;
}

function _rowView(wt, { onSelectRun, onCleanup } = {}) {
  const isRunning = wt.status === 'running';
  const groupLabel = _groupLabel(wt);

  return html`
    <tr class="worktree-row worktree-row-${wt.status}">
      <td class="worktree-title">${wt.title || wt.run_id}</td>
      <td class="worktree-status">
        <sl-badge variant="${_statusBadgeVariant(wt.status)}" pill class="status-badge-${wt.status}">
          ${wt.status}
        </sl-badge>
      </td>
      <td class="worktree-branch">${wt.branch || '—'}</td>
      <td class="worktree-path">${wt.worktree_path}</td>
      <td class="worktree-disk">${_formatBytes(wt.disk_bytes)}</td>
      <td class="worktree-age">${_formatAge(wt.age_seconds)}</td>
      <td class="worktree-group">${groupLabel}</td>
      <td class="worktree-actions">
        <sl-button
          size="small"
          variant="default"
          class="btn-open-run"
          @click=${onSelectRun ? () => onSelectRun(wt.run_id) : null}>
          Open
        </sl-button>
        <sl-button
          size="small"
          variant="danger"
          outline
          class="btn-cleanup${isRunning ? ' btn-cleanup-disabled' : ''}"
          ?disabled=${isRunning}
          title=${isRunning ? 'Cannot cleanup a running worktree' : nothing}
          @click=${!isRunning && onCleanup ? () => onCleanup(wt) : null}>
          Cleanup
        </sl-button>
      </td>
    </tr>
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
    <div class="worktrees-dialog-cleanup">
      <p>Remove worktree for <strong>${dialogItem.title}</strong>?</p>
      ${
        isGrouped
          ? html`<p class="group-warning">This worktree belongs to <strong>${_groupLabel(dialogItem)}</strong> — removing it will block the group's <code>--resume</code> for this child.</p>`
          : nothing
      }
      ${
        needsCheckbox
          ? html`
            <label class="cleanup-confirm-label">
              <input
                type="checkbox"
                class="cleanup-resume-checkbox"
                ?checked=${dialogCheckbox}
                @change=${onDialogCheckboxChange ? (e) => onDialogCheckboxChange(e.target.checked) : null}>
              I understand resume will be unavailable
            </label>
          `
          : nothing
      }
      <div class="dialog-actions">
        <sl-button variant="default" @click=${onDialogClose}>Cancel</sl-button>
        <sl-button
          variant="danger"
          class="btn-cleanup-confirm${confirmDisabled ? ' btn-cleanup-confirm-disabled' : ''}"
          ?disabled=${confirmDisabled}
          @click=${!confirmDisabled && onDialogConfirm ? () => onDialogConfirm(dialogItem.run_id, needsCheckbox) : null}>
          Cleanup
        </sl-button>
      </div>
    </div>
  `;
}

function _bulkDialogView(worktrees, { onDialogClose, onDialogConfirm } = {}) {
  const completed = worktrees.filter((w) => w.status === 'completed');
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
    <div class="worktrees-dialog-bulk">
      <p>Clean up ${completed.length} completed worktrees (${_formatBytes(totalBytes)} freed)?</p>
      <ul class="worktrees-bulk-groups">
        ${groupLines.map((line) => html`<li>${line}</li>`)}
      </ul>
      <div class="dialog-actions">
        <sl-button variant="default" @click=${onDialogClose}>Cancel</sl-button>
        <sl-button
          variant="danger"
          class="btn-bulk-cleanup-confirm"
          @click=${onDialogConfirm ? () => onDialogConfirm(null, true) : null}>
          Cleanup All
        </sl-button>
      </div>
    </div>
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
        <div class="worktrees-empty">
          <p>No worktrees yet. Start a run to create one.</p>
        </div>
      </div>
    `;
  }

  const filtered = filter
    ? worktrees.filter((wt) => _matchesFilter(wt, filter))
    : worktrees;
  const completedCount = worktrees.filter(
    (w) => w.status === 'completed',
  ).length;

  return html`
    <div class="worktrees-view">
      ${_diskHeaderView(worktrees)}
      <div class="worktrees-toolbar">
        <sl-input
          class="worktrees-filter"
          type="text"
          placeholder="Filter by title, branch, or group…"
          value="${filter || ''}"
          @sl-input=${onFilter ? (e) => onFilter(e.target.value) : null}>
        </sl-input>
        ${
          completedCount > 0
            ? html`<sl-button
                variant="danger"
                outline
                class="btn-bulk-cleanup"
                @click=${onBulkCleanup}>
                Cleanup all completed (${completedCount})
              </sl-button>`
            : nothing
        }
      </div>
      <table class="worktrees-table">
        <thead>
          <tr>
            <th>Run title</th>
            <th>Status</th>
            <th>Branch</th>
            <th>Worktree path</th>
            <th>Disk usage</th>
            <th>Age</th>
            <th>Group</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map((wt) => _rowView(wt, { onSelectRun, onCleanup }))}
        </tbody>
      </table>
      ${dialogBulk ? _bulkDialogView(worktrees, { onDialogClose, onDialogConfirm }) : nothing}
      ${_cleanupDialogView(dialogItem, dialogCheckbox, {
        onDialogClose,
        onDialogConfirm,
        onDialogCheckboxChange,
      })}
    </div>
  `;
}
