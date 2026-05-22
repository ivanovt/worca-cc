import { html } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, RefreshCw, Save } from '../utils/icons.js';
import { getModelKeys } from './settings.js';

export const GRAPHIFY_MODES = ['structural', 'full'];

const PRIVACY_STRUCTURAL =
  'Structural mode is fully local — zero outbound LLM calls. ' +
  'Captures call graphs, inline rationale, and Leiden communities without sending any data externally.';

const PRIVACY_FULL =
  'Full mode sends document and diagram summaries (never raw source code) ' +
  'to the configured model provider for semantic analysis. ' +
  'Only Markdown, PDFs, and images are processed — source files stay local.';

export function graphifyTab(worca, _rerender) {
  const graphify = worca.graphify || {};
  const enabled = graphify.enabled ?? false;
  const mode = graphify.mode || 'structural';
  const backend = graphify.model_profile || '';
  const modelKeys = getModelKeys(worca);
  const isFullMode = mode === 'full';

  return html`
    <div class="settings-tab-content">
      <h3 class="settings-section-title">Knowledge Graph</h3>
      <p class="settings-tab-description">
        Graphify pre-computes a knowledge graph of your codebase, reducing agent orientation cost across pipeline stages.
      </p>

      <div class="settings-grid">
        <div class="settings-field">
          <label class="settings-label" for="graphify-enabled">Enabled</label>
          <sl-switch id="graphify-enabled" ?checked=${enabled}></sl-switch>
        </div>

        <div class="settings-field">
          <label class="settings-label">Mode</label>
          <sl-radio-group id="graphify-mode" value="${mode}">
            ${GRAPHIFY_MODES.map(
              (m) => html`<sl-radio-button value="${m}">${m}</sl-radio-button>`,
            )}
          </sl-radio-group>
        </div>

        <div class="settings-field">
          <label class="settings-label" for="graphify-backend">Model Profile</label>
          <sl-select id="graphify-backend" value="${backend}" placeholder="None (structural default)" clearable>
            ${modelKeys.map(
              (k) => html`<sl-option value="${k}">${k}</sl-option>`,
            )}
          </sl-select>
        </div>
      </div>

      <sl-details
        id="graphify-privacy-notice"
        class="graphify-privacy-notice ${isFullMode ? 'graphify-privacy-expanded' : ''}"
        summary="Privacy Notice"
        ?open=${isFullMode}
      >
        <p>${isFullMode ? PRIVACY_FULL : PRIVACY_STRUCTURAL}</p>
      </sl-details>

      <div class="settings-tab-actions">
        <sl-button variant="primary" class="graphify-save-btn">
          ${unsafeHTML(iconSvg(Save, 14))}
          Save
        </sl-button>
        <sl-button variant="default" outline class="graphify-reset-btn">
          ${unsafeHTML(iconSvg(RefreshCw, 14))}
          Reset
        </sl-button>
      </div>
    </div>
  `;
}
