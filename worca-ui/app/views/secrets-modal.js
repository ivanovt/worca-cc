import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { iconSvg, Plus, Trash2 } from '../utils/icons.js';

let _activeModel = null;
let _secrets = {};
let _newKey = '';
let _newValue = '';
let _saveStatus = '';
let _saveMessage = '';

function settingsSecretsUrl(projectId) {
  if (projectId) return `/api/projects/${projectId}/settings/secrets`;
  return '/api/settings/secrets';
}

async function loadSecrets(projectId) {
  try {
    const res = await fetch(settingsSecretsUrl(projectId));
    if (res.ok) {
      const data = await res.json();
      _secrets = data.models || {};
    }
  } catch {
    _secrets = {};
  }
}

async function saveSecret(model, key, value, projectId, rerender) {
  _saveStatus = 'saving';
  rerender();
  try {
    const res = await fetch(settingsSecretsUrl(projectId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, key, value }),
    });
    const data = await res.json();
    if (!res.ok) {
      _saveStatus = 'error';
      _saveMessage = data.error || 'Failed to save';
    } else {
      _saveStatus = 'success';
      _saveMessage = 'Secret saved';
      await loadSecrets(projectId);
    }
  } catch (err) {
    _saveStatus = 'error';
    _saveMessage = err.message;
  }
  rerender();
}

async function deleteSecret(model, key, projectId, rerender) {
  await saveSecret(model, key, null, projectId, rerender);
}

export async function openSecretsModal(modelName, projectId, rerender) {
  _activeModel = modelName;
  _newKey = '';
  _newValue = '';
  _saveStatus = '';
  _saveMessage = '';
  await loadSecrets(projectId);
  rerender();
  requestAnimationFrame(() => {
    document.getElementById('secrets-modal')?.show();
  });
}

export function closeSecretsModal(rerender) {
  _activeModel = null;
  const dlg = document.getElementById('secrets-modal');
  if (dlg) dlg.hide();
  rerender();
}

export function secretsModalTemplate(projectId, rerender) {
  if (!_activeModel) return nothing;

  const modelSecrets = _secrets[_activeModel] || {};
  const entries = Object.entries(modelSecrets);

  function handleAdd() {
    const keyEl = document.getElementById('secrets-new-key');
    const valEl = document.getElementById('secrets-new-value');
    const key = keyEl?.value?.trim();
    const value = valEl?.value || '';
    if (!key) return;
    saveSecret(_activeModel, key, value, projectId, rerender);
    _newKey = '';
    _newValue = '';
  }

  return html`
    <sl-dialog id="secrets-modal" label="Secrets — ${_activeModel}"
      @sl-after-hide=${() => {
        _activeModel = null;
      }}>
      <div class="secrets-modal-body">
        ${
          _saveStatus === 'error'
            ? html`<sl-alert variant="danger" open>${_saveMessage}</sl-alert>`
            : nothing
        }
        ${
          _saveStatus === 'success'
            ? html`<sl-alert variant="success" open duration="2000">${_saveMessage}</sl-alert>`
            : nothing
        }

        ${
          entries.length > 0
            ? html`
            <table class="secrets-table">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Value</th>
                  <th>Source</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${entries.map(
                  ([key, info]) => html`
                  <tr>
                    <td><code>${key}</code></td>
                    <td>${
                      info.source === 'public'
                        ? html`<span class="secrets-value-public">${info.value}</span>`
                        : html`<span class="secrets-value-masked">${info.value}</span>`
                    }
                    </td>
                    <td><sl-badge variant="${info.source === 'public' ? 'neutral' : 'warning'}" pill>${info.source}</sl-badge></td>
                    <td>
                      ${
                        info.source !== 'public'
                          ? html`<sl-button variant="text" size="small"
                            @click=${() => deleteSecret(_activeModel, key, projectId, rerender)}>
                            ${unsafeHTML(iconSvg(Trash2, 14))}
                          </sl-button>`
                          : nothing
                      }
                    </td>
                  </tr>
                `,
                )}
              </tbody>
            </table>
          `
            : html`<p class="settings-muted">No secrets configured for this model.</p>`
        }

        <div class="secrets-add-row">
          <sl-input id="secrets-new-key" size="small" placeholder="ENV_KEY"
            value=${_newKey} @sl-input=${(e) => {
              _newKey = e.target.value;
            }}></sl-input>
          <sl-input id="secrets-new-value" size="small" placeholder="secret value" type="password"
            value=${_newValue} @sl-input=${(e) => {
              _newValue = e.target.value;
            }}></sl-input>
          <sl-button variant="default" size="small" @click=${handleAdd}>
            ${unsafeHTML(iconSvg(Plus, 14))} Add
          </sl-button>
        </div>

        <p class="settings-muted" style="margin-top: var(--sl-spacing-small); font-size: 0.8rem;">
          Secrets are stored in <code>settings.local.json</code> (gitignored).
        </p>
      </div>
      <div slot="footer">
        <sl-button variant="default" @click=${() => closeSecretsModal(rerender)}>Close</sl-button>
      </div>
    </sl-dialog>
  `;
}
