/**
 * Tests for the project-info fetch logic in main.js.
 *
 * main.js fetches /api/project-info at startup and on WS reconnect,
 * stores the name in state.projectName, and updates document.title.
 *
 * We test the pure logic (title formatting, store contract) without DOM.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createStore } from './state.js';
import { formatTitle } from './utils/title.js';

describe('project-info fetch: store and title contract', () => {
  let store;

  beforeEach(() => {
    store = createStore();
  });

  it('stores projectName from API response', () => {
    const apiResponse = { name: 'my-app' };
    store.setState({ projectName: apiResponse.name });
    expect(store.getState().projectName).toBe('my-app');
  });

  it('formats title with project name', () => {
    expect(formatTitle('my-app')).toBe('my-app — worca');
  });

  it('formats title as "worca" when project name is empty', () => {
    expect(formatTitle('')).toBe('worca');
  });

  it('formats title as "worca" when project name is undefined', () => {
    expect(formatTitle(undefined)).toBe('worca');
  });

  it('subscriber sees projectName during rerender', () => {
    const captured = [];
    store.subscribe((state) => {
      captured.push(state.projectName);
    });
    store.setState({ projectName: 'cool-project' });
    expect(captured).toEqual(['cool-project']);
  });
});
