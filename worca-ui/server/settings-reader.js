import { readFileSync } from 'node:fs';
import { atomicWriteSync } from './atomic-write.js';
import { GLOBAL_DEFAULTS } from './keys-schema.js';
import { deepMerge, readMergedSettings } from './settings-merge.js';

export function readSettings(path) {
  try {
    const raw = readMergedSettings(path);
    const worca = raw.worca || {};
    return {
      agents: worca.agents || {},
      loops: worca.loops || {},
      milestones: worca.milestones || {},
      stageUi: worca.ui?.stages || {},
      learnEnabled: worca.stages?.learn?.enabled || false,
    };
  } catch {
    return {
      agents: {},
      loops: {},
      milestones: {},
      stageUi: {},
      learnEnabled: false,
    };
  }
}

export function readGlobalSettings(globalSettingsPath) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(globalSettingsPath, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // First-run: file doesn't exist yet — return defaults
    } else if (err instanceof SyntaxError) {
      console.error(
        `Invalid JSON in ${globalSettingsPath}: ${err.message}; falling back to defaults`,
      );
    } else {
      throw err;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  raw.worca = deepMerge(GLOBAL_DEFAULTS, raw.worca || {});
  return raw;
}

export function writeGlobalSettings(globalSettingsPath, partial) {
  const existing = readGlobalSettings(globalSettingsPath);
  const merged = deepMerge(existing, partial);
  atomicWriteSync(globalSettingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}
