import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { statusClass, statusIcon } from '../utils/status-badge.js';
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

function _formatBytes(b) {
  if (!b) return '0 B';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function _formatDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso.slice(0, 16);
  }
}

function _isTerminal(status) {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'halted' ||
    status === 'unrecoverable'
  );
}

function _requiresResumeLossConfirm(status) {
  return status === 'halted' || status === 'failed';
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

// ─── sub-views ────────────────────────────────────────────────────────────────

function _statusHeaderView(fleet) {
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
  return html`
    <div class="fleet-detail-status-row">
      <sl-badge
        variant="${variant}"
        pill
        class="fleet-status-badge"
        title="${tooltip || ''}"
      >${label}</sl-badge>
      <code class="fleet-id-chip">${fleet.fleet_id}</code>
    </div>
  `;
}

function _manifestSection(fleet) {
  const thresholdPct = Math.round((fleet.fleet_failure_threshold ?? 0.3) * 100);
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Manifest</h3>
      <div class="settings-grid fleet-manifest-grid">
        <div class="settings-field">
          <label class="settings-label">Branch template</label>
          <code class="fleet-meta-mono">${fleet.head_template || '—'}</code>
        </div>
        <div class="settings-field">
          <label class="settings-label">Base branch</label>
          <span class="fleet-meta-value">${fleet.base_branch || 'each repo default'}</span>
        </div>
        <div class="settings-field">
          <label class="settings-label">Plan mode</label>
          <span class="fleet-meta-value">${fleet.plan?.mode || 'none'}</span>
        </div>
        <div class="settings-field">
          <label class="settings-label">Max parallel</label>
          <span class="fleet-meta-value">${fleet.max_parallel ?? 5}</span>
        </div>
        <div class="settings-field">
          <label class="settings-label">Circuit-breaker</label>
          <span class="fleet-meta-value">${thresholdPct}%</span>
        </div>
        <div class="settings-field">
          <label class="settings-label">Created</label>
          <span class="fleet-meta-value">${_formatDate(fleet.created_at)}</span>
        </div>
      </div>
    </div>
  `;
}

function _workRequestSection(fleet) {
  const wr = fleet.work_request || {};
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Work Request</h3>
      <div class="settings-field">
        <label class="settings-label">Title</label>
        <strong class="fleet-wr-title">${wr.title || '—'}</strong>
      </div>
      ${
        wr.description
          ? html`
            <div class="settings-field">
              <label class="settings-label">Description</label>
              <p class="fleet-wr-description">${wr.description}</p>
            </div>
          `
          : nothing
      }
      ${
        wr.source
          ? html`
            <div class="settings-field">
              <label class="settings-label">Source</label>
              <code class="fleet-meta-mono">${wr.source}</code>
            </div>
          `
          : nothing
      }
    </div>
  `;
}

function _guideSection(fleet, { rerender } = {}) {
  const guide = fleet.guide;
  if (!guide) {
    return html`
      <div class="new-run-section">
        <h3 class="new-run-section-title">Reference Guide</h3>
        <div class="settings-field">
          <span class="settings-field-hint">No guide attached to this fleet.</span>
        </div>
      </div>
    `;
  }

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

  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Reference Guide</h3>
      <div class="settings-field">
        <label class="settings-label">Attached files</label>
        <div class="fleet-guide-files">
          ${(guide.filenames || []).map(
            (n) => html`<sl-tag pill size="small" class="fleet-guide-tag">${n}</sl-tag>`,
          )}
        </div>
        <span class="settings-field-hint">Total size: ${_formatBytes(guide.bytes)}.</span>
      </div>
      <div class="settings-tab-actions fleet-guide-actions">
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
      </div>
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
    </div>
  `;
}

function _childrenSection(fleet) {
  const children = fleet.children || [];

  if (children.length === 0) {
    return html`
      <div class="new-run-section">
        <h3 class="new-run-section-title">Children</h3>
        <div class="settings-field">
          <span class="settings-field-hint">No child runs dispatched yet — fleet orchestrator may still be provisioning targets.</span>
        </div>
      </div>
    `;
  }

  const allHavePr = children.length > 0 && children.every((c) => c.pr_url);
  const headerCount = `${children.length} ${children.length === 1 ? 'child' : 'children'}`;

  return html`
    <div class="new-run-section fleet-children-section">
      <div class="fleet-children-header">
        <h3 class="new-run-section-title">Children · ${headerCount}</h3>
        ${
          allHavePr
            ? html`
              <sl-button size="small" class="btn-copy-all-pr-urls">Copy all PR URLs</sl-button>
            `
            : nothing
        }
      </div>
      <div class="run-list fleet-children-list">
        ${children.map((child) => {
          const status = child.status || 'pending';
          const variant = _childStatusVariant(status);
          const childCost = _computeChildCost(child);
          return html`
            <div class="run-card ${statusClass(status)} fleet-child-card">
              <div class="run-card-top">
                <span class="run-card-status">${unsafeHTML(statusIcon(status, 16))}</span>
                <span class="run-card-title">${_projectName(child.project_path)}</span>
                <sl-badge variant="${variant}" pill class="status-badge-${status}">${status}</sl-badge>
              </div>
              <div class="run-card-meta">
                ${
                  child.head_branch
                    ? html`
                      <span class="run-card-meta-item">
                        <span class="meta-label">Head:</span>
                        <span class="meta-value"><code class="fleet-meta-mono">${child.head_branch}</code></span>
                      </span>
                    `
                    : nothing
                }
                ${
                  child.base_branch
                    ? html`
                      <span class="run-card-meta-item">
                        <span class="meta-label">Base:</span>
                        <span class="meta-value">${child.base_branch}</span>
                      </span>
                    `
                    : nothing
                }
                <span class="run-card-meta-item">
                  <span class="meta-label">Cost:</span>
                  <span class="meta-value">${_formatCost(childCost)}</span>
                </span>
                ${
                  child.pr_url
                    ? html`
                      <span class="run-card-meta-item">
                        <span class="meta-label">PR:</span>
                        <a class="meta-value" href="${child.pr_url}" target="_blank" rel="noopener">${child.pr_url.split('/').slice(-2).join('/')}</a>
                      </span>
                    `
                    : nothing
                }
              </div>
              ${
                child.project_path
                  ? html`
                    <div class="run-card-meta worktree-card-path">
                      <span class="meta-label">Project:</span>
                      <code class="worktree-path-mono">${child.project_path}</code>
                    </div>
                  `
                  : nothing
              }
            </div>
          `;
        })}
      </div>
    </div>
  `;
}

function _aggregateCostSection(fleet) {
  const total = _computeFleetCost(fleet.children || []);
  return html`
    <div class="new-run-section fleet-aggregate-cost-section">
      <h3 class="new-run-section-title">Aggregate Cost</h3>
      <div class="settings-field">
        <label class="settings-label">Total USD spent</label>
        <span class="fleet-total-cost">${_formatCost(total)}</span>
        <span class="settings-field-hint">Summed across every child's stage iterations.</span>
      </div>
    </div>
  `;
}

function _circuitBreakerAlertView(fleet) {
  // Only show the orange alert when the breaker actually tripped. A
  // user-initiated halt is informational and should not look like an
  // error condition (W-040 §13.7).
  if (fleet.status !== 'halted' || fleet.halt_reason !== 'circuit_breaker') {
    return nothing;
  }
  const cb = fleet.circuit_breaker || {};
  return html`
    <sl-alert variant="warning" open class="fleet-circuit-breaker-alert">
      <sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
      <strong>Circuit breaker tripped.</strong>
      Unstarted children were cancelled; in-flight children finished naturally.
      ${
        cb.unstarted_count != null
          ? html`<span class="cb-unstarted-count">${cb.unstarted_count} children halted before launch.</span>`
          : nothing
      }
      ${cb.trip_reason ? html`<div class="cb-trip-reason">${cb.trip_reason}</div>` : nothing}
    </sl-alert>
  `;
}

function _userHaltAlertView(fleet) {
  if (fleet.status !== 'halted' || fleet.halt_reason === 'circuit_breaker') {
    return nothing;
  }
  return html`
    <sl-alert variant="neutral" open class="fleet-user-halt-alert">
      <sl-icon slot="icon" name="pause-circle"></sl-icon>
      <strong>Halted by operator.</strong>
      In-flight children finished naturally. Resume to re-launch failed or pending children.
    </sl-alert>
  `;
}

function _actionsSection(fleet, { onNavigate, rerender } = {}) {
  const { status } = fleet;
  const requiresConfirm = _requiresResumeLossConfirm(status);
  const cleanupConfirmDisabled = requiresConfirm && !cleanupResumeLossChecked;

  return html`
    <div class="settings-tab-actions fleet-actions">
      ${
        status === 'running'
          ? html`
            <sl-button
              variant="warning"
              size="small"
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
                 <strong>In-flight children will continue to run</strong> until they finish.</p>
              <sl-button slot="footer" variant="warning" class="btn-halt-confirm">Confirm halt</sl-button>
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
            <sl-button variant="success" size="small" class="btn-resume-fleet">Resume fleet</sl-button>
          `
          : nothing
      }
      ${
        _isTerminal(status)
          ? html`
            <sl-button
              variant="danger"
              size="small"
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
              size="small"
              outline
              class="btn-rerun-fleet"
              @click=${
                onNavigate
                  ? () => onNavigate('fleet-runs', 'new')
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
    <div class="new-run-page fleet-detail-page">
      ${_statusHeaderView(fleet)}
      ${_circuitBreakerAlertView(fleet)}
      ${_userHaltAlertView(fleet)}
      <div class="new-run-form fleet-detail-body">
        ${_manifestSection(fleet)}
        ${_workRequestSection(fleet)}
        ${_guideSection(fleet, { rerender })}
        ${_childrenSection(fleet)}
        ${_aggregateCostSection(fleet)}
        ${_actionsSection(fleet, { onNavigate, rerender })}
      </div>
    </div>
  `;
}
