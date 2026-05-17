/**
 * Tests for the header Start button integration contract.
 *
 * main.js contentHeaderView uses getNewRunSubmitState() and getEffectiveProjectId()
 * together to decide:
 *   - btnDisabled = nrs.isSubmitting || capReached || nrs.noProject
 *   - btnTitle = nrs.noProject ? 'Select a project to launch.' : ''
 *   - onClick → submitNewRun({ projectId: getEffectiveProjectId(state), hasProjects })
 *
 * These tests verify the two functions stay consistent: when noProject is true,
 * effectiveProjectId must be null (button disabled prevents submitting a null id),
 * and when effectiveProjectId is non-null, noProject must be false.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('lit-html', () => ({
  html: () => null,
  nothing: null,
}));
vi.mock('lit-html/directives/unsafe-html.js', () => ({
  unsafeHTML: () => null,
}));
vi.mock('../utils/icons.js', () => ({
  iconSvg: () => '',
  FileText: 'FileText',
  Circle: 'Circle',
  CircleAlert: 'CircleAlert',
  CircleCheck: 'CircleCheck',
  CircleSlash: 'CircleSlash',
  Loader: 'Loader',
  Pause: 'Pause',
}));

describe('header Start button contract — getNewRunSubmitState + getEffectiveProjectId consistency', () => {
  let getNewRunSubmitState, getEffectiveProjectId, resetNewRunState;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('lit-html', () => ({ html: () => null, nothing: null }));
    vi.doMock('lit-html/directives/unsafe-html.js', () => ({
      unsafeHTML: () => null,
    }));
    vi.doMock('../utils/icons.js', () => ({
      iconSvg: () => '',
      FileText: 'FileText',
      Circle: 'Circle',
      CircleAlert: 'CircleAlert',
      CircleCheck: 'CircleCheck',
      CircleSlash: 'CircleSlash',
      Loader: 'Loader',
      Pause: 'Pause',
    }));

    const mod = await import('./new-run.js');
    getNewRunSubmitState = mod.getNewRunSubmitState;
    getEffectiveProjectId = mod.getEffectiveProjectId;
    resetNewRunState = mod.resetNewRunState;
  });

  it('All Projects mode, no selection: noProject=true, effectiveProjectId=null', () => {
    resetNewRunState();
    const appState = {
      hasProjects: true,
      currentProjectId: null,
      projects: [{ name: 'proj-a' }],
    };
    const nrs = getNewRunSubmitState(appState);
    const pid = getEffectiveProjectId(appState);
    expect(nrs.noProject).toBe(true);
    expect(pid).toBeNull();
  });

  it('All Projects mode, user picked a project: noProject=false, effectiveProjectId=selected', () => {
    resetNewRunState({ selectedProject: 'proj-a' });
    const appState = {
      hasProjects: true,
      currentProjectId: null,
      projects: [{ name: 'proj-a' }],
    };
    const nrs = getNewRunSubmitState(appState);
    const pid = getEffectiveProjectId(appState);
    expect(nrs.noProject).toBe(false);
    expect(pid).toBe('proj-a');
  });

  it('scoped project mode: noProject=false, effectiveProjectId=currentProjectId', () => {
    resetNewRunState();
    const appState = {
      hasProjects: true,
      currentProjectId: 'proj-b',
      projects: [{ name: 'proj-a' }, { name: 'proj-b' }],
    };
    const nrs = getNewRunSubmitState(appState);
    const pid = getEffectiveProjectId(appState);
    expect(nrs.noProject).toBe(false);
    expect(pid).toBe('proj-b');
  });

  it('single-project mode (no projects list): noProject=false, effectiveProjectId=null (uses /api/runs)', () => {
    resetNewRunState();
    const appState = {
      hasProjects: false,
      currentProjectId: null,
      projects: [],
    };
    const nrs = getNewRunSubmitState(appState);
    const pid = getEffectiveProjectId(appState);
    expect(nrs.noProject).toBe(false);
    expect(pid).toBeNull();
  });

  it('after Change link (projectEditable=true), effectiveProjectId uses selectedProject', () => {
    resetNewRunState({ projectEditable: true, selectedProject: 'proj-c' });
    const appState = {
      hasProjects: true,
      currentProjectId: 'proj-a',
      projects: [{ name: 'proj-a' }, { name: 'proj-c' }],
    };
    const nrs = getNewRunSubmitState(appState);
    const pid = getEffectiveProjectId(appState);
    expect(nrs.noProject).toBe(false);
    expect(pid).toBe('proj-c');
  });

  it('after Change link but nothing selected yet: noProject=true, effectiveProjectId=null', () => {
    resetNewRunState({ projectEditable: true });
    const appState = {
      hasProjects: true,
      currentProjectId: 'proj-a',
      projects: [{ name: 'proj-a' }],
    };
    const nrs = getNewRunSubmitState(appState);
    const pid = getEffectiveProjectId(appState);
    expect(nrs.noProject).toBe(true);
    expect(pid).toBeNull();
  });
});

describe('header Start button — disabled state derivation', () => {
  let getNewRunSubmitState, isAtCapacity, resetNewRunState;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('lit-html', () => ({ html: () => null, nothing: null }));
    vi.doMock('lit-html/directives/unsafe-html.js', () => ({
      unsafeHTML: () => null,
    }));
    vi.doMock('../utils/icons.js', () => ({
      iconSvg: () => '',
      FileText: 'FileText',
      Circle: 'Circle',
      CircleAlert: 'CircleAlert',
      CircleCheck: 'CircleCheck',
      CircleSlash: 'CircleSlash',
      Loader: 'Loader',
      Pause: 'Pause',
    }));

    const mod = await import('./new-run.js');
    getNewRunSubmitState = mod.getNewRunSubmitState;
    isAtCapacity = mod.isAtCapacity;
    resetNewRunState = mod.resetNewRunState;
  });

  function headerBtnDisabled(state) {
    const hasProjects = (state.projects?.length ?? 0) > 0;
    const nrs = getNewRunSubmitState({
      hasProjects,
      currentProjectId: state.currentProjectId,
    });
    const capReached = isAtCapacity(state);
    return nrs.isSubmitting || capReached || nrs.noProject;
  }

  function headerBtnTitle(state) {
    const hasProjects = (state.projects?.length ?? 0) > 0;
    const nrs = getNewRunSubmitState({
      hasProjects,
      currentProjectId: state.currentProjectId,
    });
    return nrs.noProject ? 'Select a project to launch.' : '';
  }

  it('disabled when All Projects and no project selected', () => {
    resetNewRunState();
    const state = {
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
      totalRunning: 0,
      maxConcurrentPipelines: 10,
    };
    expect(headerBtnDisabled(state)).toBe(true);
    expect(headerBtnTitle(state)).toBe('Select a project to launch.');
  });

  it('enabled when project selected in All Projects mode', () => {
    resetNewRunState({ selectedProject: 'proj-a' });
    const state = {
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
      totalRunning: 0,
      maxConcurrentPipelines: 10,
    };
    expect(headerBtnDisabled(state)).toBe(false);
    expect(headerBtnTitle(state)).toBe('');
  });

  it('enabled when scoped to a specific project', () => {
    resetNewRunState();
    const state = {
      projects: [{ name: 'proj-a' }],
      currentProjectId: 'proj-a',
      totalRunning: 0,
      maxConcurrentPipelines: 10,
    };
    expect(headerBtnDisabled(state)).toBe(false);
    expect(headerBtnTitle(state)).toBe('');
  });

  it('enabled in single-project mode (no projects list)', () => {
    resetNewRunState();
    const state = {
      projects: [],
      currentProjectId: null,
      totalRunning: 0,
      maxConcurrentPipelines: 10,
    };
    expect(headerBtnDisabled(state)).toBe(false);
    expect(headerBtnTitle(state)).toBe('');
  });

  it('disabled when at capacity even with project selected', () => {
    resetNewRunState({ selectedProject: 'proj-a' });
    const state = {
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
      totalRunning: 5,
      maxConcurrentPipelines: 5,
    };
    expect(headerBtnDisabled(state)).toBe(true);
  });

  it('disabled when at capacity AND no project (both reasons)', () => {
    resetNewRunState();
    const state = {
      projects: [{ name: 'proj-a' }],
      currentProjectId: null,
      totalRunning: 5,
      maxConcurrentPipelines: 5,
    };
    expect(headerBtnDisabled(state)).toBe(true);
    expect(headerBtnTitle(state)).toBe('Select a project to launch.');
  });
});
