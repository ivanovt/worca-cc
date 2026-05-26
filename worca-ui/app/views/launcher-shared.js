import { html, nothing } from 'lit-html';

const DEFAULT_GUIDE_CAP = 128 * 1024; // matches worca.guide.max_bytes default in src/worca/settings.json
const DEFAULT_TOKEN_THRESHOLD = 1_000_000;

function _formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

function _formatTokens(n) {
  return Math.round(n).toLocaleString('en-US');
}

function _slugify(str) {
  return (
    (str || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  );
}

function _resolveTemplate(template, projectPath) {
  const project = _slugify(projectPath.split('/').pop() || projectPath);
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const yyyymmdd = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}`;
  const yyyymmddhhmm = `${yyyymmdd}${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}`;

  let result = template || 'migration/{project}';
  result = result.replace(/\{project\}/g, project);
  result = result.replace(/\{fleet_id\}/g, 'f_preview');
  result = result.replace(/\{slug\}/g, 'slug');
  result = result.replace(/\{yyyymmddhhmm\}/g, yyyymmddhhmm);
  result = result.replace(/\{yyyymmdd\}/g, yyyymmdd);
  return result;
}

/**
 * @param {{ label?: string, accept?: string, multiple?: boolean, onFiles?: function, className?: string }} opts
 */
export function filePickerButton({
  label = 'Browse files',
  accept,
  multiple = true,
  onFiles,
  className = 'btn-file-picker',
} = {}) {
  return html`
    <sl-button
      size="small"
      variant="default"
      class="${className}"
      @click=${
        onFiles
          ? () => {
              const inp = document.createElement('input');
              inp.type = 'file';
              inp.multiple = multiple;
              if (accept) inp.accept = accept;
              inp.onchange = () => {
                const files = [...(inp.files || [])];
                if (files.length) onFiles(files);
              };
              inp.click();
            }
          : null
      }
    >${label}</sl-button>
  `;
}

/**
 * @param {{ guides: Array<{name: string, size: number}> }} state
 * @param {{ onChange?: function, maxBytes?: number }} opts
 */
export function guideUploadWidget(
  state,
  { onChange, maxBytes = DEFAULT_GUIDE_CAP } = {},
) {
  const guides = state.guides || [];
  const totalBytes = guides.reduce((s, g) => s + (g.size || 0), 0);
  const pct = maxBytes > 0 ? totalBytes / maxBytes : 0;
  const overCap = totalBytes > maxBytes;
  const nearCap = !overCap && pct >= 0.8;
  const sizeClass = overCap
    ? 'guide-size-danger'
    : nearCap
      ? 'guide-size-warning'
      : 'guide-size-ok';

  return html`
    <div class="guide-upload-widget">
      <div
        class="guide-drop-zone"
        @dragover=${(e) => e.preventDefault()}
        @drop=${
          onChange
            ? (e) => {
                e.preventDefault();
                const files = [...(e.dataTransfer?.files || [])];
                if (files.length) onChange({ type: 'add-files', files });
              }
            : null
        }
      >
        ${filePickerButton({
          className: 'btn-guide-browse',
          onFiles: onChange
            ? (files) => onChange({ type: 'add-files', files })
            : undefined,
        })}
      </div>
      ${
        guides.length > 0
          ? html`
            <div class="guide-tags">
              ${guides.map(
                (g, i) => html`
                  <sl-tag
                    removable
                    class="guide-tag"
                    @sl-remove=${onChange ? () => onChange({ type: 'remove-file', index: i }) : null}
                  >${g.name} (${_formatBytes(g.size)})</sl-tag>
                `,
              )}
            </div>
          `
          : nothing
      }
      <div class="guide-size-readout ${sizeClass}">
        Total guide size: ${_formatBytes(totalBytes)} / ${_formatBytes(maxBytes)}
        ${
          overCap
            ? html`<span class="guide-size-error"> — exceeds cap, cannot submit</span>`
            : nothing
        }
      </div>
    </div>
  `;
}

/**
 * @param {{ headTemplate: string }} state
 * @param {{ selectedProjects?: string[], onChange?: function }} opts
 */
export function headTemplateInput(
  state,
  { selectedProjects = [], onChange } = {},
) {
  const template = state.headTemplate || '';

  const previews = selectedProjects.map((p) => ({
    project: p,
    branch: _resolveTemplate(template, p),
  }));

  const branchCounts = {};
  for (const { branch } of previews) {
    branchCounts[branch] = (branchCounts[branch] || 0) + 1;
  }
  const hasCollision = Object.values(branchCounts).some((c) => c > 1);

  return html`
    <div class="head-template-input">
      <sl-input
        class="input-head-template"
        value="${template}"
        placeholder="migration/v2/{project}"
        @sl-input=${
          onChange
            ? (e) =>
                onChange({ type: 'set-head-template', value: e.target.value })
            : null
        }
      ></sl-input>
      ${
        previews.length > 0
          ? html`
            <div class="head-template-preview ${hasCollision ? 'head-template-collision' : ''}">
              ${previews.map(({ project, branch }) => {
                const collides = branchCounts[branch] > 1;
                return html`
                  <div class="head-template-preview-row ${collides ? 'collision' : ''}">
                    <span class="preview-project">${project.split('/').pop() || project}</span>
                    <span class="preview-arrow">→</span>
                    <code class="preview-branch">${branch}</code>
                    ${collides ? html`<span class="collision-flag">collision</span>` : nothing}
                  </div>
                `;
              })}
            </div>
          `
          : nothing
      }
      ${
        hasCollision
          ? html`
            <sl-alert variant="danger" open class="head-template-collision-alert">
              Two or more projects resolve to the same branch name. Add {project} to the
              template to ensure uniqueness.
            </sl-alert>
          `
          : nothing
      }
    </div>
  `;
}

/**
 * @param {{ planMode: string, planPath?: string, planFirstProject?: string, selectedProjects?: string[] }} state
 * @param {{ options?: Array<{value,label}>, onChange?: function }} opts
 */
export function planModeRadio(state, { options, onChange } = {}) {
  const mode = state.planMode || 'none';
  const defaultOptions = [
    { value: 'explicit', label: 'Use existing plan' },
    { value: 'plan-first', label: 'Plan-first reference project' },
    { value: 'none', label: 'Independent plans' },
  ];
  const opts = options || defaultOptions;

  return html`
    <div class="plan-mode-radio">
      <sl-radio-group
        class="plan-mode-group"
        value="${mode}"
        @sl-change=${
          onChange
            ? (e) => onChange({ type: 'set-plan-mode', value: e.target.value })
            : null
        }
      >
        ${opts.map(
          (opt) => html`
            <sl-radio value="${opt.value}" class="plan-mode-option-${opt.value}">${opt.label}</sl-radio>
          `,
        )}
      </sl-radio-group>
      ${
        mode === 'explicit'
          ? html`
            <sl-input
              class="input-plan-path"
              value="${state.planPath || ''}"
              placeholder="docs/plans/W-040-migration.md"
              @sl-input=${
                onChange
                  ? (e) =>
                      onChange({ type: 'set-plan-path', value: e.target.value })
                  : null
              }
            ></sl-input>
          `
          : nothing
      }
      ${
        mode === 'plan-first'
          ? html`
            <sl-select
              class="select-plan-first-project"
              value="${state.planFirstProject || ''}"
              @sl-change=${
                onChange
                  ? (e) =>
                      onChange({
                        type: 'set-plan-first-project',
                        value: e.target.value,
                      })
                  : null
              }
            >
              ${(state.selectedProjects || []).map(
                (p) => html`
                  <sl-option value="${p}">${p.split('/').pop() || p}</sl-option>
                `,
              )}
            </sl-select>
          `
          : nothing
      }
      ${
        mode === 'none'
          ? html`
            <sl-alert variant="warning" open class="plan-mode-independent-warning">
              Each project runs its own Planner independently. Strategies may diverge across
              projects.
            </sl-alert>
          `
          : nothing
      }
    </div>
  `;
}

/**
 * @param {{ targets: Array<{name: string, status: string}> }} state
 * @param {{ onCancel?: function, dispatched?: boolean }} opts
 */
export function initProgressStrip(
  state,
  { onCancel, dispatched = false } = {},
) {
  const targets = state.targets || [];
  if (targets.length === 0) return nothing;

  const cancelLabel = dispatched ? 'Halt workspace' : 'Cancel launch';

  return html`
    <div class="init-progress-strip">
      ${targets.map(
        (t) => html`
          <div class="init-target-row init-target-${t.status}">
            <span class="init-target-name">${t.name}</span>
            ${
              t.status === 'initializing'
                ? html`<sl-progress-bar indeterminate></sl-progress-bar>`
                : html`<span class="init-target-status">${t.status}</span>`
            }
          </div>
        `,
      )}
      ${
        onCancel
          ? html`
            <sl-button
              size="small"
              variant="danger"
              outline
              class="btn-cancel-init"
              @click=${onCancel}
            >${cancelLabel}</sl-button>
          `
          : nothing
      }
    </div>
  `;
}

/**
 * @param {{ estimated: boolean, tokenEstimate?: number }} state
 * @param {{ estimateFn?: function, threshold?: number, onChange?: function }} opts
 */
export function tokenOverheadGate(
  state,
  { estimateFn, threshold = DEFAULT_TOKEN_THRESHOLD, onChange } = {},
) {
  const estimated = state.estimated || false;
  const rawEstimate = state.tokenEstimate || 0;
  const displayTokens = estimateFn ? estimateFn(state) : rawEstimate;
  const overThreshold = estimated && displayTokens > threshold;

  if (!estimated) {
    return html`
      <div class="token-overhead-gate">
        <sl-button
          size="small"
          variant="default"
          class="btn-estimate-cost"
          @click=${onChange ? () => onChange({ type: 'estimate-request' }) : null}
        >Estimate cost</sl-button>
      </div>
    `;
  }

  return html`
    <div class="token-overhead-gate">
      <div class="token-overhead-result ${overThreshold ? 'token-overhead-ack' : 'token-overhead-ok'}">
        <span class="token-overhead-value">${_formatTokens(displayTokens)} input tokens</span>
        ${
          overThreshold
            ? html`
              <sl-alert variant="warning" open class="token-overhead-warning">
                Estimated overhead exceeds ${_formatTokens(threshold)} tokens.
              </sl-alert>
              <sl-checkbox
                class="checkbox-ack-cost"
                @sl-change=${onChange ? (e) => onChange({ type: 'ack-toggle', checked: e.target.checked }) : null}
              >I understand the cost</sl-checkbox>
            `
            : nothing
        }
      </div>
    </div>
  `;
}
