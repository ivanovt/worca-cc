import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { elapsed, formatDuration, formatTimestamp } from '../utils/duration.js';
import { Archive, iconSvg, Pause, Play, RotateCcw } from '../utils/icons.js';
import { statusClass, statusIcon } from '../utils/status-badge.js';
import {
  fleetStatusLabel,
  fleetStatusTooltip,
  fleetStatusVariant,
} from './group-rendering.js';

function _shortRepoName(child) {
  // Both shapes work: dashboard passes `Run` objects (use project name from
  // path / project_id), fleet-detail passes manifest entries (project_path).
  const raw = child.project_path || child.project || child._project || '';
  return raw.split('/').filter(Boolean).pop() || '—';
}

// How many project name badges to render inline before collapsing the
// rest into a "+N more" chip.
const _PROJECT_BADGES_VISIBLE = 3;
const _PROJECT_BADGE_MAX_CHARS = 20;

function _truncateName(name) {
  if (name.length <= _PROJECT_BADGE_MAX_CHARS) return name;
  return `${name.slice(0, _PROJECT_BADGE_MAX_CHARS - 1)}…`;
}

// Renders the value of the "Projects:" meta label as up to three
// neutral (colorless) name badges, with a "+N more" chip when the fleet
// has more children than fit. Replaces the bare project count.
//
// Exported so the fleet detail page hero can render the project list
// with identical styling to the dashboard/list fleet card.
export function projectBadgesView(children = []) {
  const visible = children.slice(0, _PROJECT_BADGES_VISIBLE);
  const overflow = children.length - visible.length;
  return html`
    ${visible.map((c) => {
      const name = _shortRepoName(c);
      return html`<span class="fleet-card-project-badge" title="${name}">${_truncateName(name)}</span>`;
    })}
    ${
      overflow > 0
        ? html`<span class="fleet-card-project-more">+${overflow} more</span>`
        : nothing
    }
  `;
}

function _resolveChildStatus(child) {
  // Manifest children carry `status`; live Run objects carry `pipeline_status`.
  return child.status || child.pipeline_status || 'pending';
}

function _formatCost(usd) {
  if (!usd) return null;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function _aggregateCounts(children) {
  let completed = 0;
  let failed = 0;
  let running = 0;
  let paused = 0;
  let halted = 0;
  let pending = 0;
  for (const c of children) {
    const s = _resolveChildStatus(c);
    if (s === 'completed') completed++;
    else if (s === 'failed' || s === 'setup_failed' || s === 'unrecoverable')
      failed++;
    else if (s === 'running' || s === 'resuming') running++;
    else if (s === 'paused') paused++;
    else if (s === 'halted') halted++;
    else pending++;
  }
  return {
    completed,
    failed,
    running,
    paused,
    halted,
    pending,
    total: children.length,
  };
}

/**
 * `fleetCardView` — the shared "card per fleet" component used in the
 * dashboard and as the page hero on the fleet detail page. Shares the
 * pipeline card's information hierarchy (status accent, title, meta-chip
 * rows, action row at the bottom) but differs in form: a layered "stack
 * of cards" silhouette and a children-strip in the slot that the pipeline
 * card uses for stage badges.
 *
 * The single signature accepts both shapes for `children`:
 *   - Manifest entries: { project_path, run_id?, status, head_branch?, … }
 *   - Live Run objects: { id, project, pipeline_status, work_request, … }
 *
 * Callers are expected to normalise the rest of the fleet metadata into the
 * `fleet` argument before invoking — see `_dashboardFleetFromChildren` in
 * `dashboard.js` for the synthetic-fleet construction path.
 *
 * @param {{
 *   fleet_id: string,
 *   fleet_id_short?: string,
 *   title?: string,
 *   status: string,
 *   halt_reason?: string | null,
 *   base_branch?: string | null,
 *   head_template?: string | null,
 *   plan_mode?: string | null,
 *   started_at?: string | null,
 *   last_activity_at?: string | null,
 *   cost_usd?: number,
 * }} fleet
 * @param {Array<object>} children
 * @param {{
 *   onClick?: (fleetId: string) => void,
 *   onHalt?: (fleetId: string) => void,
 *   onResumeFailed?: (fleetId: string) => void,
 *   onArchive?: (fleetId: string) => void,
 *   onUnarchive?: (fleetId: string) => void,
 * }} options
 */
export function fleetCardView(fleet, children = [], options = {}) {
  const { onClick, onHalt, onResumeFailed, onArchive, onUnarchive } = options;

  const status = fleet.status || 'running';
  const haltReason = fleet.halt_reason || null;
  const variant = fleetStatusVariant(status, haltReason);
  const label = fleetStatusLabel(status, haltReason);
  const counts = _aggregateCounts(children);
  const tooltip = fleetStatusTooltip(status, haltReason, {
    haltAt: fleet.halted_at,
    failedCount: counts.failed,
    totalCount: counts.total,
  });

  // Field-name fallbacks let the card accept the server payload shape
  // (`GET /api/fleet-runs` → `work_request.title`, `plan.mode`, `created_at`,
  // `updated_at`) directly. Synthetic shapes built client-side may use the
  // flatter `title` / `plan_mode` / `started_at` / `last_activity_at` aliases.
  const title =
    fleet.title ||
    fleet.work_request?.title ||
    `Fleet ${fleet.fleet_id_short || fleet.fleet_id || ''}`;
  const baseBranch = fleet.base_branch;
  const planMode = fleet.plan_mode || fleet.plan?.mode || null;
  const startedAt = fleet.started_at || fleet.created_at || null;
  const lastActivityAt = fleet.last_activity_at || fleet.updated_at || null;
  const costUsd = fleet.cost_usd ?? 0;

  // "Worst child" exception counters — surface halted/paused buckets in the
  // top row when they don't already match the fleet's overall status badge.
  // The failed-count is handled separately: it rides the "Projects:" row
  // after the name badges (see below), as a plain default-color label.
  const exceptionPills = [];
  if (counts.halted > 0 && status !== 'halted') {
    exceptionPills.push({
      variant: 'warning',
      cls: 'fleet-card-exception-halted',
      label: `${counts.halted} halted`,
    });
  }
  if (counts.paused > 0 && status !== 'paused') {
    exceptionPills.push({
      variant: 'warning',
      cls: 'fleet-card-exception-paused',
      label: `${counts.paused} paused`,
    });
  }

  // Duration: started → last_activity_at if running, else started → most
  // recent terminal timestamp (or now if neither is provided).
  const duration =
    startedAt && lastActivityAt
      ? formatDuration(elapsed(startedAt, lastActivityAt))
      : startedAt
        ? formatDuration(elapsed(startedAt, null))
        : null;

  const showHalt =
    onHalt &&
    (status === 'running' || status === 'paused' || status === 'resuming');
  const showResume =
    onResumeFailed &&
    (status === 'halted' || status === 'failed') &&
    counts.failed + counts.pending > 0;
  // Archive is a terminal-state action — same gating intent as the pipeline
  // run card: never offered while a fleet is in-flight (running/resuming).
  const isInFlight = status === 'running' || status === 'resuming';
  const showArchive = onArchive && !fleet.archived && !isInFlight;
  const showUnarchive = onUnarchive && fleet.archived === true;

  const handleCardClick = onClick
    ? (e) => {
        // Ignore clicks that started on an interactive descendant.
        if (e.target.closest('button, a, sl-button')) return;
        onClick(fleet.fleet_id);
      }
    : null;

  return html`
    <div
      class="fleet-card fleet-card-stack ${statusClass(status)}"
      data-fleet-id="${fleet.fleet_id || ''}"
      data-halt-reason="${haltReason || ''}"
      @click=${handleCardClick}
      style="${handleCardClick ? 'cursor:pointer' : ''}"
    >
      <div class="fleet-card-top">
        <span class="fleet-card-status" title="${tooltip || ''}">
          ${unsafeHTML(statusIcon(status, 16))}
        </span>
        <span class="fleet-card-title">${title}</span>
        <sl-badge
          variant="${variant}"
          pill
          class="fleet-card-status-badge"
          title="${tooltip || ''}"
        >${label}</sl-badge>
        ${exceptionPills.map(
          (p) => html`
            <sl-badge
              variant="${p.variant}"
              pill
              class="fleet-card-exception-pill ${p.cls}"
            >${p.label}</sl-badge>
          `,
        )}
      </div>

      <div class="fleet-card-progress">
        <span class="meta-label fleet-card-children-label">Projects:</span>
        ${
          children.length > 0
            ? projectBadgesView(children)
            : html`<span class="fleet-card-children-empty">No projects dispatched yet</span>`
        }
        ${
          counts.failed > 0
            ? html`<span class="fleet-card-failed-count">${counts.failed} failed</span>`
            : nothing
        }
      </div>

      <div class="fleet-card-meta">
        ${
          planMode
            ? html`<span class="fleet-card-meta-item"><span class="meta-label">Plan:</span> <span class="meta-value">${planMode}</span></span>`
            : nothing
        }
        ${
          baseBranch
            ? html`<span class="fleet-card-meta-item"><span class="meta-label">Base:</span> <span class="meta-value">${baseBranch}</span></span>`
            : nothing
        }
      </div>

      <div class="fleet-card-meta">
        ${
          startedAt
            ? html`<span class="fleet-card-meta-item"><span class="meta-label">Started:</span> <span class="meta-value">${formatTimestamp(startedAt)}</span></span>`
            : nothing
        }
        ${
          lastActivityAt
            ? html`<span class="fleet-card-meta-item"><span class="meta-label">Last activity:</span> <span class="meta-value">${formatTimestamp(lastActivityAt)}</span></span>`
            : nothing
        }
        ${
          duration
            ? html`<span class="fleet-card-meta-item"><span class="meta-label">Duration:</span> <span class="meta-value">${duration}</span></span>`
            : nothing
        }
        ${
          _formatCost(costUsd)
            ? html`<span class="fleet-card-meta-item"><span class="meta-label">Cost:</span> <span class="meta-value">${_formatCost(costUsd)}</span></span>`
            : nothing
        }
      </div>

      ${
        showHalt || showResume || showArchive || showUnarchive
          ? html`
            <div class="fleet-card-actions">
              ${
                showHalt
                  ? html`
                    <sl-button size="small" variant="warning" outline class="btn-fleet-halt" @click=${(
                      e,
                    ) => {
                      e.stopPropagation();
                      onHalt(fleet.fleet_id);
                    }}>
                      ${unsafeHTML(iconSvg(Pause, 12))} Halt fleet
                    </sl-button>
                  `
                  : nothing
              }
              ${
                showResume
                  ? html`
                    <sl-button size="small" variant="primary" outline class="btn-fleet-resume" @click=${(
                      e,
                    ) => {
                      e.stopPropagation();
                      onResumeFailed(fleet.fleet_id);
                    }}>
                      ${unsafeHTML(iconSvg(status === 'halted' ? Play : RotateCcw, 12))}
                      ${status === 'halted' ? 'Resume failed' : 'Retry failed'}
                    </sl-button>
                  `
                  : nothing
              }
              ${
                showArchive
                  ? html`
                    <button class="btn-quick-archive" @click=${(e) => {
                      e.stopPropagation();
                      onArchive(fleet.fleet_id);
                    }}>
                      ${unsafeHTML(iconSvg(Archive, 12))} Archive
                    </button>
                  `
                  : nothing
              }
              ${
                showUnarchive
                  ? html`
                    <button class="btn-quick-archive" @click=${(e) => {
                      e.stopPropagation();
                      onUnarchive(fleet.fleet_id);
                    }}>
                      ${unsafeHTML(iconSvg(RotateCcw, 12))} Unarchive
                    </button>
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
