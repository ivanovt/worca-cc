/**
 * Canonical pipeline stage order — single source of truth for the UI.
 * Mirrors stages.py STAGE_ORDER on the Python side.
 */
export const STAGE_ORDER = [
  'preflight',
  'plan',
  'plan_review',
  'coordinate',
  'implement',
  'test',
  'review',
  'pr',
  'learn',
];

/** Stage order with orchestrator prepended (for log display). */
export const STAGE_ORDER_WITH_ORCHESTRATOR = ['orchestrator', ...STAGE_ORDER];

/**
 * Sort stage entries by canonical order. Unknown stages sort to the end.
 */
export function sortByStageOrder(entries) {
  return [...entries].sort(([a], [b]) => {
    const ai = STAGE_ORDER.indexOf(a);
    const bi = STAGE_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

/**
 * Sort stage name strings by canonical order. Unknown stages sort to the end.
 */
export function sortStageNames(names) {
  return [...names].sort((a, b) => {
    const ai = STAGE_ORDER.indexOf(a);
    const bi = STAGE_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}
