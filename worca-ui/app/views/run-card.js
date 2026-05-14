import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { elapsed, formatDuration, formatTimestamp } from '../utils/duration.js';
import {
  Archive,
  iconSvg,
  Pause,
  Play,
  RotateCcw,
  Square,
  X,
} from '../utils/icons.js';
import { STAGE_ORDER } from '../utils/stage-order.js';
import { actionAllowed } from '../utils/state-actions.js';
import {
  resolveStatus,
  statusClass,
  statusIcon,
} from '../utils/status-badge.js';

function _sortedEntries(stages) {
  const entries = Object.entries(stages);
  return entries.sort(([a], [b]) => {
    const ai = STAGE_ORDER.indexOf(a);
    const bi = STAGE_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

const BADGE_VARIANT = {
  completed: 'success',
  in_progress: 'primary',
  error: 'danger',
  interrupted: 'warning',
  cancelled: 'neutral',
  pending: 'neutral',
};

function _statusTooltip(run, status) {
  const ref =
    run.status_changed_at ||
    (status === 'completed' || status === 'failed' ? run.completed_at : null) ||
    run.started_at;
  if (!ref) return null;
  const ms = elapsed(ref, null);
  const dur = formatDuration(ms);
  if (status === 'running') return `Running for ${dur}`;
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return `${label} ${dur} ago`;
}

function _lastStageEnd(stages) {
  if (!stages) return null;
  let latest = null;
  for (const s of Object.values(stages)) {
    if (s.completed_at && (!latest || s.completed_at > latest))
      latest = s.completed_at;
  }
  return latest;
}

function _runCost(run) {
  let total = 0;
  for (const stage of Object.values(run.stages || {})) {
    for (const iter of stage.iterations || []) {
      total += iter.cost_usd || 0;
    }
  }
  return total;
}

function _formatCost(usd) {
  if (usd === 0) return null;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Render the beads progress badge for a run card.
 *
 * Accepts either a plain number (legacy) or an object {total, done} from the
 * countIssuesByRunLabel server endpoint. Renders "<done>/<total> Beads".
 * Variant matches run-detail's beads header: success (green) when done ===
 * total, primary (blue) while in progress.
 */
function beadsBadge(beadsCount) {
  let total = 0;
  let done = 0;
  if (typeof beadsCount === 'number') {
    total = beadsCount;
  } else if (beadsCount && typeof beadsCount === 'object') {
    total = beadsCount.total || 0;
    done = beadsCount.done || 0;
  }
  if (total <= 0) return nothing;
  const variant = done >= total ? 'success' : 'primary';
  return html`<sl-badge variant="${variant}" pill class="run-card-stage-badge">${done}/${total} Beads</sl-badge>`;
}

/**
 * Shared run card component used in both run-list and dashboard active list.
 * Shows title, overall status icon, duration, and stage badges.
 */
export function runCardView(
  run,
  {
    onClick,
    beadsCount,
    onPause,
    onResume,
    onStop,
    onCancel,
    onArchive,
    onUnarchive,
  } = {},
) {
  const title = run.work_request?.title || 'Untitled';
  const isActive = run.active;
  const overallStatus =
    run.pipeline_status ||
    (isActive ? 'running' : run.stage === 'error' ? 'failed' : 'completed');
  const tooltip = _statusTooltip(run, overallStatus);
  const endTime =
    run.completed_at || (isActive ? null : _lastStageEnd(run.stages));
  const duration =
    run.started_at && isActive
      ? formatDuration(elapsed(run.started_at, null))
      : run.started_at && endTime
        ? formatDuration(elapsed(run.started_at, endTime))
        : 'N/A';
  const branch = run.branch || run.work_request?.branch || '';
  const stages = run.stages ? _sortedEntries(run.stages) : [];
  const cost = _runCost(run);

  const pauseBtn =
    onPause && actionAllowed('pause', overallStatus)
      ? html`
          <sl-button size="small" variant="warning" outline class="btn-quick-pause" @click=${(
            e,
          ) => {
            e.stopPropagation();
            onPause(run.id);
          }}>
            ${unsafeHTML(iconSvg(Pause, 12))} Pause
          </sl-button>
      `
      : nothing;

  const stopBtn =
    onStop && actionAllowed('stop', overallStatus)
      ? html`
          <sl-button size="small" variant="danger" outline class="btn-quick-stop" @click=${(
            e,
          ) => {
            e.stopPropagation();
            onStop(run.id);
          }}>
            ${unsafeHTML(iconSvg(Square, 12))} Stop
          </sl-button>
      `
      : nothing;

  const resumeBtn =
    onResume && actionAllowed('resume', overallStatus)
      ? html`
          <button class="btn-quick-resume" @click=${(e) => {
            e.stopPropagation();
            onResume(run.id);
          }}>
            ${unsafeHTML(iconSvg(Play, 12))} Resume
          </button>
      `
      : nothing;

  const cancelBtn =
    onCancel && actionAllowed('cancel', overallStatus)
      ? html`
          <sl-button size="small" variant="danger" class="btn-quick-cancel" @click=${(
            e,
          ) => {
            e.stopPropagation();
            onCancel(run.id);
          }}>
            ${unsafeHTML(iconSvg(X, 12))} Cancel
          </sl-button>
      `
      : nothing;

  const archiveBtn =
    onArchive && !run.archived && actionAllowed('archive', overallStatus)
      ? html`
          <button class="btn-quick-archive" @click=${(e) => {
            e.stopPropagation();
            onArchive(run.id);
          }}>
            ${unsafeHTML(iconSvg(Archive, 12))} Archive
          </button>
      `
      : nothing;

  const unarchiveBtn =
    onUnarchive &&
    run.archived === true &&
    actionAllowed('unarchive', overallStatus)
      ? html`
          <button class="btn-quick-archive" @click=${(e) => {
            e.stopPropagation();
            onUnarchive(run.id);
          }}>
            ${unsafeHTML(iconSvg(RotateCcw, 12))} Unarchive
          </button>
      `
      : nothing;

  const pipelineTemplate = run.pipeline_template
    ? run.pipeline_template.startsWith('builtin:')
      ? `worca:${run.pipeline_template.slice('builtin:'.length)}`
      : run.pipeline_template
    : null;

  const projectName = run.project || run._project || null;

  return html`
    <div class="run-card ${statusClass(overallStatus)}" @click=${onClick ? () => onClick(run.id) : null}>
      <div class="run-card-top">
        ${
          tooltip
            ? html`<span class="run-card-status" title=${tooltip}>${unsafeHTML(statusIcon(overallStatus, 16))}</span>`
            : html`<span class="run-card-status">${unsafeHTML(statusIcon(overallStatus, 16))}</span>`
        }
        <span class="run-card-title">${title}</span>
        ${run.is_worktree_run ? html`<sl-icon name="folder-symlink" class="run-card-worktree-icon" title=${`Isolated worktree at ${run.worktree_path || ''}`}></sl-icon>` : nothing}
      </div>
      ${(() => {
        const projectItem = projectName
          ? html`<span class="run-card-meta-item"><span class="meta-label">Project:</span>
              <span class="meta-value run-card-project">${projectName}</span>
            </span>`
          : nothing;
        // When the run belongs to a fleet, the Fleet label+value sits on
        // the same meta row as Project so the grouping is visible at a
        // glance. Workspace grouping keeps its own row (one group type
        // applies at a time, so this is mutually exclusive).
        if (run.fleet_id && run.group_type === 'fleet') {
          return html`<div class="run-card-meta">
            ${projectItem}
            <span class="run-card-meta-item"><span class="meta-label">Fleet:</span>
              <a class="meta-value run-card-group-link" href="#/fleet-runs/${run.fleet_id}" @click=${(e) => e.stopPropagation()}>${run.fleet_id}</a>
            </span>
          </div>`;
        }
        if (run.workspace_id && run.group_type === 'workspace') {
          return html`<div class="run-card-meta">
            ${projectItem}
            <span class="run-card-meta-item"><span class="meta-label">Workspace:</span>
              <a class="meta-value run-card-group-link" href="#/workspace-runs/${run.workspace_id}" @click=${(e) => e.stopPropagation()}>${run.workspace_id}</a>
            </span>
          </div>`;
        }
        return projectName
          ? html`<div class="run-card-meta">${projectItem}</div>`
          : nothing;
      })()}
      ${branch ? html`<div class="run-card-meta"><span class="run-card-meta-item"><span class="meta-label">Branch:</span> <span class="meta-value">${branch}</span></span></div>` : nothing}
      ${pipelineTemplate ? html`<div class="run-card-template"><span class="meta-label">Pipeline:</span> <span class="meta-value">${pipelineTemplate}</span></div>` : nothing}
      <div class="run-card-meta">
        <span class="run-card-meta-item"><span class="meta-label">Started:</span> <span class="meta-value">${formatTimestamp(run.started_at)}</span></span>
        <span class="run-card-meta-item"><span class="meta-label">Finished:</span> <span class="meta-value">${formatTimestamp(endTime)}</span></span>
        <span class="run-card-meta-item"><span class="meta-label">Duration:</span> <span class="meta-value">${duration}</span></span>
        ${_formatCost(cost) ? html`<span class="run-card-meta-item"><span class="meta-label">Cost:</span> <span class="meta-value">${_formatCost(cost)}</span></span>` : nothing}
      </div>
      ${
        stages.length > 0
          ? html`
        <div class="run-card-stages">
          ${stages.map(([key, stage]) => {
            const status = resolveStatus(stage.status || 'pending', isActive);
            const variant = BADGE_VARIANT[status] || 'neutral';
            const label = key.replace(/_/g, ' ').toUpperCase();
            return html`<sl-badge variant="${variant}" pill class="run-card-stage-badge">${label}</sl-badge>`;
          })}
          ${beadsBadge(beadsCount)}
        </div>
      `
          : beadsBadge(beadsCount) !== nothing
            ? html`
        <div class="run-card-stages">
          ${beadsBadge(beadsCount)}
        </div>
      `
            : nothing
      }
      <div class="run-card-actions">
        ${pauseBtn}${stopBtn}${resumeBtn}${cancelBtn}${archiveBtn}${unarchiveBtn}
      </div>
    </div>
  `;
}
