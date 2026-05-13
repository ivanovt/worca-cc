import { html, nothing } from 'lit-html';

// ─── Fleet status badge mapping (W-040 §13.7) ────────────────────────────────

const FLEET_STATUS_VARIANT = {
  running: 'primary',
  completed: 'success',
  failed: 'danger',
  halted: 'warning',
};

export function fleetStatusVariant(status, haltReason) {
  if (status === 'halted') {
    return haltReason === 'user' ? 'neutral' : 'warning';
  }
  return FLEET_STATUS_VARIANT[status] || 'neutral';
}

export function fleetStatusLabel(status, haltReason) {
  if (status === 'halted') {
    return haltReason === 'circuit_breaker'
      ? 'Halted (circuit breaker)'
      : 'Halted';
  }
  return status;
}

export function fleetStatusTooltip(
  status,
  haltReason,
  { haltAt = null, failedCount = null, totalCount = null } = {},
) {
  if (status !== 'halted') return null;
  if (haltReason === 'user') {
    return haltAt ? `Halted by you on ${haltAt}` : 'Halted by you';
  }
  if (failedCount != null && totalCount != null) {
    return `Halted automatically: ${failedCount} of ${totalCount} children failed`;
  }
  return null;
}

// ─── Grouping ─────────────────────────────────────────────────────────────────

/**
 * Splits an array of runs into fleet groups and standalone runs.
 * Only groups runs where group_type === 'fleet' AND fleet_id is set
 * (W-048 §5 binding contract — never derive type from fleet_id alone).
 *
 * @param {object[]} runs
 * @returns {{ fleetGroups: Record<string, object[]>, standalone: object[] }}
 */
export function groupByFleet(runs) {
  const fleetGroups = {};
  const standalone = [];

  for (const run of runs) {
    if (run.group_type === 'fleet' && run.fleet_id) {
      if (!fleetGroups[run.fleet_id]) fleetGroups[run.fleet_id] = [];
      fleetGroups[run.fleet_id].push(run);
    } else {
      standalone.push(run);
    }
  }

  return { fleetGroups, standalone };
}

// ─── Fleet header helpers ─────────────────────────────────────────────────────

function _deriveFleetStatus(children) {
  if (!children.length) return 'unknown';
  const statuses = children.map((r) => r.pipeline_status || 'unknown');
  if (statuses.some((s) => s === 'running')) return 'running';
  if (statuses.some((s) => s === 'paused')) return 'paused';
  if (statuses.every((s) => s === 'completed')) return 'completed';
  return 'failed';
}

function _computeFleetCost(children) {
  let total = 0;
  for (const run of children) {
    for (const stage of Object.values(run.stages || {})) {
      for (const iter of stage.iterations || []) {
        total += iter.cost_usd || 0;
      }
    }
  }
  return total;
}

function _formatCost(usd) {
  if (!usd) return null;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// localStorage key per fleet
const _lsKey = (fleetId) => `worca.fleet.expanded.${fleetId}`;

/**
 * Read expand state from localStorage, falling back to a status-based default.
 * Active fleets (running/paused/halted) default to expanded; finished fleets collapse.
 */
export function fleetExpandedFromStorage(fleetId, status) {
  try {
    const stored =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(_lsKey(fleetId))
        : null;
    if (stored !== null) return stored === 'true';
  } catch {
    // localStorage unavailable (test env, SSR)
  }
  return status === 'running' || status === 'paused' || status === 'halted';
}

// ─── Fleet header view ────────────────────────────────────────────────────────

/**
 * Renders a collapsible fleet group header + children.
 *
 * @param {string} fleetId
 * @param {object[]} children  Runs belonging to this fleet group
 * @param {{
 *   expanded?: boolean,
 *   onToggle?: (fleetId: string) => void,
 *   onNavigate?: (view: string, opts: object) => void,
 *   renderChild?: (run: object) => import('lit-html').TemplateResult,
 *   haltReason?: string|null,
 *   haltAt?: string|null,
 *   fleetStatus?: string|null,
 * }} options
 */
export function fleetHeaderView(
  fleetId,
  children,
  {
    expanded,
    onToggle,
    onNavigate,
    renderChild,
    haltReason = null,
    haltAt = null,
    fleetStatus = null,
  } = {},
) {
  const derivedStatus = _deriveFleetStatus(children);
  const status = fleetStatus ?? derivedStatus;

  // Resolve expand state: explicit param > localStorage > status-based default
  const isExpanded =
    expanded !== undefined
      ? expanded
      : fleetExpandedFromStorage(fleetId, status);

  const variant = fleetStatusVariant(status, haltReason);
  const label = fleetStatusLabel(status, haltReason);

  const title =
    children[0]?.work_request?.title || `Fleet ${fleetId.slice(-8)}`;

  const completedCount = children.filter(
    (r) => r.pipeline_status === 'completed',
  ).length;
  const failedCount = children.filter(
    (r) =>
      r.pipeline_status === 'failed' || r.pipeline_status === 'setup_failed',
  ).length;
  const total = children.length;
  const progressPct =
    total > 0 ? Math.round((completedCount / total) * 100) : 0;

  const tooltip = fleetStatusTooltip(status, haltReason, {
    haltAt,
    failedCount,
    totalCount: total,
  });

  const progressParts = [`${completedCount}/${total} completed`];
  if (failedCount > 0) progressParts.push(`${failedCount} failed`);
  const progressText = progressParts.join(' · ');

  const cost = _computeFleetCost(children);
  const costText = _formatCost(cost);

  const toggleIcon = isExpanded ? 'chevron-down' : 'chevron-right';
  const groupClass = isExpanded
    ? 'fleet-group-expanded'
    : 'fleet-group-collapsed';

  const handleToggle = onToggle
    ? (e) => {
        e.stopPropagation();
        try {
          localStorage.setItem(_lsKey(fleetId), String(!isExpanded));
        } catch {
          // ignore
        }
        onToggle(fleetId);
      }
    : null;

  // Navigate to /#/fleet-runs/<fleetId>. Section is "fleet-runs", id is the
  // string fleetId — main.js's handleNavigate forwards both into buildHash.
  // (The earlier call onNavigate('fleet-detail', { fleetId }) produced a
  // broken URL "#/fleet-detail/[object Object]" because the runId arg was
  // an object and the section name didn't match any route.)
  const handleHeaderClick = onNavigate
    ? () => onNavigate('fleet-runs', fleetId)
    : null;

  return html`
    <div
      class="fleet-group ${groupClass}"
      data-fleet-id="${fleetId}"
    >
      <div
        class="fleet-header ${handleHeaderClick ? 'fleet-header-clickable' : ''}"
        @click=${handleHeaderClick}
        style="${handleHeaderClick ? 'cursor:pointer' : ''}"
      >
        <sl-icon
          name="${toggleIcon}"
          class="fleet-toggle"
          @click=${handleToggle}
        ></sl-icon>
        <strong class="fleet-title">${title}</strong>
        <sl-badge
          variant="${variant}"
          pill
          class="fleet-status-badge"
          title="${tooltip || ''}"
        >${label}</sl-badge>
        <span class="fleet-progress">${progressText}</span>
        <sl-progress-bar
          value="${progressPct}"
          class="fleet-progress-bar"
        ></sl-progress-bar>
        ${costText ? html`<span class="fleet-cost">${costText}</span>` : nothing}
      </div>
      ${
        isExpanded
          ? html`
              <div class="fleet-children">
                ${renderChild ? children.map((child) => renderChild(child)) : nothing}
              </div>
            `
          : nothing
      }
    </div>
  `;
}
