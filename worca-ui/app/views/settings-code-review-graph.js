import { html } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, RefreshCw, Save, Trash2 } from '../utils/icons.js';
import { confirmReset, saveSettings } from './settings.js';

export const CRG_STATES = ['off', 'structural'];

export const CRG_VERSION_RANGE_DEFAULT = '>=2,<3';
export const CRG_FASTMCP_MIN = '3.2.4';
export const CRG_PYPI_PACKAGE = 'code-review-graph';

export const DEFAULT_STAGE_TOOLS = {
  planner: [
    'get_architecture_overview_tool',
    'get_minimal_context_tool',
    'query_graph_tool',
    'list_communities_tool',
  ],
  coordinator: [
    'get_architecture_overview_tool',
    'get_minimal_context_tool',
    'query_graph_tool',
    'list_communities_tool',
  ],
  implementer: [
    'get_minimal_context_tool',
    'get_impact_radius_tool',
    'query_graph_tool',
  ],
  tester: [
    'get_impact_radius_tool',
    'detect_changes_tool',
    'get_affected_flows_tool',
  ],
  reviewer: [
    'detect_changes_tool',
    'get_review_context_tool',
    'get_impact_radius_tool',
    'query_graph_tool',
  ],
  guardian: ['detect_changes_tool'],
};

export function crgStateValue(crg = {}) {
  return crg.enabled ? 'structural' : 'off';
}

export function crgInstallCommand(versionRange) {
  const range = versionRange || CRG_VERSION_RANGE_DEFAULT;
  return `pip install '${CRG_PYPI_PACKAGE}${range}'`;
}

export function isCrgUnavailable(detection) {
  if (!detection) return false;
  return !(detection.installed && detection.compatible && detection.fastmcp_ok);
}

export function crgCachePathLabel(path, received) {
  if (path) return path;
  return received ? 'unavailable' : 'resolving…';
}

let _cacheBusy = false;
let _cacheMsg = '';
let _cachePath = null;
let _cacheStatusFetched = false;
let _cacheStatusReceived = false;
let _crgDetection = null;
let _crgVersionRange = CRG_VERSION_RANGE_DEFAULT;
let _projectId = null;

function crgApiUrl(path) {
  return _projectId
    ? `${path}?project=${encodeURIComponent(_projectId)}`
    : path;
}

async function _refreshCacheStatus(rerender) {
  try {
    const j = await (await fetch(crgApiUrl('/api/crg/status'))).json();
    _cacheStatusReceived = true;
    _cacheBusy = Boolean(j.building);
    _cachePath = j.cache_path ?? _cachePath;
    _crgDetection = j.detection ?? _crgDetection;
    _crgVersionRange = j.effective?.version_range ?? _crgVersionRange;
    if (j.graph_stats)
      _cacheMsg = 'Code review graph is built for the current commit.';
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
  _cacheMsg = 'Building code review graph for the current commit…';
  rerender();
  try {
    const j = await (
      await fetch(crgApiUrl('/api/crg/build'), { method: 'POST' })
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
    await fetch(crgApiUrl('/api/crg/clear'), { method: 'POST' });
    _cacheMsg = 'Graph cache cleared for this project.';
  } catch {
    _cacheMsg = 'Clear request failed.';
  }
  _cacheBusy = false;
  rerender();
}

function _stageToolsInfoBox() {
  return html`
    <div class="crg-stage-tools">
      <label class="settings-label">Per-Stage MCP Tools</label>
      <p class="settings-tab-description">
        Each pipeline stage exposes a subset of read-only CRG MCP tools.
        Mutating tools are always excluded.
      </p>
      <div class="crg-stage-tools-grid">
        ${Object.entries(DEFAULT_STAGE_TOOLS).map(
          ([role, tools]) => html`
          <div class="crg-stage-tools-entry">
            <span class="crg-stage-role">${role}</span>
            <span class="crg-stage-tool-list">${tools.join(', ')}</span>
          </div>
        `,
        )}
      </div>
    </div>
  `;
}

export function crgTab(worca, rerender, projectId = null) {
  _projectId = projectId;
  const crg = worca.code_review_graph || {};
  const state = crgStateValue(crg);
  const enabled = state !== 'off';

  if (enabled && !_cacheStatusFetched) {
    _cacheStatusFetched = true;
    _refreshCacheStatus(rerender);
  }

  const onStateChange = (value) => {
    worca.code_review_graph = {
      ...crg,
      enabled: value !== 'off',
    };
    rerender();
  };

  const onSave = () => {
    saveSettings(
      { worca: { code_review_graph: worca.code_review_graph || {} } },
      rerender,
    );
  };

  return html`
    <div class="settings-tab-content">
      <h3 class="settings-section-title">Code Review Graph</h3>
      <p class="settings-tab-description">
        Code Review Graph builds a Tree-sitter AST graph exposed as MCP tools,
        giving pipeline agents task-shaped context for plan, implement, and review stages.
      </p>

      <div class="settings-grid">
        <div class="settings-field">
          <label class="settings-label">Status</label>
          <sl-radio-group
            id="crg-state"
            value="${state}"
            @sl-change=${(e) => onStateChange(e.target.value)}
          >
            <sl-radio-button value="off">Off</sl-radio-button>
            <sl-radio-button value="structural">Structural</sl-radio-button>
          </sl-radio-group>
        </div>

        ${
          enabled
            ? html`
        <div class="settings-field crg-embeddings">
          <label class="settings-label">Embeddings</label>
          <sl-switch disabled size="small">Semantic search</sl-switch>
          <span class="settings-field-hint crg-coming-soon">coming soon — structural-only in v1</span>
        </div>`
            : ''
        }
      </div>

      ${
        enabled
          ? ''
          : html`
      <p class="settings-tab-description crg-disabled-hint">
        Code review graph is off — pipeline behavior is unchanged.
      </p>`
      }

      ${
        enabled
          ? html`
      <div class="settings-field crg-cache-actions">
        <label class="settings-label">Graph Cache</label>
        <p class="settings-tab-description">
          Snapshots are stored per-commit in the worca cache (not in the repo).
          Building runs in the background.
        </p>
        <label class="settings-label" for="crg-cache-path">Cache location</label>
        <div class="crg-copy-row">
          <code id="crg-cache-path" class="crg-codebox"
            >${crgCachePathLabel(_cachePath, _cacheStatusReceived)}</code
          >
          <sl-copy-button
            class="crg-copy-path-btn"
            value=${_cachePath || ''}
            ?disabled=${!_cachePath}
            copy-label="Copy cache location"
            success-label="Copied"
          ></sl-copy-button>
        </div>
        ${
          isCrgUnavailable(_crgDetection)
            ? html`
        <div id="crg-not-installed-notice" class="crg-not-installed">
          <p class="settings-tab-description">
            ${
              _crgDetection?.error ||
              'code-review-graph CLI not found — install it to build graphs.'
            }
          </p>
          ${
            !_crgDetection?.fastmcp_ok && _crgDetection?.installed
              ? html`<p class="settings-tab-description">
                  fastmcp &ge; ${CRG_FASTMCP_MIN} is also required for MCP serve.
                  <code>pip install 'fastmcp>=${CRG_FASTMCP_MIN}'</code>
                </p>`
              : ''
          }
          <label class="settings-label" for="crg-install-cmd">Suggested install command</label>
          <div class="crg-copy-row">
            <code id="crg-install-cmd" class="crg-codebox"
              >${crgInstallCommand(_crgVersionRange)}</code
            >
            <sl-copy-button
              class="crg-copy-cmd-btn"
              value=${crgInstallCommand(_crgVersionRange)}
              copy-label="Copy install command"
              success-label="Copied"
            ></sl-copy-button>
          </div>
        </div>`
            : ''
        }
        <div class="crg-cache-buttons">
          <sl-button
            class="crg-build-btn"
            variant="primary"
            outline
            ?loading=${_cacheBusy}
            ?disabled=${_cacheBusy || isCrgUnavailable(_crgDetection)}
            @click=${() => _onBuildGraph(rerender)}
          >
            ${unsafeHTML(iconSvg(RefreshCw, 14))}
            Build / refresh graph
          </sl-button>
          <sl-button
            class="crg-clear-btn"
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
            ? html`<p class="settings-tab-description crg-cache-msg">${_cacheMsg}</p>`
            : ''
        }
      </div>

      ${_stageToolsInfoBox()}
      `
          : ''
      }

      <div class="settings-tab-actions">
        <sl-button variant="primary" class="crg-save-btn" @click=${onSave}>
          ${unsafeHTML(iconSvg(Save, 14))}
          Save
        </sl-button>
        <sl-button
          variant="default"
          outline
          class="crg-reset-btn"
          @click=${() => confirmReset('code_review_graph', rerender)}
        >
          ${unsafeHTML(iconSvg(RefreshCw, 14))}
          Reset
        </sl-button>
      </div>
    </div>
  `;
}
