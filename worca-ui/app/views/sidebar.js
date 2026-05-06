import { html } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import {
  Activity,
  Archive,
  Coins,
  GitBranch,
  iconSvg,
  List,
  Plus,
  Settings,
  SlidersHorizontal,
  Zap,
} from '../utils/icons.js';

/**
 * Derive aggregate status for a project from its runs.
 * @param {string} projectId
 * @param {object} runs - { [runId]: run }
 * @returns {'idle'|'running'|'error'|'paused'}
 */
export function projectStatus(projectId, runs, currentProjectId) {
  const runList = Object.values(runs);
  // In multi-project mode, runs in state belong to currentProjectId.
  // For other projects we have no data — return idle.
  const projectRuns = projectId
    ? runList.filter((r) => {
        const tagged = r.project || r._project;
        if (tagged) return tagged === projectId;
        // Untagged runs belong to the current project (server only sends
        // runs for the selected project, so all untagged runs are its).
        return !currentProjectId || currentProjectId === projectId;
      })
    : runList;

  let hasRunning = false;
  let hasError = false;
  let hasPaused = false;

  for (const r of projectRuns) {
    const ps = r.pipeline_status || (r.active ? 'running' : 'completed');
    if (ps === 'running') hasRunning = true;
    else if (ps === 'failed' || ps === 'error') hasError = true;
    else if (ps === 'paused' || ps === 'approval_needed') hasPaused = true;
  }

  if (hasRunning) return 'running';
  if (hasError) return 'error';
  if (hasPaused) return 'paused';
  return 'idle';
}

/**
 * Map project status to a CSS color class for the status dot.
 */
function statusDotClass(status) {
  switch (status) {
    case 'running':
      return 'project-status-running';
    case 'error':
      return 'project-status-error';
    case 'paused':
      return 'project-status-paused';
    default:
      return 'project-status-idle';
  }
}

export function sidebarView(
  state,
  route,
  connectionState,
  { onNavigate, onProjectChange, onAddProject },
) {
  // Settings use nested shape only — read pre-resolved scalars from state, never flat-dot bracket keys.
  const {
    runs,
    preferences,
    projects,
    currentProjectId,
    worktrees = [],
    worktreeDiskWarningBytes = 2_000_000_000,
    totalRunning = 0,
    maxConcurrentPipelines = 10,
  } = state;
  const atCapacity = totalRunning >= maxConcurrentPipelines;
  const allRunList = Object.values(runs);
  // Filter to selected project for counters (sidebar dots use allRunList via projectStatus)
  const runList =
    currentProjectId && (projects || []).length > 1
      ? allRunList.filter((r) => {
          const rp = r.project || r._project;
          return rp === currentProjectId;
        })
      : allRunList;
  const activeCount = runList.filter((r) => {
    const ps = r.pipeline_status || (r.active ? 'running' : 'completed');
    return ps === 'running';
  }).length;
  const historyCount = runList.length;

  const beadsIssues = state.beads?.issues || [];
  const beadsReady = beadsIssues.filter(
    (i) => i.status === 'ready' && (i.blocked_by?.length ?? 0) === 0,
  ).length;

  const worktreeCount = worktrees.length;
  const diskWarningThreshold = worktreeDiskWarningBytes;
  const totalWorktreeDisk = worktrees.reduce(
    (s, w) => s + (w.disk_bytes || 0),
    0,
  );
  const worktreeDiskWarning = totalWorktreeDisk > diskWarningThreshold;

  const connClass =
    connectionState === 'open'
      ? 'connected'
      : connectionState === 'reconnecting'
        ? 'reconnecting'
        : 'disconnected';
  const connLabel =
    connectionState === 'open'
      ? 'Connected'
      : connectionState === 'reconnecting'
        ? 'Reconnecting\u2026'
        : 'Disconnected';

  return html`
    <aside class="sidebar ${preferences.sidebarCollapsed ? 'collapsed' : ''}">
      <div class="sidebar-logo" @click=${() => onNavigate('dashboard')} style="cursor:pointer">
        <span class="logo-text">WORCA</span>
      </div>

      ${
        projects && projects.length >= 1
          ? html`
        <div class="sidebar-section sidebar-project-section">
          <div class="sidebar-section-header">Project</div>
          <div class="sidebar-project-selector-row">
            <div class="sidebar-project-selector">
              <sl-select
                size="small"
                value=${currentProjectId || ''}
                @sl-change=${(e) => onProjectChange?.(e.target.value)}
              >
                <sl-option value="">All Projects</sl-option>
                <sl-divider></sl-divider>
                ${projects.map((p) => {
                  const pStatus = projectStatus(p.name, runs, currentProjectId);
                  const dotClass = statusDotClass(pStatus);
                  return html`
                    <sl-option value=${p.name}>
                      <span class="project-option-label">
                        <span class="project-status-dot ${dotClass}"></span>
                        ${p.name}
                      </span>
                    </sl-option>
                  `;
                })}
              </sl-select>
            </div>
            <button class="sidebar-add-project-btn" aria-label="Add project" @click=${() => onAddProject?.()}>
              ${unsafeHTML(iconSvg(Plus, 16))}
            </button>
          </div>
        </div>
      `
          : ''
      }

      ${
        currentProjectId || (projects || []).length <= 1
          ? html`
      <div class="sidebar-new-run">
        <button
          type="button"
          class="sidebar-new-run-btn"
          ?disabled=${atCapacity}
          @click=${() => onNavigate('new-run')}
        >
          ${unsafeHTML(iconSvg(Plus, 14))}
          <span>New Pipeline</span>
        </button>
      </div>

      <div class="sidebar-section">
        <div class="sidebar-section-header">Pipeline</div>
        <div class="sidebar-item ${route.section === 'active' ? 'active' : ''}"
             @click=${() => onNavigate('active')}>
          <span class="sidebar-item-left">
            ${unsafeHTML(iconSvg(Activity, 16))}
            <span>Running</span>
          </span>
          ${activeCount > 0 ? html`<sl-badge variant="primary" pill>${activeCount}</sl-badge>` : ''}
        </div>
        <div class="sidebar-item ${route.section === 'history' ? 'active' : ''}"
             @click=${() => onNavigate('history')}>
          <span class="sidebar-item-left">
            ${unsafeHTML(iconSvg(Archive, 16))}
            <span>History</span>
          </span>
          ${historyCount > 0 ? html`<sl-badge variant="neutral" pill>${historyCount}</sl-badge>` : ''}
        </div>
        ${
          worktreeCount > 0
            ? html`
        <div class="sidebar-item ${route.section === 'worktrees' ? 'active' : ''}"
             @click=${() => onNavigate('worktrees')}>
          <span class="sidebar-item-left">
            ${unsafeHTML(iconSvg(GitBranch, 16))}
            <span>Worktrees</span>
          </span>
          <sl-badge variant="${worktreeDiskWarning ? 'warning' : 'neutral'}" pill class="worktrees-count-badge">${worktreeCount}</sl-badge>
        </div>`
            : ''
        }
      </div>

      <div class="sidebar-section">
        <div class="sidebar-section-header">Work</div>
        <div class="sidebar-item ${route.section === 'beads' ? 'active' : ''}"
             @click=${() => onNavigate('beads')}>
          <span class="sidebar-item-left">
            ${unsafeHTML(iconSvg(List, 16))}
            <span>Beads</span>
          </span>
          ${beadsReady > 0 ? html`<sl-badge variant="success" pill>${beadsReady}</sl-badge>` : ''}
        </div>
      </div>

      <div class="sidebar-section">
        <div class="sidebar-section-header">Analytics</div>
        <div class="sidebar-item ${route.section === 'costs' ? 'active' : ''}"
             @click=${() => onNavigate('costs')}>
          <span class="sidebar-item-left">
            ${unsafeHTML(iconSvg(Coins, 16))}
            <span>Costs</span>
          </span>
        </div>
        <div class="sidebar-item ${route.section === 'webhooks' ? 'active' : ''}"
             @click=${() => onNavigate('webhooks')}>
          <span class="sidebar-item-left">
            ${unsafeHTML(iconSvg(Zap, 16))}
            <span>Webhooks</span>
          </span>
          ${(state.webhookInbox?.events?.length || 0) > 0 ? html`<sl-badge variant="warning" pill>${state.webhookInbox.events.length}</sl-badge>` : ''}
        </div>
      </div>

      <div class="sidebar-section">
        <div class="sidebar-section-header">Configuration</div>
        <div class="sidebar-item ${route.section === 'project-settings' ? 'active' : ''}"
             @click=${() => onNavigate('project-settings')}>
          <span class="sidebar-item-left">
            ${unsafeHTML(iconSvg(SlidersHorizontal, 16))}
            <span>Project Settings</span>
          </span>
        </div>
      </div>
      `
          : ''
      }

      <div class="sidebar-footer">
        <div class="connection-indicator ${connClass}">
          <span class="conn-dot"></span>
          <span class="conn-label">${connLabel}</span>
        </div>
        <button
          class="theme-toggle-btn ${route.section === 'settings' ? 'active' : ''}"
          aria-label="Settings"
          @click=${() => onNavigate('settings')}
        >${unsafeHTML(iconSvg(Settings, 18))}</button>
      </div>
    </aside>
  `;
}
