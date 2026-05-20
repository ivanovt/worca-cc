/**
 * Single source of truth for the pipeline agent roster.
 *
 * Kept in its own module (no JSON imports, no DOM deps) so the
 * tests/test_denylist_sync.py harness can `import {AGENT_NAMES}` via plain
 * `node --input-type=module` without pulling in the rest of settings.js.
 *
 * Must stay aligned with STAGE_AGENT_MAP in src/worca/orchestrator/stages.py
 * plus the workspace_planner role; the alignment is enforced by
 * tests/test_denylist_sync.py::test_agent_roster_match.
 */
export const AGENT_NAMES = [
  'planner',
  'plan_reviewer',
  'coordinator',
  'implementer',
  'tester',
  'reviewer',
  'guardian',
  'learner',
  'workspace_planner',
];
