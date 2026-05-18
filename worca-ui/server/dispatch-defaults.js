/**
 * Dispatch governance defaults — JS mirror of Python _DISPATCH_DEFAULTS
 * in src/worca/hooks/tracking.py.
 *
 * Single source of truth for the JS side; used by dispatch-migration.js
 * and the settings editor.
 */

export const DISPATCH_DEFAULTS = {
  tools: {
    always_disallowed: ['EnterPlanMode', 'EnterWorktree', 'TodoWrite'],
    default_denied: [],
    per_agent_allow: { _defaults: ['*'] },
  },
  skills: {
    always_disallowed: [
      'loop',
      'schedule',
      'worca-*',
      'update-config',
      'hookify:hookify',
      'hookify:configure',
      'hookify:list',
      'hookify:writing-rules',
      'init',
    ],
    default_denied: [
      'review',
      'security-review',
      'feature-dev:feature-dev',
      'claude-md-management:revise-claude-md',
      'claude-md-management:claude-md-improver',
    ],
    per_agent_allow: { _defaults: ['*'] },
  },
  subagents: {
    always_disallowed: ['general-purpose'],
    default_denied: [],
    per_agent_allow: { _defaults: ['Explore'] },
  },
};

/**
 * Check if candidate matches any pattern in the list.
 *
 * Supported: exact match, trailing-* prefix glob, bare '*' (matches all).
 * JS port of Python _matches_any() in src/worca/hooks/tracking.py (§11).
 *
 * @param {string} candidate
 * @param {string[]} patterns
 * @returns {boolean}
 */
export function matchesAny(candidate, patterns) {
  for (const pattern of patterns) {
    if (pattern === candidate) return true;
    if (pattern === '*') return true;
    if (
      pattern.endsWith('*') &&
      pattern.length > 1 &&
      candidate.startsWith(pattern.slice(0, -1))
    ) {
      return true;
    }
  }
  return false;
}
