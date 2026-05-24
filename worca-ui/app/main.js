import { html, nothing, render } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { createNotificationManager } from './notifications.js';
import { navigate, onHashChange, parseHash } from './router.js';
import { createStore, isArchivedRunExpired } from './state.js';
import { createArchiveActions } from './utils/archive-actions.js';
import { confirmDialogTemplate, showConfirm } from './utils/confirm-dialog.js';
import {
  AlertTriangle,
  ArrowLeft,
  CircleSlash,
  Database,
  iconSvg,
  Loader,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Square,
  Trash2,
} from './utils/icons.js';
import {
  mapProjectRunsResponse,
  mapWorktreesResponse,
} from './utils/run-mappers.js';
import { sortByStartDesc } from './utils/sort-runs.js';
import { actionAllowed } from './utils/state-actions.js';
import { statusIcon } from './utils/status-badge.js';
import { applyTheme } from './utils/theme.js';
import { formatTitle } from './utils/title.js';
import {
  addProjectDialogView,
  batchWorcaSetupDialogTemplate,
} from './views/add-project-dialog.js';
import { beadsPanelView, beadsRunListView } from './views/beads-panel.js';
import { dashboardView } from './views/dashboard.js';
import { fleetCardView } from './views/fleet-card.js';
import { fleetDetailView } from './views/fleet-detail.js';
import {
  fleetLauncherView,
  getFleetLauncherSubmitState,
  resetLauncherState,
  submitFleetLauncher,
} from './views/fleet-launcher.js';
import { learningsSectionView } from './views/learnings-panel.js';
import {
  clearLiveTerminal,
  disposeLiveTerminal,
  getActiveStage,
  liveOutputView,
  mountLiveTerminal,
  updateActiveStage,
  writeLiveIterationSeparator,
  writeLiveLogLine,
} from './views/live-output.js';
import {
  clearTerminal,
  disposeTerminal,
  logViewerView,
  mountTerminal,
  searchTerminal,
  writeLogLine,
} from './views/log-viewer.js';
import {
  getEffectiveProjectId,
  getNewRunSubmitState,
  isAtCapacity,
  newRunView,
  submitNewRun,
} from './views/new-run.js';
import { runCardView } from './views/run-card.js';
import {
  prApprovalPanelView,
  runBeadsSectionView,
  runDetailView,
} from './views/run-detail.js';
import { runListView } from './views/run-list.js';
import {
  loadSettings,
  projectSettingsView,
  settingsView,
} from './views/settings.js';
import { sidebarView } from './views/sidebar.js';
import { tokenCostsView } from './views/token-costs.js';
import { webhookInboxView } from './views/webhook-inbox.js';
import { workspaceCardView } from './views/workspace-card.js';
import {
  getWorkspaceCreateSubmitState,
  resetWorkspaceCreateState,
  submitWorkspaceCreate,
  workspaceCreateView,
} from './views/workspace-create.js';
import { workspaceDetailView } from './views/workspace-detail.js';
import {
  getWorkspaceEditSubmitState,
  loadWorkspace,
  submitWorkspaceEdit,
  workspaceEditView,
} from './views/workspace-edit.js';
import { workspacesConfigView } from './views/workspaces-config.js';
import { worktreesView } from './views/worktrees.js';
import { createWsClient } from './ws.js';

// Register Shoelace components (tree-shaken — only imports what we use)
import '@shoelace-style/shoelace/dist/components/details/details.js';
import '@shoelace-style/shoelace/dist/components/select/select.js';
import '@shoelace-style/shoelace/dist/components/option/option.js';
import '@shoelace-style/shoelace/dist/components/input/input.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/copy-button/copy-button.js';

import '@shoelace-style/shoelace/dist/components/badge/badge.js';
import '@shoelace-style/shoelace/dist/components/divider/divider.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import '@shoelace-style/shoelace/dist/components/dialog/dialog.js';
import '@shoelace-style/shoelace/dist/components/tab-group/tab-group.js';
import '@shoelace-style/shoelace/dist/components/tab/tab.js';
import '@shoelace-style/shoelace/dist/components/tab-panel/tab-panel.js';
import '@shoelace-style/shoelace/dist/components/switch/switch.js';
import '@shoelace-style/shoelace/dist/components/alert/alert.js';
import '@shoelace-style/shoelace/dist/components/textarea/textarea.js';
import '@shoelace-style/shoelace/dist/components/radio-group/radio-group.js';
import '@shoelace-style/shoelace/dist/components/radio/radio.js';
import '@shoelace-style/shoelace/dist/components/radio-button/radio-button.js';
import '@shoelace-style/shoelace/dist/components/checkbox/checkbox.js';
import '@shoelace-style/shoelace/dist/components/spinner/spinner.js';
// Dropdown + menu power the sidebar's "+ New" picker. Without these the
// custom elements stay unregistered and the <sl-menu-item> children bleed
// inline as plain text (observed: "New Fleet" rendering below the trigger).
import '@shoelace-style/shoelace/dist/components/dropdown/dropdown.js';
import '@shoelace-style/shoelace/dist/components/menu/menu.js';
import '@shoelace-style/shoelace/dist/components/menu-item/menu-item.js';
// sl-icon / sl-icon-button: status indicators and toggle controls used in
// fleet detail, group-rendering, settings, run-card.
import '@shoelace-style/shoelace/dist/components/icon/icon.js';
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js';
// sl-card: PR approval panel in run-detail.
import '@shoelace-style/shoelace/dist/components/card/card.js';
// sl-progress-bar / sl-range / sl-tag: fleet header progress bar, fleet
// launcher circuit-breaker threshold slider, fleet-detail guide filenames.
import '@shoelace-style/shoelace/dist/components/progress-bar/progress-bar.js';
import '@shoelace-style/shoelace/dist/components/range/range.js';
import '@shoelace-style/shoelace/dist/components/tag/tag.js';

const store = createStore();

function projectUrl(path) {
  const pid = store.getState().currentProjectId;
  return pid ? `/api/projects/${pid}${path}` : `/api${path}`;
}

// Resolve the projectId for a runId by looking up the run in state.
// Required for run-scoped WS messages in global mode: the WS connection
// itself is bound to `currentProjectId` (often null in global mode), but
// the server's `resolveProject()` honours `payload.projectId` first. Without
// this, fetches like `get-agent-prompt` and `subscribe-log` for a run that
// lives in a non-default project return NOT_FOUND and silently fail (the
// JS catches the error, the cache stays empty, the UI shows nothing).
function _runProjectId(runId) {
  if (!runId) return null;
  const state = store.getState();
  const run = state.runs?.[runId] || state.archivedRuns?.[runId] || null;
  return run?.project || run?._project || state.currentProjectId || null;
}

// Build a project-scoped URL for a run-scoped REST endpoint. Resolves the
// run's owning project via `_runProjectId` so global mode (no currentProjectId)
// still hits `/api/projects/<project>/...` instead of falling back to the
// legacy `/api/...` mount — which has no `worcaDir` configured and returns
// 501 "worcaDir not configured" for any project-scoped action.
function runUrl(runId, path) {
  const pid = _runProjectId(runId);
  return pid ? `/api/projects/${pid}${path}` : `/api${path}`;
}

// Build a project-scoped URL for a worktree-scoped REST endpoint. Worktrees
// in state carry a `project` field stamped by fetchWorktrees; using that
// keeps cleanup working in global mode when no project is selected. Falls
// back to legacy `/api/...` only when the worktree isn't in state (e.g. a
// race with a fresh page navigation).
function worktreeUrl(runId, path) {
  const wt = (store.getState().worktrees || []).find((w) => w.run_id === runId);
  const pid = wt?.project || store.getState().currentProjectId;
  return pid ? `/api/projects/${pid}${path}` : `/api${path}`;
}

const ws = createWsClient();
const notificationManager = createNotificationManager({
  store,
  ws,
  getSettings: () => settings,
});
// ─── Session-level state (not reset on project switch) ────────────────
let route = parseHash(location.hash);
let connectionState = ws.getState();
let autoScroll = true;

// ─── Project-scoped mutable state ─────────────────────────────────────
// All variables below are reset by resetProjectState() during project
// switch. When adding a new project-scoped variable, add its default to
// resetProjectState() to avoid stale state bugs.

// -- Settings & pipeline control --
let settings = {};
let pipelineAction = null; // null | 'stopping' | 'resuming' | 'pausing'
let _controlPending = null; // null | { action: 'pause'|'resume'|'stop', runId: string }
let actionError = null; // null | string (error message, auto-clears)
let restartStageKey = null;

// -- Fleet views --
const _fleetDetailCache = {}; // { fleetId: manifest }
let _fleetDetailFetching = null; // currently-fetching fleet id (single in-flight)
// Set of fleet ids the API has confirmed missing (404 / !data.ok). Symmetric
// to _fleetDetailCache for the negative case — without it the detail view
// stays at "Loading fleet…" forever when the manifest has been cleaned up
// (common path: user navigates to a fleet link from a history entry, but
// `worca cleanup --fleet-id` already removed the manifest). In-memory only
// — a page refresh re-fetches and re-marks. Persisting would create a
// staleness hazard (manifest re-created with same id during testing) for
// no real-world benefit since fleet ids embed a timestamp + random suffix.
const _fleetDetailMissing = new Set();
let _fleetStatusFilter = 'all'; // /#/fleet-runs filter chip selection
let _fleetTextFilter = ''; // /#/fleet-runs free-text filter

// -- Workspace views -- (mirror fleet detail-cache pattern)
const _wsDetailCache = {}; // { workspaceId: manifest }
let _wsDetailFetching = null;
const _wsDetailMissing = new Set();

// Tracks which section last entered the launcher's "new" route so we only
// reset launcherMode on transitions between fleet-runs and workspace-runs.
// Without this, every rerender would clobber user edits inside the form.
let _lastLauncherSection = null;
// Same idea for the workspace-create form — reset on first entry, persist
// across in-route rerenders so user input survives keystrokes.
let _lastCreateSection = null;
// Track the workspace name currently loaded into the edit form so we only
// re-fetch when navigating to a different workspace, not on every rerender.
let _lastEditWorkspace = null;
// When the user clicks "Launch" in the workspaces-config list, we stash the
// chosen workspace name here. The launcher consumes it on mount, presetting
// the dropdown so the user lands ready to submit instead of re-selecting.
let _pendingLaunchWorkspace = null;

// Free-text match for a fleet — title, fleet id, and member project
// names. Mirrors `_runMatchesText` (run-list) and `_matchesFilter`
// (worktrees) so all three list pages search consistently.
function _fleetMatchesText(fleet, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const title = fleet.work_request?.title || fleet.title || '';
  const projectNames = (fleet.children || [])
    .map((c) => (c.project_path || c.project || '').split('/').pop() || '')
    .join(' ');
  return (
    title.toLowerCase().includes(needle) ||
    (fleet.fleet_id || '').toLowerCase().includes(needle) ||
    projectNames.toLowerCase().includes(needle)
  );
}

// Status chips for the /#/fleet-runs list — mirrors the History page's
// `.filter-chips`. "halted" replaces pipeline's "paused"/"error" since
// that's the fleet-level non-terminal-but-stopped state; "archived" pulls
// from the archived flag rather than a status value.
const _FLEET_FILTER_STATUSES = [
  'all',
  'running',
  'completed',
  'failed',
  'halted',
  'archived',
];

function _fleetListView() {
  // state.fleets is the single source of truth: populated on bootstrap and
  // refreshed by the fleet-update WS handler. Reading the module-level
  // cache used to drop refreshed entries on the floor (the list never
  // updated after halt / cleanup events). Switch to a state-driven read so
  // the list view stays consistent with the sidebar Fleets count.
  const fleets = store.getState().fleets;
  if (fleets === undefined) {
    // Bootstrap hasn't completed yet (no /api/fleet-runs fetch returned).
    return html`<div class="fleet-list-loading"><sl-spinner></sl-spinner> Loading fleets…</div>`;
  }
  if (fleets.length === 0) {
    return html`
      <div class="fleet-list-empty">
        <p>No fleet runs yet.</p>
        <sl-button variant="primary" @click=${() => navigate('fleet-runs', 'new', null)}>
          + Run Fleet
        </sl-button>
      </div>
    `;
  }

  // Per-chip counts. `all` and every status count is over *non-archived*
  // fleets; `archived` is its own bucket — same split as History (where
  // archived runs live in a separate `archivedRuns` array).
  const live = fleets.filter((f) => !f.archived);
  const counts = { all: live.length, archived: fleets.length - live.length };
  for (const f of live) {
    counts[f.status] = (counts[f.status] || 0) + 1;
  }

  const cardOptions = {
    onClick: (id) => navigate('fleet-runs', id, null),
    onChildClick: (runId) => navigate('active', runId, null),
    onArchive: archiveFleet,
    onUnarchive: unarchiveFleet,
  };

  let displayed =
    _fleetStatusFilter === 'archived'
      ? fleets.filter((f) => f.archived)
      : _fleetStatusFilter === 'all'
        ? live
        : live.filter((f) => f.status === _fleetStatusFilter);

  // Text filter runs after the chip filter — same ordering as History.
  const textQ = (_fleetTextFilter || '').trim();
  if (textQ) {
    displayed = displayed.filter((f) => _fleetMatchesText(f, textQ));
  }

  return html`
    <div class="filter-chips">
      ${_FLEET_FILTER_STATUSES
        .filter((s) => s === 'all' || counts[s])
        .map(
          (s) => html`
          <button
            class="filter-chip ${(_fleetStatusFilter || 'all') === s ? 'active' : ''} filter-chip-${s}"
            @click=${() => {
              _fleetStatusFilter = s;
              rerender();
            }}
          >
            ${s === 'all' ? 'All' : s}
            <span class="chip-count">${counts[s] || 0}</span>
          </button>
        `,
        )}
    </div>
    <div class="list-filter-row">
      <sl-input
        size="small"
        class="list-text-filter"
        type="text"
        placeholder="Filter by title, fleet id, or project…"
        value="${_fleetTextFilter || ''}"
        @sl-input=${(e) => {
          _fleetTextFilter = e.target.value;
          rerender();
        }}
      ></sl-input>
    </div>
    ${
      displayed.length === 0
        ? html`<div class="empty-state">No ${_fleetStatusFilter} fleets</div>`
        : html`<div class="fleet-list">
            ${displayed.map((f) =>
              fleetCardView(f, f.children || [], cardOptions),
            )}
          </div>`
    }
  `;
}

// Workspace-list filters — mirror _fleetStatusFilter / _fleetTextFilter so
// both list pages have the same filter UX (chips + text input).
let _wsStatusFilter = 'all';
let _wsTextFilter = '';

// Free-text match for a workspace run — name, workspace id, and prompt.
// Same shape as _fleetMatchesText so the two filters behave identically.
function _wsMatchesText(ws, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const name = ws.workspace_name || '';
  const prompt = ws.work_request?.title || ws.work_request?.description || '';
  return (
    name.toLowerCase().includes(needle) ||
    (ws.workspace_id || '').toLowerCase().includes(needle) ||
    prompt.toLowerCase().includes(needle)
  );
}

// Status chips for /#/workspace-runs. `halted` and `integration_failed` are
// included because they're the workspace-specific terminal-but-stopped
// states (vs fleet's just `halted`). `planning`/`integration_testing` roll
// up into the `running` bucket so the chip set stays compact.
const _WS_FILTER_STATUSES = [
  'all',
  'running',
  'completed',
  'failed',
  'halted',
  'integration_failed',
];

const _WS_ACTIVE_STATUSES = new Set([
  'running',
  'planning',
  'integration_testing',
]);

function _wsBucket(status, bucket) {
  if (bucket === 'running') return _WS_ACTIVE_STATUSES.has(status);
  return status === bucket;
}

function _workspaceListView() {
  const workspaces = store.getState().workspaceRuns;
  if (workspaces === undefined) {
    return html`<div class="fleet-list-loading"><sl-spinner></sl-spinner> Loading workspace runs…</div>`;
  }
  if (workspaces.length === 0) {
    return html`
      <div class="fleet-list-empty">
        <p>No workspace runs yet.</p>
        <sl-button variant="primary" @click=${() => navigate('workspace-runs', 'new', null)}>
          + Run Workspace
        </sl-button>
      </div>
    `;
  }

  // Per-chip counts. Every workspace is live (no archive concept yet, so
  // skip the archived bucket — when archive lands the shape becomes
  // identical to fleets and this loop just gains an extra arm).
  const counts = { all: workspaces.length };
  for (const s of _WS_FILTER_STATUSES.slice(1)) {
    counts[s] = workspaces.filter((w) => _wsBucket(w.status, s)).length;
  }

  let displayed =
    _wsStatusFilter === 'all'
      ? workspaces
      : workspaces.filter((w) => _wsBucket(w.status, _wsStatusFilter));

  const textQ = (_wsTextFilter || '').trim();
  if (textQ) {
    displayed = displayed.filter((w) => _wsMatchesText(w, textQ));
  }

  const cardOptions = {
    onClick: (id) => navigate('workspace-runs', id, null),
    // Re-run / cleanup wiring is intentionally deferred — the per-row
    // actions render only when these callbacks are supplied. Re-run needs a
    // POST /api/workspace-runs/:id/relaunch flow + UI confirm; cleanup
    // needs the worca-cleanup-by-workspace-id story finished. Both can land
    // independently once their backend contracts settle.
  };

  return html`
    <div class="filter-chips">
      ${_WS_FILTER_STATUSES
        .filter((s) => s === 'all' || counts[s])
        .map(
          (s) => html`
            <button
              class="filter-chip ${(_wsStatusFilter || 'all') === s ? 'active' : ''} filter-chip-${s}"
              @click=${() => {
                _wsStatusFilter = s;
                rerender();
              }}
            >
              ${s === 'all' ? 'All' : s.replace(/_/g, ' ')}
              <span class="chip-count">${counts[s] || 0}</span>
            </button>
          `,
        )}
    </div>
    <div class="list-filter-row">
      <sl-input
        size="small"
        class="list-text-filter"
        type="text"
        placeholder="Filter by name, workspace id, or prompt…"
        value="${_wsTextFilter || ''}"
        @sl-input=${(e) => {
          _wsTextFilter = e.target.value;
          rerender();
        }}
      ></sl-input>
    </div>
    ${
      displayed.length === 0
        ? html`<div class="empty-state">No ${_wsStatusFilter.replace(/_/g, ' ')} workspace runs</div>`
        : html`<div class="fleet-list">
            ${displayed.map((w) => workspaceCardView(w, cardOptions))}
          </div>`
    }
  `;
}

// -- Worktrees view --
let worktreesFilter = '';
let worktreesStatusFilter = 'all'; // worktrees filter-chip selection
let worktreesDialogItem = null; // null | worktree (single-row cleanup)
let worktreesDialogBulk = false; // true when "Cleanup all completed" dialog open
let worktreesDialogCheckbox = false; // resumable/grouped confirmation checkbox

// -- Log viewer --
let logFilter = '*';
let logSearch = '';
let logIterationFilter = null; // null = all iterations, number = specific

// -- Prompt cache --
const promptCache = {}; // { [runId]: { [stage]: { agentInstructions, userPrompt, agent } } }
const promptCachePending = new Set(); // tracks in-flight fetches

// -- Beads --
let beadsStatusFilter = 'all';
let beadsPriorityFilter = 'all';
let beadsStarting = null; // null | issueId
let beadsStartError = null; // null | string
const runBeads = new Map(); // runId → issues[]
let beadsCounts = {}; // { runId: count }
let lastBeadsPayload = null;
let beadsRunIssues = []; // issues for the currently viewed run
let beadsRunLoading = false;

// -- Stage iteration tabs --
const stageIterationTab = new Map(); // stageKey → iterationNumber

// -- Costs --
let costsTokenData = {}; // { runId: { stage: [ { inputTokens, outputTokens, ... } ] } }
let costsExpanded = null; // runId or null
let costsFetched = false;

// ── Integrations state ──────────────────────────────────────────────────
let integrationsStatus = null;
let integrationsConfig = null;
let integrationsEditingAdapter = null;
const integrationsForms = {};

const DEFAULT_EVENTS = [
  'pipeline.run.started',
  'pipeline.run.completed',
  'pipeline.run.failed',
  'pipeline.run.interrupted',
  'pipeline.run.paused',
  'pipeline.run.cancelled',
  'pipeline.run.resumed',
  'pipeline.run.resumed_from_pause',
  'pipeline.git.pr_created',
  'pipeline.circuit_breaker.tripped',
  'pipeline.cost.budget_warning',
];

function fetchIntegrationsData() {
  Promise.all([
    fetch('/api/integrations/status').then((r) => r.json()),
    fetch('/api/integrations/config').then((r) => r.json()),
  ])
    .then(([status, config]) => {
      integrationsStatus = status;
      integrationsConfig = config;
      rerender();
    })
    .catch(() => {
      integrationsStatus = { enabled: false };
      integrationsConfig = {};
      rerender();
    });
}

// Poll integrations status while settings tab is visible (updates connection badges)
let _igPollTimer = null;
function startIntegrationsPoll() {
  stopIntegrationsPoll();
  _igPollTimer = setInterval(() => {
    fetch('/api/integrations/status')
      .then((r) => r.json())
      .then((status) => {
        integrationsStatus = status;
        rerender();
      })
      .catch(() => {});
  }, 10_000);
}
function stopIntegrationsPoll() {
  if (_igPollTimer) {
    clearInterval(_igPollTimer);
    _igPollTimer = null;
  }
}

function getIntegrationsForm(adapter) {
  if (!integrationsForms[adapter]) {
    // Pre-fill from existing config if available
    const cfg = integrationsConfig?.[adapter];
    integrationsForms[adapter] = {
      token: cfg?.bot_token || cfg?.webhook_url || '',
      chatId: String(cfg?.chat_id || cfg?.channel_id || ''),
      events: cfg?.events ? [...cfg.events] : [...DEFAULT_EVENTS],
      saving: false,
      error: null,
      saved: false,
    };
  }
  return integrationsForms[adapter];
}

function handleIgStartEdit(adapter) {
  integrationsEditingAdapter = adapter;
  // Reset form from config
  delete integrationsForms[adapter];
  getIntegrationsForm(adapter);
  rerender();
}

function handleIgCancelEdit() {
  if (integrationsEditingAdapter) {
    delete integrationsForms[integrationsEditingAdapter];
  }
  integrationsEditingAdapter = null;
  rerender();
}

function handleIgFieldChange(adapter, field, value) {
  const form = getIntegrationsForm(adapter);
  form[field] = value;
  form.saved = false;
  form.error = null;
  rerender();
}

function handleIgEventToggle(adapter, evt) {
  const form = getIntegrationsForm(adapter);
  const idx = form.events.indexOf(evt);
  if (idx >= 0) form.events.splice(idx, 1);
  else form.events.push(evt);
  form.saved = false;
  rerender();
}

function handleIgSave(adapter) {
  const form = getIntegrationsForm(adapter);
  form.saving = true;
  form.error = null;
  form.saved = false;
  rerender();

  fetch('/api/integrations/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      adapter,
      token: form.token,
      chatId: form.chatId,
      events: form.events,
    }),
  })
    .then((r) => {
      if (!r.ok)
        return r
          .json()
          .then((d) => Promise.reject(new Error(d.error || 'Save failed')));
      return r.json();
    })
    .then(() => {
      form.saving = false;
      form.saved = true;
      integrationsEditingAdapter = null;
      fetchIntegrationsData();
    })
    .catch((err) => {
      form.saving = false;
      form.error = err.message;
      rerender();
    });
}

function handleIgRemove(adapter) {
  fetch(`/api/integrations/config/${adapter}`, { method: 'DELETE' })
    .then((r) => r.json())
    .then(() => {
      delete integrationsForms[adapter];
      integrationsEditingAdapter = null;
      fetchIntegrationsData();
    })
    .catch(() => rerender());
}

function handleIgToggleEnabled(adapter, enabled) {
  fetch(`/api/integrations/config/${adapter}/enabled`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
    .then((r) => r.json())
    .then(() => fetchIntegrationsData())
    .catch(() => rerender());
}

function handleIgDetect(adapter) {
  if (adapter !== 'telegram') return;
  const form = getIntegrationsForm(adapter);
  form.detecting = true;
  form.detectHint = null;
  rerender();

  fetch('/api/integrations/telegram/detect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: form.token }),
  })
    .then((r) => r.json())
    .then((data) => {
      form.detecting = false;
      if (!data.ok) {
        form.detectHint = data.error || 'Detection failed';
      } else if (data.chats.length === 0) {
        const bot = data.botUsername ? `@${data.botUsername}` : 'the bot';
        form.detectHint = `No chats found. Send /start to ${bot} in Telegram, then click Detect again.`;
      } else {
        form.chatId = String(data.chats[0].id);
        form.detectHint = `Found: ${data.chats[0].title} (${data.chats[0].id})`;
      }
      rerender();
    })
    .catch(() => {
      form.detecting = false;
      form.detectHint = 'Detection failed — check server logs.';
      rerender();
    });
}

// -- Webhook UI --
let webhookSelectedId = null;
let webhookCategoryFilter = 'all';
let webhookRunFilter = null;
let webhookSearchTerm = '';

// -- Run history --
let historyStatusFilter = 'all';
let historyTextFilter = ''; // free-text filter on the History list

/**
 * Reset all project-scoped state to defaults.
 * Called on project switch to prevent stale state leaking between projects.
 * When adding a new project-scoped variable above, add its reset here.
 */
function resetProjectState() {
  // Settings & pipeline control
  settings = {};
  pipelineAction = null;
  _controlPending = null;
  actionError = null;
  restartStageKey = null;
  // Log viewer
  logFilter = '*';
  logSearch = '';
  logIterationFilter = null;
  // Prompt cache
  for (const key of Object.keys(promptCache)) delete promptCache[key];
  promptCachePending.clear();
  // Beads
  beadsStatusFilter = 'all';
  beadsPriorityFilter = 'all';
  beadsStarting = null;
  beadsStartError = null;
  runBeads.clear();
  beadsCounts = {};
  lastBeadsPayload = null;
  beadsRunIssues = [];
  beadsRunLoading = false;
  // Stage iteration tabs
  stageIterationTab.clear();
  // Costs
  costsTokenData = {};
  costsExpanded = null;
  costsFetched = false;
  // Webhook UI
  webhookSelectedId = null;
  webhookCategoryFilter = 'all';
  webhookRunFilter = null;
  webhookSearchTerm = '';
  // Run history
  historyStatusFilter = 'all';
  historyTextFilter = '';
}

function handleStageTabChange(stageKey, iterationNumber) {
  stageIterationTab.set(stageKey, iterationNumber);
}

function fetchRunBeads(runId) {
  if (!runId) return;
  ws.send('list-beads-by-run', { runId, projectId: _runProjectId(runId) })
    .then((payload) => {
      runBeads.set(runId, payload.issues || []);
      rerender();
    })
    .catch(() => {});
}

function fetchAgentPrompts(runId, stages) {
  if (!runId || !stages) return;
  if (!promptCache[runId]) promptCache[runId] = {};
  const projectId = _runProjectId(runId);
  for (const [key, stage] of Object.entries(stages)) {
    if (stage.status === 'pending') continue;
    const cacheKey = `${runId}:${key}`;
    if (promptCache[runId][key] || promptCachePending.has(cacheKey)) continue;
    promptCachePending.add(cacheKey);
    ws.send('get-agent-prompt', { runId, stage: key, projectId })
      .then((data) => {
        promptCache[runId][key] = data;
        promptCachePending.delete(cacheKey);
        rerender();
      })
      .catch(() => {
        promptCachePending.delete(cacheKey);
      });
  }
}

// --- Auto-reset log filter on stage transition ---

function findActiveStage(run) {
  if (!run || !run.stages) return null;
  for (const [key, stage] of Object.entries(run.stages)) {
    if (stage.status === 'in_progress') return key;
  }
  return null;
}

function autoResetLogFilterOnStageChange(prevRun, newRun) {
  const prevStage = findActiveStage(prevRun);
  const newStage = findActiveStage(newRun);
  if (newStage && prevStage !== newStage) {
    logFilter = '*';
    logIterationFilter = null;
    clearTerminal();
    store.clearLog();
    ws.send('unsubscribe-log').catch(() => {});
    ws.send('subscribe-log', {
      stage: null,
      runId: newRun.id,
      projectId: _runProjectId(newRun.id),
    }).catch(() => {});
  }
}

// --- Wire WS events to state ---

ws.on('runs-list', (payload, msg) => {
  const isMultiProject = (store.getState().projects || []).length > 1;
  // In multi-project mode, always merge so all projects keep their runs
  if (isMultiProject) {
    const existing = { ...store.getState().runs };
    const freshIds = new Set((payload.runs || []).map((r) => r.id));
    const sourceProject = msg?.project || null;
    if (sourceProject) {
      for (const [id, run] of Object.entries(existing)) {
        if (run._project === sourceProject && !freshIds.has(id)) {
          delete existing[id];
        }
      }
    }
    const archivedUpdates = { ...store.getState().archivedRuns };
    // Prune stale archived runs from source project
    if (sourceProject) {
      for (const [id, run] of Object.entries(archivedUpdates)) {
        if (run._project === sourceProject && !freshIds.has(id)) {
          delete archivedUpdates[id];
        }
      }
    }
    const now = Date.now();
    for (const run of payload.runs || []) {
      if (sourceProject) run._project = sourceProject;
      if (run.archived) {
        if (isArchivedRunExpired(run, now)) continue;
        archivedUpdates[run.id] = run;
        delete existing[run.id];
      } else {
        existing[run.id] = run;
        delete archivedUpdates[run.id];
      }
    }
    if (payload.settings) settings = payload.settings;
    store.setState({
      runs: existing,
      archivedRuns: archivedUpdates,
      runsLoaded: true,
    });
    return;
  }
  if (payload.settings) settings = payload.settings;
  store.setRunsBulk(payload.runs || []);
});

// Pipeline lifecycle changes (start/finish) move worktrees in/out of the
// active set. Refresh worktrees on each runs-list bulk push so the sidebar
// count badge and worktrees view stay in sync without a manual reload.
ws.on('runs-list', () => {
  fetchWorktrees();
  const runs = store.getState().runs;
  let totalRunning = 0;
  for (const r of Object.values(runs)) {
    const ps = r.pipeline_status || (r.active ? 'running' : 'completed');
    if (ps === 'running' || ps === 'paused') totalRunning++;
  }
  store.setState({ totalRunning });
});

ws.on('run-snapshot', (payload) => {
  if (payload?.id) {
    const prevRun = store.getRunById(payload.id) ?? null;
    // Suppress notifications for archived runs
    const isArchived =
      payload.archived === true || !!store.getState().archivedRuns[payload.id];
    if (!isArchived) {
      notificationManager.handleRunUpdate(payload.id, payload, prevRun);
    }
    // Invalidate prompt cache for stages whose iteration count or prompt changed
    if (prevRun && promptCache[payload.id]) {
      for (const [key, stage] of Object.entries(payload.stages || {})) {
        const prevStage = prevRun.stages?.[key];
        const prevCount = prevStage?.iterations?.length || 0;
        const newCount = stage.iterations?.length || 0;
        if (newCount > prevCount) {
          delete promptCache[payload.id][key];
        } else if (stage.prompt && stage.prompt !== prevStage?.prompt) {
          delete promptCache[payload.id][key];
        }
      }
    }
    store.setRun(payload.id, payload);
    if (route.runId === payload.id) {
      autoResetLogFilterOnStageChange(prevRun, payload);
      updateActiveStage(payload);
    }
    if (pipelineAction) {
      pipelineAction = null;
      rerender();
    }
  }
});

ws.on('run-update', (payload) => {
  if (payload?.id) {
    const prevRun = store.getRunById(payload.id) ?? null;
    // Suppress notifications for archived runs
    const isArchivedUpdate =
      payload.archived === true || !!store.getState().archivedRuns[payload.id];
    if (!isArchivedUpdate) {
      notificationManager.handleRunUpdate(payload.id, payload, prevRun);
    }
    store.setRun(payload.id, payload);
    if (route.runId === payload.id) {
      autoResetLogFilterOnStageChange(prevRun, payload);
      updateActiveStage(payload);
      fetchRunBeads(payload.id);
    }
    if (pipelineAction) {
      pipelineAction = null;
      rerender();
    }
  }
});

// Wiring contract: log-line → Live Output only (not Log History).
// Log History is populated exclusively by log-bulk backfill on subscribe.
// See main-log-line-handler.test.js — changes here may break contract tests.
ws.on('log-line', (payload) => {
  if (payload) {
    store.appendLog(payload);
    // Show iteration separator when iteration changes
    if (payload.iteration && payload.iteration > 1 && payload._iterStart) {
      writeLiveIterationSeparator(payload.iteration);
    }
    writeLiveLogLine(payload);
  }
});

ws.on('log-bulk', (payload) => {
  if (payload && Array.isArray(payload.lines)) {
    for (const line of payload.lines) {
      // NB: timestamp is receive-time, not original write-time (log files lack per-line timestamps)
      const entry = {
        stage: payload.stage,
        iteration: payload.iteration,
        line,
        timestamp: new Date().toISOString(),
      };
      store.appendLog(entry);
      // Log History: only write to the history terminal when a specific stage is selected
      if (logFilter !== '*') writeLogLine(entry);
      writeLiveLogLine(entry);
    }
  }
});

ws.on('preferences', (payload) => {
  if (payload) {
    store.setState({ preferences: payload });
    applyTheme(payload.theme || 'light');
  }
});

// Fleet manifest watcher pushes fleet-update events when ~/.worca/fleet-runs/<id>.json
// changes. Refresh the list so the sidebar count badge and any open fleet
// detail view stay current.
ws.on('fleet-update', () => {
  fetch('/api/fleet-runs')
    .then((r) => r.json())
    .then((data) => {
      store.setState({ fleets: data?.fleets || [], fleetsLoaded: true });
      // Invalidate cached detail manifests so the next view fetch is fresh.
      // Drop missing markers in the same step — a fleet-list refresh implies
      // any negative caches may be stale (manifest could have been restored).
      for (const k of Object.keys(_fleetDetailCache)) {
        delete _fleetDetailCache[k];
      }
      _fleetDetailMissing.clear();
    })
    .catch(() => {});
});

ws.on('beads-update', (payload, msg) => {
  const currentProject = store.getState().currentProjectId;
  if (msg?.project && currentProject && msg.project !== currentProject) return;
  if (payload) {
    const serialized = JSON.stringify(payload);
    if (serialized === lastBeadsPayload) return;
    lastBeadsPayload = serialized;
    store.setState({
      beads: {
        issues: payload.issues || [],
        dbExists: payload.dbExists ?? false,
        dbPath: payload.dbPath || null,
        loading: false,
      },
    });
    beadsCounts = payload.counts || {};
    // Refetch the viewed run on every beads update so non-count edits
    // (title, description, notes, priority) still render live. The N+1
    // we eliminated was the server-side per-run-label cost; one
    // viewed-run refetch per WAL tick is a single bd call and bounded.
    if (route.runId && route.section !== 'beads') fetchRunBeads(route.runId);
    if (route.runId && route.section === 'beads')
      fetchBeadsRunIssues(route.runId);
    rerender();
  }
});

/** Fetch runs list from server and update store. Returns a promise. */
function fetchAndUpdateRuns() {
  return ws.send('list-runs').then((payload) => {
    if (payload.settings) settings = payload.settings;
    store.setRunsBulk(payload.runs || []);
  });
}

ws.on('run-started', () => {
  pipelineAction = null;
  // Pull the new run into the store so sidebar counters and run lists
  // (Worktrees, Beads, Active Runs) reflect it without manual navigation.
  fetchAndUpdateRuns().catch(() => {});
  rerender();
});

ws.on('run-archived', (payload) => {
  if (payload?.runId) {
    const existingRun =
      store.getState().runs[payload.runId] ??
      store.getState().archivedRuns[payload.runId];
    if (existingRun) {
      store.setRun(payload.runId, {
        ...existingRun,
        archived: true,
        archived_at: payload.archived_at || new Date().toISOString(),
      });
    } else {
      fetchAndUpdateRuns().catch(() => {});
    }
  }
});

ws.on('run-unarchived', (payload) => {
  if (payload?.runId) {
    const existingRun =
      store.getState().runs[payload.runId] ??
      store.getState().archivedRuns[payload.runId];
    if (existingRun) {
      const { archived: _a, archived_at: _b, ...rest } = existingRun;
      store.setRun(payload.runId, rest);
    } else {
      fetchAndUpdateRuns().catch(() => {});
    }
  }
});

ws.on('run-stopped', () => {
  pipelineAction = null;
  rerender();
});

ws.on('run-cancelled', (payload) => {
  if (payload?.runId) {
    const run = store.getRunById(payload.runId);
    if (run) {
      store.setRun(payload.runId, {
        ...run,
        pipeline_status: 'cancelled',
        active: false,
      });
    }
  }
});

ws.on('stage-restarted', () => {
  // Status watcher's runs-list push handles the update
});

ws.on('learn-started', (payload) => {
  if (payload?.runId && payload.runId === route.runId) {
    ws.send('subscribe-run', {
      runId: payload.runId,
      projectId: _runProjectId(payload.runId),
    }).catch(() => {});
  }
});

// --- Webhook inbox events ---

ws.on('webhook-inbox-event', (payload) => {
  if (payload) {
    const currentProject = store.getState().currentProjectId;
    if (
      !payload.projectId ||
      !currentProject ||
      payload.projectId === currentProject
    ) {
      const inbox = store.getState().webhookInbox;
      store.setState({
        webhookInbox: { ...inbox, events: [...inbox.events, payload] },
      });
    }
  }
});

ws.on('webhook-control-changed', (payload) => {
  if (payload) {
    const inbox = store.getState().webhookInbox;
    store.setState({
      webhookInbox: { ...inbox, controlAction: payload.action },
    });
  }
});

ws.on('webhook-inbox-cleared', () => {
  const inbox = store.getState().webhookInbox;
  store.setState({ webhookInbox: { ...inbox, events: [] } });
  webhookSelectedId = null;
});

// --- Protocol negotiation ---

function handleHello(_payload) {
  const capabilities = _payload?.capabilities || [];
  const isMultiProject = capabilities.includes('multi-project');

  if (!isMultiProject) {
    // Single-project mode: no /api/projects endpoint, just ack and fetch data
    ws.sendRaw({
      type: 'hello-ack',
      payload: { protocol: 2, projectId: null },
    });
    fetchProjectScopedData();
    return;
  }

  // Fetch fleets list (used by sidebar's Fleets entry + count badge). Best-effort.
  // Flip fleetsLoaded on success AND failure so the sidebar spinner stops
  // even when the endpoint is missing in older clones — same UX contract
  // worktreesLoaded / runsLoaded follow.
  fetch('/api/fleet-runs')
    .then((r) => r.json())
    .then((data) => {
      store.setState({ fleets: data?.fleets || [], fleetsLoaded: true });
    })
    .catch(() => {
      store.setState({ fleetsLoaded: true });
    });

  // Fetch workspace runs list (used by sidebar's Workspaces entry + count badge).
  // Best-effort — server may not be wired in older clones.
  fetch('/api/workspace-runs')
    .then((r) => r.json())
    .then((data) => {
      store.setState({
        workspaceRuns: data?.workspace_runs || [],
        workspaceRunsLoaded: true,
      });
    })
    .catch(() => {
      store.setState({ workspaceRunsLoaded: true });
    });

  // Fetch workspace definitions (used by the launcher's "Select workspace"
  // dropdown). Distinct from workspace runs — see state.js comment.
  fetch('/api/workspaces')
    .then((r) => r.json())
    .then((data) => {
      store.setState({ workspaces: data?.workspaces || [] });
    })
    .catch(() => {});

  // Multi-project mode: fetch projects and send hello-ack
  fetch('/api/projects')
    .then((r) => r.json())
    .then((data) => {
      const projects = data.projects || [];
      store.setState({ projects });

      // Determine currentProjectId from URL; only auto-select when single project
      const currentProjectId =
        route.projectId || (projects.length === 1 ? projects[0].name : null);
      store.setState({ currentProjectId });

      // Send hello-ack — sets project context on server before any requests
      ws.sendRaw({
        type: 'hello-ack',
        payload: { protocol: 2, projectId: currentProjectId },
      });

      // Now that project context is set, fetch project-scoped data
      fetchProjectScopedData();
    })
    .catch(() => {});
}

/** Fetch runs from all projects via REST and merge into state. */
function fetchAllProjectRuns() {
  const projects = store.getState().projects || [];
  return Promise.all(
    projects.map((p) =>
      fetch(`/api/projects/${p.name}/runs`)
        .then((r) => r.json())
        .then((data) => mapProjectRunsResponse(data, p.name))
        .catch(() => ({ runs: [], settings: null, projectName: p.name })),
    ),
  ).then((results) => {
    const runs = {};
    const archivedRuns = {};
    const now = Date.now();
    for (const { runs: projectRuns, settings: projSettings } of results) {
      // Use settings from any project that provides them (last write wins;
      // in practice loop limits are uniform across projects).
      if (projSettings) settings = projSettings;
      for (const run of projectRuns) {
        if (run.archived) {
          if (isArchivedRunExpired(run, now)) continue;
          archivedRuns[run.id] = run;
        } else {
          runs[run.id] = run;
        }
      }
    }
    store.setState({ runs, archivedRuns, runsLoaded: true });
    rerender();
  });
}

/** Fetch worktrees for the current project (or all projects when none selected). */
function fetchWorktrees() {
  const projects = store.getState().projects || [];
  const currentProjectId = store.getState().currentProjectId;
  // Worktrees are exposed only via /api/projects/<id>/worktrees. In single-
  // project mode without a registered project, leave worktrees empty.
  const targets = currentProjectId
    ? [currentProjectId]
    : projects.length > 1
      ? projects.map((p) => p.name)
      : [];

  if (targets.length === 0) {
    store.setState({ worktrees: [], worktreesLoaded: true });
    return;
  }

  const requests = targets.map((name) =>
    fetch(`/api/projects/${name}/worktrees`)
      .then((r) => r.json())
      .then((data) => mapWorktreesResponse(data, name))
      .catch(() => []),
  );

  Promise.all(requests).then((lists) => {
    store.setState({ worktrees: lists.flat(), worktreesLoaded: true });
    // Reload during cleanup or a freshly-stamped pending — keep polling
    // until the server confirms everything has settled.
    if (anyCleanupInFlight()) startCleanupPolling();
  });
}

/** Fetch all project-scoped data after hello-ack sets the project context. */
function fetchProjectScopedData() {
  // Multi-project mode: always fetch runs from every project so the sidebar
  // dots reflect the real status of all projects, not just the selected one.
  // We capture the runs-load promise so the run-scoped subscriptions below
  // can wait for it — without that, `_runProjectId(route.runId)` resolves
  // to null because state.runs is empty, the WS request hits the wrong
  // project, and the artifact panels (logs, beads, agent prompts) end up
  // empty on initial page load.
  const runsLoadedPromise =
    (store.getState().projects || []).length > 1
      ? fetchAllProjectRuns()
      : ws
          .send('list-runs')
          .then((payload) => {
            if (payload.settings) settings = payload.settings;
            store.setRunsBulk(payload.runs || []);
          })
          .catch(() => {});

  ws.send('list-beads-issues')
    .then((payload) => {
      store.setState({
        beads: {
          issues: payload.issues || [],
          dbExists: payload.dbExists ?? false,
          dbPath: payload.dbPath || null,
          loading: false,
        },
      });
    })
    .catch(() => {});

  ws.send('get-webhook-inbox')
    .then((payload) => {
      store.setState({
        webhookInbox: {
          events: payload.events || [],
          controlAction: payload.controlAction || 'continue',
        },
      });
    })
    .catch(() => {});

  fetchBeadsCounts();
  fetchProjectInfo();
  fetchWorktrees();

  // Subscribe to active run if selected. Wait for runs to load so that
  // `_runProjectId(route.runId)` can resolve to the correct project — the
  // server falls back to its default project when no projectId is supplied,
  // which is the wrong one in global mode and causes the artifact panels
  // to come up empty.
  if (route.runId) {
    runsLoadedPromise.then(() => {
      if (route.section !== 'beads') {
        const projectId = _runProjectId(route.runId);
        ws.send('subscribe-run', {
          runId: route.runId,
          projectId,
        }).catch(() => {});
        ws.send('subscribe-log', {
          stage: logFilter === '*' ? null : logFilter,
          runId: route.runId,
          projectId,
        }).catch(() => {});
      }
      fetchRunBeads(route.runId);
      if (route.section === 'beads') fetchBeadsRunIssues(route.runId);
    });
  }
}

ws.on('hello', handleHello);

ws.on('projects-updated', (payload) => {
  if (payload?.projects) {
    store.setState({ projects: payload.projects });
  }
});

// --- Project switching ---

function handleProjectSwitch(newProjectId) {
  // Unsubscribe from any run/log/event subscriptions tied to the old project
  // before switching context — otherwise the server keeps pushing updates
  // for the old project's runs to this client.
  ws.send('unsubscribe-run').catch(() => {});
  ws.send('unsubscribe-log').catch(() => {});
  ws.send('unsubscribe-events').catch(() => {});
  store.clearLog();

  store.setState({
    currentProjectId: newProjectId,
    runs: {},
    archivedRuns: {},
    logLines: [],
    activeRunId: null,
    runsLoaded: false,
    worktrees: [],
    worktreesLoaded: false,
  });
  worktreesFilter = '';
  worktreesStatusFilter = 'all';
  worktreesDialogItem = null;
  worktreesDialogBulk = false;
  worktreesDialogCheckbox = false;

  resetProjectState();

  // Send updated hello-ack
  ws.sendRaw({
    type: 'hello-ack',
    payload: { protocol: 2, projectId: newProjectId },
  });

  // Re-fetch data for new project — always fetch all projects so sidebar
  // dots stay accurate for unselected projects too.
  if ((store.getState().projects || []).length > 1) {
    fetchAllProjectRuns();
  } else {
    ws.send('list-runs')
      .then((payload) => {
        if (payload.settings) settings = payload.settings;
        store.setRunsBulk(payload.runs || []);
      })
      .catch(() => {});
  }

  ws.send('list-beads-issues')
    .then((payload) => {
      store.setState({
        beads: {
          issues: payload.issues || [],
          dbExists: payload.dbExists ?? false,
          dbPath: payload.dbPath || null,
          loading: false,
        },
      });
    })
    .catch(() => {});

  // Clear and re-fetch webhook inbox for new project
  store.setState({
    webhookInbox: {
      events: [],
      controlAction: store.getState().webhookInbox?.controlAction || 'continue',
    },
  });
  ws.send('get-webhook-inbox')
    .then((payload) => {
      store.setState({
        webhookInbox: {
          events: payload.events || [],
          controlAction: payload.controlAction || 'continue',
        },
      });
    })
    .catch(() => {});

  fetchBeadsCounts();
  fetchProjectInfo();
  fetchWorktrees();
}

// --- Connection handling ---

ws.onConnection((state) => {
  connectionState = state;
  if (state === 'open') {
    // Only fetch global (non-project-scoped) data here.
    // Project-scoped data is fetched in handleHello after hello-ack sets
    // the project context on the server.
    ws.send('get-preferences')
      .then((prefs) => {
        store.setState({ preferences: prefs });
        applyTheme(prefs.theme || 'light');
      })
      .catch(() => {});
  }
  rerender();
});

// --- Routing ---

onHashChange((newRoute) => {
  const prevRunId = route.runId;
  const prevProjectId = route.projectId;
  route = newRoute;

  // Detect project switch via URL
  if (newRoute.projectId !== prevProjectId) {
    handleProjectSwitch(newRoute.projectId);
  }

  if (prevRunId && prevRunId !== route.runId) {
    stageIterationTab.clear();
    ws.send('unsubscribe-run').catch(() => {});
    ws.send('unsubscribe-log').catch(() => {});
    store.clearLog();
    clearTerminal();
    clearLiveTerminal();
  }

  if (route.runId && route.runId !== prevRunId) {
    if (route.section === 'beads') {
      // Beads section: fetch run's issues, no log/run subscriptions
      fetchBeadsRunIssues(route.runId);
    } else {
      logFilter = '*';
      logIterationFilter = null;
      const projectId = _runProjectId(route.runId);
      ws.send('subscribe-run', {
        runId: route.runId,
        projectId,
      }).catch(() => {});
      ws.send('subscribe-log', {
        stage: null,
        runId: route.runId,
        projectId,
      }).catch(() => {});
      fetchRunBeads(route.runId);
    }
  }

  if (route.section === 'settings') {
    loadSettings(null).then(() => rerender());
    startIntegrationsPoll();
  } else {
    stopIntegrationsPoll();
  }

  if (route.section === 'project-settings') {
    // In single-project mode the server has worcaDir, so loadSettings(null)
    // works. In All-Projects mode (multi-project + no selection) it hits
    // the un-scoped endpoint with no real project — skip the fetch; the
    // view renders a CTA empty state instead.
    const s = store.getState();
    const isAllProjects = (s.projects || []).length > 1 && !s.currentProjectId;
    if (!isAllProjects) {
      loadSettings(s.currentProjectId || null).then(() => rerender());
    }
  }

  if (route.section === 'costs') {
    costsFetched = false;
    fetchCostsData();
  }

  if (!route.runId && prevRunId) {
    disposeTerminal();
    disposeLiveTerminal();
  }

  rerender();
});

// --- Actions ---

function handleNavigate(section, runId) {
  // runId is forwarded so callers can deep-link (e.g. fleet header → fleet
  // detail at /fleet-runs/<id>). Most invocations pass only `section`, which
  // leaves runId === undefined and navigates to the section root.
  navigate(section, runId ?? null, route.projectId);
}

function handleSelectRun(runId) {
  navigate(route.section, runId, route.projectId);
}

function handleProjectChange(projectId) {
  if (!projectId) {
    navigate('dashboard', null, null);
  } else {
    navigate(route.section, null, projectId);
  }
}

function handleThemeToggle() {
  const current = store.getState().preferences.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  ws.send('set-preferences', { theme: next }).catch(() => {});
  store.setState({ preferences: { theme: next } });
  applyTheme(next);
}

function handleSaveNotifications(notifPrefs) {
  ws.send('set-preferences', { notifications: notifPrefs }).catch(() => {});
  store.setState({ preferences: { notifications: notifPrefs } });
}

function handleSaveSourceRepo(sourceRepo) {
  ws.send('set-preferences', { source_repo: sourceRepo }).catch(() => {});
  store.setState({ preferences: { source_repo: sourceRepo } });
}

function handleStageFilter(stage) {
  logFilter = stage;
  // Auto-select last iteration when a stage is chosen
  if (stage !== '*') {
    const run = store.getRunById(route.runId);
    const stageData = run?.stages?.[stage];
    const iterCount = stageData?.iterations?.length || 0;
    logIterationFilter = iterCount > 0 ? iterCount : null;
  } else {
    logIterationFilter = null;
  }
  clearTerminal();
  store.clearLog();
  ws.send('unsubscribe-log').catch(() => {});
  ws.send('subscribe-log', {
    stage: stage === '*' ? null : stage,
    runId: route.runId,
    iteration: logIterationFilter,
    projectId: _runProjectId(route.runId),
  }).catch(() => {});
  rerender();
}

function handleIterationFilter(iteration) {
  logIterationFilter = iteration;
  clearTerminal();
  store.clearLog();
  ws.send('unsubscribe-log').catch(() => {});
  ws.send('subscribe-log', {
    stage: logFilter === '*' ? null : logFilter,
    runId: route.runId,
    iteration: iteration,
    projectId: _runProjectId(route.runId),
  }).catch(() => {});
  rerender();
}

function handleSearch(term) {
  logSearch = term;
  searchTerminal(term);
}

function handleToggleAutoScroll() {
  autoScroll = !autoScroll;
  rerender();
}

function showActionError(msg) {
  actionError = msg;
  rerender();
  // Open the dialog after render
  requestAnimationFrame(() => {
    const dialog = document.getElementById('action-error-dialog');
    if (dialog) dialog.show();
  });
}

function dismissActionError() {
  actionError = null;
  rerender();
}

function handleStopPipeline() {
  showConfirm(
    {
      label: 'Stop Pipeline?',
      message:
        'Are you sure? The current stage will be interrupted and marked as error.',
      confirmLabel: 'Stop',
      confirmVariant: 'danger',
      onConfirm: handleConfirmStop,
    },
    rerender,
  );
}

async function handleConfirmStop() {
  pipelineAction = 'stopping';
  actionError = null;
  rerender();

  try {
    const activeRun = Object.values(store.getState().runs).find(
      (r) => r.active,
    );
    const runId = activeRun?.id || 'current';
    const res = await fetch(runUrl(runId, `/runs/${runId}/stop`), {
      method: 'POST',
    });
    const data = await res.json();
    if (!data.ok) {
      pipelineAction = null;
      showActionError(data.error || 'Failed to stop pipeline');
    }
    // Status update via file watcher / WS broadcast will clear pipelineAction
  } catch (err) {
    pipelineAction = null;
    showActionError(err?.message || 'Failed to stop pipeline');
  }
}

function handleResumePipeline() {
  pipelineAction = 'resuming';
  actionError = null;
  rerender();
  ws.send('resume-run', { runId: route.runId })
    .then(() => {
      pipelineAction = null;
      rerender();
    })
    .catch((err) => {
      pipelineAction = null;
      showActionError(err?.message || 'Failed to resume pipeline');
    });
}

async function handlePausePipeline() {
  const activeRun = Object.values(store.getState().runs).find((r) => r.active);
  const runId = activeRun?.id || 'current';
  pipelineAction = 'pausing';
  actionError = null;
  rerender();
  try {
    const res = await fetch(runUrl(runId, `/runs/${runId}/pause`), {
      method: 'POST',
    });
    const data = await res.json();
    if (!data.ok) {
      pipelineAction = null;
      showActionError(data.error || 'Failed to pause pipeline');
    }
    // Status update via file watcher / WS broadcast will clear pipelineAction
  } catch (err) {
    pipelineAction = null;
    showActionError(err?.message || 'Failed to pause pipeline');
  }
}

async function handlePauseRun(runId) {
  _controlPending = { action: 'pause', runId };
  rerender();
  try {
    const res = await fetch(runUrl(runId, `/runs/${runId}/pause`), {
      method: 'POST',
    });
    const data = await res.json();
    if (!data.ok) showActionError(data.error || 'Failed to pause run');
  } catch (err) {
    showActionError(err?.message || 'Failed to pause run');
  } finally {
    _controlPending = null;
    rerender();
  }
}

async function handleResumeRun(runId) {
  _controlPending = { action: 'resume', runId };
  rerender();
  try {
    await ws.send('resume-run', { runId });
  } catch (err) {
    showActionError(err?.message || 'Failed to resume run');
  } finally {
    _controlPending = null;
    rerender();
  }
}

async function handleResumeFleet(fleetId) {
  try {
    const res = await fetch(`/api/fleet-runs/${fleetId}/resume`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!data.ok) {
      showActionError(data.error || 'Failed to resume fleet');
    } else {
      // Force a re-fetch of the fleet manifest so the badge / actions
      // update without needing a manual reload.
      delete _fleetDetailCache[fleetId];
      rerender();
    }
  } catch (err) {
    showActionError(err?.message || 'Failed to resume fleet');
  }
}

function handleHaltFleet(fleetId) {
  showConfirm(
    {
      label: 'Halt Fleet Run',
      message:
        'Unstarted children are cancelled. In-flight children keep running until they finish naturally — they are never killed. A halted fleet can be resumed later.',
      confirmLabel: 'Halt',
      confirmVariant: 'warning',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/fleet-runs/${fleetId}`, {
            method: 'DELETE',
          });
          const data = await res.json();
          if (!data.ok) {
            showActionError(data.error || 'Failed to halt fleet');
            return;
          }
          delete _fleetDetailCache[fleetId];
          await _refreshFleets();
          rerender();
        } catch (err) {
          showActionError(err?.message || 'Failed to halt fleet');
        }
      },
    },
    rerender,
  );
}

function handlePauseFleet(fleetId) {
  showConfirm(
    {
      label: 'Pause Fleet Run',
      message:
        'Every in-flight child pauses at its next checkpoint; no new children are launched. A paused fleet can be continued in place with Resume.',
      confirmLabel: 'Pause',
      confirmVariant: 'warning',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/fleet-runs/${fleetId}/pause`, {
            method: 'POST',
          });
          const data = await res.json();
          if (!data.ok) {
            showActionError(data.error || 'Failed to pause fleet');
            return;
          }
          delete _fleetDetailCache[fleetId];
          await _refreshFleets();
          rerender();
        } catch (err) {
          showActionError(err?.message || 'Failed to pause fleet');
        }
      },
    },
    rerender,
  );
}

function handleStopFleet(fleetId) {
  showConfirm(
    {
      label: 'Stop Fleet Run',
      message:
        'Every in-flight child is interrupted immediately (SIGTERM) and no new children are launched. Stopped children can still be continued with Resume.',
      confirmLabel: 'Stop',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/fleet-runs/${fleetId}/stop`, {
            method: 'POST',
          });
          const data = await res.json();
          if (!data.ok) {
            showActionError(data.error || 'Failed to stop fleet');
            return;
          }
          delete _fleetDetailCache[fleetId];
          await _refreshFleets();
          rerender();
        } catch (err) {
          showActionError(err?.message || 'Failed to stop fleet');
        }
      },
    },
    rerender,
  );
}

function handleCleanupFleet(fleetId) {
  showConfirm(
    {
      label: 'Cleanup Fleet Run',
      message:
        'Removes every child worktree and the fleet manifest. This is irreversible — a halted or failed fleet can no longer be resumed once cleaned up.',
      confirmLabel: 'Cleanup',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          // force=1: the confirm dialog is itself the resume-loss
          // acknowledgement, so we proceed past the server's 412 gate.
          const res = await fetch(
            `/api/fleet-runs/${fleetId}?cleanup=1&force=1`,
            { method: 'DELETE' },
          );
          const data = await res.json();
          if (!data.ok) {
            showActionError(data.error || 'Failed to clean up fleet');
            return;
          }
          delete _fleetDetailCache[fleetId];
          await _refreshFleets();
          navigate('fleet-runs', null, null);
        } catch (err) {
          showActionError(err?.message || 'Failed to clean up fleet');
        }
      },
    },
    rerender,
  );
}

// ── Workspace-run actions (mirror the fleet handlers above) ────────────
async function handleResumeWorkspace(workspaceId) {
  try {
    const res = await fetch(
      `/api/workspace-runs/${encodeURIComponent(workspaceId)}/resume`,
      { method: 'POST' },
    );
    const data = await res.json();
    if (!data.ok) {
      showActionError(data.error || 'Failed to resume workspace');
      return;
    }
    delete _wsDetailCache[workspaceId];
    await _refreshWorkspaces();
    rerender();
  } catch (err) {
    showActionError(err?.message || 'Failed to resume workspace');
  }
}

function handleCleanupWorkspaceRun(workspaceId) {
  showConfirm(
    {
      label: 'Cleanup Workspace Run',
      message:
        'Removes the workspace run manifest, pointer file, and any on-disk child worktree state. Per-repo PRs are NOT touched. Irreversible.',
      confirmLabel: 'Cleanup',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(
            `/api/workspace-runs/${encodeURIComponent(workspaceId)}`,
            { method: 'DELETE' },
          );
          const data = await res.json();
          if (!data.ok) {
            showActionError(data.error || 'Failed to clean up workspace');
            return;
          }
          delete _wsDetailCache[workspaceId];
          await _refreshWorkspaces();
          navigate('workspace-runs', null, null);
        } catch (err) {
          showActionError(err?.message || 'Failed to clean up workspace');
        }
      },
    },
    rerender,
  );
}

async function handleRerunWorkspace(workspaceId) {
  try {
    const res = await fetch(
      `/api/workspace-runs/${encodeURIComponent(workspaceId)}/relaunch`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const data = await res.json();
    if (!data.ok || !data.workspace_id) {
      showActionError(data.error || 'Failed to re-run workspace');
      return;
    }
    await _refreshWorkspaces();
    navigate('workspace-runs', data.workspace_id, null);
  } catch (err) {
    showActionError(err?.message || 'Failed to re-run workspace');
  }
}

// Re-fetch /api/fleet-runs and replace state.fleets. Used after a fleet
// archive / unarchive so the list + sidebar count update immediately —
// the WS `fleet-update` watcher also fires, but an explicit refetch gives
// instant feedback rather than waiting on the fs-watch debounce.
async function _refreshFleets() {
  try {
    const res = await fetch('/api/fleet-runs');
    const data = await res.json();
    store.setState({ fleets: data?.fleets || [], fleetsLoaded: true });
  } catch {
    // Non-fatal — the WS fleet-update handler will reconcile shortly.
  }
}

async function _refreshWorkspaces() {
  try {
    const res = await fetch('/api/workspace-runs');
    const data = await res.json();
    store.setState({
      workspaceRuns: data?.workspace_runs || [],
      workspaceRunsLoaded: true,
    });
  } catch {
    // Non-fatal — bootstrap and next user navigation will reconcile.
  }
}

async function _refreshWorkspaceDefinitions() {
  try {
    const res = await fetch('/api/workspaces');
    const data = await res.json();
    store.setState({ workspaces: data?.workspaces || [] });
  } catch {
    // Non-fatal.
  }
}

function handleLaunchWorkspace(name) {
  // Stash for the launcher to consume on its first render in workspace mode.
  _pendingLaunchWorkspace = name;
  navigate('workspace-runs', 'new', null);
}

function handleDeleteWorkspace(name) {
  showConfirm(
    {
      label: 'Delete Workspace',
      message: `This removes the registration AND the workspace.json topology file. The repos themselves are untouched. Cannot be undone.`,
      confirmLabel: 'Delete',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(
            `/api/workspaces/${encodeURIComponent(name)}`,
            { method: 'DELETE' },
          );
          const data = await res.json();
          if (!data.ok) {
            showActionError(data.error || 'Failed to delete workspace');
            return;
          }
          await _refreshWorkspaceDefinitions();
        } catch (err) {
          showActionError(err?.message || 'Failed to delete workspace');
        }
      },
    },
    rerender,
  );
}

function archiveFleet(fleetId) {
  showConfirm(
    {
      label: 'Archive Fleet Run',
      message:
        "This fleet will be hidden from the Fleets list. You can find it later with the 'Show archived' toggle.",
      confirmLabel: 'Archive',
      confirmVariant: 'danger',
      onConfirm: async () => {
        try {
          const res = await fetch(`/api/fleet-runs/${fleetId}/archive`, {
            method: 'POST',
          });
          const data = await res.json();
          if (!data.ok) {
            showActionError(data.error || 'Failed to archive fleet');
            return;
          }
          delete _fleetDetailCache[fleetId];
          await _refreshFleets();
        } catch (err) {
          showActionError(err?.message || 'Failed to archive fleet');
        }
      },
    },
    rerender,
  );
}

async function unarchiveFleet(fleetId) {
  try {
    const res = await fetch(`/api/fleet-runs/${fleetId}/unarchive`, {
      method: 'POST',
    });
    const data = await res.json();
    if (!data.ok) {
      showActionError(data.error || 'Failed to unarchive fleet');
      return;
    }
    delete _fleetDetailCache[fleetId];
    await _refreshFleets();
  } catch (err) {
    showActionError(err?.message || 'Failed to unarchive fleet');
  }
}

function handleStopRun(runId) {
  showConfirm(
    {
      label: 'Stop Pipeline?',
      message:
        'Are you sure? The current stage will be interrupted and marked as error.',
      confirmLabel: 'Stop',
      confirmVariant: 'danger',
      onConfirm: async () => {
        _controlPending = { action: 'stop', runId };
        rerender();
        try {
          const res = await fetch(runUrl(runId, `/runs/${runId}/stop`), {
            method: 'POST',
          });
          const data = await res.json();
          if (res.status === 409 && data.code === 'no_running_process') {
            showActionError(
              'Process is no longer running. Use Cancel to force the run into cancelled state.',
            );
          } else if (!data.ok) {
            showActionError(data.error || 'Failed to stop run');
          }
        } catch (err) {
          showActionError(err?.message || 'Failed to stop run');
        } finally {
          _controlPending = null;
          rerender();
        }
      },
    },
    rerender,
  );
}

function handleCancelRun(runId) {
  showConfirm(
    {
      label: 'Cancel Pipeline?',
      message:
        'This will permanently cancel the run. Any running process will be terminated and the pipeline cannot be resumed.',
      confirmLabel: 'Cancel Run',
      confirmVariant: 'danger',
      onConfirm: async () => {
        _controlPending = { action: 'cancel', runId };
        rerender();
        try {
          const res = await fetch(runUrl(runId, `/runs/${runId}/cancel`), {
            method: 'POST',
          });
          const data = await res.json();
          if (!data.ok) showActionError(data.error || 'Failed to cancel run');
        } catch (err) {
          showActionError(err?.message || 'Failed to cancel run');
        } finally {
          _controlPending = null;
          rerender();
        }
      },
    },
    rerender,
  );
}

// --- PR Approval ---

async function handleApprovePR(runId) {
  try {
    const res = await fetch(runUrl(runId, `/runs/${runId}/control`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', source: 'ui-pr-approval' }),
    });
    if (res.status === 404) {
      showActionError('This run has already finished. Refreshing...');
      return;
    }
    if (res.status === 409) {
      showActionError('This run is no longer awaiting approval.');
      return;
    }
    if (!res.ok) {
      showActionError('Could not deliver decision; try again.');
    }
  } catch {
    showActionError('Could not deliver decision; try again.');
  }
}

async function handleRejectPR(runId) {
  try {
    const res = await fetch(runUrl(runId, `/runs/${runId}/control`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject', source: 'ui-pr-approval' }),
    });
    if (res.status === 404) {
      showActionError('This run has already finished. Refreshing...');
      return;
    }
    if (res.status === 409) {
      showActionError('This run is no longer awaiting approval.');
      return;
    }
    if (!res.ok) {
      showActionError('Could not deliver decision; try again.');
    }
  } catch {
    showActionError('Could not deliver decision; try again.');
  }
}

// --- Archive/Unarchive ---

const { archiveRun, unarchiveRun } = createArchiveActions({
  showConfirm,
  showActionError,
  runUrl,
  store,
  rerender,
});

// --- Worktrees: cleanup polling ---
//
// While any worktree carries cleanup_state ('pending' or 'cleaning'), poll
// GET /worktrees every 2s so the spinner cards reflect server-side progress
// across reloads and multiple tabs. Stops when no worktree is mid-cleanup.

let _cleanupPollTimer = null;
const CLEANUP_POLL_MS = 2000;

function anyCleanupInFlight() {
  return (store.getState().worktrees || []).some(
    (w) => w.cleanup_state === 'pending' || w.cleanup_state === 'cleaning',
  );
}

function startCleanupPolling() {
  if (_cleanupPollTimer) return;
  const tick = () => {
    _cleanupPollTimer = null;
    fetchWorktrees();
    // fetchWorktrees mutates state asynchronously; re-check on next tick.
    setTimeout(() => {
      if (anyCleanupInFlight()) {
        _cleanupPollTimer = setTimeout(tick, CLEANUP_POLL_MS);
      }
    }, 50);
  };
  _cleanupPollTimer = setTimeout(tick, CLEANUP_POLL_MS);
}

// --- Worktrees: cleanup actions ---

function openWorktreeCleanupDialog(wt) {
  worktreesDialogItem = wt;
  worktreesDialogBulk = false;
  worktreesDialogCheckbox = false;
  rerender();
}

function openWorktreeBulkCleanupDialog() {
  worktreesDialogItem = null;
  worktreesDialogBulk = true;
  worktreesDialogCheckbox = false;
  rerender();
}

function closeWorktreeCleanupDialog() {
  worktreesDialogItem = null;
  worktreesDialogBulk = false;
  worktreesDialogCheckbox = false;
  rerender();
}

async function deleteWorktree(runId, force) {
  const url = worktreeUrl(
    runId,
    `/worktrees/${encodeURIComponent(runId)}${force ? '?force=1' : ''}`,
  );
  const res = await fetch(url, { method: 'DELETE' });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok || !data?.ok) {
    throw new Error(data?.error || `Cleanup failed (HTTP ${res.status})`);
  }
}

async function confirmWorktreeCleanup(runId, force) {
  // Bulk path: runId is null — delete every completed worktree. In global
  // mode the completed set can span multiple projects, so we bucket runIds
  // by their owning project and fire one POST per project. Each /cleanup
  // endpoint is scoped to a single project's worcaDir/registry.
  // No optimistic removal — the server stamps `cleanup_state: 'pending'` on
  // each registry entry; we surface that via a spinner per card and poll
  // GET /worktrees until everything settles. A page reload during cleanup
  // sees the same intermediate state.
  if (runId === null) {
    const completed = (store.getState().worktrees || []).filter(
      (w) => w.status === 'completed',
    );
    closeWorktreeCleanupDialog();
    const currentProjectId = store.getState().currentProjectId;
    const byProject = new Map();
    for (const w of completed) {
      const pid = w.project || currentProjectId || null;
      if (!byProject.has(pid)) byProject.set(pid, []);
      byProject.get(pid).push(w.run_id);
    }
    const rejected = [];
    await Promise.all(
      [...byProject.entries()].map(async ([pid, run_ids]) => {
        const url = pid
          ? `/api/projects/${pid}/worktrees/cleanup`
          : '/api/worktrees/cleanup';
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ run_ids, force: true }),
          });
          try {
            const data = await res.json();
            if (Array.isArray(data?.rejected)) rejected.push(...data.rejected);
          } catch {
            /* ignore parse errors */
          }
        } catch {
          /* network error — startCleanupPolling will reconcile on next tick */
        }
      }),
    );
    fetchWorktrees();
    startCleanupPolling();
    if (rejected.length > 0) {
      showActionError(
        `Cleanup rejected ${rejected.length} item(s):\n${rejected
          .map((r) => `${r.run_id}: ${r.error || 'failed'}`)
          .join('\n')}`,
      );
    }
    return;
  }

  // Single-row path — server-side single-target DELETE is synchronous (it
  // does the actual filesystem rm + git worktree remove before responding),
  // and on macOS with nested node_modules it can take 10+ seconds. Stamp
  // `cleanup_state: 'pending'` on the local entry immediately so the card
  // renders the existing spinner UI while we wait; the bulk path stamps the
  // same field server-side, so the rendering logic is identical.
  closeWorktreeCleanupDialog();
  const state0 = store.getState();
  const optimisticWorktrees = (state0.worktrees || []).map((w) =>
    w.run_id === runId ? { ...w, cleanup_state: 'pending' } : w,
  );
  store.setState({ worktrees: optimisticWorktrees });
  try {
    await deleteWorktree(runId, !!force);
    fetchWorktrees();
  } catch (err) {
    // Roll back the optimistic stamp so the user can retry from a clean card.
    const stateNow = store.getState();
    const rolledBack = (stateNow.worktrees || []).map((w) => {
      if (w.run_id !== runId) return w;
      const { cleanup_state: _drop, ...rest } = w;
      return rest;
    });
    store.setState({ worktrees: rolledBack });
    showActionError(err?.message || 'Cleanup failed');
  }
}

function handleRestartStage(stageKey) {
  restartStageKey = stageKey;
  showConfirm(
    {
      label: 'Restart Stage?',
      message: `Restart the "${stageKey}" stage? The pipeline will resume from this point.`,
      confirmLabel: 'Restart',
      confirmVariant: 'warning',
      onConfirm: handleConfirmRestartStage,
      onCancel: () => {
        restartStageKey = null;
      },
    },
    rerender,
  );
}

async function handleConfirmRestartStage() {
  const stage = restartStageKey;
  restartStageKey = null;
  rerender();

  try {
    const activeRun = Object.values(store.getState().runs).find(
      (r) => !r.active,
    );
    const runId = activeRun?.id || 'current';
    const res = await fetch(
      runUrl(runId, `/runs/${runId}/stages/${stage}/restart`),
      {
        method: 'POST',
      },
    );
    const data = await res.json();
    if (data.ok) {
      navigate('active', null, route.projectId);
    } else {
      showActionError(data.error || 'Failed to restart stage');
    }
  } catch (err) {
    showActionError(err?.message || 'Failed to restart stage');
  }
}

function handleBack() {
  if (route.runId) {
    navigate(route.section, null, route.projectId);
  } else if (route.section && route.section !== 'dashboard') {
    navigate('dashboard', null, route.projectId);
  }
}

// --- Beads actions ---

function handleBeadsStatusFilter(value) {
  beadsStatusFilter = value;
  rerender();
}

function handleBeadsPriorityFilter(value) {
  beadsPriorityFilter = value;
  rerender();
}

async function handleStartBeadsIssue(issueId) {
  beadsStarting = issueId;
  beadsStartError = null;
  rerender();
  try {
    await ws.send('start-beads-issue', { issueId });
    beadsStarting = null;
    navigate('active', null, route.projectId);
  } catch (err) {
    beadsStarting = null;
    beadsStartError = err?.message || 'Failed to start pipeline';
    rerender();
  }
}

function handleDismissBeadsError() {
  beadsStartError = null;
  rerender();
}

function fetchBeadsCounts() {
  ws.send('list-beads-counts')
    .then((payload) => {
      beadsCounts = payload.counts || {};
      rerender();
    })
    .catch(() => {});
}

function fetchBeadsRunIssues(runId) {
  beadsRunLoading = true;
  rerender();
  ws.send('list-beads-by-run', { runId, projectId: _runProjectId(runId) })
    .then((payload) => {
      beadsRunIssues = payload.issues || [];
      beadsRunLoading = false;
      rerender();
    })
    .catch(() => {
      beadsRunLoading = false;
      rerender();
    });
}

// --- Costs actions ---

function fetchCostsData() {
  fetch(projectUrl('/costs'))
    .then((r) => r.json())
    .then((data) => {
      if (data.ok) {
        costsTokenData = data.tokenData || {};
        costsFetched = true;
        rerender();
      }
    })
    .catch(() => {});
}

function fetchProjectInfo() {
  const currentProjectId = store.getState().currentProjectId;
  const url = currentProjectId
    ? `/api/projects/${currentProjectId}/info`
    : '/api/project-info';
  fetch(url)
    .then((r) => r.json())
    .then((data) => {
      const name = data.project?.name ?? data.name;
      if (name !== undefined) {
        store.setState({ projectName: name });
        document.title = formatTitle(name);
      }
    })
    .catch(() => {});
}

function handleToggleCostRun(runId) {
  costsExpanded = costsExpanded === runId ? null : runId;
  rerender();
}

// --- Webhook inbox actions ---

function handleWebhookSelectEvent(id) {
  webhookSelectedId = webhookSelectedId === id ? null : id;
  rerender();
}

function handleWebhookCategoryFilter(cat) {
  webhookCategoryFilter = cat;
  rerender();
}

function handleWebhookRunFilter(runId) {
  webhookRunFilter = runId;
  rerender();
}

function handleWebhookSearch(term) {
  webhookSearchTerm = term;
  rerender();
}

function handleWebhookSetControl(action) {
  ws.send('set-webhook-control', { action }).catch(() => {});
}

function handleWebhookClear() {
  ws.send('clear-webhook-inbox').catch(() => {});
  webhookSelectedId = null;
}

function handleWebhookCopyJson(event) {
  try {
    navigator.clipboard.writeText(JSON.stringify(event.envelope, null, 2));
  } catch {
    /* ignore */
  }
}

function handleWebhookDismissDetail() {
  webhookSelectedId = null;
  rerender();
}

// --- Learn actions ---

function handleRunLearn() {
  const run = store.getRunById(route.runId);
  const learnStatus = run?.stages?.learn?.status;
  if (learnStatus === 'completed' || learnStatus === 'error') {
    showConfirm(
      {
        label: 'Re-run Learning Analysis?',
        message: 'This will replace existing learnings. Continue?',
        confirmLabel: 'Re-run',
        confirmVariant: 'warning',
        onConfirm: doRunLearn,
      },
      rerender,
    );
    return;
  }
  doRunLearn();
}

async function doRunLearn() {
  rerender();
  try {
    const runId = route.runId;
    const res = await fetch(runUrl(runId, `/runs/${runId}/learn`), {
      method: 'POST',
    });
    const data = await res.json();
    if (!data.ok) {
      showActionError(data.error || 'Failed to run learning analysis');
    } else {
      // Optimistic update — show spinner immediately instead of waiting for WS
      const run = store.getRunById(runId);
      if (run) {
        const now = new Date().toISOString();
        store.setRun(runId, {
          ...run,
          stages: {
            ...(run.stages || {}),
            learn: {
              status: 'in_progress',
              pid: data.pid,
              started_at: now,
              iterations: [
                {
                  number: 1,
                  status: 'in_progress',
                  started_at: now,
                  trigger: 'manual',
                },
              ],
            },
          },
        });
      }
    }
  } catch (err) {
    showActionError(err?.message || 'Failed to run learning analysis');
  }
}

// --- Render ---

function contentHeaderView() {
  const state = store.getState();
  let title = 'Dashboard';
  let showBack = false;
  let badge = null;

  let actionButton = null;

  if (route.section === 'beads' && route.runId) {
    // Beads kanban for a specific run
    const run = store.getRunById(route.runId);
    const raw = run?.work_request?.title || route.runId;
    const firstLine = raw.split('\n')[0];
    title =
      firstLine.length > 80 ? `${firstLine.slice(0, 80)}\u2026` : firstLine;
    showBack = true;
  } else if (route.section === 'beads' && !route.runId) {
    title = 'Beads Issues';
    showBack = true;
    const dbPath = state.beads?.dbPath;
    if (dbPath) {
      actionButton = html`<span class="beads-db-path">${unsafeHTML(iconSvg(Database, 12))} Beads DB<br><code>${dbPath}</code></span>`;
    }
  } else if (route.section === 'fleet-runs') {
    title =
      route.runId === 'new'
        ? 'Run Fleet'
        : route.runId
          ? `Fleet ${route.runId.split('_').pop() || route.runId}`
          : 'Fleets';
    showBack = true;
    if (route.runId === 'new') {
      const fls = getFleetLauncherSubmitState();
      const capReached = isAtCapacity(state);
      actionButton = html`
        <button class="action-btn action-btn--primary" ?disabled=${fls.isSubmitting || !fls.canLaunch || capReached}
          @click=${() =>
            submitFleetLauncher({
              rerender,
              onStarted: (fleetId) => navigate('fleet-runs', fleetId, null),
            })}>
          ${unsafeHTML(iconSvg(Play, 14))}
          ${fls.isSubmitting ? 'Launching…' : 'Launch'}
        </button>`;
    } else if (route.runId) {
      const fleet = _fleetDetailCache[route.runId];
      if (fleet) {
        const fs = fleet.status || 'running';
        const variantMap = {
          running: 'primary',
          resuming: 'primary',
          paused: 'warning',
          completed: 'success',
          failed: 'danger',
          halted: fleet.halt_reason === 'user' ? 'neutral' : 'warning',
        };
        // Badge text is the bare status word, Title-cased for the page header
        // (the run-detail header does the same). halt_reason informs the
        // variant only — never the badge text.
        badge = html`<sl-badge variant="${variantMap[fs] || 'neutral'}" pill>
          ${unsafeHTML(statusIcon(fs, 12))}
          ${fs.charAt(0).toUpperCase() + fs.slice(1)}
        </sl-badge>`;

        const isResumable =
          fs === 'halted' || fs === 'failed' || fs === 'paused';
        const isRunning = fs === 'running' || fs === 'resuming';
        const isTerminal = !isRunning;

        // In-flight fleet → three ways to wind it down, by how they treat
        // children already running:
        //   Pause — suspend in-flight children at their next checkpoint
        //   Halt  — stop launching new ones, let in-flight finish naturally
        //   Stop  — interrupt in-flight children immediately
        const pauseBtn = isRunning
          ? html`<button class="action-btn action-btn--amber" @click=${() => handlePauseFleet(route.runId)}>
              ${unsafeHTML(iconSvg(Pause, 14))} Pause
            </button>`
          : nothing;
        const haltBtn = isRunning
          ? html`<button class="action-btn action-btn--amber" @click=${() => handleHaltFleet(route.runId)}>
              ${unsafeHTML(iconSvg(CircleSlash, 14))} Halt
            </button>`
          : nothing;
        const stopBtn = isRunning
          ? html`<button class="action-btn action-btn--danger" @click=${() => handleStopFleet(route.runId)}>
              ${unsafeHTML(iconSvg(Square, 14))} Stop
            </button>`
          : nothing;
        const resumeBtn = isResumable
          ? html`<button class="action-btn action-btn--primary" @click=${() => handleResumeFleet(route.runId)}>
              ${unsafeHTML(iconSvg(Play, 14))} Resume
            </button>`
          : nothing;
        const cleanupBtn = isTerminal
          ? html`<button class="action-btn action-btn--danger" @click=${() => handleCleanupFleet(route.runId)}>
              ${unsafeHTML(iconSvg(Trash2, 14))} Cleanup
            </button>`
          : nothing;
        const rerunBtn = isTerminal
          ? html`<button class="action-btn action-btn--teal" @click=${() => navigate('fleet-runs', 'new', null)}>
              ${unsafeHTML(iconSvg(RotateCcw, 14))} Re-run
            </button>`
          : nothing;
        const btns = [
          pauseBtn,
          haltBtn,
          stopBtn,
          resumeBtn,
          cleanupBtn,
          rerunBtn,
        ].filter((b) => b !== nothing);
        if (btns.length) actionButton = html`${btns}`;
      }
    }
  } else if (route.section === 'workspaces' && route.runId === 'new') {
    title = 'New Workspace';
    showBack = true;
    const wcs = getWorkspaceCreateSubmitState();
    actionButton = html`
      <button class="action-btn action-btn--primary" ?disabled=${wcs.isSubmitting || !wcs.canSubmit}
        @click=${() =>
          submitWorkspaceCreate({
            rerender,
            onCreated: (name) => {
              _refreshWorkspaceDefinitions();
              resetWorkspaceCreateState();
              // After creating, drop the user back at the workspaces list so
              // they can see their new definition and decide what to do next
              // (launch it, edit it, create another). The launcher remains
              // one click away via the row's Launch action.
              navigate('workspaces', null, null);
              return name;
            },
          })}>
        ${unsafeHTML(iconSvg(Plus, 14))}
        ${wcs.isSubmitting ? 'Creating…' : 'Create'}
      </button>`;
  } else if (
    route.section === 'workspaces' &&
    route.runId &&
    route.action === 'edit'
  ) {
    title = `Edit Workspace: ${route.runId}`;
    showBack = true;
    const wes = getWorkspaceEditSubmitState();
    actionButton = html`
      <button class="action-btn action-btn--primary" ?disabled=${wes.isSubmitting || !wes.canSubmit}
        @click=${() =>
          submitWorkspaceEdit({
            rerender,
            onUpdated: () => {
              _refreshWorkspaceDefinitions();
              _lastEditWorkspace = null;
              navigate('workspaces', null, null);
            },
          })}>
        ${unsafeHTML(iconSvg(Save, 14))}
        ${wes.isSubmitting ? 'Saving…' : 'Save'}
      </button>`;
  } else if (route.section === 'workspaces') {
    title = 'Workspaces';
    actionButton = html`
      <button class="action-btn action-btn--primary"
        @click=${() => navigate('workspaces', 'new', null)}>
        ${unsafeHTML(iconSvg(Plus, 14))}
        New Workspace
      </button>`;
  } else if (route.section === 'workspace-runs') {
    showBack = true;
    if (route.runId === 'new') {
      title = 'Run Workspace';
      // Reuse fleet-launcher's submit state — it dispatches based on
      // launcherMode, so workspace mode hits POST /api/workspace-runs and
      // returns data.workspace_id on success.
      const fls = getFleetLauncherSubmitState();
      const capReached = isAtCapacity(state);
      actionButton = html`
        <button class="action-btn action-btn--primary" ?disabled=${fls.isSubmitting || !fls.canLaunch || capReached}
          @click=${() =>
            submitFleetLauncher({
              rerender,
              onStarted: (workspaceId) => {
                _refreshWorkspaces();
                navigate('workspace-runs', workspaceId, null);
              },
            })}>
          ${unsafeHTML(iconSvg(Play, 14))}
          ${fls.isSubmitting ? 'Launching…' : 'Launch'}
        </button>`;
    } else if (route.runId) {
      // Mirror the fleet-runs/:id header: badge LEFT of title (semantic
      // pill + spinner/glyph), action buttons RIGHT (Resume/Cleanup/Re-run
      // gated on terminal/halted/in-flight). Pull the cached manifest the
      // detail view already fetched.
      const ws = _wsDetailCache[route.runId];
      const shortId = route.runId.split('_').pop() || route.runId;
      // Mirror workspace-card / fleet-card: title is always
      // `Workspace <id_short>`. The workspace_name (e.g. "test-multi")
      // is surfaced inside the detail page body, not the header.
      title = `Workspace ${shortId}`;

      if (ws) {
        const wsStatus = ws.status || 'running';
        const variantMap = {
          planning: 'primary',
          running: 'primary',
          integration_testing: 'primary',
          completed: 'success',
          failed: 'danger',
          integration_failed: 'warning',
          halted: 'warning',
          blocked: 'neutral',
        };
        badge = html`<sl-badge variant="${variantMap[wsStatus] || 'neutral'}" pill>
          ${unsafeHTML(statusIcon(wsStatus, 12))}
          ${wsStatus.charAt(0).toUpperCase() + wsStatus.slice(1).replace(/_/g, ' ')}
        </sl-badge>`;

        const isResumable =
          wsStatus === 'halted' ||
          wsStatus === 'failed' ||
          wsStatus === 'integration_failed';
        const isRunning =
          wsStatus === 'running' ||
          wsStatus === 'planning' ||
          wsStatus === 'integration_testing';
        const isTerminal = !isRunning;

        // Workspaces don't yet have a halt/pause/stop endpoint — only
        // resume/cleanup/relaunch (W-047 §10.10). Re-run uses the
        // /relaunch endpoint which forks a fresh ws_id.
        const resumeBtn = isResumable
          ? html`<button class="action-btn action-btn--primary" @click=${() => handleResumeWorkspace(route.runId)}>
              ${unsafeHTML(iconSvg(Play, 14))} Resume
            </button>`
          : nothing;
        const cleanupBtn = isTerminal
          ? html`<button class="action-btn action-btn--danger" @click=${() => handleCleanupWorkspaceRun(route.runId)}>
              ${unsafeHTML(iconSvg(Trash2, 14))} Cleanup
            </button>`
          : nothing;
        const rerunBtn = isTerminal
          ? html`<button class="action-btn action-btn--teal" @click=${() => handleRerunWorkspace(route.runId)}>
              ${unsafeHTML(iconSvg(RotateCcw, 14))} Re-run
            </button>`
          : nothing;
        const btns = [resumeBtn, cleanupBtn, rerunBtn].filter(
          (b) => b !== nothing,
        );
        if (btns.length) actionButton = html`${btns}`;
      }
    } else {
      title = 'Workspaces';
    }
  } else if (route.runId) {
    const run = store.getRunById(route.runId);
    const raw = run?.work_request?.title || 'Pipeline Details';
    const firstLine = raw.split('\n')[0];
    title =
      firstLine.length > 80 ? `${firstLine.slice(0, 80)}\u2026` : firstLine;
    showBack = true;
    if (run) {
      const ps = run.pipeline_status || (run.active ? 'running' : 'completed');
      const variantMap = {
        running: 'primary',
        paused: 'warning',
        completed: 'success',
        failed: 'danger',
        cancelled: 'neutral',
        interrupted: 'warning',
      };
      const variant = variantMap[ps] || 'neutral';
      const label = ps.charAt(0).toUpperCase() + ps.slice(1);
      badge = html`<sl-badge variant="${variant}" pill>
        ${unsafeHTML(statusIcon(ps, 12))}
        ${label}
      </sl-badge>`;

      if (pipelineAction === 'stopping') {
        actionButton = html`
          <button class="action-btn action-btn--danger" disabled>
            ${unsafeHTML(iconSvg(Loader, 14, 'icon-spin'))}
            Stopping\u2026
          </button>`;
      } else if (pipelineAction === 'pausing') {
        actionButton = html`
          <button class="action-btn action-btn--amber" disabled>
            ${unsafeHTML(iconSvg(Loader, 14, 'icon-spin'))}
            Pausing\u2026
          </button>`;
      } else if (pipelineAction === 'resuming') {
        actionButton = html`
          <button class="action-btn action-btn--primary" disabled>
            ${unsafeHTML(iconSvg(Loader, 14, 'icon-spin'))}
            Resuming\u2026
          </button>`;
      } else {
        const pauseBtn = actionAllowed('pause', ps)
          ? html`<button class="action-btn action-btn--amber" @click=${handlePausePipeline}>
              ${unsafeHTML(iconSvg(Pause, 14))} Pause
            </button>`
          : nothing;
        const stopBtn = actionAllowed('stop', ps)
          ? html`<button class="action-btn action-btn--danger" @click=${handleStopPipeline}>
              ${unsafeHTML(iconSvg(Square, 14))} Stop
            </button>`
          : nothing;
        const resumeBtn = actionAllowed('resume', ps)
          ? html`<button class="action-btn action-btn--primary" @click=${handleResumePipeline}>
              ${unsafeHTML(iconSvg(Play, 14))} Resume
            </button>`
          : nothing;
        const cancelBtn =
          stopBtn === nothing && actionAllowed('cancel', ps)
            ? html`<button class="action-btn action-btn--danger" @click=${() => handleCancelRun(run.id)}>
                ${unsafeHTML(iconSvg(Square, 14))} Cancel
              </button>`
            : nothing;
        const btns = [pauseBtn, stopBtn, resumeBtn, cancelBtn].filter(
          (b) => b !== nothing,
        );
        if (btns.length) actionButton = html`${btns}`;
      }
    }
  } else if (route.section === 'active') {
    title = 'Running Pipelines';
    showBack = true;
  } else if (route.section === 'worktrees') {
    title = 'Worktrees';
    showBack = true;
  } else if (route.section === 'history') {
    title = 'History';
    showBack = true;
    if (route.runId) {
      const historyRun = Object.values(state.runs).find(
        (r) => r.id === route.runId,
      );
      const hs = historyRun?.pipeline_status;
      const pending =
        _controlPending?.runId === route.runId ? _controlPending.action : null;
      if (pending === 'stop') {
        actionButton = html`
          <button class="action-btn action-btn--danger" disabled>
            ${unsafeHTML(iconSvg(Loader, 14, 'icon-spin'))}
            Stopping\u2026
          </button>`;
      } else if (pending === 'pause') {
        actionButton = html`
          <button class="action-btn action-btn--amber" disabled>
            ${unsafeHTML(iconSvg(Loader, 14, 'icon-spin'))}
            Pausing\u2026
          </button>`;
      } else if (pending === 'resume') {
        actionButton = html`
          <button class="action-btn action-btn--primary" disabled>
            ${unsafeHTML(iconSvg(Loader, 14, 'icon-spin'))}
            Resuming\u2026
          </button>`;
      } else {
        const pauseBtn = actionAllowed('pause', hs)
          ? html`<button class="action-btn action-btn--amber" @click=${() => handlePauseRun(route.runId)}>
              ${unsafeHTML(iconSvg(Pause, 14))} Pause
            </button>`
          : nothing;
        const stopBtn = actionAllowed('stop', hs)
          ? html`<button class="action-btn action-btn--danger" @click=${() => handleStopRun(route.runId)}>
              ${unsafeHTML(iconSvg(Square, 14))} Stop
            </button>`
          : nothing;
        const resumeBtn = actionAllowed('resume', hs)
          ? html`<button class="action-btn action-btn--primary" @click=${() => handleResumeRun(route.runId)}>
              ${unsafeHTML(iconSvg(Play, 14))} Resume
            </button>`
          : nothing;
        const cancelBtn =
          stopBtn === nothing && actionAllowed('cancel', hs)
            ? html`<button class="action-btn action-btn--danger" @click=${() => handleCancelRun(route.runId)}>
                ${unsafeHTML(iconSvg(Square, 14))} Cancel
              </button>`
            : nothing;
        const btns = [pauseBtn, stopBtn, resumeBtn, cancelBtn].filter(
          (b) => b !== nothing,
        );
        if (btns.length) actionButton = html`${btns}`;
      }
    }
  } else if (route.section === 'new-run') {
    title = 'Run Pipeline';
    showBack = true;
    const hasProjects = (state.projects?.length ?? 0) > 0;
    const nrs = getNewRunSubmitState({
      hasProjects,
      currentProjectId: state.currentProjectId,
    });
    const capReached = isAtCapacity(state);
    const btnDisabled = nrs.isSubmitting || capReached || nrs.noProject;
    const btnTitle = nrs.noProject ? 'Select a project to launch.' : '';
    actionButton = html`
      <button class="action-btn action-btn--primary" ?disabled=${btnDisabled} title=${btnTitle}
        @click=${() => submitNewRun({ rerender, onStarted: () => navigate('active', null, route.projectId), projectId: getEffectiveProjectId(store.getState()), hasProjects })}>

        ${unsafeHTML(iconSvg(Play, 14))}
        ${nrs.isSubmitting ? 'Starting\u2026' : 'Start'}
      </button>`;
  } else if (route.section === 'webhooks') {
    title = 'Webhook Inbox';
    showBack = true;
    const inboxEvents = state.webhookInbox?.events || [];
    if (inboxEvents.length > 0) {
      actionButton = html`
        <button class="action-btn action-btn--danger" @click=${handleWebhookClear}>
          ${unsafeHTML(iconSvg(Trash2, 14))}
          Clear
        </button>`;
    }
  } else if (route.section === 'costs') {
    title = 'Token & Cost Dashboard';
    showBack = true;
  } else if (route.section === 'settings') {
    title = 'Settings';
    showBack = true;
  } else if (route.section === 'project-settings') {
    title = 'Project Settings';
    showBack = true;
  }

  // Dashboard gets a "Run Pipeline" button in the header
  if (!route.section && !route.runId) {
    actionButton = html`
      <button class="action-btn action-btn--primary" @click=${() => navigate('new-run', null, route.projectId)}>
        ${unsafeHTML(iconSvg(Plus, 14))}
        Run Pipeline
      </button>`;
  }

  return html`
    <div class="content-header">
      ${
        showBack
          ? html`
        <button class="content-header-back" @click=${handleBack}>
          ${unsafeHTML(iconSvg(ArrowLeft, 18))}
        </button>
      `
          : ''
      }
      ${badge || ''}
      <h1 class="content-header-title">${title}</h1>
      ${
        actionButton
          ? html`<div class="content-header-actions">
        ${actionButton}
      </div>`
          : ''
      }
    </div>
  `;
}

function mainContentView() {
  const state = store.getState();
  const allRuns = Object.values(state.runs);
  // In multi-project mode, filter runs to the selected project so views
  // only show runs belonging to the current project — not all projects.
  const currentProjectId = state.currentProjectId;
  const runs =
    currentProjectId && (state.projects || []).length > 1
      ? allRuns.filter((r) => {
          const rp = r.project || r._project;
          return rp === currentProjectId;
        })
      : allRuns;
  // Build a derived state with only the filtered runs for views (like
  // dashboardView) that read state.runs internally.
  const filteredRunsMap = {};
  for (const r of runs) filteredRunsMap[r.id] = r;

  // Archived runs — same project filter as active runs
  const allArchivedRuns = Object.values(state.archivedRuns);
  const archivedRuns =
    currentProjectId && (state.projects || []).length > 1
      ? allArchivedRuns.filter((r) => {
          const rp = r.project || r._project;
          return rp === currentProjectId;
        })
      : allArchivedRuns;
  const filteredArchivedRunsMap = {};
  for (const r of archivedRuns) filteredArchivedRunsMap[r.id] = r;
  const viewState = {
    ...state,
    runs: filteredRunsMap,
    archivedRuns: filteredArchivedRunsMap,
  };

  // Beads section: two-level routing (must be checked before generic runId)
  if (route.section === 'beads') {
    if (route.runId) {
      return beadsPanelView(beadsRunIssues, {
        statusFilter: beadsStatusFilter,
        priorityFilter: beadsPriorityFilter,
        starting: beadsStarting,
        startError: beadsStartError,
        onStatusFilter: handleBeadsStatusFilter,
        onPriorityFilter: handleBeadsPriorityFilter,
        onStartIssue: handleStartBeadsIssue,
        onDismissError: handleDismissBeadsError,
        loading: beadsRunLoading,
        run: store.getRunById(route.runId),
        runId: route.runId,
      });
    }
    return beadsRunListView(runs, {
      onSelectRun: handleSelectRun,
      beadsCounts,
    });
  }

  // The runId catch-all renders the per-run pipeline detail view. Exclude
  // sections that own their own :id sub-route (fleet-runs, workspace-runs,
  // workspaces — the create-definition flow).
  if (
    route.runId &&
    route.section !== 'fleet-runs' &&
    route.section !== 'workspace-runs' &&
    route.section !== 'workspaces'
  ) {
    const run = store.getRunById(route.runId);
    // If the run doesn't belong to the current project (e.g. after a project
    // switch), redirect to the section root instead of showing a stale view.
    // Skip redirect if runs haven't loaded yet (cold page load race condition).
    if (
      !run &&
      state.runsLoaded &&
      currentProjectId &&
      (state.projects || []).length > 1
    ) {
      navigate(route.section, null, route.projectId);
      return html``;
    }
    // Orphan run (e.g. child that died before writing status.json): runs
    // are loaded but this id isn't there. Show an empty-state instead of
    // rendering run-detail with run=undefined (which silently breaks).
    if (!run && state.runsLoaded) {
      return html`
        <div class="run-detail run-detail-layout">
          <div class="run-detail-layout__overview">
            <sl-alert variant="warning" open>
              <strong>Run not found.</strong>
              No <code>status.json</code> exists for
              <code>${route.runId}</code> — it may have been an orphan worktree
              whose pipeline died before writing run state. Clean it up from the
              <a href="#/worktrees" @click=${() => navigate('worktrees')}>Worktrees</a> view.
            </sl-alert>
          </div>
        </div>
      `;
    }
    // Compute iteration counts per stage from run status
    const stageIterations = {};
    if (run?.stages) {
      for (const [key, stage] of Object.entries(run.stages)) {
        const iters = stage.iterations || [];
        if (iters.length > 0) stageIterations[key] = iters.length;
      }
      fetchAgentPrompts(route.runId, run.stages);
    }
    const logState = filteredLogState(state);
    logState.currentLogStage = logFilter === '*' ? null : logFilter;
    logState.currentLogIteration = logIterationFilter;
    const isRunning = !!run?.active;
    const liveStage = getActiveStage();
    // Initialize active stage tracking on first render
    if (run && !liveStage) {
      updateActiveStage(run);
    }
    const { overview, stages: stagePanelsHtml } = runDetailView(run, settings, {
      promptCache: promptCache[route.runId] || {},
      onRestartStage: handleRestartStage,
      stageIterationTab,
      onStageTabChange: handleStageTabChange,
      // Plan-stage View plan dialog needs to redraw when the modal
      // toggles open/closed and when the lazy plan fetch resolves.
      rerender,
    });
    return html`
      <div class="run-detail run-detail-layout">
        <div class="run-detail-layout__overview">
          ${overview}
        </div>
        <div class="run-detail-layout__stages">
          <div class="run-detail-column-header">Stages</div>
          ${stagePanelsHtml}
        </div>
        <div class="run-detail-layout__logs">
          <div class="run-detail-column-header">Artifacts</div>
          ${prApprovalPanelView(run, { onApprove: handleApprovePR, onReject: handleRejectPR })}
          ${liveOutputView(getActiveStage(), isRunning)}
          ${logViewerView(logState, {
            onStageFilter: handleStageFilter,
            onIterationFilter: handleIterationFilter,
            onSearch: handleSearch,
            onToggleAutoScroll: handleToggleAutoScroll,
            autoScroll,
            stageIterations,
            runStages: run?.stages,
          })}
          ${runBeadsSectionView(runBeads.get(route.runId))}
          ${learningsSectionView(run?.stages?.learn, {
            onRunLearn: actionAllowed('learn', run?.pipeline_status)
              ? handleRunLearn
              : null,
          })}
        </div>
      </div>
    `;
  }

  if (route.section === 'webhooks') {
    return webhookInboxView(state, {
      selectedId: webhookSelectedId,
      categoryFilter: webhookCategoryFilter,
      runFilter: webhookRunFilter,
      searchTerm: webhookSearchTerm,
      onSelectEvent: handleWebhookSelectEvent,
      onCategoryFilter: handleWebhookCategoryFilter,
      onRunFilter: handleWebhookRunFilter,
      onSearch: handleWebhookSearch,
      onSetControl: handleWebhookSetControl,
      onClear: handleWebhookClear,
      onCopyJson: handleWebhookCopyJson,
      onDismissDetail: handleWebhookDismissDetail,
    });
  }

  if (route.section === 'costs') {
    if (!costsFetched) fetchCostsData();
    return tokenCostsView(viewState, {
      expandedRun: costsExpanded,
      tokenData: costsTokenData,
      onToggleRun: handleToggleCostRun,
    });
  }

  if (route.section === 'new-run') {
    return newRunView(viewState, { rerender });
  }

  if (route.section === 'fleet-runs') {
    // /fleet-runs/new → launcher (Launch button lives in the page header,
    // wired to submitFleetLauncher above).
    if (route.runId === 'new') {
      if (_lastLauncherSection !== 'fleet-runs') {
        resetLauncherState({ launcherMode: 'fleet' });
        _lastLauncherSection = 'fleet-runs';
      }
      return fleetLauncherView(viewState, { rerender });
    }
    // /fleet-runs/:id → detail (fetch on demand, cache result)
    if (route.runId) {
      const fleet = _fleetDetailCache[route.runId];
      const isMissing = _fleetDetailMissing.has(route.runId);
      if (!fleet && !isMissing) {
        // Trigger fetch — only re-render on success/error
        if (_fleetDetailFetching !== route.runId) {
          _fleetDetailFetching = route.runId;
          fetch(`/api/fleet-runs/${route.runId}`)
            .then(async (r) => ({ status: r.status, data: await r.json() }))
            .then(({ status, data }) => {
              _fleetDetailFetching = null;
              if (data?.ok && data.fleet) {
                _fleetDetailMissing.delete(route.runId);
                _fleetDetailCache[route.runId] = data.fleet;
                rerender();
              } else if (status === 404 || data?.ok === false) {
                // Manifest cleaned up (or never existed) — record the
                // negative result so the view leaves the loading state and
                // we don't refetch on every render tick.
                _fleetDetailMissing.add(route.runId);
                rerender();
              }
            })
            .catch(() => {
              _fleetDetailFetching = null;
            });
        }
      }
      return fleetDetailView(fleet || null, {
        rerender,
        runsById: state.runs,
        onSelectRun: (id) => navigate('history', id, null),
        missing: isMissing,
        fleetId: route.runId,
      });
    }
    // /fleet-runs → list of fleets
    return _fleetListView(rerender);
  }

  if (route.section === 'workspaces') {
    // /workspaces/new → create a workspace definition.
    if (route.runId === 'new') {
      if (_lastCreateSection !== 'workspaces') {
        resetWorkspaceCreateState();
        _lastCreateSection = 'workspaces';
      }
      return workspaceCreateView(viewState, { rerender });
    }
    // /workspaces/:name/edit → edit an existing definition. workspaceEditView
    // owns its own load state — kick off the fetch on first entry so the
    // form populates with the current workspace.json.
    if (route.runId && route.action === 'edit') {
      if (_lastEditWorkspace !== route.runId) {
        _lastEditWorkspace = route.runId;
        loadWorkspace({ name: route.runId, rerender });
      }
      return workspaceEditView(viewState, { rerender });
    }
    // Bare /workspaces → list view (CRUD surface for definitions).
    return workspacesConfigView(viewState, {
      onCreate: () => navigate('workspaces', 'new', null),
      onLaunch: handleLaunchWorkspace,
      onEdit: (name) => navigate('workspaces', name, null, 'edit'),
      onDelete: handleDeleteWorkspace,
      onOpenRuns: () => navigate('workspace-runs', null, null),
    });
  }

  if (route.section === 'workspace-runs') {
    // /workspace-runs/new → launcher in workspace mode. Fleet launcher is the
    // shared launch surface for both fleets and workspaces; preset the mode
    // once on entry, then defer to its own state on subsequent renders.
    if (route.runId === 'new') {
      // A pending launch from the Configuration → Workspaces list takes
      // priority over the normal mode-reset: we want to land with the
      // chosen workspace already selected and its DAG visible.
      if (_pendingLaunchWorkspace) {
        const ws = (store.getState().workspaces || []).find(
          (w) => w.name === _pendingLaunchWorkspace,
        );
        resetLauncherState({
          launcherMode: 'workspace',
          selectedWorkspace: _pendingLaunchWorkspace,
          workspaceData: ws || null,
        });
        _lastLauncherSection = 'workspace-runs';
        _pendingLaunchWorkspace = null;
      } else if (_lastLauncherSection !== 'workspace-runs') {
        resetLauncherState({ launcherMode: 'workspace' });
        _lastLauncherSection = 'workspace-runs';
      }
      return fleetLauncherView(viewState, { rerender });
    }
    // /workspace-runs/:id → detail (fetch on demand, mirror fleet pattern)
    if (route.runId) {
      const ws = _wsDetailCache[route.runId];
      const isMissing = _wsDetailMissing.has(route.runId);
      if (!ws && !isMissing) {
        if (_wsDetailFetching !== route.runId) {
          _wsDetailFetching = route.runId;
          fetch(`/api/workspace-runs/${route.runId}`)
            .then(async (r) => ({ status: r.status, data: await r.json() }))
            .then(({ status, data }) => {
              _wsDetailFetching = null;
              if (data?.ok && data.manifest) {
                _wsDetailMissing.delete(route.runId);
                // Pin the server-computed cost_usd onto the cached
                // manifest so _overviewSection can read it without an
                // extra fetch. Without this, the client falls back to a
                // walk over `child.stages` (always empty in the manifest)
                // and prints $0.00 for every workspace run.
                _wsDetailCache[route.runId] = {
                  ...data.manifest,
                  cost_usd: data.cost_usd,
                };
                rerender();
              } else if (status === 404 || data?.ok === false) {
                _wsDetailMissing.add(route.runId);
                rerender();
              }
            })
            .catch(() => {
              _wsDetailFetching = null;
            });
        }
      }
      return workspaceDetailView(ws || null, {
        rerender,
        missing: isMissing,
        workspaceId: route.runId,
        // Mirror /fleet-runs/:id call site so _childrenSection can render
        // rich runCardView's for each child instead of a sparse PR table.
        runsById: state.runs,
        onSelectRun: (id) => navigate('history', id, null),
      });
    }
    // /workspace-runs → list of workspace runs
    return _workspaceListView(rerender);
  }

  if (route.section === 'project-settings') {
    const isAllProjects =
      (state.projects || []).length > 1 && !state.currentProjectId;
    if (isAllProjects) {
      return html`
        <div class="empty-state project-settings-empty">
          <p>Select a project from the sidebar to view its settings.</p>
          <sl-button variant="primary" @click=${() => navigate('dashboard', null, null)}>
            Back to Dashboard
          </sl-button>
        </div>
      `;
    }
    return projectSettingsView(state.preferences, {
      rerender,
      currentProjectId: state.currentProjectId || null,
    });
  }

  if (route.section === 'settings') {
    if (integrationsStatus === null) fetchIntegrationsData();
    return settingsView(state.preferences, {
      rerender,
      onThemeToggle: handleThemeToggle,
      onSaveSourceRepo: handleSaveSourceRepo,
      onSaveNotifications: handleSaveNotifications,
      onRequestPermission: () => notificationManager.requestPermission(),
      globals: {
        worktreeDiskWarningBytes: state.worktreeDiskWarningBytes,
        classifierModel: state.classifierModel,
        cleanupPolicy: state.cleanupPolicy,
        maxConcurrentPipelines: state.maxConcurrentPipelines,
      },
      onSaveGlobals: (patch) => store.setState(patch),
      projects: state.projects || [],
      integrations: {
        status: integrationsStatus,
        config: integrationsConfig,
        editingAdapter: integrationsEditingAdapter,
        forms: Object.fromEntries(
          ['telegram', 'discord', 'slack'].map((k) => [
            k,
            getIntegrationsForm(k),
          ]),
        ),
      },
      onIgStartEdit: handleIgStartEdit,
      onIgCancelEdit: handleIgCancelEdit,
      onIgFieldChange: handleIgFieldChange,
      onIgEventToggle: handleIgEventToggle,
      onIgSave: handleIgSave,
      onIgRemove: handleIgRemove,
      onIgDetect: handleIgDetect,
      onIgToggleEnabled: handleIgToggleEnabled,
      onProjectAdd: (result) => {
        if (result?.openDialog) {
          store.setState({ addProjectDialogOpen: true });
          rerender();
        } else if (Array.isArray(result) || result?.name) {
          // New project(s) added — re-fetch projects
          fetch('/api/projects')
            .then((r) => r.json())
            .then((data) => {
              store.setState({ projects: data.projects || [] });
              rerender();
            })
            .catch(() => {});
        }
      },
      onProjectRemove: () => {
        fetch('/api/projects')
          .then((r) => r.json())
          .then((data) => {
            store.setState({ projects: data.projects || [] });
            rerender();
          })
          .catch(() => {});
      },
      onProjectsRefresh: () => {
        fetch('/api/projects')
          .then((r) => r.json())
          .then((data) => {
            store.setState({ projects: data.projects || [] });
            rerender();
          })
          .catch(() => {});
      },
    });
  }

  if (route.section === 'history') {
    return runListView(runs, 'history', {
      onSelectRun: handleSelectRun,
      onResume: handleResumeRun,
      onStop: handleStopRun,
      onCancel: handleCancelRun,
      onArchive: archiveRun,
      onUnarchive: unarchiveRun,
      archivedRuns,
      statusFilter: historyStatusFilter,
      runsLoaded: store.getState().runsLoaded,
      onStatusFilter: (s) => {
        historyStatusFilter = s;
        rerender();
      },
      textFilter: historyTextFilter,
      onTextFilter: (value) => {
        historyTextFilter = value;
        rerender();
      },
    });
  }

  if (route.section === 'worktrees') {
    return worktreesView(state.worktrees || [], {
      diskWarningBytes: state.worktreeDiskWarningBytes,
      filter: worktreesFilter,
      onFilter: (value) => {
        worktreesFilter = value;
        rerender();
      },
      statusFilter: worktreesStatusFilter,
      onStatusFilter: (s) => {
        worktreesStatusFilter = s;
        rerender();
      },
      onSelectRun: handleSelectRun,
      onCleanup: openWorktreeCleanupDialog,
      onBulkCleanup: openWorktreeBulkCleanupDialog,
      dialogItem: worktreesDialogItem,
      dialogBulk: worktreesDialogBulk,
      dialogCheckbox: worktreesDialogCheckbox,
      onDialogClose: closeWorktreeCleanupDialog,
      onDialogConfirm: confirmWorktreeCleanup,
      onDialogCheckboxChange: (checked) => {
        worktreesDialogCheckbox = checked;
        rerender();
      },
    });
  }

  if (route.section === 'active') {
    const activeRuns = sortByStartDesc(runs.filter((r) => r.active));
    // Always show the list view — let the user click into a run.
    return html`
      <h3 class="dashboard-section-title">Active Runs</h3>
      ${
        activeRuns.length > 0
          ? html`
        <div class="active-group">
          <div class="run-list">
            ${activeRuns.map((run) =>
              runCardView(run, {
                onClick: handleSelectRun,
                onPause: handlePauseRun,
                onResume: handleResumeRun,
                onStop: handleStopRun,
                onCancel: handleCancelRun,
                onArchive: archiveRun,
              }),
            )}
          </div>
        </div>
      `
          : html`<div class="empty-state">No running pipelines</div>`
      }
    `;
  }

  return html`
    ${dashboardView(viewState, {
      onSelectRun: (runId) => navigate('active', runId, route.projectId),
      onArchive: archiveRun,
      onArchiveFleet: archiveFleet,
      onUnarchiveFleet: unarchiveFleet,
      onNavigate: (section, secondArg, thirdArg) => {
        if (
          secondArg &&
          typeof secondArg === 'object' &&
          secondArg.statusFilter
        ) {
          historyStatusFilter = secondArg.statusFilter;
          navigate(section, null, route.projectId);
        } else {
          navigate(section, secondArg || null, thirdArg || route.projectId);
        }
      },
      onPause: handlePauseRun,
      onResume: handleResumeRun,
      onStop: handleStopRun,
      onCancel: handleCancelRun,
    })}
  `;
}

function filteredLogState(state) {
  let lines = state.logLines;
  if (logFilter !== '*') {
    lines = lines.filter((l) => l.stage === logFilter);
  }
  if (logSearch) {
    const term = logSearch.toLowerCase();
    lines = lines.filter((l) => (l.line || '').toLowerCase().includes(term));
  }
  return { ...state, logLines: lines };
}

function rerender() {
  const state = store.getState();
  const appEl = document.getElementById('app');
  if (!appEl) return;

  render(
    html`
    <div class="app-shell">
      ${sidebarView(state, route, connectionState, {
        onNavigate: handleNavigate,
        onSelectRun: handleSelectRun,
        onProjectChange: handleProjectChange,
        onAddProject: () => {
          store.setState({ addProjectDialogOpen: true });
          rerender();
        },
      })}
      <main class="main-content">
        ${notificationManager.renderBanner()}
        ${contentHeaderView()}
        ${mainContentView()}
      </main>
    </div>
    ${
      actionError
        ? html`
      <sl-dialog id="action-error-dialog" label="Pipeline Error" @sl-after-hide=${dismissActionError}>
        <div class="error-dialog-body">
          ${unsafeHTML(iconSvg(AlertTriangle, 32, 'error-dialog-icon'))}
          <p>${actionError}</p>
        </div>
        <sl-button slot="footer" variant="primary" @click=${() => {
          document.getElementById('action-error-dialog')?.hide();
        }}>OK</sl-button>
      </sl-dialog>
    `
        : ''
    }
    ${confirmDialogTemplate()}
    ${batchWorcaSetupDialogTemplate(rerender)}
    ${addProjectDialogView(state, {
      onProjectAdd: (_project) => {
        store.setState({ addProjectDialogOpen: false });
        fetch('/api/projects')
          .then((r) => r.json())
          .then((data) => {
            store.setState({ projects: data.projects || [] });
            rerender();
          })
          .catch(() => {});
      },
      onClose: () => {
        store.setState({ addProjectDialogOpen: false });
        rerender();
      },
      rerender,
    })}
  `,
    appEl,
  );

  // Mount xterm terminals after render if in run view
  if (route.runId) {
    // Log History: only mount when a specific stage is selected (terminal div exists)
    if (logFilter !== '*') mountTerminal(route.runId);
    mountLiveTerminal(route.runId);
  }
}

// --- Sticky header scroll shadow ---
let scrollListenerAttached = false;

function attachStickyHeaderListener() {
  if (scrollListenerAttached) return;
  const mainEl = document.querySelector('.main-content');
  if (!mainEl) return;
  mainEl.addEventListener(
    'scroll',
    () => {
      const header = mainEl.querySelector('.content-header');
      if (header) {
        header.classList.toggle(
          'content-header--scrolled',
          mainEl.scrollTop > 10,
        );
      }
    },
    { passive: true },
  );
  scrollListenerAttached = true;
}

// --- Bootstrap ---

notificationManager.setRerender(rerender);
store.subscribe(() => rerender());
applyTheme(store.getState().preferences.theme);
if (route.projectId) {
  store.setState({ currentProjectId: route.projectId });
}
fetchProjectInfo();
Promise.all([
  fetch('/api/preferences')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null),
  fetch('/api/status/runs-count')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null),
]).then(([prefsRes, countRes]) => {
  const patch = {};
  if (prefsRes?.ok) {
    const p = prefsRes.preferences?.worca ?? {};
    if (p.ui?.worktree_disk_warning_bytes != null)
      patch.worktreeDiskWarningBytes = p.ui.worktree_disk_warning_bytes;
    if (p.circuit_breaker?.classifier_model != null)
      patch.classifierModel = p.circuit_breaker.classifier_model;
    if (p.parallel?.cleanup_policy != null)
      patch.cleanupPolicy = p.parallel.cleanup_policy;
    if (p.parallel?.max_concurrent_pipelines != null)
      patch.maxConcurrentPipelines = p.parallel.max_concurrent_pipelines;
  }
  if (countRes?.ok && typeof countRes.totalRunning === 'number') {
    patch.totalRunning = countRes.totalRunning;
  }
  if (Object.keys(patch).length > 0) store.setState(patch);
});
if (route.section === 'settings') {
  loadSettings(null).then(() => rerender());
  startIntegrationsPoll();
}
if (route.section === 'project-settings') {
  const s = store.getState();
  const isAllProjects = (s.projects || []).length > 1 && !s.currentProjectId;
  if (!isAllProjects) {
    loadSettings(s.currentProjectId || null).then(() => rerender());
  }
}

// Single-project polling fallback: WS totalRunning derivation only covers
// the focused project's runs. Poll /api/status/runs-count every 5s so
// launch gating stays accurate across all projects.
setInterval(() => {
  fetch('/api/status/runs-count')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data?.ok && typeof data.totalRunning === 'number') {
        const patch = { totalRunning: data.totalRunning };
        if (typeof data.cap === 'number')
          patch.maxConcurrentPipelines = data.cap;
        store.setState(patch);
      }
    })
    .catch(() => {});
}, 5000);

rerender();
attachStickyHeaderListener();
