/**
 * Lazy resolvers for ~/.worca/ subdirectories.
 *
 * Mirror of src/worca/utils/paths.py — every helper re-reads the
 * environment on each call so $WORCA_HOME is honored consistently by
 * both halves of the system. See issue #162.
 *
 * Resolution order for every subdir helper:
 *   1. `override` arg (e.g. a constant set by the caller / tests)
 *   2. $WORCA_HOME/<subdir>
 *   3. ~/.worca/<subdir>
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @returns {string} The worca state directory.  Honors $WORCA_HOME, else ~/.worca.
 */
export function worcaHome() {
  const override = process.env.WORCA_HOME;
  if (override) return override;
  return join(homedir(), '.worca');
}

/**
 * @param {string=} override Caller-supplied path that wins over $WORCA_HOME.
 * @returns {string} Absolute path to the fleet-runs directory.
 */
export function fleetRunsDir(override) {
  if (override) return override;
  return join(worcaHome(), 'fleet-runs');
}

/**
 * @param {string=} override
 * @returns {string} Absolute path to the workspace-runs directory.
 */
export function workspaceRunsDir(override) {
  if (override) return override;
  return join(worcaHome(), 'workspace-runs');
}

/**
 * @param {string=} override
 * @returns {string} Absolute path to the workspaces.d directory.
 */
export function workspacesDir(override) {
  if (override) return override;
  return join(worcaHome(), 'workspaces.d');
}

/**
 * @param {string=} override
 * @returns {string} Absolute path to the preferences/prefs root (= worca home).
 */
export function prefsDir(override) {
  if (override) return override;
  return worcaHome();
}

/**
 * @param {string=} override
 * @returns {string} Absolute path to the user templates directory.
 */
export function templatesDir(override) {
  if (override) return override;
  return join(worcaHome(), 'templates');
}

/**
 * @param {string=} override
 * @returns {string} Absolute path to preferences.json.
 */
export function preferencesPath(override) {
  if (override) return override;
  return join(worcaHome(), 'preferences.json');
}
