import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import {
  Activity,
  CircleAlert,
  CircleCheck,
  Coins,
  iconSvg,
  Zap,
} from '../utils/icons.js';
import { sortByStartDesc } from '../utils/sort-runs.js';
import {
  fleetExpandedFromStorage,
  fleetHeaderView,
  groupByFleet,
} from './group-rendering.js';
import { runCardView } from './run-card.js';

function _computeTotalCost(runs) {
  let total = 0;
  for (const run of runs) {
    for (const stage of Object.values(run.stages || {})) {
      for (const iter of stage.iterations || []) {
        total += iter.cost_usd || 0;
      }
    }
  }
  return total;
}

function _formatCost(usd) {
  if (usd == null || usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function _activeGroup(runs, statuses) {
  return runs.filter((r) => statuses.includes(r.pipeline_status));
}

function _renderRunList(
  runs,
  {
    onSelectRun,
    onPause,
    onResume,
    onStop,
    onCancel,
    onArchive,
    onNavigate,
    onToggleFleet,
  } = {},
) {
  const { fleetGroups, standalone } = groupByFleet(runs);
  const fleetEntries = Object.entries(fleetGroups);

  if (fleetEntries.length === 0) {
    return runs.map((run) =>
      runCardView(run, {
        onClick: onSelectRun,
        onPause,
        onResume,
        onStop,
        onCancel,
        onArchive,
      }),
    );
  }

  const renderChild = (run) =>
    runCardView(run, {
      onClick: onSelectRun,
      onPause,
      onResume,
      onStop,
      onCancel,
      onArchive,
    });

  return [
    ...fleetEntries.map(([fleetId, children]) => {
      const status = children.some((r) => r.pipeline_status === 'running')
        ? 'running'
        : children.some((r) => r.pipeline_status === 'paused')
          ? 'paused'
          : children.every((r) => r.pipeline_status === 'completed')
            ? 'completed'
            : 'failed';
      const expanded = fleetExpandedFromStorage(fleetId, status);
      return fleetHeaderView(fleetId, children, {
        expanded,
        onToggle: onToggleFleet,
        onNavigate,
        renderChild,
      });
    }),
    ...standalone.map((run) =>
      runCardView(run, {
        onClick: onSelectRun,
        onPause,
        onResume,
        onStop,
        onCancel,
        onArchive,
      }),
    ),
  ];
}

// Project cards (per-project summary tiles) were removed: the sidebar's
// always-visible project dropdown is the single source of truth for project
// switching, and the cards' run-to-project attribution relied on a
// `run.projectId` field that isn't populated reliably across modes. The
// function and its CSS (.project-cards / .project-card-*) are gone with it.

export function dashboardView(
  state,
  {
    onSelectRun,
    onNavigate,
    onPause,
    onResume,
    onStop,
    onCancel,
    onArchive,
    onToggleFleet,
  } = {},
) {
  const runs = Object.values(state.runs);
  const active = runs.filter((r) => r.active);
  const completed = runs.filter((r) => !r.active);
  const errored = runs.filter((r) => {
    const stages = r.stages ? Object.values(r.stages) : [];
    return stages.some((s) => s.status === 'error');
  });
  const total = runs.length;
  const totalCost = _computeTotalCost(runs);

  const activeGroup = sortByStartDesc(active);
  const allPaused = sortByStartDesc(_activeGroup(runs, ['paused']));

  const MAX_RECENT = 3;
  const allFailed = sortByStartDesc(_activeGroup(runs, ['failed']));
  const failedPreview = allFailed.slice(0, MAX_RECENT);
  const allCompleted = sortByStartDesc(_activeGroup(runs, ['completed']));
  const completedPreview = allCompleted.slice(0, MAX_RECENT);

  // Project cards used to appear here in global mode as a grid of
  // per-project summary tiles. Removed: the sidebar's project dropdown
  // already provides project switching, and the cards' "no runs"
  // attribution was unreliable when runs lacked a projectId field.
  return html`
    <div class="dashboard">
      <div class="dashboard-stats">
        <div class="stat-card stat-total">
          <div class="stat-icon-ring">${unsafeHTML(iconSvg(Zap, 20))}</div>
          <div class="stat-body">
            <span class="stat-number">${total}</span>
            <span class="stat-label">Total Runs</span>
          </div>
        </div>
        <div class="stat-card stat-active">
          <div class="stat-icon-ring">${unsafeHTML(iconSvg(Activity, 20))}</div>
          <div class="stat-body">
            <span class="stat-number">${active.length}</span>
            <span class="stat-label">Active</span>
          </div>
        </div>
        <div class="stat-card stat-completed">
          <div class="stat-icon-ring">${unsafeHTML(iconSvg(CircleCheck, 20))}</div>
          <div class="stat-body">
            <span class="stat-number">${completed.length}</span>
            <span class="stat-label">Completed</span>
          </div>
        </div>
        <div class="stat-card stat-errors">
          <div class="stat-icon-ring">${unsafeHTML(iconSvg(CircleAlert, 20))}</div>
          <div class="stat-body">
            <span class="stat-number">${errored.length}</span>
            <span class="stat-label">Errors</span>
          </div>
        </div>
        <div class="stat-card stat-cost-total" style="cursor:pointer" @click=${() => onNavigate?.('costs')}>
          <div class="stat-icon-ring">${unsafeHTML(iconSvg(Coins, 20))}</div>
          <div class="stat-body">
            <span class="stat-number">${_formatCost(totalCost)}</span>
            <span class="stat-label">Total Cost</span>
          </div>
        </div>
      </div>

      <h3 class="dashboard-section-title">Active Runs</h3>
      ${
        activeGroup.length > 0
          ? html`
        <div class="active-group">
          <div class="run-list">
            ${_renderRunList(activeGroup, { onSelectRun, onPause, onResume, onStop, onCancel, onNavigate, onToggleFleet })}
          </div>
        </div>
      `
          : html`<div class="empty-state">No active pipelines</div>`
      }

      ${
        allPaused.length > 0
          ? html`
        <h3 class="dashboard-section-title">
          Paused
          <span class="dashboard-section-count">${allPaused.length}</span>
        </h3>
        <div class="active-group active-group-paused">
          <div class="run-list">
            ${_renderRunList(allPaused, { onSelectRun, onResume, onCancel, onNavigate, onToggleFleet })}
          </div>
        </div>
      `
          : nothing
      }

      ${
        failedPreview.length > 0
          ? html`
        <h3 class="dashboard-section-title">
          Recent Failures
          ${
            allFailed.length > MAX_RECENT
              ? html`
            <a class="dashboard-view-all" @click=${() => onNavigate?.('history', { statusFilter: 'failed' })}>View all ${allFailed.length}</a>
          `
              : nothing
          }
        </h3>
        <div class="active-group active-group-failed">
          <div class="run-list">
            ${_renderRunList(failedPreview, { onSelectRun, onResume, onCancel, onArchive, onNavigate, onToggleFleet })}
          </div>
        </div>
      `
          : nothing
      }

      ${
        completedPreview.length > 0
          ? html`
        <h3 class="dashboard-section-title">
          Recent Completed
          ${
            allCompleted.length > MAX_RECENT
              ? html`
            <a class="dashboard-view-all" @click=${() => onNavigate?.('history', { statusFilter: 'completed' })}>View all ${allCompleted.length}</a>
          `
              : nothing
          }
        </h3>
        <div class="active-group active-group-completed">
          <div class="run-list">
            ${_renderRunList(completedPreview, { onSelectRun, onNavigate, onToggleFleet })}
          </div>
        </div>
      `
          : nothing
      }
    </div>
  `;
}
