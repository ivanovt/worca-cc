import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Router } from 'express';
import { atomicWriteSync } from './atomic-write.js';
import { localPathFor } from './settings-merge.js';

const require = createRequire(import.meta.url);
const denylist = require('./reserved-env-keys.json');
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

    const localPath = localPathFor(settingsPath);
    const local = readJsonOr(localPath, {});
    if (!local.worca) local.worca = {};
    if (!local.worca.models) local.worca.models = {};

    const entry = local.worca.models[model];
    const nextEntry =
      entry && typeof entry === 'object' && !Array.isArray(entry)
        ? { ...entry }
        : {};

    if (id != null) nextEntry.id = id;
    nextEntry.env = { ...envIn };

    // Drop empty entries — if the model has no id and no env vars in local,
    // remove it entirely so the JSON stays minimal.
    if (!nextEntry.id && Object.keys(nextEntry.env).length === 0) {
      delete local.worca.models[model];
    } else {
      local.worca.models[model] = nextEntry;
    }

    atomicWriteSync(localPath, `${JSON.stringify(local, null, 2)}\n`);
    res.json({ ok: true, model, env: nextEntry.env });
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
