import { GLOBAL_ONLY_KEYS } from './keys-schema.js';

const INERT_MILESTONE_KEYS = ['pr_approval', 'deploy_approval'];

/**
 * Mutates `blob` in place: extracts misplaced global-only keys and strips
 * inert milestone keys (pr_approval/deploy_approval when set to `true`).
 *
 * Returns { globalExtracted, removedMilestones } for the caller to merge
 * into ~/.worca/settings.json and to surface in the response.
 */
export function extractAndStripGlobalKeys(blob) {
  const globalExtracted = {};
  const removedMilestones = [];

  const worca = blob.worca;
  if (!worca || typeof worca !== 'object') {
    return { globalExtracted, removedMilestones };
  }

  for (const [section, key] of GLOBAL_ONLY_KEYS) {
    const sectionObj = worca[section];
    if (!sectionObj || typeof sectionObj !== 'object') continue;
    if (!(key in sectionObj)) continue;

    if (!globalExtracted[section]) globalExtracted[section] = {};
    globalExtracted[section][key] = sectionObj[key];
    delete sectionObj[key];

    if (Object.keys(sectionObj).length === 0) {
      delete worca[section];
    }
  }

  const milestones = worca.milestones;
  if (milestones && typeof milestones === 'object') {
    for (const key of INERT_MILESTONE_KEYS) {
      if (milestones[key] === true) {
        delete milestones[key];
        removedMilestones.push(key);
      }
    }
    if (Object.keys(milestones).length === 0) {
      delete worca.milestones;
    }
  }

  return { globalExtracted, removedMilestones };
}
