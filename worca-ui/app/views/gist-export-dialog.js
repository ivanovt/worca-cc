import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { CircleCheck, Copy, iconSvg } from '../utils/icons.js';

/**
 * Renders the gist-export dialog, controlled by `state.gistDialog`.
 *
 * Shape of `state.gistDialog`:
 *   { open: bool, status: 'loading'|'done'|'error',
 *     url: string|null, error: string|null, templateName: string,
 *     copied?: bool }
 *
 * Mirrors the addProjectDialog pattern: pure/functional, mounted in main.js's
 * render output. Opens immediately (loading state) before the network request
 * resolves, then re-renders to 'done' / 'error' on result. The transient
 * "Copied" feedback lives in `state.gistDialog.copied` so it flows through the
 * standard setState→rerender path (the view stays stateless).
 *
 * @param {object} state - Global app state.
 * @param {object} options
 * @param {() => void} options.onClose - Dismiss the dialog (setState open:false + rerender).
 * @param {(url: string) => void} [options.onCopy] - Copy hook: writes to clipboard
 *   and flips `gistDialog.copied` for ~1.5s. Defaults to a bare clipboard write.
 */
export function gistExportDialogView(state, { onClose, onCopy } = {}) {
  const dlg = state?.gistDialog;
  if (!dlg || !dlg.open) return nothing;

  const status = dlg.status || 'loading';
  const isLoading = status === 'loading';
  const isDone = status === 'done';
  const isError = status === 'error';
  const url = dlg.url || null;
  const copied = !!dlg.copied;

  const label = isLoading
    ? 'Exporting template via gist…'
    : isError
      ? 'Gist export failed'
      : 'Template exported via gist';

  function handleClose() {
    onClose?.();
  }

  function handleHide(e) {
    // Ignore hide events from elements disconnected during rerender.
    if (e?.target && !e.target.isConnected) return;
    handleClose();
  }

  function handleCopy() {
    if (!url) return;
    if (onCopy) {
      onCopy(url);
    } else {
      navigator.clipboard?.writeText(url);
    }
  }

  // Field content: the URL on success, the error text on failure, a
  // placeholder while generating.
  const fieldValue = isError
    ? dlg.error || 'Export failed'
    : isDone && url
      ? url
      : 'generating…';

  const copyDisabled = !isDone || !url;
  const copyIcon = copied ? CircleCheck : Copy;
  const copyLabel = copied ? 'Copied' : 'Copy';

  return html`
    <sl-dialog
      class="gist-export-dialog"
      label=${label}
      ?open=${dlg.open}
      @sl-after-hide=${handleHide}
    >
      <div slot="label" class="gist-export-label">
        <span>${label}</span>
        ${isLoading ? html`<sl-spinner class="gist-export-spinner"></sl-spinner>` : nothing}
      </div>
      <div class="gist-export-body">
        <label class="settings-label" for="gist-export-url">URL:</label>
        <div class="gist-export-url-row">
          <sl-input
            id="gist-export-url"
            class="gist-export-url-field"
            readonly
            value=${fieldValue}
            style="flex:1"
          ></sl-input>
          ${
            isError
              ? nothing
              : html`
                <sl-button
                  class="gist-export-copy-btn ${copied ? 'is-copied' : ''}"
                  size="medium"
                  title=${copyLabel || nothing}
                  ?disabled=${copyDisabled}
                  @click=${handleCopy}
                >
                  ${unsafeHTML(iconSvg(copyIcon, 16))}
                  ${copyLabel}
                </sl-button>
              `
          }
        </div>
      </div>
      <div slot="footer" class="gist-export-footer">
        <sl-button variant="primary" class="gist-export-close-btn" @click=${handleClose}>Close</sl-button>
      </div>
    </sl-dialog>
  `;
}
