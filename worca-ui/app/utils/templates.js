/**
 * Utility functions for pipeline templates.
 *
 * Provides diff detection, built-in comparison, and template-related helpers.
 */

/**
 * Deep compare two objects and return list of differing keys.
 *
 * Returns an array of diff entries:
 * {
 *   path: string[],  // dot-notation path (e.g., ['stages', 'planner', 'enabled'])
 *   key: string,     // last key in path (e.g., 'enabled')
 *   currentValue: any,
 *   builtinValue: any,
 *   changed: boolean // true if values differ
 * }
 *
 * Handles nested objects, arrays, and primitive values.
 */
export function diffTemplateConfig(currentConfig, builtinConfig) {
  const diffs = [];

  function traverse(current, builtin, path = []) {
    // Handle null/undefined
    if (current === null || current === undefined) {
      current = {};
    }
    if (builtin === null || builtin === undefined) {
      builtin = {};
    }

    // Collect all keys from both objects (union)
    const allKeys = new Set([
      ...Object.keys(current || {}),
      ...Object.keys(builtin || {}),
    ]);

    for (const key of allKeys) {
      const curVal = current[key];
      const builtinVal = builtin[key];
      const childPath = [...path, key];

      // Both are objects - recurse
      if (
        typeof curVal === 'object' &&
        curVal !== null &&
        !Array.isArray(curVal) &&
        typeof builtinVal === 'object' &&
        builtinVal !== null &&
        !Array.isArray(builtinVal)
      ) {
        traverse(curVal, builtinVal, childPath);
      } else {
        // Compare values (including arrays)
        const isChanged = !deepEqual(curVal, builtinVal);
        diffs.push({
          path: childPath,
          key: childPath[childPath.length - 1] || key,
          dotPath: childPath.join('.'),
          currentValue: curVal,
          builtinValue: builtinVal,
          changed: isChanged,
        });
      }
    }
  }

  traverse(currentConfig, builtinConfig);
  return diffs;
}

/**
 * Test if two values are deeply equal.
 * Handles objects, arrays, and primitives.
 */
function deepEqual(a, b) {
  // Fast path for primitives
  if (a === b) return true;

  // Both null or undefined
  if (a == null && b == null) return true;

  // Different types
  if (typeof a !== typeof b) return false;

  // Both are objects (not arrays, not null)
  if (
    typeof a === 'object' &&
    a !== null &&
    !Array.isArray(a) &&
    typeof b === 'object' &&
    b !== null &&
    !Array.isArray(b)
  ) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);

    // Different number of keys
    if (aKeys.length !== bKeys.length) return false;

    // Check each key
    for (const key of aKeys) {
      if (!Object.hasOwn(b, key) || !deepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }

  // Both are arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // Non-equal primitives
  return false;
}

/**
 * Check if a template shadows a built-in template.
 *
 * Returns true if:
 * - The template's effectiveTier is project or user
 * - The template ID exists in the built-in tier
 * - The built-in tier is one of `template.shadows` or the resolved tier
 */
export function shadowsBuiltin(template) {
  if (!template) return false;

  // The API uses 'builtin' (matching Python's TemplateResolver). The
  // 'worca' string is the legacy alias for the same tier; we accept it
  // so older cached responses don't suddenly stop reporting shadows.
  const isBuiltinTier = (t) => t === 'builtin' || t === 'worca';

  if (template.shadows?.some(isBuiltinTier)) {
    return true;
  }
  if (isBuiltinTier(template.effectiveTier)) {
    return false; // This is the built-in itself.
  }
  // Project/user effectiveTier without an explicit shadow array still
  // implies a built-in is being overridden, because the API only emits
  // a project/user row when it found at least one match in any tier.
  return (
    template.effectiveTier === 'project' || template.effectiveTier === 'user'
  );
}

/**
 * Format a diff value for display.
 * Handles objects, arrays, and primitives with nice formatting.
 */
export function formatDiffValue(value) {
  if (value === undefined || value === null) {
    return '—';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  return String(value);
}

/**
 * Get a human-readable label for a config path.
 * Maps common paths to readable labels.
 */
export function getDiffLabel(dottPath) {
  const labelMap = {
    stages: 'Stages',
    'stages.enabled': 'Stages: Enabled',
    'stages.agent': 'Stages: Agent',
    agents: 'Agents',
    loops: 'Loop Limits',
    circuit_breaker: 'Circuit Breaker',
    'circuit_breaker.enabled': 'Circuit Breaker: Enabled',
    'circuit_breaker.max_consecutive_failures': 'Circuit Breaker: Max Failures',
    governance: 'Governance',
    'governance.guards': 'Governance: Guards',
    'governance.test_gate_strikes': 'Governance: Test Gate Strikes',
    effort: 'Effort Level',
  };

  return labelMap[dottPath] || dottPath;
}

/**
 * Compute a diff summary text.
 * Returns a string like "3 differences" or "1 difference".
 */
export function diffSummary(diffs) {
  const changedCount = diffs.filter((d) => d.changed).length;
  if (changedCount === 0) return 'No differences';
  if (changedCount === 1) return '1 difference';
  return `${changedCount} differences`;
}
