/**
 * Shipped recommended minimum effort floors per agent.
 *
 * UI-only advisory data — never read at runtime, never persisted to a template.
 * The template editor consults this map purely to render a warning indicator
 * when the user's chosen per-agent `effort` falls below the shipped floor for
 * that agent. There is no editable surface and no `min_effort` field on the
 * template config.
 *
 * The pipeline runtime (`src/worca/orchestrator/effort.py`) does NOT consult
 * this map. Users may freely save templates whose effort is below the floor;
 * the editor only warns.
 *
 * Rationale per agent:
 *   - planner / plan_reviewer / reviewer / workspace_planner — heavy reasoning
 *     roles (plan quality compounds; review quality drives the loop count;
 *     cross-project planning is judgment-heavy). Floor: high.
 *   - coordinator / guardian — important judgment but tighter scope
 *     (classification calls; irreversible PR/git work). Floor: medium.
 *   - implementer / tester / learner — mechanical or adaptive-driven; the
 *     bead label / verification semantics carry the load. Floor: low.
 */
export const RECOMMENDED_MIN_EFFORT = Object.freeze({
  planner: 'high',
  plan_reviewer: 'high',
  coordinator: 'medium',
  implementer: 'low',
  tester: 'low',
  reviewer: 'high',
  guardian: 'medium',
  learner: 'low',
  workspace_planner: 'high',
});

/**
 * Order-comparison helper for effort levels. Mirrors the canonical 5-rung
 * ladder from `worca.orchestrator.effort.EFFORT_LEVELS`.
 *
 * Returns true when `level` is strictly below `floor`. Any unknown/falsy
 * input returns false (no false-positive warnings).
 */
const _CANONICAL = ['low', 'medium', 'high', 'xhigh', 'max'];

export function effortBelowFloor(level, floor) {
  if (!level || !floor) return false;
  const li = _CANONICAL.indexOf(level);
  const fi = _CANONICAL.indexOf(floor);
  if (li < 0 || fi < 0) return false;
  return li < fi;
}
