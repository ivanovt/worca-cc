/**
 * Secret-placeholder values used by the Python bundle redactor.
 *
 * When a project exports a template with model env vars, real secrets
 * (sk-*, ghp_*, xoxb-*, ...) are replaced with one of these placeholder
 * strings. On import the values land verbatim in settings.local.json,
 * so the UI surfaces them as "Not configured" until the operator replaces
 * them with the real secret.
 *
 * MIRROR: keep aligned with `src/worca/orchestrator/bundle.py`
 * (SECRET_PLACEHOLDERS). The first entry is the canonical placeholder
 * written by current redaction; the rest are recognised but not produced.
 */

export const SECRET_PLACEHOLDERS = ['<YOUR-SECRET-HERE>'];

/** True when *value* is one of the recognised secret placeholders. */
export function isSecretPlaceholder(value) {
  return typeof value === 'string' && SECRET_PLACEHOLDERS.includes(value);
}

/** True when *env* (a {key: string} map) has any placeholder value. */
export function envHasPlaceholder(env) {
  if (!env || typeof env !== 'object') return false;
  for (const v of Object.values(env)) {
    if (isSecretPlaceholder(v)) return true;
  }
  return false;
}
