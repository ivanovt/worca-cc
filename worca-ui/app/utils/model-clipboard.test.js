import { describe, expect, it } from 'vitest';
import {
  decodeModelEnvelope,
  encodeModelEnvelope,
  MODEL_CLIPBOARD_KIND,
  MODEL_CLIPBOARD_VERSION,
} from './model-clipboard.js';

describe('encodeModelEnvelope', () => {
  it('produces a JSON string with the expected envelope shape', () => {
    const text = encodeModelEnvelope({
      name: 'glm-ds',
      id: 'discretestack-stable',
      env: { ANTHROPIC_BASE_URL: 'https://api.example.com' },
    });
    const parsed = JSON.parse(text);
    expect(parsed.kind).toBe(MODEL_CLIPBOARD_KIND);
    expect(parsed.version).toBe(MODEL_CLIPBOARD_VERSION);
    expect(parsed.model).toEqual({
      name: 'glm-ds',
      id: 'discretestack-stable',
      env: { ANTHROPIC_BASE_URL: 'https://api.example.com' },
    });
  });

  it('defaults env to {} and id to "" when omitted', () => {
    const parsed = JSON.parse(encodeModelEnvelope({ name: 'm' }));
    expect(parsed.model).toEqual({ name: 'm', id: '', env: {} });
  });

  it('coerces non-string name/id to strings', () => {
    const parsed = JSON.parse(encodeModelEnvelope({ name: null, id: 42 }));
    expect(parsed.model.name).toBe('');
    expect(parsed.model.id).toBe('42');
  });
});

describe('decodeModelEnvelope', () => {
  it('round-trips an encoded envelope', () => {
    const text = encodeModelEnvelope({
      name: 'glm-ds',
      id: 'discretestack-stable',
      env: { K: 'v' },
    });
    const decoded = decodeModelEnvelope(text);
    expect(decoded).toEqual({
      ok: true,
      model: { name: 'glm-ds', id: 'discretestack-stable', env: { K: 'v' } },
    });
  });

  it('returns reason="empty" for empty/whitespace input', () => {
    expect(decodeModelEnvelope('')).toEqual({ ok: false, reason: 'empty' });
    expect(decodeModelEnvelope('   \n  ')).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(decodeModelEnvelope(null)).toEqual({ ok: false, reason: 'empty' });
    expect(decodeModelEnvelope(undefined)).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('returns reason="invalid_json" for non-JSON text', () => {
    expect(decodeModelEnvelope('not json')).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
    expect(decodeModelEnvelope('{ broken: ')).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
  });

  it('returns reason="wrong_kind" for unrelated JSON objects', () => {
    expect(decodeModelEnvelope('{"hello": "world"}')).toEqual({
      ok: false,
      reason: 'wrong_kind',
    });
    expect(decodeModelEnvelope('{"kind": "something/else"}')).toEqual({
      ok: false,
      reason: 'wrong_kind',
    });
  });

  it('returns reason="wrong_kind" for JSON arrays and primitives', () => {
    expect(decodeModelEnvelope('[1,2,3]')).toEqual({
      ok: false,
      reason: 'wrong_kind',
    });
    expect(decodeModelEnvelope('"a string"')).toEqual({
      ok: false,
      reason: 'wrong_kind',
    });
    expect(decodeModelEnvelope('42')).toEqual({
      ok: false,
      reason: 'wrong_kind',
    });
    expect(decodeModelEnvelope('null')).toEqual({
      ok: false,
      reason: 'wrong_kind',
    });
  });

  it('returns reason="wrong_version" when kind matches but version differs', () => {
    const text = JSON.stringify({
      kind: MODEL_CLIPBOARD_KIND,
      version: 99,
      model: { name: 'm', id: 'x', env: {} },
    });
    expect(decodeModelEnvelope(text)).toEqual({
      ok: false,
      reason: 'wrong_version',
    });
  });

  it('returns reason="malformed" when model is missing or non-object', () => {
    const base = {
      kind: MODEL_CLIPBOARD_KIND,
      version: MODEL_CLIPBOARD_VERSION,
    };
    expect(decodeModelEnvelope(JSON.stringify(base))).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(
      decodeModelEnvelope(JSON.stringify({ ...base, model: 'string' })),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      decodeModelEnvelope(JSON.stringify({ ...base, model: [1, 2] })),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns reason="malformed" when name is missing or blank', () => {
    const base = {
      kind: MODEL_CLIPBOARD_KIND,
      version: MODEL_CLIPBOARD_VERSION,
    };
    expect(
      decodeModelEnvelope(
        JSON.stringify({ ...base, model: { id: 'x', env: {} } }),
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      decodeModelEnvelope(
        JSON.stringify({ ...base, model: { name: '   ', id: 'x', env: {} } }),
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns reason="malformed" when env is non-object or has empty keys', () => {
    const base = {
      kind: MODEL_CLIPBOARD_KIND,
      version: MODEL_CLIPBOARD_VERSION,
    };
    expect(
      decodeModelEnvelope(
        JSON.stringify({ ...base, model: { name: 'm', id: '', env: 'bad' } }),
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      decodeModelEnvelope(
        JSON.stringify({
          ...base,
          model: { name: 'm', id: '', env: { '': 'x' } },
        }),
      ),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('coerces non-string env values to strings on decode', () => {
    const text = JSON.stringify({
      kind: MODEL_CLIPBOARD_KIND,
      version: MODEL_CLIPBOARD_VERSION,
      model: { name: 'm', id: 'x', env: { A: 42, B: true } },
    });
    const decoded = decodeModelEnvelope(text);
    expect(decoded.ok).toBe(true);
    expect(decoded.model.env).toEqual({ A: '42', B: 'true' });
  });

  it('accepts envelope with missing env (defaults to {})', () => {
    const text = JSON.stringify({
      kind: MODEL_CLIPBOARD_KIND,
      version: MODEL_CLIPBOARD_VERSION,
      model: { name: 'm', id: 'x' },
    });
    const decoded = decodeModelEnvelope(text);
    expect(decoded).toEqual({
      ok: true,
      model: { name: 'm', id: 'x', env: {} },
    });
  });

  it('trims trailing whitespace before parsing', () => {
    const text = `${encodeModelEnvelope({ name: 'm', id: 'x', env: {} })}\n\n`;
    expect(decodeModelEnvelope(text).ok).toBe(true);
  });
});
