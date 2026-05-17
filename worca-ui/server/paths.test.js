import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  fleetRunsDir,
  preferencesPath,
  prefsDir,
  templatesDir,
  worcaHome,
  workspaceRunsDir,
  workspacesDir,
} from './paths.js';

describe('worca-ui server paths helper', () => {
  let originalHome;

  beforeEach(() => {
    originalHome = process.env.WORCA_HOME;
    delete process.env.WORCA_HOME;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.WORCA_HOME;
    } else {
      process.env.WORCA_HOME = originalHome;
    }
  });

  describe('worcaHome()', () => {
    it('falls back to ~/.worca when WORCA_HOME is unset', () => {
      expect(worcaHome()).toBe(join(homedir(), '.worca'));
    });

    it('honors WORCA_HOME when set', () => {
      process.env.WORCA_HOME = '/tmp/custom-worca';
      expect(worcaHome()).toBe('/tmp/custom-worca');
    });

    it('is resolved lazily — env set after import takes effect', () => {
      expect(worcaHome()).toBe(join(homedir(), '.worca'));
      process.env.WORCA_HOME = '/tmp/late-binding';
      expect(worcaHome()).toBe('/tmp/late-binding');
    });
  });

  describe('subdir helpers honor WORCA_HOME', () => {
    beforeEach(() => {
      process.env.WORCA_HOME = '/tmp/wh';
    });

    it('fleetRunsDir()', () => {
      expect(fleetRunsDir()).toBe('/tmp/wh/fleet-runs');
    });

    it('workspaceRunsDir()', () => {
      expect(workspaceRunsDir()).toBe('/tmp/wh/workspace-runs');
    });

    it('workspacesDir()', () => {
      expect(workspacesDir()).toBe('/tmp/wh/workspaces.d');
    });

    it('templatesDir()', () => {
      expect(templatesDir()).toBe('/tmp/wh/templates');
    });

    it('prefsDir()', () => {
      expect(prefsDir()).toBe('/tmp/wh');
    });

    it('preferencesPath()', () => {
      expect(preferencesPath()).toBe('/tmp/wh/preferences.json');
    });
  });

  describe('explicit override beats WORCA_HOME', () => {
    beforeEach(() => {
      process.env.WORCA_HOME = '/tmp/wh';
    });

    it('fleetRunsDir(override) returns override unchanged', () => {
      expect(fleetRunsDir('/explicit/path')).toBe('/explicit/path');
    });

    it('workspaceRunsDir(override) returns override unchanged', () => {
      expect(workspaceRunsDir('/explicit/ws')).toBe('/explicit/ws');
    });
  });
});
