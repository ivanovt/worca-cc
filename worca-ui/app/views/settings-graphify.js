import { html } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, RefreshCw, Save, Trash2 } from '../utils/icons.js';
import { confirmReset, getModelKeys, saveSettings } from './settings.js';

// Single 3-way control collapses the former [enabled switch] + [mode radios]
// into one selector. It maps onto the two persisted settings keys:
//   off        -> { enabled: false }
//   structural -> { enabled: true, mode: 'structural' }
//   full       -> { enabled: true, mode: 'full' }
export const GRAPHIFY_STATES = ['off', 'structural', 'full'];
// Retained for back-compat: the persisted `mode` values.
export const GRAPHIFY_MODES = ['structural', 'full'];

// Default version range — mirror of _GRAPHIFY_DEFAULTS["version_range"] in
// src/worca/utils/graphify.py and GRAPHIFY_DEFAULTS in server/graphify-status.js.
export const GRAPHIFY_VERSION_RANGE_DEFAULT = '>=0.8.16,<1';

// The PyPI distribution is `graphifyy` (double-y) even though the CLI it
// installs is `graphify`. graphify is a CLI that must land on PATH, so the
// project recommends `uv tool install` / `pipx` over plain `pip` (which often
// installs into a venv/site that isn't on PATH). Ref:
// https://github.com/safishamsi/graphify
export const GRAPHIFY_PYPI_PACKAGE = 'graphifyy';

/** Suggested command to install a compatible graphify CLI (shell-quoted). */
export function graphifyInstallCommand(versionRange) {
  const range = versionRange || GRAPHIFY_VERSION_RANGE_DEFAULT;
  return `uv tool install '${GRAPHIFY_PYPI_PACKAGE}${range}'`;
}

/**
 * A copy-able read-only query against the cached graph.json. Pipeline agents
 * get the graph via the GRAPHIFY_OUT env var the runner injects; humans don't,
 * so the snippet passes the path explicitly with `--graph`.
 */
export function graphifyQuerySnippet(graphJsonPath) {
  return `graphify query "<your question>" --graph ${graphJsonPath}`;
}

const PRIVACY_STRUCTURAL =
  'Structural mode is fully local — zero outbound LLM calls. ' +
  'Captures call graphs, inline rationale, and Leiden communities without sending any data externally.';

const PRIVACY_FULL =
  'Full mode sends document and diagram summaries (never raw source code) ' +
  'to the configured model provider for semantic analysis. ' +
  'Only Markdown, PDFs, and images are processed — source files stay local.';

/** Derive the 3-way control value from the persisted enabled/mode keys. */
export function graphifyStateValue(graphify = {}) {
  if (!(graphify.enabled ?? false)) return 'off';
  return graphify.mode === 'full' ? 'full' : 'structural';
}

// `worca.graphify.nudge` — how often the pre_tool hook nudges agents to run
// `graphify query` before a broad code search. Default (unset) is "every".
export const GRAPHIFY_NUDGE_MODES = ['off', 'every', 'stage', 'run'];
export const GRAPHIFY_NUDGE_LABELS = {
  off: 'Off',
  every: 'Every search',
  stage: 'Once per stage',
  run: 'First search per run',
};

/** Resolve the persisted nudge mode, defaulting to "every" when unset. */
export function graphifyNudgeValue(graphify = {}) {
  const v = graphify.nudge;
  return GRAPHIFY_NUDGE_MODES.includes(v) ? v : 'every';
}

// Module-level cache-action state (the tab is a stateless lit-html template;
// long-running build/clear track progress here and re-render via rerender()).
let _cacheBusy = false;
let _cacheMsg = '';
let _cachePath = null; // <cache>/ast/<repo-id>/ for this project (from the server)
// Absolute path to the current commit's graph.json, or null when not built.
// Drives the human "Query this graph" affordance.
let _graphJsonPath = null;
let _cacheStatusFetched = false;
// True once any status response has come back. Distinguishes "still loading"
// (show "resolving…") from "loaded but path is null" (not a git repo / error —
// show "unavailable") so the path field is never terminally stuck.
let _cacheStatusReceived = false;
// Latest graphify CLI detection from the server, or null until first fetch.
// When the CLI is missing/incompatible, Build is disabled and a notice shows.
let _graphifyDetection = null;
// Effective version range from the server, used to suggest an install command.
let _graphifyVersionRange = GRAPHIFY_VERSION_RANGE_DEFAULT;
// Selected project id (global mode). The graphify endpoints have no fixed
// project there, so we pass ?project=<id> to scope status/build/clear to it.
let _projectId = null;

/** Append ?project=<id> when a project is selected (global mode). */
function graphifyApiUrl(path) {
  return _projectId
    ? `${path}?project=${encodeURIComponent(_projectId)}`
    : path;
}

/**
 * True when the graphify CLI is known-missing or version-incompatible, so
 * Build must be disabled and the install notice shown. `null` detection means
 * "not fetched yet" → not unavailable (don't flash the notice while loading).
 */
export function isGraphifyUnavailable(detection) {
  return detection ? !(detection.installed && detection.compatible) : false;
}

/**
 * Label for the cache-location field. A resolved path wins; otherwise show
 * "resolving…" until the first status response, then "unavailable" (the repo
 * isn't a git repo, or the status fetch failed) — never terminally stuck.
 */
export function cachePathLabel(path, received) {
  if (path) return path;
  return received ? 'unavailable' : 'resolving…';
}

async function _refreshCacheStatus(rerender) {
  try {
    const j = await (
      await fetch(graphifyApiUrl('/api/graphify/status'))
    ).json();
    _cacheStatusReceived = true;
    _cacheBusy = Boolean(j.building);
    _cachePath = j.cache_path ?? _cachePath;
    _graphifyDetection = j.detection ?? _graphifyDetection;
    _graphifyVersionRange = j.effective?.version_range ?? _graphifyVersionRange;
    _graphJsonPath = j.graph_stats?.graph_json_path ?? null;
    if (j.graph_stats)
      _cacheMsg = 'Knowledge graph is built for the current commit.';
    else if (!_cacheBusy)
      _cacheMsg = 'No graph cached for the current commit yet.';
    rerender();
    if (_cacheBusy) setTimeout(() => _refreshCacheStatus(rerender), 2000);
  } catch {
    _cacheStatusReceived = true;
    _cacheBusy = false;
    rerender();
  }
}

async function _onBuildGraph(rerender) {
  _cacheBusy = true;
  _cacheMsg = 'Building knowledge graph for the current commit…';
  rerender();
  try {
    const j = await (
      await fetch(graphifyApiUrl('/api/graphify/build'), { method: 'POST' })
    ).json();
    if (!j.ok) {
      _cacheBusy = false;
      _cacheMsg = j.error || 'Build failed.';
      rerender();
      return;
    }
    setTimeout(() => _refreshCacheStatus(rerender), 1500);
  } catch {
    _cacheBusy = false;
    _cacheMsg = 'Build request failed.';
    rerender();
  }
}

async function _onClearCache(rerender) {
  _cacheBusy = true;
  _cacheMsg = 'Clearing graph cache…';
  rerender();
  try {
    await fetch(graphifyApiUrl('/api/graphify/clear'), { method: 'POST' });
    _cacheMsg = 'Graph cache cleared for this project.';
  } catch {
    _cacheMsg = 'Clear request failed.';
  }
  _cacheBusy = false;
  rerender();
}

export function graphifyTab(worca, rerender, projectId = null) {
  _projectId = projectId;
  const graphify = worca.graphify || {};
  const state = graphifyStateValue(graphify);
  const enabled = state !== 'off';
  const isFullMode = state === 'full';
  const modelProfile = graphify.model_profile || '';
  const modelKeys = getModelKeys(worca);
  const nudgeValue = graphifyNudgeValue(graphify);

  // Load the cache path + build state once when the tab first shows enabled.
  if (enabled && !_cacheStatusFetched) {
    _cacheStatusFetched = true;
    _refreshCacheStatus(rerender);
  }

  // Edits update worca.graphify in-memory and re-render (same pattern as the
  // governance tab); the Save button persists via saveSettings().
  const onStateChange = (value) => {
    worca.graphify = {
      ...graphify,
      enabled: value !== 'off',
      // Preserve a real mode while off, so toggling back restores it.
      mode: value === 'off' ? graphify.mode || 'structural' : value,
    };
    rerender();
  };

  const onModelProfileChange = (value) => {
    worca.graphify = {
      ...(worca.graphify || {}),
      model_profile: value || null,
    };
    rerender();
  };

  const onNudgeChange = (value) => {
    worca.graphify = {
      ...(worca.graphify || {}),
      nudge: value || 'every',
    };
    rerender();
  };

  const onSave = () => {
    saveSettings({ worca: { graphify: worca.graphify || {} } }, rerender);
  };

  return html`
    <div class="settings-tab-content">
      <h3 class="settings-section-title">Knowledge Graph</h3>
      <p class="settings-tab-description">
        Graphify pre-computes a knowledge graph of your codebase, reducing agent orientation cost across pipeline stages.
      </p>

      <div class="settings-grid">
        <div class="settings-field">
          <label class="settings-label">Status</label>
          <sl-radio-group
            id="graphify-state"
            value="${state}"
            @sl-change=${(e) => onStateChange(e.target.value)}
          >
            <sl-radio-button value="off">Off</sl-radio-button>
            <sl-radio-button value="structural">Structural</sl-radio-button>
            <sl-radio-button value="full">Full</sl-radio-button>
          </sl-radio-group>
        </div>

        ${
          // Model Profile only affects the Full-mode LLM pass. Structural mode
          // runs `graphify update` with no provider key (zero outbound calls),
          // so the profile is inert there — only render when state is full.
          isFullMode
            ? html`
        <div class="settings-field">
          <label class="settings-label" for="graphify-model-profile">Model Profile</label>
          <sl-select
            id="graphify-model-profile"
            value="${modelProfile}"
            placeholder="None (graphify default)"
            clearable
            @sl-change=${(e) => onModelProfileChange(e.target.value)}
          >
            ${modelKeys.map((k) => html`<sl-option value="${k}">${k}</sl-option>`)}
          </sl-select>
        </div>`
            : ''
        }

        ${
          // Nudge agents to run `graphify query` before broad code searches.
          // Applies to any enabled mode; the pre_tool hook reads worca.graphify.nudge.
          enabled
            ? html`
        <div class="settings-field">
          <label class="settings-label" for="graphify-nudge">Query nudge</label>
          <sl-select
            id="graphify-nudge"
            class="graphify-nudge-select"
            value="${nudgeValue}"
            help-text="Suggest a scoped graph query before grep/find (non-blocking)."
            @sl-change=${(e) => onNudgeChange(e.target.value)}
          >
            ${GRAPHIFY_NUDGE_MODES.map(
              (m) =>
                html`<sl-option value="${m}">${GRAPHIFY_NUDGE_LABELS[m]}</sl-option>`,
            )}
          </sl-select>
        </div>`
            : ''
        }
      </div>

      ${
        enabled
          ? html`
      <sl-details
        id="graphify-privacy-notice"
        class="graphify-privacy-notice ${isFullMode ? 'graphify-privacy-expanded' : ''}"
        summary="Privacy Notice"
        ?open=${isFullMode}
      >
        <p>${isFullMode ? PRIVACY_FULL : PRIVACY_STRUCTURAL}</p>
      </sl-details>`
          : html`
      <p class="settings-tab-description graphify-disabled-hint">
        Knowledge graph is off — pipeline behavior is unchanged.
      </p>`
      }

      ${
        enabled
          ? html`
      <div class="settings-field graphify-cache-actions">
        <label class="settings-label">Knowledge Graph Cache</label>
        <p class="settings-tab-description">
          Snapshots are stored per-commit in the worca cache (not in the repo).
          Building can take a while on large repos and runs in the background.
        </p>
        <label class="settings-label" for="graphify-cache-path">Cache location</label>
        <div class="graphify-copy-row">
          <code id="graphify-cache-path" class="graphify-codebox"
            >${cachePathLabel(_cachePath, _cacheStatusReceived)}</code
          >
          <sl-copy-button
            class="graphify-copy-path-btn"
            value=${_cachePath || ''}
            ?disabled=${!_cachePath}
            copy-label="Copy cache location"
            success-label="Copied"
          ></sl-copy-button>
        </div>
        ${
          isGraphifyUnavailable(_graphifyDetection)
            ? html`
        <div id="graphify-not-installed-notice" class="graphify-not-installed">
          <p class="settings-tab-description">
            ${
              _graphifyDetection?.error ||
              'Graphify CLI not found on PATH — install it to build graphs.'
            }
          </p>
          <label class="settings-label" for="graphify-install-cmd">Suggested install command</label>
          <div class="graphify-copy-row">
            <code id="graphify-install-cmd" class="graphify-codebox"
              >${graphifyInstallCommand(_graphifyVersionRange)}</code
            >
            <sl-copy-button
              class="graphify-copy-cmd-btn"
              value=${graphifyInstallCommand(_graphifyVersionRange)}
              copy-label="Copy install command"
              success-label="Copied"
            ></sl-copy-button>
          </div>
          <p class="settings-tab-description graphify-install-hint">
            PyPI package is <code>${GRAPHIFY_PYPI_PACKAGE}</code> (the CLI is
            still <code>graphify</code>). No <code>uv</code>? <code>pipx install
            '${GRAPHIFY_PYPI_PACKAGE}${_graphifyVersionRange}'</code> works too —
            prefer uv/pipx over plain pip so the CLI lands on PATH.
          </p>
        </div>`
            : ''
        }
        <div class="graphify-cache-buttons">
          <sl-button
            class="graphify-build-btn"
            variant="primary"
            outline
            ?loading=${_cacheBusy}
            ?disabled=${_cacheBusy || isGraphifyUnavailable(_graphifyDetection)}
            @click=${() => _onBuildGraph(rerender)}
          >
            ${unsafeHTML(iconSvg(RefreshCw, 14))}
            Build / refresh graph
          </sl-button>
          <sl-button
            class="graphify-clear-btn"
            variant="default"
            outline
            ?disabled=${_cacheBusy}
            @click=${() => _onClearCache(rerender)}
          >
            ${unsafeHTML(iconSvg(Trash2, 14))}
            Clear cache
          </sl-button>
        </div>
        ${
          _cacheMsg
            ? html`<p class="settings-tab-description graphify-cache-msg">${_cacheMsg}</p>`
            : ''
        }
        ${
          // Human query affordance — only when a graph is actually built for
          // the current commit. Agents query automatically via GRAPHIFY_OUT;
          // humans pass the path explicitly with --graph.
          _graphJsonPath
            ? html`
        <div class="settings-field graphify-query-hint">
          <label class="settings-label" for="graphify-query-cmd">Query this graph</label>
          <p class="settings-tab-description">
            Pipeline agents query the graph automatically. To explore it
            yourself, run a scoped query against the cached
            <code>graph.json</code>:
          </p>
          <div class="graphify-copy-row">
            <code id="graphify-query-cmd" class="graphify-codebox"
              >${graphifyQuerySnippet(_graphJsonPath)}</code
            >
            <sl-copy-button
              class="graphify-copy-query-btn"
              value=${graphifyQuerySnippet(_graphJsonPath)}
              copy-label="Copy query command"
              success-label="Copied"
            ></sl-copy-button>
          </div>
        </div>`
            : ''
        }
      </div>`
          : ''
      }

      <div class="settings-tab-actions">
        <sl-button variant="primary" class="graphify-save-btn" @click=${onSave}>
          ${unsafeHTML(iconSvg(Save, 14))}
          Save
        </sl-button>
        <sl-button
          variant="default"
          outline
          class="graphify-reset-btn"
          @click=${() => confirmReset('graphify', rerender)}
        >
          ${unsafeHTML(iconSvg(RefreshCw, 14))}
          Reset
        </sl-button>
      </div>
    </div>
  `;
}
