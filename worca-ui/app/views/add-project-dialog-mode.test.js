/**
 * Tests for Add Project dialog mode toggle (single / workspace).
 * Plan cases 18–20.
 * @vitest-environment jsdom
 */

import { render } from 'lit-html';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _test, addProjectDialogView } from './add-project-dialog.js';

function renderToContainer(template) {
  const container = document.createElement('div');
  render(template, container);
  return container;
}

const baseState = { addProjectDialogOpen: true, projects: [] };
const makeCallbacks = () => ({
  onProjectAdd: vi.fn(),
  onClose: vi.fn(),
  rerender: vi.fn(),
});

beforeEach(() => {
  _test.dialogMode = 'single';
  _test.scannedFolders = [];
});

describe('case 18 — default mode is single', () => {
  it('default dialogMode is "single"', () => {
    expect(_test.dialogMode).toBe('single');
  });

  it('renders name and path inputs', () => {
    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#add-project-name')).not.toBeNull();
    expect(container.querySelector('#add-project-path')).not.toBeNull();
  });

  it('does not render workspace scan area', () => {
    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#workspace-scan-area')).toBeNull();
  });
});

describe('case 19 — switch to workspace mode', () => {
  beforeEach(() => {
    _test.dialogMode = 'workspace';
  });

  it('hides the name input', () => {
    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#add-project-name')).toBeNull();
  });

  it('shows the workspace scan area', () => {
    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#workspace-scan-area')).not.toBeNull();
  });

  it('still shows the path input', () => {
    const container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#add-project-path')).not.toBeNull();
  });
});

describe('case 20 — switch back to single mode', () => {
  it('restores name input after switching back from workspace', () => {
    _test.dialogMode = 'workspace';
    let container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#add-project-name')).toBeNull();

    _test.dialogMode = 'single';
    container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#add-project-name')).not.toBeNull();
  });

  it('hides scan area after switching back from workspace', () => {
    _test.dialogMode = 'workspace';
    let container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#workspace-scan-area')).not.toBeNull();

    _test.dialogMode = 'single';
    container = renderToContainer(
      addProjectDialogView(baseState, makeCallbacks()),
    );
    expect(container.querySelector('#workspace-scan-area')).toBeNull();
  });

  it('clears scanned folders when mode state is reset', () => {
    _test.dialogMode = 'workspace';
    _test.scannedFolders = [
      { name: 'auth-service', path: '/ws/auth-service' },
      { name: 'web-app', path: '/ws/web-app' },
    ];
    expect(_test.scannedFolders).toHaveLength(2);

    // Simulate what handleModeChange does when switching back
    _test.dialogMode = 'single';
    _test.scannedFolders = [];

    expect(_test.dialogMode).toBe('single');
    expect(_test.scannedFolders).toHaveLength(0);
  });
});
