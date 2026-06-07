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

// Cross-tier merge atomic paths. Entries at these paths replace wholesale
// when the project tier defines them — they do NOT deep-merge across
// user-global ↔ project. Within-tier id+env still merges (the settings.json /
// settings.local.json sibling pair is one logical tier). Mirrors the Python
// _ATOMIC_LEAF_PATHS list in src/worca/utils/settings.py.
const ATOMIC_LEAF_PATHS = [
  ['worca', 'models'],
  ['worca', 'pricing', 'models'],
];

function replaceAtomicSubkeys(merged, override, path) {
  let nodeMerged = merged;
  let nodeOverride = override;
  for (const segment of path) {
    if (
      !nodeMerged ||
      typeof nodeMerged !== 'object' ||
      Array.isArray(nodeMerged) ||
      !(segment in nodeMerged)
    )
      return;
    if (
      !nodeOverride ||
      typeof nodeOverride !== 'object' ||
      Array.isArray(nodeOverride) ||
      !(segment in nodeOverride)
    )
      return;
    nodeMerged = nodeMerged[segment];
    nodeOverride = nodeOverride[segment];
  }
  if (
    !nodeMerged ||
    typeof nodeMerged !== 'object' ||
    Array.isArray(nodeMerged) ||
    !nodeOverride ||
    typeof nodeOverride !== 'object' ||
    Array.isArray(nodeOverride)
  )
    return;
  for (const [key, value] of Object.entries(nodeOverride)) {
    nodeMerged[key] = value;
  }
}

/**
 * Read the full effective settings stack the way the Python runtime resolves
 * it: user-global base → user-global .local → project base → project .local.
 * Each layer deep-merges over the previous, EXCEPT entries under
 * worca.models.* and worca.pricing.models.* which replace wholesale across
 * tiers (project shadows user shadows builtin per alias). Missing files are
 * treated as empty objects.
 *
 * `globalSettingsPath` is passed in so callers can substitute it during
 * tests; production callers thread the result of `paths.globalSettingsPath()`.
 */
export function readEffectiveSettings(projectSettingsPath, globalSettingsPath) {
  const userLayers = [];
  const projectLayers = [];
  if (globalSettingsPath) {
    try {
      userLayers.push(JSON.parse(readFileSync(globalSettingsPath, 'utf8')));
    } catch {
      /* missing or invalid — treat as empty */
    }
    const globalLocal = localPathFor(globalSettingsPath);
    if (existsSync(globalLocal)) {
      try {
        userLayers.push(JSON.parse(readFileSync(globalLocal, 'utf8')));
      } catch {
        /* invalid — skip */
      }
    }
  }
  if (projectSettingsPath) {
    try {
      projectLayers.push(JSON.parse(readFileSync(projectSettingsPath, 'utf8')));
    } catch {
      /* missing or invalid — treat as empty */
    }
    const projectLocal = localPathFor(projectSettingsPath);
    if (existsSync(projectLocal)) {
      try {
        projectLayers.push(JSON.parse(readFileSync(projectLocal, 'utf8')));
      } catch {
        /* invalid — skip */
      }
    }
  }
  const userMerged = userLayers.reduce(
    (acc, layer) => deepMerge(acc, layer),
    {},
  );
  const projectMerged = projectLayers.reduce(
    (acc, layer) => deepMerge(acc, layer),
    {},
  );
  const merged = deepMerge(userMerged, projectMerged);
  for (const path of ATOMIC_LEAF_PATHS) {
    replaceAtomicSubkeys(merged, projectMerged, path);
  }
  return merged;
}
