import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { elapsed, formatDuration, formatTimestamp } from '../utils/duration.js';
import { dagGraphView } from './dag-graph.js';

// ─── module-level state ───────────────────────────────────────────────────────

let planEditDialogOpen = false;
let planEditContent = '';
let haltConfirmDialogOpen = false;
let cleanupDialogOpen = false;
let cleanupResumeAcked = false;

export function resetWorkspaceDetailState(overrides = {}) {
  planEditDialogOpen = overrides.planEditDialogOpen ?? false;
  planEditContent = overrides.planEditContent ?? '';
  haltConfirmDialogOpen = overrides.haltConfirmDialogOpen ?? false;
  cleanupDialogOpen = overrides.cleanupDialogOpen ?? false;
  cleanupResumeAcked = overrides.cleanupResumeAcked ?? false;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function _computeChildCost(child) {
  let total = 0;
  for (const stage of Object.values(child.stages || {})) {
    for (const iter of stage.iterations || []) {
      total += iter.cost_usd || 0;
    }
  }
  return total;
}

function _computeTotalCost(children, masterPlannerCost) {
  let total = (children || []).reduce(
    (sum, c) => sum + _computeChildCost(c),
    0,
  );
  if (masterPlannerCost?.cost_usd) {
    total += masterPlannerCost.cost_usd;
  }
  return total;
}

function _formatCost(usd) {
  if (usd == null || usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function _tierProgress(tiers) {
  if (!tiers || tiers.length === 0) return '0 / 0';
  const completed = tiers.filter((t) => t.status === 'completed').length;
  return `${completed} / ${tiers.length}`;
}

function _wallEndedAt(ws) {
  if (
    ws.status === 'running' ||
    ws.status === 'planning' ||
    ws.status === 'integration_testing'
  ) {
    return null;
  }
  return ws.halted_at || ws.updated_at || null;
}

function _guideConflictsAggregate(children) {
  const byRepo = [];
  for (const child of children || []) {
    const conflicts = child.guide_conflicts;
    if (!conflicts || conflicts.length === 0) continue;
    const repo = child.repo_name || child.project_path?.split('/').pop() || '—';
    byRepo.push({ repo, conflicts });
  }
  if (byRepo.length === 0) return nothing;
  const total = byRepo.reduce((sum, r) => sum + r.conflicts.length, 0);
  const label =
    total === 1
      ? '1 guide conflict across children'
      : `${total} guide conflicts across children`;
  return html`
    <sl-details class="guide-conflicts-aggregate">
      <div slot="summary" class="guide-conflicts-aggregate-header">
        <sl-icon name="exclamation-triangle" class="conflict-icon"></sl-icon>
        <span>${label}</span>
      </div>
      <div class="guide-conflicts-aggregate-list">
        ${byRepo.map(
          ({ repo, conflicts }) => html`
          <div class="guide-conflicts-aggregate-group">
            <strong class="guide-conflicts-repo">${repo}</strong>
            ${conflicts.map(
              (c) => html`
              <div class="guide-conflict-row">
                <span class="guide-conflict-stage">${c.stage}</span>
                <span class="guide-conflict-message">${c.message}</span>
                <sl-badge variant="neutral" pill class="guide-conflict-source">${c.source}</sl-badge>
              </div>
            `,
            )}
          </div>
        `,
        )}
      </div>
    </sl-details>
  `;
}

const HALTABLE = new Set(['running', 'planning', 'integration_testing']);
const RESUMABLE = new Set(['halted', 'failed', 'integration_failed']);
const TERMINAL = new Set([
  'completed',
  'failed',
  'integration_failed',
  'halted',
]);
const PLAN_EDITABLE = new Set(['halted', 'failed', 'integration_failed']);
const RERUN_INTEGRATION = new Set(['integration_failed', 'completed']);

function _depAnnotationLabel(ann) {
  if (ann.type === 'blocks') return `Blocks: ${ann.target}`;
  if (ann.type === 'depends_on') return `Depends on: ${ann.target}`;
  return ann.target;
}

// ─── sub-views ────────────────────────────────────────────────────────────────

function _overviewSection(ws) {
  const startedAt = ws.created_at || null;
  const endedAt = _wallEndedAt(ws);
  const isActive = HALTABLE.has(ws.status);
  const duration = startedAt
    ? formatDuration(elapsed(startedAt, isActive ? null : endedAt))
    : 'N/A';
  const cost = _computeTotalCost(ws.children, ws.master_planner_cost);
  const editHref = ws.workspace_json_name
    ? `#/workspaces/${ws.workspace_json_name}/edit`
    : null;

  // Reuse `.fleet-meta-line` / `.fleet-meta-item` classes so the workspace
  // hero meta strip lays out identically to the fleet hero — horizontal
  // wrap, 4px row gap × 20px column gap, label-then-value pairs. The hero
  // breadcrumb and the body's `_actionsRow` were removed: the page-header
  // bar now carries the status badge and Resume/Cleanup/Re-run buttons
  // (mirrors fleet-runs/:id), so showing them twice is just noise.
  return html`
    <div
      class="run-detail-overview workspace-detail-overview"
      data-workspace-id="${ws.workspace_id}"
    >
      <div class="run-info-section fleet-info-section">
        <div class="fleet-overview-status-row">
          <span class="meta-label">Workspace ID:</span>
          <code class="fleet-id-chip">${ws.workspace_id}</code>
          ${
            editHref
              ? html`<a href="${editHref}" class="edit-workspace-json">Edit workspace.json</a>`
              : nothing
          }
        </div>

        <div class="fleet-meta-line">
          <span class="fleet-meta-item">
            <span class="meta-label">Name:</span>
            <span class="meta-value">${ws.name || '—'}</span>
          </span>
          <span class="fleet-meta-item">
            <span class="meta-label">Tiers:</span>
            <span class="meta-value">${_tierProgress(ws.tiers)}</span>
          </span>
        </div>

        <div class="fleet-meta-line">
          <span class="fleet-meta-item">
            <span class="meta-label">Started:</span>
            <span class="meta-value">${formatTimestamp(startedAt)}</span>
          </span>
          ${
            endedAt
              ? html`<span class="fleet-meta-item">
                  <span class="meta-label">Finished:</span>
                  <span class="meta-value">${formatTimestamp(endedAt)}</span>
                </span>`
              : nothing
          }
          <span class="fleet-meta-item">
            <span class="meta-label">Duration:</span>
            <span class="meta-value">${duration}</span>
          </span>
          <span class="fleet-meta-item">
            <span class="meta-label">Cost:</span>
            <span class="meta-value">${_formatCost(cost)}</span>
          </span>
        </div>

        ${_guideConflictsAggregate(ws.children)}
      </div>
    </div>
  `;
}

function _dagPanel(ws) {
  if (!ws.dag) return nothing;
  const { svg } = dagGraphView(ws.dag, { mode: 'navigate' });
  if (!svg) return nothing;
  return html`
    <div class="new-run-section workspace-dag-panel">
      <h3 class="new-run-section-title">Dependency Graph</h3>
      <div class="workspace-dag-svg">${unsafeHTML(svg)}</div>
    </div>
  `;
}

function _workRequestSection(ws) {
  const wr = ws.work_request || {};
  return html`
    <div class="new-run-section">
      <h3 class="new-run-section-title">Work Request</h3>
      <div class="settings-field">
        <label class="settings-label">Title</label>
        <strong class="workspace-wr-title">${wr.title || '—'}</strong>
      </div>
      ${
        wr.description
          ? html`
            <div class="settings-field">
              <label class="settings-label">Description</label>
              <p class="workspace-wr-description">${wr.description}</p>
            </div>
          `
          : nothing
      }
    </div>
  `;
}

function _planPanel(ws, { rerender, onSavePlan } = {}) {
  const canEdit = PLAN_EDITABLE.has(ws.status);
  const hasPlan = ws.workspace_plan != null && ws.workspace_plan !== '';

  return html`
    <div class="new-run-section workspace-plan-panel">
      <h3 class="new-run-section-title">Workspace Plan</h3>
      ${
        hasPlan
          ? html`<pre class="workspace-plan-content">${ws.workspace_plan}</pre>`
          : html`<div class="settings-field"><span class="settings-field-hint">No workspace plan available.</span></div>`
      }
      ${
        canEdit
          ? html`
            <div class="settings-tab-actions">
              <sl-button
                size="small"
                class="btn-edit-plan"
                @click=${
                  rerender
                    ? () => {
                        planEditDialogOpen = true;
                        planEditContent = ws.workspace_plan || '';
                        rerender();
                      }
                    : null
                }
              >Edit plan</sl-button>
            </div>
            <sl-dialog
              label="Edit Workspace Plan"
              class="plan-edit-dialog"
              ?open=${planEditDialogOpen}
              @sl-after-hide=${
                rerender
                  ? () => {
                      planEditDialogOpen = false;
                      rerender();
                    }
                  : null
              }
            >
              <sl-textarea
                rows="30"
                class="plan-edit-textarea code"
                value="${planEditContent}"
                @sl-input=${
                  rerender
                    ? (e) => {
                        planEditContent = e.target.value;
                      }
                    : null
                }
              ></sl-textarea>
              <div slot="footer">
                <sl-button
                  variant="primary"
                  class="btn-save-plan"
                  @click=${
                    onSavePlan
                      ? () => {
                          onSavePlan(planEditContent);
                          planEditDialogOpen = false;
                          if (rerender) rerender();
                        }
                      : null
                  }
                >Save</sl-button>
              </div>
            </sl-dialog>
          `
          : nothing
      }
    </div>
  `;
}

function _contextArtifactsPanel(ws) {
  const artifacts = ws.context_artifacts;
  if (!artifacts || Object.keys(artifacts).length === 0) return nothing;

  const entries = Object.entries(artifacts);
  return html`
    <div class="new-run-section context-artifacts-panel">
      <h3 class="new-run-section-title">Context Artifacts</h3>
      <sl-tab-group>
        ${entries.map(
          ([edge, content], i) => html`
            <sl-tab slot="nav" panel="artifact-${i}">${edge}</sl-tab>
            <sl-tab-panel name="artifact-${i}">
              <pre class="context-artifact-content">${content}</pre>
            </sl-tab-panel>
          `,
        )}
      </sl-tab-group>
    </div>
  `;
}

function _aggregateCostSection(ws) {
  const total = _computeTotalCost(ws.children, ws.master_planner_cost);
  return html`
    <div class="new-run-section workspace-aggregate-cost">
      <h3 class="new-run-section-title">Aggregate Cost</h3>
      <div class="settings-field">
        <label class="settings-label">Total USD spent</label>
        <span class="workspace-total-cost">${_formatCost(total)}</span>
        <span class="settings-field-hint">Summed across all child runs and master planner.</span>
      </div>
    </div>
  `;
}

function _integrationTestPanel(ws) {
  const integ = ws.integration;
  if (!integ || !integ.enabled) return nothing;

  const showRerun = RERUN_INTEGRATION.has(ws.status);

  return html`
    <div class="new-run-section integration-test-panel">
      <h3 class="new-run-section-title">Integration Test</h3>
      <div class="settings-field">
        <label class="settings-label">Command</label>
        <code class="integration-command">${integ.command || '—'}</code>
      </div>
      ${
        integ.cwd
          ? html`
            <div class="settings-field">
              <label class="settings-label">Working directory</label>
              <code>${integ.cwd}</code>
            </div>
          `
          : nothing
      }
      ${
        integ.status
          ? html`
            <div class="settings-field">
              <label class="settings-label">Status</label>
              <sl-badge variant="${integ.status === 'passed' ? 'success' : 'danger'}">${integ.status}</sl-badge>
            </div>
          `
          : nothing
      }
      ${
        showRerun
          ? html`
            <div class="settings-tab-actions">
              <sl-button size="small" class="btn-rerun-integration">Re-run integration test</sl-button>
            </div>
          `
          : nothing
      }
    </div>
  `;
}

function _prTable(ws) {
  const children = ws.children || [];
  const anyHavePr = children.some((c) => c.pr_url);

  return html`
    <div class="new-run-section workspace-pr-table">
      <div class="workspace-pr-header">
        <h3 class="new-run-section-title">Pull Requests</h3>
        ${
          anyHavePr
            ? html`<sl-button size="small" class="btn-copy-all-pr-urls">Copy all PR URLs</sl-button>`
            : nothing
        }
      </div>
      ${
        ws.umbrella_issue_url
          ? html`
            <div class="settings-field">
              <a href="${ws.umbrella_issue_url}" target="_blank" class="umbrella-issue-link">View umbrella issue</a>
            </div>
          `
          : nothing
      }
      <table class="workspace-pr-rows">
        <thead>
          <tr>
            <th>Repo</th>
            <th>PR</th>
            <th>Status</th>
            <th>Dependencies</th>
          </tr>
        </thead>
        <tbody>
          ${children.map(
            (child) => html`
              <tr class="workspace-pr-row">
                <td>${child.repo_name || child.project_path?.split('/').pop() || '—'}</td>
                <td>
                  ${
                    child.pr_url
                      ? html`<a href="${child.pr_url}" target="_blank">#${child.pr_number}</a>`
                      : html`<span class="pr-pending">—</span>`
                  }
                </td>
                <td>
                  ${
                    child.pr_status
                      ? html`<sl-badge variant="${child.pr_status === 'merged' ? 'success' : 'primary'}" pill>${child.pr_status}</sl-badge>`
                      : html`<span class="pr-pending">—</span>`
                  }
                </td>
                <td>
                  ${
                    (child.dep_annotations || []).length > 0
                      ? (child.dep_annotations || []).map(
                          (ann) =>
                            html`<sl-tag size="small" pill>${_depAnnotationLabel(ann)}</sl-tag>`,
                        )
                      : html`<span>—</span>`
                  }
                </td>
              </tr>
            `,
          )}
        </tbody>
      </table>
    </div>
  `;
}

function _actionsRow(
  ws,
  { rerender, onHalt, onResume, onCleanup, onRerun } = {},
) {
  const showHalt = HALTABLE.has(ws.status);
  const showResume = RESUMABLE.has(ws.status);
  const showCleanup = TERMINAL.has(ws.status);
  const showRerun = TERMINAL.has(ws.status);
  const isNonCompleted = ws.status !== 'completed';

  return html`
    <div class="workspace-actions">
      ${
        showHalt
          ? html`
            <sl-button
              variant="danger"
              outline
              class="btn-halt"
              @click=${
                rerender
                  ? () => {
                      haltConfirmDialogOpen = true;
                      rerender();
                    }
                  : null
              }
            >Halt workspace</sl-button>
          `
          : nothing
      }
      ${
        showResume
          ? html`
            <sl-button
              variant="success"
              class="btn-resume"
              @click=${onResume || null}
            >Resume workspace</sl-button>
          `
          : nothing
      }
      ${
        showCleanup
          ? html`
            <sl-button
              variant="warning"
              outline
              class="btn-cleanup"
              @click=${
                rerender
                  ? () => {
                      cleanupDialogOpen = true;
                      cleanupResumeAcked = false;
                      rerender();
                    }
                  : null
              }
            >Cleanup workspace</sl-button>
          `
          : nothing
      }
      ${
        showRerun
          ? html`
            <sl-button
              variant="neutral"
              class="btn-rerun"
              @click=${onRerun || null}
            >Re-run workspace</sl-button>
          `
          : nothing
      }

      <sl-dialog
        label="Halt Workspace"
        class="halt-confirm-dialog"
        ?open=${haltConfirmDialogOpen}
        @sl-after-hide=${
          rerender
            ? () => {
                haltConfirmDialogOpen = false;
                rerender();
              }
            : null
        }
      >
        <p>In-flight tier children will finish. Unstarted tiers will not be launched.</p>
        <div slot="footer">
          <sl-button variant="danger" class="btn-confirm-halt" @click=${onHalt || null}>Halt</sl-button>
        </div>
      </sl-dialog>

      <sl-dialog
        label="Cleanup Workspace"
        class="cleanup-confirm-dialog"
        ?open=${cleanupDialogOpen}
        @sl-after-hide=${
          rerender
            ? () => {
                cleanupDialogOpen = false;
                rerender();
              }
            : null
        }
      >
        <p>This will remove all child worktrees and the workspace run directory.</p>
        ${
          isNonCompleted
            ? html`
              <div class="resume-loss-warning">
                <sl-checkbox
                  class="cleanup-resume-ack"
                  ?checked=${cleanupResumeAcked}
                  @sl-change=${
                    rerender
                      ? (e) => {
                          cleanupResumeAcked = e.target.checked;
                          rerender();
                        }
                      : null
                  }
                >I understand this workspace cannot be resumed after cleanup.</sl-checkbox>
              </div>
            `
            : nothing
        }
        <div slot="footer">
          <sl-button variant="danger" class="btn-confirm-cleanup" @click=${onCleanup || null}>Cleanup</sl-button>
        </div>
      </sl-dialog>
    </div>
  `;
}

function _circuitBreakerAlertView(ws) {
  if (ws.status !== 'halted' || ws.halt_reason !== 'circuit_breaker') {
    return nothing;
  }
  const cb = ws.circuit_breaker || {};
  return html`
    <sl-alert variant="warning" open class="workspace-circuit-breaker-alert">
      <sl-icon slot="icon" name="exclamation-triangle"></sl-icon>
      <strong>Circuit breaker tripped.</strong>
      Unstarted tiers were cancelled; in-flight children finished naturally.
      ${
        cb.unstarted_count != null
          ? html`<span class="cb-unstarted-count">${cb.unstarted_count} children halted before launch.</span>`
          : nothing
      }
      ${cb.trip_reason ? html`<div class="cb-trip-reason">${cb.trip_reason}</div>` : nothing}
    </sl-alert>
  `;
}

function _userHaltAlertView(ws) {
  if (ws.status !== 'halted' || ws.halt_reason === 'circuit_breaker') {
    return nothing;
  }
  return html`
    <sl-alert variant="neutral" open class="workspace-user-halt-alert">
      <sl-icon slot="icon" name="pause-circle"></sl-icon>
      <strong>Halted by operator.</strong>
      In-flight tier children finished naturally. Resume to continue from the halted tier.
    </sl-alert>
  `;
}

// ─── main view ────────────────────────────────────────────────────────────────

export function workspaceDetailView(
  workspace,
  {
    rerender,
    missing,
    workspaceId,
    // onHalt / onResume / onCleanup / onRerun were consumed by the
    // bottom-of-body `_actionsRow`. Those buttons live in the page-header
    // bar now (driven by main.js' contentHeaderView for workspace-runs/:id),
    // so the callbacks are accepted-but-unused here for API compatibility.
    onHalt: _onHalt,
    onResume: _onResume,
    onCleanup: _onCleanup,
    onRerun: _onRerun,
    onSavePlan,
    onSelectRun: _onSelectRun,
  } = {},
) {
  if (!workspace) {
    if (missing) {
      return html`
        <div class="workspace-detail-empty">
          <sl-icon name="archive" library="default"></sl-icon>
          <h2>Workspace not found</h2>
          <p>
            ${
              workspaceId
                ? html`The workspace manifest for
                  <code>${workspaceId}</code> is no longer available.`
                : html`The workspace manifest is no longer available.`
            }
            It has been cleaned up or was never created.
          </p>
          <p class="workspace-detail-empty-hint">
            Per-project run history is still accessible from the
            <a href="#/history">History</a> view.
          </p>
        </div>
      `;
    }
    return html`<div class="workspace-detail-loading"><sl-spinner></sl-spinner> Loading workspace…</div>`;
  }

  // Header actions (Resume / Cleanup / Re-run) live in the page-header bar
  // for visual parity with /fleet-runs/:id and /history/:id — the previous
  // bottom-of-body `_actionsRow` is intentionally dropped. The cost meta
  // moved into the hero meta strip, so `_aggregateCostSection` is dropped
  // too. Both onHalt/onResume/onCleanup/onRerun callbacks remain in the
  // signature so callers don't break; they're just unused here now.
  return html`
    <div class="new-run-page workspace-detail-page">
      ${_overviewSection(workspace)}
      ${_circuitBreakerAlertView(workspace)}
      ${_userHaltAlertView(workspace)}
      <div class="new-run-form workspace-detail-body">
        ${_dagPanel(workspace)}
        ${_workRequestSection(workspace)}
        ${_planPanel(workspace, { rerender, onSavePlan })}
        ${_contextArtifactsPanel(workspace)}
        ${_integrationTestPanel(workspace)}
        ${_prTable(workspace)}
      </div>
    </div>
  `;
}
