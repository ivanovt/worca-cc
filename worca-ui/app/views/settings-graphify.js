import { html } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, RefreshCw, Save } from '../utils/icons.js';
import { confirmReset, getModelKeys, saveSettings } from './settings.js';

// Single 3-way control collapses the former [enabled switch] + [mode radios]
// into one selector. It maps onto the two persisted settings keys:
//   off        -> { enabled: false }
//   structural -> { enabled: true, mode: 'structural' }
//   full       -> { enabled: true, mode: 'full' }
export const GRAPHIFY_STATES = ['off', 'structural', 'full'];
// Retained for back-compat: the persisted `mode` values.
export const GRAPHIFY_MODES = ['structural', 'full'];

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

export function graphifyTab(worca, rerender) {
  const graphify = worca.graphify || {};
  const state = graphifyStateValue(graphify);
  const enabled = state !== 'off';
  const isFullMode = state === 'full';
  const backend = graphify.model_profile || '';
  const modelKeys = getModelKeys(worca);

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

  const onBackendChange = (value) => {
    worca.graphify = {
      ...(worca.graphify || {}),
      model_profile: value || null,
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
          enabled
            ? html`
        <div class="settings-field">
          <label class="settings-label" for="graphify-backend">Model Profile</label>
          <sl-select
            id="graphify-backend"
            value="${backend}"
            placeholder="None (structural default)"
            clearable
            @sl-change=${(e) => onBackendChange(e.target.value)}
          >
            ${modelKeys.map((k) => html`<sl-option value="${k}">${k}</sl-option>`)}
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
