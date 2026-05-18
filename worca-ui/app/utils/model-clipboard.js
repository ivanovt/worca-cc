export const MODEL_CLIPBOARD_KIND = 'worca/model';
export const MODEL_CLIPBOARD_VERSION = 1;

export function encodeModelEnvelope({ name, id, env }) {
  const envelope = {
    kind: MODEL_CLIPBOARD_KIND,
    version: MODEL_CLIPBOARD_VERSION,
    model: {
      name: String(name || ''),
      id: String(id || ''),
      env: { ...(env || {}) },
    },
  };
  return JSON.stringify(envelope, null, 2);
}

/**
 * Decode clipboard text into a model envelope.
 * Returns { ok: true, model: { name, id, env } } on success,
 * or { ok: false, reason } where reason is one of:
 *   - 'empty'        — clipboard text was empty/whitespace
 *   - 'invalid_json' — text didn't parse as JSON
 *   - 'wrong_kind'   — JSON parsed but kind wasn't 'worca/model'
 *   - 'wrong_version' — kind matched but version unsupported
 *   - 'malformed'    — kind/version matched but model fields missing/invalid
 */
export function decodeModelEnvelope(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: false, reason: 'empty' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'wrong_kind' };
  }
  if (parsed.kind !== MODEL_CLIPBOARD_KIND) {
    return { ok: false, reason: 'wrong_kind' };
  }
  if (parsed.version !== MODEL_CLIPBOARD_VERSION) {
    return { ok: false, reason: 'wrong_version' };
  }

  const m = parsed.model;
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { ok: false, reason: 'malformed' };
  }
  const name = typeof m.name === 'string' ? m.name.trim() : '';
  if (!name) return { ok: false, reason: 'malformed' };
  const id = typeof m.id === 'string' ? m.id : '';

  const env = {};
  if (m.env != null) {
    if (typeof m.env !== 'object' || Array.isArray(m.env)) {
      return { ok: false, reason: 'malformed' };
    }
    for (const [k, v] of Object.entries(m.env)) {
      if (typeof k !== 'string' || !k) {
        return { ok: false, reason: 'malformed' };
      }
      env[k] = typeof v === 'string' ? v : String(v);
    }
  }

  return { ok: true, model: { name, id, env } };
}
