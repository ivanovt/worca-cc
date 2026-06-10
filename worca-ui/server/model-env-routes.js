import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Router } from 'express';
import { atomicWriteSync } from './atomic-write.js';
import { localPathFor } from './settings-merge.js';

const require = createRequire(import.meta.url);
const denylist = require('./schemas/reserved-env-keys.json');
const RESERVED_KEYS = new Set(denylist.keys);
const RESERVED_PREFIXES = denylist.prefixes;

function isReservedKey(key) {
  if (RESERVED_KEYS.has(key)) return true;
  return RESERVED_PREFIXES.some((p) => key.startsWith(p));
}

function readJsonOr(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function createModelEnvRouter({ settingsPath: staticPath } = {}) {
  const router = Router({ mergeParams: true });

  function resolveSettingsPath(req) {
    return req.project?.settingsPath || staticPath;
  }

  router.put('/', (req, res) => {
    const { model, id, env } = req.body || {};

    if (!model || typeof model !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'model name is required' });
    }
    if (id != null && typeof id !== 'string') {
      return res.status(400).json({ ok: false, error: 'id must be a string' });
    }
    if (env != null && (typeof env !== 'object' || Array.isArray(env))) {
      return res
        .status(400)
        .json({ ok: false, error: 'env must be an object' });
    }

    const envIn = env || {};
    for (const [key, value] of Object.entries(envIn)) {
      if (typeof key !== 'string' || key === '') {
        return res
          .status(400)
          .json({ ok: false, error: 'env keys must be non-empty strings' });
      }
      if (isReservedKey(key)) {
        return res.status(400).json({
          ok: false,
          key,
          error: `Key "${key}" is reserved and cannot be used as a model env var`,
        });
      }
      if (typeof value !== 'string') {
        return res.status(400).json({
          ok: false,
          key,
          error: `value for "${key}" must be a string`,
        });
      }
    }

    const settingsPath = resolveSettingsPath(req);
    if (!settingsPath) {
      return res
        .status(501)
        .json({ ok: false, error: 'settingsPath not configured' });
    }

    // Storage split (deliberate after the W-051 simplification):
    //   settings.json       — public model entry: string id or { id }, NEVER env
    //   settings.local.json — { env } only, NEVER id
    //
    // Writing env to local while leaving env behind in settings.json would
    // let deep-merge resurrect deleted keys (a key removed in the UI but
    // still present in settings.json would reappear on next load). So PUT
    // actively strips env from the settings.json entry whenever it writes
    // env to local, and conversely never lets id leak into local.
    const localPath = localPathFor(settingsPath);
    const local = readJsonOr(localPath, {});
    if (!local.worca) local.worca = {};
    if (!local.worca.models) local.worca.models = {};

    if (Object.keys(envIn).length === 0) {
      delete local.worca.models[model];
    } else {
      local.worca.models[model] = { env: { ...envIn } };
    }
    atomicWriteSync(localPath, `${JSON.stringify(local, null, 2)}\n`);

    // settings.json: keep/update id, drop env entirely. If the model
    // doesn't exist there and no id was supplied, skip the file. If id is
    // explicitly an empty string, treat it as "no id" and drop the entry.
    const base = readJsonOr(settingsPath, {});
    if (!base.worca) base.worca = {};
    if (!base.worca.models) base.worca.models = {};

    const baseEntry = base.worca.models[model];
    let resolvedId = id;
    if (resolvedId == null) {
      if (typeof baseEntry === 'string') resolvedId = baseEntry;
      else if (baseEntry && typeof baseEntry === 'object')
        resolvedId = baseEntry.id;
    }

    let baseChanged = false;
    if (resolvedId) {
      // When env exists in local, base MUST use the object form `{id}` so
      // deepMerge({id}, {env}) preserves the id. With the string form,
      // deepMerge would see a non-object base and discard it, dropping the id
      // entirely — the bug behind empty Model ID after Duplicate/Paste.
      // String form stays the default when there's no env, to keep JSON minimal.
      const hasEnv = Object.keys(envIn).length > 0;
      const nextBaseEntry = hasEnv ? { id: resolvedId } : resolvedId;
      if (JSON.stringify(baseEntry) !== JSON.stringify(nextBaseEntry)) {
        base.worca.models[model] = nextBaseEntry;
        baseChanged = true;
      }
    } else if (baseEntry !== undefined) {
      delete base.worca.models[model];
      baseChanged = true;
    }
    if (baseChanged) {
      atomicWriteSync(settingsPath, `${JSON.stringify(base, null, 2)}\n`);
    }

    res.json({ ok: true, model, id: resolvedId || null, env: { ...envIn } });
  });

  router.delete('/', (req, res) => {
    const model =
      req.body?.model ||
      (typeof req.query?.model === 'string' ? req.query.model : null);

    if (!model) {
      return res
        .status(400)
        .json({ ok: false, error: 'model name is required' });
    }

    const settingsPath = resolveSettingsPath(req);
    if (!settingsPath) {
      return res
        .status(501)
        .json({ ok: false, error: 'settingsPath not configured' });
    }

    // Remove from BOTH files so deep-merge can't resurrect the entry. The
    // settings POST endpoint deep-merges and cannot remove a key, so we
    // operate on disk directly. This is intentional — "Delete model" in
    // the UI means the model goes away, full stop.
    let removedFromBase = false;
    let removedFromLocal = false;

    if (existsSync(settingsPath)) {
      const base = readJsonOr(settingsPath, {});
      if (base?.worca?.models && model in base.worca.models) {
        delete base.worca.models[model];
        atomicWriteSync(settingsPath, `${JSON.stringify(base, null, 2)}\n`);
        removedFromBase = true;
      }
    }

    const localPath = localPathFor(settingsPath);
    if (existsSync(localPath)) {
      const local = readJsonOr(localPath, {});
      if (local?.worca?.models && model in local.worca.models) {
        delete local.worca.models[model];
        atomicWriteSync(localPath, `${JSON.stringify(local, null, 2)}\n`);
        removedFromLocal = true;
      }
    }

    res.json({
      ok: true,
      model,
      removed: removedFromBase || removedFromLocal,
      fromBase: removedFromBase,
      fromLocal: removedFromLocal,
    });
  });

  return router;
}
