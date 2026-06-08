// Shared settings loader with .local.json deep-merge support.
//
// All worca-ui server code should use readMergedSettings() for reads and
// write UI changes to settings.local.json via readLocalSettings/localPathFor.

import { existsSync, readFileSync } from 'node:fs';
import { extname } from 'node:path';

/**
 * Recursively merge override into base, returning a new object.
 * Dicts are merged recursively; lists and scalars from override replace entirely.
 * Neither input is mutated.
 */
export function deepMerge(base, override) {
  if (!base || typeof base !== 'object' || Array.isArray(base)) return override;
  if (!override || typeof override !== 'object' || Array.isArray(override))
    return override;

  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      key in result &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key]) &&
      typeof override[key] === 'object' &&
      !Array.isArray(override[key])
    ) {
      result[key] = deepMerge(result[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

/**
 * Derive the .local.json sibling path from a base settings path.
 * e.g. "settings.json" → "settings.local.json"
 */
export function localPathFor(settingsPath) {
  const ext = extname(settingsPath);
  const base = settingsPath.slice(0, -ext.length);
  return `${base}.local${ext}`;
}

/**
 * Read base settings + .local.json sibling, deep-merge, and return the result.
 * If local file is missing or invalid, returns base as-is.
 */
export function readMergedSettings(settingsPath) {
  let base;
  try {
    base = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }

  const localPath = localPathFor(settingsPath);
  if (!existsSync(localPath)) return base;

  try {
    const local = JSON.parse(readFileSync(localPath, 'utf8'));
    return deepMerge(base, local);
  } catch {
    console.warn(
      `[settings] Warning: ${localPath} contains invalid JSON, ignoring local overrides`,
    );
    return base;
  }
}

/**
 * Read just the .local.json sibling (for write-back / reset operations).
 * Returns {} if the file doesn't exist or has invalid JSON.
 */
export function readLocalSettings(settingsPath) {
  const localPath = localPathFor(settingsPath);
  try {
    return JSON.parse(readFileSync(localPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Read the full effective settings stack the way the Python runtime resolves
 * it: user-global base → user-global .local → project base → project .local.
 * Each layer deep-merges over the previous. Missing files are treated as
 * empty objects. Used by UI surfaces (model alias dropdowns, etc.) that must
 * mirror what `worca.utils.settings.resolve_model` sees at run time.
 *
 * `globalSettingsPath` is passed in so callers can substitute it during
 * tests; production callers thread the result of `paths.globalSettingsPath()`.
 */
export function readEffectiveSettings(projectSettingsPath, globalSettingsPath) {
  const layers = [];
  if (globalSettingsPath) {
    try {
      layers.push(JSON.parse(readFileSync(globalSettingsPath, 'utf8')));
    } catch {
      /* missing or invalid — treat as empty */
    }
    const globalLocal = localPathFor(globalSettingsPath);
    if (existsSync(globalLocal)) {
      try {
        layers.push(JSON.parse(readFileSync(globalLocal, 'utf8')));
      } catch {
        /* invalid — skip */
      }
    }
  }
  if (projectSettingsPath) {
    try {
      layers.push(JSON.parse(readFileSync(projectSettingsPath, 'utf8')));
    } catch {
      /* missing or invalid — treat as empty */
    }
    const projectLocal = localPathFor(projectSettingsPath);
    if (existsSync(projectLocal)) {
      try {
        layers.push(JSON.parse(readFileSync(projectLocal, 'utf8')));
      } catch {
        /* invalid — skip */
      }
    }
  }
  return layers.reduce((acc, layer) => deepMerge(acc, layer), {});
}
