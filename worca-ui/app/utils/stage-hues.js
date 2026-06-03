/** Canonical per-stage accent colors, keyed by Stage enum values from stages.py. */
export const STAGE_HUES = {
  preflight: '#64748b',
  plan: '#4f46e5',
  plan_review: '#7c3aed',
  coordinate: '#0d9488',
  implement: '#9333ea',
  test: '#d97706',
  review: '#059669',
  pr: '#0891b2',
  learn: '#e11d48',
};

/**
 * Returns a CSS block that exposes each stage color as a custom property
 * --stage-hue-<key> on :root (works in light and dark mode via CSS inheritance).
 */
export function applyStageCSSVars() {
  const declarations = Object.entries(STAGE_HUES)
    .map(([key, color]) => `  --stage-hue-${key}: ${color};`)
    .join('\n');
  return `:root {\n${declarations}\n}`;
}
