import { html, nothing } from 'lit-html';
import {
  fleetStatusLabel,
  fleetStatusTooltip,
  fleetStatusVariant,
} from './group-rendering.js';

// ─── module-level state ───────────────────────────────────────────────────────

let guideDialogOpen = false;
let guideContent = null;
let guideLoading = false;
let guideError = null;
let guideErrorHint = null;
let haltDialogOpen = false;
let cleanupDialogOpen = false;
let cleanupResumeLossChecked = false;

export function resetFleetDetailState(overrides = {}) {
  guideDialogOpen = overrides.guideDialogOpen ?? false;
  guideContent = overrides.guideContent ?? null;
  guideLoading = overrides.guideLoading ?? false;
  guideError = overrides.guideError ?? null;
  guideErrorHint = overrides.guideErrorHint ?? null;
  haltDialogOpen = overrides.haltDialogOpen ?? false;
  cleanupDialogOpen = overrides.cleanupDialogOpen ?? false;
  cleanupResumeLossChecked = overrides.cleanupResumeLossChecked ?? false;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _projectName(projectPath) {
  if (!projectPath) return '(unknown)';
  return projectPath.split('/').pop() || projectPath;
}

function _computeChildCost(child) {
  let total = 0;
  for (const stage of Object.values(child.stages || {})) {
    for (const iter of stage.iterations || []) {
      total += iter.cost_usd || 0;
    }
  }
  return total;
}

function _computeFleetCost(children) {
  return children.reduce((sum, c) => sum + _computeChildCost(c), 0);
}

function _formatCost(usd) {
  if (usd == null || usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function _formatDate(iso) {
  if (!iso) return '';
  return iso.slice(0, 10);
}

function _isTerminal(status) {
  return status === 'completed' || status === 'failed' || status === 'halted';
}

function _requiresResumeLossConfirm(status) {
  return status === 'halted' || status === 'failed';
}

// ─── sub-views ────────────────────────────────────────────────────────────────

function _headerView(fleet, { onNavigate, rerender } = {}) {
  const variant = fleetStatusVariant(fleet.status, fleet.halt_reason);
  const label = fleetStatusLabel(fleet.status, fleet.halt_reason);
  const failedCount = (fleet.children || []).filter(
    (c) => c.status === 'failed' || c.status === 'setup_failed',
  ).length;
  const tooltip = fleetStatusTooltip(fleet.status, fleet.halt_reason, {
    haltAt: fleet.halted_at,
    failedCount,
    totalCount: (fleet.children || []).length,
  });
  const title =
    fleet.work_request?.title ||
    `Fleet ${fleet.fleet_id_short || fleet.fleet_id}`;

  return html`
    <div class="fleet-detail-header">
      <sl-button
        size="small"
        variant="default"
        class="btn-back-to-dashboard"
        @click=${onNavigate ? () => onNavigate('dashboard') : null}
      >← Dashboard</sl-button>
      <h2 class="fleet-detail-title">${title}</h2>
      <sl-badge
        variant="${variant}"
        pill
        class="fleet-status-badge"
        title="${tooltip || ''}"
      >${label}</sl-badge>
    </div>
  `;
}

function _manifestPanelView(fleet) {
  const thresholdPct = Math.round((fleet.fleet_failure_threshold ?? 0.3) * 100);

  return html`
    <sl-card class="fleet-manifest-panel">
      <div slot="header">Manifest</div>
      <dl class="fleet-manifest-fields">
        <dt>Branch template</dt>
        <dd>${fleet.head_template || '—'}</dd>
        <dt>Base branch</dt>
        <dd>${fleet.base_branch || '(each repo default)'}</dd>
        <dt>Plan mode</dt>
        <dd>${fleet.plan?.mode || 'none'}</dd>
        <dt>Max parallel</dt>
        <dd>${fleet.max_parallel ?? 5}</dd>
        <dt>Circuit-breaker threshold</dt>
        <dd>${thresholdPct}%</dd>
        <dt>Created</dt>
        <dd>${_formatDate(fleet.created_at)}</dd>
      </dl>
    </sl-card>
  `;
}

function _workRequestPanelView(fleet) {
  const wr = fleet.work_request || {};
  return html`
    <sl-card class="fleet-work-request-panel">
      <div slot="header">Work Request</div>
      <strong class="fleet-wr-title">${wr.title || '—'}</strong>
      ${
        wr.description
          ? html`<p class="fleet-wr-description">${wr.description}</p>`
          : nothing
      }
    </sl-card>
  `;
}

function _guidePanelView(fleet, { rerender } = {}) {
  const guide = fleet.guide;

  let content;
  if (!guide) {
    content = html`<span class="no-guide">No guide attached to this fleet.</span>`;
  } else {
    const guideBody = (() => {
      if (guideLoading) {
        return html`<div class="guide-loading"><sl-spinner></sl-spinner> Loading…</div>`;
      }
      if (guideError === 'guide_not_retrievable') {
        return html`
          <div class="guide-not-retrievable">
            ${guideErrorHint || 'Guide content is not retrievable from this server.'}
          </div>
        `;
      }
      if (guideError) {
        return html`<div class="guide-error">${guideError}</div>`;
      }
      if (guideContent) {
        return html`<pre class="guide-content">${guideContent}</pre>`;
      }
      return nothing;
    })();

    content = html`
      <div class="guide-meta">
        <span class="guide-filenames">${(guide.filenames || []).join(', ')}</span>
        <span class="guide-size">${guide.bytes} bytes</span>
      </div>
      <sl-button
        size="small"
        class="btn-view-guide"
        @click=${
          rerender
            ? () => {
                guideDialogOpen = true;
                rerender();
              }
            : null
        }
      >View guide content</sl-button>
      <sl-dialog
        label="Guide Content"
        class="guide-dialog"
        ?open=${guideDialogOpen}
        @sl-after-hide=${
          rerender
            ? () => {
                guideDialogOpen = false;
                rerender();
              }
            : null
        }
      >
        ${guideBody}
      </sl-dialog>
    `;
  }

  return html`
    <sl-card class="fleet-guide-panel">
      <div slot="header">Guide</div>
      ${content}
    </sl-card>
  `;
}

function _childrenGridView(fleet) {
  const children = fleet.children || [];

  if (children.length === 0) {
    return html`
      <sl-card class="fleet-children-grid">
        <div slot="header">Children</div>
        <div class="no-children">No child runs dispatched yet.</div>
      </sl-card>
    `;
  }

  const allHavePr = children.length > 0 && children.every((c) => c.pr_url);

  return html`
    <sl-card class="fleet-children-grid">
      <div slot="header">
        Children
        ${
          allHavePr
            ? html`
            <sl-button
              size="small"
              class="btn-copy-all-pr-urls"
            >Copy all PR URLs</sl-button>
          `
            : nothing
        }
      </div>
      <table class="fleet-children-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Status</th>
            <th>Base branch</th>
            <th>Head branch</th>
            <th>PR</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          ${children.map((child) => {
            const childCost = _computeChildCost(child);
            return html`
              <tr class="fleet-child-row">
                <td class="fleet-child-project">${_projectName(child.project_path)}</td>
                <td class="fleet-child-status">
                  <sl-badge variant="${_childStatusVariant(child.status)}">${child.status || 'unknown'}</sl-badge>
                </td>
                <td class="fleet-child-base-branch">${child.base_branch || '—'}</td>
                <td class="fleet-child-head-branch">${child.head_branch || '—'}</td>
                <td class="fleet-child-pr">
                  ${
                    child.pr_url
                      ? html`<a href="${child.pr_url}" target="_blank" rel="noopener">PR</a>`
                      : html`<span class="no-pr">—</span>`
                  }
                </td>
                <td class="fleet-child-cost">${_formatCost(childCost)}</td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </sl-card>
  `;
}

function _childStatusVariant(status) {
  const map = {
    completed: 'success',
    running: 'primary',
    failed: 'danger',
    setup_failed: 'danger',
    pending: 'neutral',
    halted: 'warning',
    unrecoverable: 'danger',
  };
  return map[status] || 'neutral';
}

function _aggregateCostView(fleet) {
  const total = _computeFleetCost(fleet.children || []);
  return html`
    <sl-card class="fleet-aggregate-cost">
      <div slot="header">Aggregate Cost</div>
      <span class="fleet-total-cost">${_formatCost(total)}</span>
    </sl-card>
  `;
}

function _circuitBreakerView(fleet) {
  if (fleet.status !== 'halted') return nothing;
  const cb = fleet.circuit_breaker || {};
  return html`
    <sl-alert variant="warning" open class="fleet-circuit-breaker-alert">
      <sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
      Fleet halted by circuit breaker.
      ${
        cb.unstarted_count != null
          ? html`<span>${cb.unstarted_count} unstarted children were halted.</span>`
          : nothing
      }
      ${cb.trip_reason ? html`<div class="cb-trip-reason">${cb.trip_reason}</div>` : nothing}
    </sl-alert>
  `;
}

function _actionsView(fleet, { onNavigate, rerender } = {}) {
  const { status } = fleet;
  const requiresConfirm = _requiresResumeLossConfirm(status);
  const cleanupConfirmDisabled = requiresConfirm && !cleanupResumeLossChecked;

  return html`
    <div class="fleet-actions">

      ${
        status === 'running'
          ? html`
          <sl-button
            variant="warning"
            class="btn-halt-fleet"
            @click=${
              rerender
                ? () => {
                    haltDialogOpen = true;
                    rerender();
                  }
                : null
            }
          >Halt fleet</sl-button>

          <sl-dialog
            label="Halt fleet?"
            class="halt-confirm-dialog"
            ?open=${haltDialogOpen}
            @sl-after-hide=${
              rerender
                ? () => {
                    haltDialogOpen = false;
                    rerender();
                  }
                : null
            }
          >
            <p>Unstarted children will be cancelled.
               <strong>in-flight children will continue to run</strong> until they finish.</p>
            <sl-button
              slot="footer"
              variant="warning"
              class="btn-halt-confirm"
            >Confirm halt</sl-button>
            <sl-button
              slot="footer"
              variant="default"
              @click=${
                rerender
                  ? () => {
                      haltDialogOpen = false;
                      rerender();
                    }
                  : null
              }
            >Cancel</sl-button>
          </sl-dialog>
        `
          : nothing
      }

      ${
        status === 'halted' || status === 'failed'
          ? html`
          <sl-button
            variant="success"
            class="btn-resume-fleet"
          >Resume fleet</sl-button>
        `
          : nothing
      }

      ${
        _isTerminal(status)
          ? html`
          <sl-button
            variant="danger"
            outline
            class="btn-cleanup-fleet"
            @click=${
              rerender
                ? () => {
                    cleanupDialogOpen = true;
                    rerender();
                  }
                : null
            }
          >Cleanup fleet</sl-button>

          <sl-dialog
            label="Cleanup fleet?"
            class="cleanup-confirm-dialog"
            ?open=${cleanupDialogOpen}
            @sl-after-hide=${
              rerender
                ? () => {
                    cleanupDialogOpen = false;
                    cleanupResumeLossChecked = false;
                    rerender();
                  }
                : null
            }
          >
            <p>This will remove all child worktrees and the fleet manifest directory.</p>
            ${
              requiresConfirm
                ? html`
                <sl-checkbox
                  class="cleanup-resume-loss-checkbox"
                  ?checked=${cleanupResumeLossChecked}
                  @sl-change=${
                    rerender
                      ? (e) => {
                          cleanupResumeLossChecked = e.target.checked;
                          rerender();
                        }
                      : null
                  }
                >I understand resume will be unavailable after cleanup</sl-checkbox>
              `
                : nothing
            }
            <sl-button
              slot="footer"
              variant="danger"
              class="${cleanupConfirmDisabled ? 'btn-cleanup-confirm-disabled' : 'btn-cleanup-confirm'}"
              ?disabled=${cleanupConfirmDisabled}
            >Confirm cleanup</sl-button>
            <sl-button
              slot="footer"
              variant="default"
              @click=${
                rerender
                  ? () => {
                      cleanupDialogOpen = false;
                      cleanupResumeLossChecked = false;
                      rerender();
                    }
                  : null
              }
            >Cancel</sl-button>
          </sl-dialog>
        `
          : nothing
      }

      ${
        _isTerminal(status)
          ? html`
          <sl-button
            variant="default"
            class="btn-rerun-fleet"
            @click=${
              onNavigate
                ? () =>
                    onNavigate('fleet-launcher', {
                      prefill: {
                        prompt: fleet.work_request?.description || '',
                        headTemplate: fleet.head_template,
                        baseBranch: fleet.base_branch,
                      },
                    })
                : null
            }
          >Re-run fleet</sl-button>
        `
          : nothing
      }

    </div>
  `;
}

// ─── main view ────────────────────────────────────────────────────────────────

/**
 * Renders the fleet detail page.
 *
 * @param {object|null} fleet  Full fleet manifest from GET /api/fleet-runs/:id (may be null while loading)
 * @param {{ onNavigate?: function, rerender?: function }} options
 */
export function fleetDetailView(fleet, { onNavigate, rerender } = {}) {
  if (!fleet) {
    return html`<div class="fleet-detail-loading"><sl-spinner></sl-spinner> Loading fleet…</div>`;
  }

  return html`
    <div class="fleet-detail-view">
      ${_headerView(fleet, { onNavigate, rerender })}
      ${_manifestPanelView(fleet)}
      ${_workRequestPanelView(fleet)}
      ${_guidePanelView(fleet, { rerender })}
      ${_childrenGridView(fleet)}
      ${_aggregateCostView(fleet)}
      ${_circuitBreakerView(fleet)}
      ${_actionsView(fleet, { onNavigate, rerender })}
    </div>
  `;
}
