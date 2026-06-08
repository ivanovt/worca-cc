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
      'batch',
      'fewer-permission-prompts',
      'loop',
      'schedule',
      // worca-* dev skills that genuinely must stay off-limits to pipeline
      // agents: release/publish, PR merges, cross-repo sync, installation,
      // agent/governance override (privilege escalation), pipeline launch
      // (recursion), and autonomous issue/plan creation. The rest of the
      // worca-* dev tooling (precommit, coverage, ui/event scaffolding,
      // webhook-test, issue read) is allowed via the per-agent '*' wildcard.
      'worca-release',
      'worca-rc',
      'worca-pr-prep',
      'worca-install',
      'worca-sync',
      'worca-sync-commit',
      'worca-sync-pr',
      'worca-agent-override',
      'worca-analyze',
      'worca-plan-new',
      'update-config',
      'hookify:hookify',
      'hookify:configure',
      'hookify:list',
      'hookify:writing-rules',
      'init',
    ],
    default_denied: [
      'claude-api',
      'debug',
      'review',
      'security-review',
      'simplify',
      'feature-dev:feature-dev',
      'claude-md-management:revise-claude-md',
      'claude-md-management:claude-md-improver',
    ],
    per_agent_allow: {
      _defaults: ['*'],
      implementer: ['*', 'simplify', 'claude-api'],
      tester: ['*', 'debug'],
      reviewer: ['*', 'review', 'security-review'],
      learner: [
        '*',
        'claude-md-management:revise-claude-md',
        'claude-md-management:claude-md-improver',
      ],
    },
  },
  subagents: {
    // No subagents are denied by default. general-purpose (a full-tool Claude
    // session) is now allowed under the '*' wildcard like any other subagent;
    // a project can still deny specific subagents via always_disallowed /
    // default_denied. Mirror of _DISPATCH_DEFAULTS in tracking.py.
    always_disallowed: [],
    default_denied: [],
    per_agent_allow: { _defaults: ['*'] },
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
