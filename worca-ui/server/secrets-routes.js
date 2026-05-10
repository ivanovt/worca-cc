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

const MASKED = '••••••••';

export function createSecretsRouter({ settingsPath: staticPath } = {}) {
  const router = Router({ mergeParams: true });

  function resolveSettingsPath(req) {
    return req.project?.settingsPath || staticPath;
  }

  router.get('/', (req, res) => {
    const settingsPath = resolveSettingsPath(req);
    if (!settingsPath) {
      return res.json({ ok: true, models: {} });
    }

    let baseSettings = {};
    try {
      if (existsSync(settingsPath)) {
        baseSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      }
    } catch {
      // ignore
    }

    let localSettings = {};
    const localPath = localPathFor(settingsPath);
    try {
      if (existsSync(localPath)) {
        localSettings = JSON.parse(readFileSync(localPath, 'utf8'));
      }
    } catch {
      // ignore
    }

    const baseModels = baseSettings?.worca?.models || {};
    const localModels = localSettings?.worca?.models || {};

    const result = {};

    for (const [name, entry] of Object.entries(baseModels)) {
      if (typeof entry === 'string') continue;
      const baseEnv = entry?.env || {};
      const localEnv = localModels[name]?.env || {};

      if (
        Object.keys(baseEnv).length === 0 &&
        Object.keys(localEnv).length === 0
      ) {
        continue;
      }

      const envResult = {};
      for (const [k, v] of Object.entries(baseEnv)) {
        if (k in localEnv) {
          envResult[k] = { source: 'override', value: MASKED };
        } else {
          envResult[k] = { source: 'public', value: String(v) };
        }
      }
      for (const [k] of Object.entries(localEnv)) {
        if (!(k in envResult)) {
          envResult[k] = { source: 'secret', value: MASKED };
        }
      }
      result[name] = envResult;
    }

    for (const [name, entry] of Object.entries(localModels)) {
      if (name in result) continue;
      if (typeof entry === 'string') continue;
      const localEnv = entry?.env || {};
      if (Object.keys(localEnv).length === 0) continue;

      const envResult = {};
      for (const k of Object.keys(localEnv)) {
        envResult[k] = { source: 'secret', value: MASKED };
      }
      result[name] = envResult;
    }

    res.json({ ok: true, models: result });
  });

  router.put('/', (req, res) => {
    const { model, key, value } = req.body || {};

    if (!model || typeof model !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'model name is required' });
    }
    if (!key || typeof key !== 'string') {
      return res.status(400).json({ ok: false, error: 'key name is required' });
    }
    if (value !== null && typeof value !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'value must be a string or null' });
    }

    if (isReservedKey(key)) {
      return res.status(400).json({
        ok: false,
        error: `Key "${key}" is reserved and cannot be used as a model env var`,
      });
    }

    const settingsPath = resolveSettingsPath(req);
    if (!settingsPath) {
      return res
        .status(501)
        .json({ ok: false, error: 'settingsPath not configured' });
    }

    const localPath = localPathFor(settingsPath);
    let local = {};
    try {
      if (existsSync(localPath)) {
        local = JSON.parse(readFileSync(localPath, 'utf8'));
      }
    } catch {
      local = {};
    }

    if (!local.worca) local.worca = {};
    if (!local.worca.models) local.worca.models = {};
    if (!local.worca.models[model]) local.worca.models[model] = {};
    if (!local.worca.models[model].env) local.worca.models[model].env = {};

    if (value === null) {
      delete local.worca.models[model].env[key];
    } else {
      local.worca.models[model].env[key] = value;
    }

    atomicWriteSync(localPath, `${JSON.stringify(local, null, 2)}\n`);
    res.json({ ok: true });
  });

  return router;
}
