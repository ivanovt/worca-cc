import { html } from 'lit-html';
import { sortByStartDesc } from '../utils/sort-runs.js';
import { runCardView } from './run-card.js';

const HISTORY_STATUSES = [
  'all',
  'running',
  'completed',
  'failed',
  'paused',
  'error',
  'archived',
];

// Free-text match across the fields a user is likely to recall: the
// work-request title, the branch name, and the run id. Mirrors the
// worktrees text filter so the three list pages search consistently.
function _runMatchesText(run, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    (run.work_request?.title || '').toLowerCase().includes(needle) ||
    (run.branch || '').toLowerCase().includes(needle) ||
    (run.id || '').toLowerCase().includes(needle)
  );
}

export function runListView(
  runs,
  filter,
  {
    onSelectRun,
    onPause,
    onResume,
    onStop,
    onCancel,
    onArchive,
    onUnarchive,
    statusFilter,
    onStatusFilter,
    textFilter = '',
    onTextFilter,
    archivedRuns = [],
    runsLoaded = true,
  } = {},
) {
  const baseFiltered =
    filter === 'active' ? runs.filter((r) => r.active) : runs;

  const showStatusChips = filter === 'history' && onStatusFilter;

  // Compute counts per status for chips
  let statusCounts = {};
  if (showStatusChips) {
    statusCounts = { all: baseFiltered.length };
    for (const r of baseFiltered) {
      const ps = r.pipeline_status || 'completed';
      statusCounts[ps] = (statusCounts[ps] || 0) + 1;
    }
    statusCounts.archived = archivedRuns.length;
  }

  // Apply status filter — archived uses archivedRuns instead of runs
  let displayed;
  if (showStatusChips && statusFilter === 'archived') {
    displayed = sortByStartDesc([...archivedRuns]);
  } else {
    displayed = baseFiltered;
    if (showStatusChips && statusFilter && statusFilter !== 'all') {
      displayed = displayed.filter(
        (r) => (r.pipeline_status || 'completed') === statusFilter,
      );
    }
    displayed = sortByStartDesc(displayed);
  }

  // Text filter runs *after* the status filter, on whatever the chips
  // narrowed down to (including the archived bucket).
  const textQ = (textFilter || '').trim();
  if (textQ) {
    displayed = displayed.filter((r) => _runMatchesText(r, textQ));
  }

  if (
    baseFiltered.length === 0 &&
    !(statusFilter === 'archived' && archivedRuns.length > 0)
  ) {
    if (!runsLoaded) {
      return html`<div class="empty-state">Loading runs…</div>`;
    }
    return html`<div class="empty-state">
      ${filter === 'active' ? 'No running pipelines' : 'No completed runs yet'}
    </div>`;
  }

  const isArchived = statusFilter === 'archived';

  return html`
    ${
      showStatusChips
        ? html`
      <div class="filter-chips">
        ${HISTORY_STATUSES.filter((s) => s === 'all' || statusCounts[s]).map(
          (s) => html`
          <button
            class="filter-chip ${(statusFilter || 'all') === s ? 'active' : ''} filter-chip-${s}"
            @click=${() => onStatusFilter(s)}
          >
            ${s === 'all' ? 'All' : s}
            <span class="chip-count">${statusCounts[s] || 0}</span>
          </button>
        `,
        )}
      </div>
    `
        : ''
    }
    ${
      showStatusChips && onTextFilter
        ? html`
      <div class="list-filter-row">
        <sl-input
          size="small"
          class="list-text-filter"
          type="text"
          placeholder="Filter by title, branch, or run id…"
          value="${textFilter || ''}"
          @sl-input=${(e) => onTextFilter(e.target.value)}
        ></sl-input>
      </div>
    `
        : ''
    }
    ${
      displayed.length === 0
        ? html`
      <div class="empty-state">No ${statusFilter} runs</div>
    `
        : html`
      <div class="run-list">
        ${displayed.map((run) =>
          runCardView(run, {
            onClick: onSelectRun,
            onPause,
            onResume,
            onStop,
            onCancel,
            onArchive: isArchived ? undefined : onArchive,
            onUnarchive: isArchived ? onUnarchive : undefined,
          }),
        )}
      </div>
    `
    }
  `;
}
