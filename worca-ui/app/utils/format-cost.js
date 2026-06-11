/**
 * Format a USD cost for card meta rows. Shared by run/fleet/workspace cards
 * and group headers — was duplicated per view (arch review 2026-06).
 *
 * @param {number|null|undefined} usd
 * @returns {string|null} "$0.0042" below a cent, "$1.23" otherwise, null for
 *   zero/absent cost (callers hide the meta item).
 */
export function formatCost(usd) {
  if (!usd) return null;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
