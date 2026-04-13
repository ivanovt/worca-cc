import { html, nothing } from 'lit-html';
import { unsafeHTML } from 'lit-html/directives/unsafe-html.js';
import { showConfirm } from '../utils/confirm-dialog.js';
import { FolderOpen, iconSvg } from '../utils/icons.js';

let dialogError = '';
let nameManuallyEdited = false;
let dialogMode = 'single'; // 'single' | 'workspace'
let scannedFolders = [];
let _selectedFolders = new Set();
let _scanning = false;
let _scanError = '';
let scanAbortController = null;
let _scanDebounceTimer = null;
// Resolved name map: folder index → resolved slug (computed once after scan)
let _resolvedNameMap = new Map();

// Batch worca setup dialog state
let _batchSetupOpen = false;
let _batchSetupItems = []; // [{ name, statusLabel, checked }]
let _batchSetupProgress = new Map(); // name → { state: 'pending'|'started'|'failed', error? }
let _batchSetupInstalling = false;

/**
 * Debounces then POSTs to /api/scan-directory, managing AbortController lifecycle.
 * Cancels any in-flight scan if path changes before debounce fires or during fetch.
 */
function triggerWorkspaceScan(path, state, rerender) {
  clearTimeout(_scanDebounceTimer);
  if (!path || !path.startsWith('/')) {
    if (scanAbortController) {
      scanAbortController.abort();
      scanAbortController = null;
    }
    scannedFolders = [];
    _selectedFolders = new Set();
    _resolvedNameMap = new Map();
    _scanError = '';
    _scanning = false;
    rerender?.();
    return;
  }
  _scanDebounceTimer = setTimeout(() => {
    if (scanAbortController) scanAbortController.abort();
    scanAbortController = new AbortController();
    const controller = scanAbortController;
    _scanning = true;
    _scanError = '';
    rerender?.();
    fetch('/api/scan-directory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          scannedFolders = data.subfolders || [];
          const registeredPaths = new Set(
            (state.projects || []).map((p) =>
              (p.path || '').replace(/\/+$/, ''),
            ),
          );
          const existingNames = new Set(
            (state.projects || []).map((p) => p.name),
          );
          _selectedFolders = new Set();
          // Compute resolved names once (fixes TOCTOU between render and submit)
          const nonRegisteredFolders = [];
          scannedFolders.forEach((f, i) => {
            if (!registeredPaths.has((f.path || '').replace(/\/+$/, ''))) {
              _selectedFolders.add(i);
              nonRegisteredFolders.push({ index: i, name: f.name });
            }
          });
          // Filter out folders whose names produce empty slugs (e.g. all special chars)
          const validFolders = nonRegisteredFolders.filter(
            (f) => slugify(f.name) !== '',
          );
          const slugged = validFolders.map((f) => slugify(f.name));
          const resolved = resolveCollisions(slugged, [...existingNames]);
          _resolvedNameMap = new Map();
          validFolders.forEach((f, idx) => {
            _resolvedNameMap.set(f.index, resolved[idx]);
          });
          // Deselect folders with empty slugs
          for (const f of nonRegisteredFolders) {
            if (slugify(f.name) === '') _selectedFolders.delete(f.index);
          }
        } else {
          _scanError = data.error || 'Scan failed';
          scannedFolders = [];
          _selectedFolders = new Set();
          _resolvedNameMap = new Map();
        }
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          _scanError = err.message || 'Scan failed';
          scannedFolders = [];
          _selectedFolders = new Set();
          _resolvedNameMap = new Map();
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          _scanning = false;
          rerender?.();
        }
      });
  }, 300);
}

function showError(msg) {
  dialogError = msg;
  const el = document.getElementById('add-project-error');
  if (el) {
    el.textContent = msg;
    el.style.display = msg ? 'block' : 'none';
  }
}

export function addProjectDialogView(
  state,
  { onProjectAdd, onClose, rerender },
) {
  const { addProjectDialogOpen } = state;
  if (!addProjectDialogOpen) {
    // Reset workspace state so next open starts fresh
    dialogMode = 'single';
    scannedFolders = [];
    _selectedFolders = new Set();
    _resolvedNameMap = new Map();
    _scanError = '';
    if (scanAbortController) {
      scanAbortController.abort();
      scanAbortController = null;
    }
    clearTimeout(_scanDebounceTimer);
    return nothing;
  }

  function handleSubmit(e) {
    e.preventDefault();

    if (dialogMode === 'workspace') {
      if (_selectedFolders.size === 0) return;

      const entries = scannedFolders
        .map((f, i) => ({ ...f, index: i }))
        .filter(
          (f) => _selectedFolders.has(f.index) && _resolvedNameMap.has(f.index),
        )
        .map((f) => ({ name: _resolvedNameMap.get(f.index), path: f.path }));

      if (entries.length === 0) return;

      showError('');
      fetch('/api/projects/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projects: entries }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            onProjectAdd?.(data.projects);
            offerBatchWorcaSetup(data.projects, rerender);
          } else {
            showError(data.error || 'Failed to add projects');
          }
        })
        .catch((err) => {
          showError(err.message || 'Network error');
        });
      return;
    }

    const nameEl = document.getElementById('add-project-name');
    const pathEl = document.getElementById('add-project-path');
    const name = nameEl?.value?.trim() || '';
    const path = pathEl?.value?.trim() || '';

    if (!name) {
      showError('Name is required');
      return;
    }
    if (!path || !path.startsWith('/')) {
      showError('Path must be an absolute path');
      return;
    }

    const normalizedPath = path.replace(/\/+$/, '');
    const existingProjects = state.projects || [];
    const duplicate = existingProjects.find(
      (p) => (p.path || '').replace(/\/+$/, '') === normalizedPath,
    );
    if (duplicate) {
      showError(`A project with this path already exists: "${duplicate.name}"`);
      return;
    }

    showError('');
    fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          showError('');
          // Register project first, then offer worca setup
          onProjectAdd?.(data.project);
          offerWorcaSetup(name, rerender);
        } else {
          showError(data.error || 'Failed to add project');
        }
      })
      .catch((err) => {
        showError(err.message || 'Network error');
      });
  }

  function autoPopulateName(path) {
    if (nameManuallyEdited) return;
    const nameEl = document.getElementById('add-project-name');
    if (!nameEl) return;
    const segments = path.replace(/\/+$/, '').split('/');
    const lastSegment = segments[segments.length - 1] || '';
    const sanitized = lastSegment
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
    nameEl.value = sanitized;
  }

  function handlePathInput(e) {
    const path = e.target.value || '';
    if (dialogMode === 'single') {
      autoPopulateName(path);
    } else {
      triggerWorkspaceScan(path, state, rerender);
    }
  }

  function handleNameInput() {
    nameManuallyEdited = true;
  }

  async function handleBrowse() {
    try {
      const resp = await fetch('/api/choose-directory', { method: 'POST' });
      const data = await resp.json();
      if (data.ok && data.path) {
        const pathEl = document.getElementById('add-project-path');
        if (pathEl) pathEl.value = data.path;
        if (dialogMode === 'single') {
          autoPopulateName(data.path);
        } else {
          triggerWorkspaceScan(data.path, state, rerender);
        }
      }
    } catch {
      /* user cancelled or error */
    }
  }

  function handleModeChange(e) {
    dialogMode = e.target.value;
    scannedFolders = [];
    _selectedFolders = new Set();
    _resolvedNameMap = new Map();
    _scanning = false;
    _scanError = '';
    clearTimeout(_scanDebounceTimer);
    _scanDebounceTimer = null;
    if (scanAbortController) {
      scanAbortController.abort();
      scanAbortController = null;
    }
    rerender?.();
  }

  function handleDialogHide(e) {
    // Ignore hide events from elements disconnected during rerender
    if (!e.target.isConnected) return;
    dialogError = '';
    nameManuallyEdited = false;
    dialogMode = 'single';
    scannedFolders = [];
    _selectedFolders = new Set();
    _resolvedNameMap = new Map();
    _scanning = false;
    _scanError = '';
    clearTimeout(_scanDebounceTimer);
    _scanDebounceTimer = null;
    if (scanAbortController) {
      scanAbortController.abort();
      scanAbortController = null;
    }
    onClose?.();
  }

  function renderScanArea() {
    if (_scanning) {
      return html`
        <div id="workspace-scan-area" style="padding: 8px; display: flex; align-items: center; gap: 8px; margin-bottom: 16px;">
          <sl-spinner></sl-spinner>
          <span>Scanning…</span>
        </div>`;
    }
    if (_scanError) {
      return html`
        <div id="workspace-scan-area" style="margin-bottom: 16px;">
          <div style="color: var(--status-failed); font-size: 0.85rem;">${_scanError}</div>
        </div>`;
    }
    if (scannedFolders.length === 0) {
      return html`<div id="workspace-scan-area" style="margin-bottom: 16px;"></div>`;
    }

    const folders = scannedFolders.map((f, i) => ({
      ...f,
      index: i,
      isRegistered: !_resolvedNameMap.has(i),
    }));

    const selectableIndices = folders
      .filter((f) => !f.isRegistered)
      .map((f) => f.index);
    const registeredCount = folders.filter((f) => f.isRegistered).length;

    function selectAll(e) {
      e.preventDefault();
      for (const i of selectableIndices) _selectedFolders.add(i);
      rerender?.();
    }

    function selectNone(e) {
      e.preventDefault();
      for (const i of selectableIndices) _selectedFolders.delete(i);
      rerender?.();
    }

    function handleCheckChange(index, e) {
      if (e.target.checked) {
        _selectedFolders.add(index);
      } else {
        _selectedFolders.delete(index);
      }
      rerender?.();
    }

    return html`
      <div id="workspace-scan-area" style="margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 0.85rem;">
          <span>Found ${scannedFolders.length} git project${scannedFolders.length !== 1 ? 's' : ''}</span>
          <span>
            <a href="#" id="select-all-link" @click=${selectAll}>Select all</a>
            &nbsp;/&nbsp;
            <a href="#" id="select-none-link" @click=${selectNone}>Select none</a>
          </span>
        </div>
        <div style="max-height: 300px; overflow-y: auto; border: 1px solid var(--sl-color-neutral-200); border-radius: 4px; padding: 4px;">
          ${folders.map((f) => {
            if (f.isRegistered) {
              return html`
                <sl-checkbox disabled style="display: block;">
                  ${f.name}
                  <span style="color: var(--sl-color-neutral-500); font-size: 0.8em; margin-left: 4px;">(already registered)</span>
                </sl-checkbox>`;
            }
            const resolvedName = _resolvedNameMap.get(f.index);
            const sluggedName = slugify(f.name);
            const nameDisplay =
              resolvedName !== sluggedName
                ? html`${sluggedName} → ${resolvedName}`
                : sluggedName;
            return html`
              <sl-checkbox
                ?checked=${_selectedFolders.has(f.index)}
                style="display: block;"
                @sl-change=${(e) => handleCheckChange(f.index, e)}
              >
                ${nameDisplay}
              </sl-checkbox>`;
          })}
        </div>
        ${
          registeredCount > 0
            ? html`<div style="font-size: 0.8rem; color: var(--sl-color-neutral-500); margin-top: 4px;">
              ${registeredCount} project${registeredCount !== 1 ? 's' : ''} already registered (greyed)
            </div>`
            : nothing
        }
      </div>`;
  }

  const selectedCount = dialogMode === 'workspace' ? _selectedFolders.size : 0;
  const submitDisabled =
    dialogMode === 'workspace' && (_selectedFolders.size === 0 || _scanning);
  const submitLabel =
    dialogMode === 'workspace'
      ? `Add ${selectedCount} Project${selectedCount !== 1 ? 's' : ''}`
      : 'Add Project';

  return html`
    <sl-dialog
      label="Add Project"
      open
      @sl-after-hide=${handleDialogHide}
    >
      <form @submit=${handleSubmit}>
        <sl-radio-group
          value=${dialogMode}
          style="margin-bottom: 16px;"
          @sl-change=${handleModeChange}
        >
          <sl-radio value="single">Single project</sl-radio>
          <sl-radio value="workspace">Workspace</sl-radio>
        </sl-radio-group>
        <div class="settings-field" style="margin-bottom: 16px;">
          <label class="settings-label">Project Path</label>
          <div style="display:flex; gap:8px; align-items:stretch;">
            <sl-input
              id="add-project-path"
              placeholder="/path/to/project"
              required
              style="flex:1"
              @sl-input=${handlePathInput}
            ></sl-input>
            <sl-button size="medium" @click=${handleBrowse} title="Browse…" style="--sl-input-height-medium:100%">
              ${unsafeHTML(iconSvg(FolderOpen, 16))}
            </sl-button>
          </div>
        </div>
        ${
          dialogMode === 'single'
            ? html`
          <div class="settings-field" style="margin-bottom: 16px;">
            <label class="settings-label">Project Name</label>
            <sl-input
              id="add-project-name"
              placeholder="my-project"
              required
              pattern="[a-z0-9][a-z0-9_-]*"
              @sl-input=${handleNameInput}
            ></sl-input>
          </div>`
            : renderScanArea()
        }
        <div
          id="add-project-error"
          style="color: var(--status-failed); font-size: 0.85rem; margin-bottom: 12px; display: ${dialogError ? 'block' : 'none'};"
        >${dialogError}</div>
        <div slot="footer" style="display:flex; justify-content:center; gap:0.75rem; width:100%">
          <sl-button autofocus @click=${handleDialogHide}>Cancel</sl-button>
          <sl-button
            id="submit-btn"
            variant="primary"
            ?disabled=${submitDisabled}
            @click=${handleSubmit}
          >${submitLabel}</sl-button>
        </div>
      </form>
    </sl-dialog>
  `;
}

/**
 * After project is registered, check worca status and offer install/update.
 */
function offerWorcaSetup(projectName, rerender) {
  if (!rerender) return;

  fetch(`/api/projects/${projectName}/worca-status`)
    .then((r) => r.json())
    .then((data) => {
      if (!data.ok) return;

      const installed = data.installed;
      const label = installed ? 'Update Worca' : 'Install Worca';
      const message = installed
        ? `Update worca in "${projectName}" with the latest pipeline files?`
        : `Install worca pipeline in "${projectName}"?`;
      const confirmLabel = 'Yes';

      showConfirm(
        {
          label,
          message,
          confirmLabel,
          cancelLabel: 'No',
          confirmVariant: 'primary',
          onConfirm: () => {
            fetch(`/api/projects/${projectName}/worca-setup`, {
              method: 'POST',
            }).catch(() => {});
          },
        },
        rerender,
      );
    })
    .catch(() => {});
}

/**
 * After batch registration, fetch worca-status for all added projects and offer
 * install/update via a dialog with per-project checkboxes and inline progress.
 * Exported for testing; internal code calls it directly.
 */
export function offerBatchWorcaSetupForTest(projects, rerender) {
  return offerBatchWorcaSetup(projects, rerender);
}

function offerBatchWorcaSetup(projects, rerender) {
  if (!rerender || !projects || projects.length === 0) return;

  Promise.all(
    projects.map((p) =>
      fetch(`/api/projects/${p.name}/worca-status`)
        .then((r) => r.json())
        .catch(() => ({
          ok: false,
          installed: false,
          outdated: false,
          version: null,
        })),
    ),
  )
    .then((statuses) => {
      _batchSetupItems = projects.map((p, i) => {
        const s = statuses[i];
        let statusLabel;
        let checked;
        if (!s.ok || !s.installed) {
          statusLabel = 'not installed';
          checked = true;
        } else if (s.outdated) {
          statusLabel = `outdated — v${s.version}`;
          checked = true;
        } else {
          statusLabel = s.version ? `v${s.version} — current` : 'current';
          checked = false;
        }
        return { name: p.name, statusLabel, checked };
      });
      _batchSetupProgress = new Map();
      _batchSetupInstalling = false;
      _batchSetupOpen = true;
      rerender();
    })
    .catch(() => {});
}

/**
 * Renders the batch worca setup dialog with per-project checkboxes and inline progress.
 * Must be included in the app's render tree (e.g. main.js).
 */
export function batchWorcaSetupDialogTemplate(rerender) {
  if (!_batchSetupOpen) return nothing;

  function handleCheckChange(name, e) {
    const item = _batchSetupItems.find((it) => it.name === name);
    if (item) item.checked = e.target.checked;
    rerender?.();
  }

  function handleSkip() {
    _batchSetupOpen = false;
    _batchSetupItems = [];
    _batchSetupProgress = new Map();
    _batchSetupInstalling = false;
    rerender?.();
  }

  async function handleInstall() {
    const selected = _batchSetupItems.filter((it) => it.checked);
    if (selected.length === 0) return;
    _batchSetupInstalling = true;
    for (const item of selected) {
      _batchSetupProgress.set(item.name, { state: 'pending' });
    }
    rerender?.();
    for (const item of selected) {
      try {
        const r = await fetch(`/api/projects/${item.name}/worca-setup`, {
          method: 'POST',
        });
        if (r.ok) {
          _batchSetupProgress.set(item.name, { state: 'started' });
        } else {
          let errMsg = `HTTP ${r.status}`;
          try {
            const data = await r.json();
            if (data?.error) errMsg = data.error;
          } catch (_) {}
          _batchSetupProgress.set(item.name, {
            state: 'failed',
            error: errMsg,
          });
        }
      } catch (err) {
        _batchSetupProgress.set(item.name, {
          state: 'failed',
          error: err.message || 'Failed',
        });
      }
      rerender?.();
    }
    _batchSetupInstalling = false;
    rerender?.();
  }

  const checkedCount = _batchSetupItems.filter((it) => it.checked).length;
  const total = _batchSetupItems.length;

  return html`
    <sl-dialog id="batch-setup-dialog" label="Worca Setup" open @sl-after-hide=${handleSkip}>
      <p>${total} project${total !== 1 ? 's' : ''} added. Install worca?</p>
      ${_batchSetupItems.map((item) => {
        const progress = _batchSetupProgress.get(item.name);
        let progressEl = nothing;
        if (progress) {
          if (progress.state === 'pending') {
            progressEl = html`<sl-spinner style="font-size: 0.9rem;"></sl-spinner>`;
          } else if (progress.state === 'started') {
            progressEl = html`<span class="batch-setup-started">✓</span>`;
          } else if (progress.state === 'failed') {
            progressEl = html`<span class="batch-setup-failed">✗ ${progress.error}</span>`;
          }
        }
        return html`
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <sl-checkbox
              ?checked=${item.checked}
              ?disabled=${_batchSetupInstalling}
              @sl-change=${(e) => handleCheckChange(item.name, e)}
            >${item.name} (${item.statusLabel})</sl-checkbox>
            ${progressEl}
          </div>
        `;
      })}
      <div slot="footer" style="display:flex; justify-content:center; gap:0.75rem; width:100%">
        <sl-button id="batch-setup-skip-btn" @click=${handleSkip}>Skip</sl-button>
        <sl-button
          id="batch-setup-confirm-btn"
          variant="primary"
          ?disabled=${checkedCount === 0 || _batchSetupInstalling}
          @click=${handleInstall}
        >Install/Update ${checkedCount}</sl-button>
      </div>
    </sl-dialog>
  `;
}

/**
 * Converts a folder name into a valid project slug.
 * Lowercase, replace non-[a-z0-9_-] with dash, collapse consecutive dashes,
 * truncate to 64 chars.
 */
export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Resolves name collisions by appending -2, -3, etc.
 *
 * @param {string[]} scannedNames - Names derived from scanned folders (in order)
 * @param {string[]} existingNames - Names already registered as projects
 * @returns {string[]} Resolved names, one per scanned name
 */
export function resolveCollisions(scannedNames, existingNames) {
  const taken = new Set(existingNames);
  const resolved = [];
  for (const name of scannedNames) {
    if (!taken.has(name)) {
      taken.add(name);
      resolved.push(name);
    } else {
      let counter = 2;
      let suffix = `-${counter}`;
      let candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
      while (taken.has(candidate)) {
        counter += 1;
        suffix = `-${counter}`;
        candidate = `${name.slice(0, 64 - suffix.length)}${suffix}`;
      }
      taken.add(candidate);
      resolved.push(candidate);
    }
  }
  return resolved;
}

// Test-only accessors — single object to reduce export surface
export const _test = {
  get dialogError() {
    return dialogError;
  },
  set dialogError(v) {
    dialogError = v;
  },
  get dialogMode() {
    return dialogMode;
  },
  set dialogMode(v) {
    dialogMode = v;
  },
  get scannedFolders() {
    return scannedFolders;
  },
  set scannedFolders(v) {
    scannedFolders = v;
  },
  get selectedFolders() {
    return _selectedFolders;
  },
  set selectedFolders(v) {
    _selectedFolders = v;
  },
  get scanning() {
    return _scanning;
  },
  set scanning(v) {
    _scanning = v;
  },
  get scanError() {
    return _scanError;
  },
  set scanError(v) {
    _scanError = v;
  },
  get resolvedNameMap() {
    return _resolvedNameMap;
  },
  set resolvedNameMap(v) {
    _resolvedNameMap = v;
  },
  get batchSetupOpen() {
    return _batchSetupOpen;
  },
  set batchSetupOpen(v) {
    _batchSetupOpen = v;
  },
  get batchSetupItems() {
    return _batchSetupItems;
  },
  set batchSetupItems(v) {
    _batchSetupItems = v;
  },
  get batchSetupProgress() {
    return _batchSetupProgress;
  },
  get batchSetupInstalling() {
    return _batchSetupInstalling;
  },
  set batchSetupInstalling(v) {
    _batchSetupInstalling = v;
  },
};
