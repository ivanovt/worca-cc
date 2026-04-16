/**
 * Pure state functions for the dispatch tag input component.
 * These are extracted for testability and reuse in settings.js.
 */

// Keep in sync with _SUBAGENT_DENYLIST in src/worca/hooks/tracking.py —
// the backend is the authoritative enforcer; this set mirrors it so the
// UI can show the same types as blocked.
export const SUBAGENT_DENYLIST = new Set(['general-purpose']);

// Fallback used when `GET /api/subagents` is unavailable or hasn't returned
// yet. The server endpoint does the real directory walk (builtins + user +
// plugin cache + project-local) and returns an identically-shaped array;
// this list mirrors `BUILTINS` in worca-ui/server/subagents-discovery.js
// so the editor stays usable even if the discovery fetch fails.
export const KNOWN_TYPES = [
  { name: 'explore', label: '(built-in)', group: 'Built-in' },
  { name: 'general-purpose', label: '(built-in)', group: 'Built-in' },
  { name: 'Plan', label: '(built-in)', group: 'Built-in' },
];

/**
 * Add a tag to the current list.
 * @param {string[]} current - Current tag list
 * @param {string} newTag - Tag to add
 * @param {Set<string>|string[]} denylist - Blocked types
 * @returns {{ tags: string[], rejected: boolean, reason?: string }}
 */
export function addTag(current, newTag, denylist = SUBAGENT_DENYLIST) {
  const tag = newTag.trim();
  if (!tag) return { tags: current, rejected: false };
  const isDenied =
    denylist instanceof Set ? denylist.has(tag) : denylist.includes(tag);
  if (isDenied) {
    return {
      tags: current,
      rejected: true,
      reason: `${tag} is on the subagent denylist`,
    };
  }
  if (current.includes(tag)) return { tags: current, rejected: false };
  return { tags: [...current, tag], rejected: false };
}

/**
 * Remove a tag from the current list.
 * @param {string[]} current - Current tag list
 * @param {string} tag - Tag to remove
 * @returns {string[]}
 */
export function removeTag(current, tag) {
  return current.filter((t) => t !== tag);
}

/**
 * Filter known types for the suggestions popup.
 * @param {string} input - Current text input value
 * @param {{ name: string, label: string, group: string }[]} knownTypes - Known subagent types
 * @param {string[]} current - Currently added tags (excluded from results)
 * @param {Set<string>|string[]} denylist - Denied types (shown struck-through)
 * @returns {{ name: string, label: string, group: string, denied: boolean }[]}
 */
export function filterSuggestions(
  input,
  knownTypes,
  current,
  denylist = SUBAGENT_DENYLIST,
) {
  const query = input.trim().toLowerCase();
  return knownTypes
    .filter((t) => !current.includes(t.name))
    .filter((t) => !query || t.name.toLowerCase().startsWith(query))
    .map((t) => ({
      ...t,
      denied:
        denylist instanceof Set
          ? denylist.has(t.name)
          : denylist.includes(t.name),
    }));
}

/**
 * Returns true if current tags differ from the agent's defaults.
 * @param {string[]} current - Current tags for an agent
 * @param {string[]} defaults - Default tags for that agent
 * @returns {boolean}
 */
export function isCustomized(current, defaults) {
  if (current.length !== defaults.length) return true;
  const sortedCurrent = [...current].sort();
  const sortedDefaults = [...defaults].sort();
  return sortedCurrent.some((v, i) => v !== sortedDefaults[i]);
}
