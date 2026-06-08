/**
 * Tier-aware model alias CRUD spanning user-global and project tiers, with
 * co-located per-model pricing. Mirrors the Pipeline Templates tier model
 * (builtin / user / project) and the storage-split rules from
 * model-env-routes.js (id+pricing in settings.json, env in settings.local.json).
 *
 * Resolution rule (matches src/worca/utils/settings.py): an alias resolves
 * from exactly one tier — whole-entry replace across tiers, no field-level
 * deep-merge. Within a single tier id/env still compose (the .json + .local.json
 * sibling pair is one logical tier).
 *
 * Mount at /api/projects/:projectId/models (per-project scoped) or
 * /api/models (unscoped, for single-project mode).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { Router } from 'express';
import { atomicWriteSync } from './atomic-write.js';
import { globalSettingsPath, templatesDir } from './paths.js';
import { localPathFor } from './settings-merge.js';

const require = createRequire(import.meta.url);
const denylist = require('./reserved-env-keys.json');
const RESERVED_KEYS = new Set(denylist.keys);
const RESERVED_PREFIXES = denylist.prefixes;

// Mirror of _DEFAULT_MODEL_MAP in src/worca/utils/settings.py.
// Surfaced as the read-only "builtin" tier on the Models page.
const BUILTIN_MODELS = Object.freeze({
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
});

// Pricing fields displayed in the per-model pricing accordion. Aligned with
// the legacy Settings → Pricing tab's PRICING_FIELDS (input/cache_read/cache_write/output).
const PRICING_FIELDS = Object.freeze([
  'input_per_mtok',
  'cache_read_per_mtok',
  'cache_write_per_mtok',
  'output_per_mtok',
]);

// Env keys whose presence flips an alias into "alt-endpoint" mode — pricing
// then becomes authoritative (worca overrides Claude CLI's cost). Matches
// _ALT_ENDPOINT_ENV_KEYS in src/worca/orchestrator/stages.py.
const ALT_ENDPOINT_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
]);

const ALIAS_RE = /^[a-zA-Z0-9_-]{1,64}$/;

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

function tierSettingsPath(tier, projectSettingsPath) {
  if (tier === 'project') return projectSettingsPath || null;
  if (tier === 'user') return globalSettingsPath();
  return null;
}

/**
 * Read all aliases at a given tier, composing the within-tier id/env split.
 * Returns { alias: { id, env, pricing } } where pricing may be {}.
 */
function readTierAliases(tier, projectSettingsPath) {
  const path = tierSettingsPath(tier, projectSettingsPath);
  if (!path) return {};
  const base = readJsonOr(path, {});
  const local = readJsonOr(localPathFor(path), {});
  const baseModels = base?.worca?.models || {};
  const localModels = local?.worca?.models || {};
  const basePricing = base?.worca?.pricing?.models || {};
  const localPricing = local?.worca?.pricing?.models || {};
  const aliases = new Set([
    ...Object.keys(baseModels),
    ...Object.keys(localModels),
    ...Object.keys(basePricing),
    ...Object.keys(localPricing),
  ]);

  const out = {};
  for (const alias of aliases) {
    const baseRaw = baseModels[alias];
    const localRaw = localModels[alias];
    let id = null;
    if (typeof baseRaw === 'string') id = baseRaw;
    else if (baseRaw && typeof baseRaw === 'object') id = baseRaw.id || null;
    // Local carries only env by convention, but tolerate legacy shapes.
    let env = {};
    if (localRaw && typeof localRaw === 'object' && localRaw.env) {
      env = localRaw.env;
    } else if (baseRaw && typeof baseRaw === 'object' && baseRaw.env) {
      env = baseRaw.env;
    }
    const pricing = {
      ...(basePricing[alias] || {}),
      ...(localPricing[alias] || {}),
    };
    // Bundle attribution metadata (set by `worca templates import` and
    // dropped on the first UI save). Surfaces as a card/editor badge so
    // users remember which alias originated from a shared template bundle.
    const importedFrom =
      baseRaw &&
      typeof baseRaw === 'object' &&
      typeof baseRaw._imported_from === 'string'
        ? baseRaw._imported_from
        : null;
    out[alias] = { id, env, pricing, importedFrom };
  }
  return out;
}

function makeRow(tier, alias, entry) {
  const env = entry.env || {};
  const envCount = Object.keys(env).length;
  const hasAlt = ALT_ENDPOINT_ENV_KEYS.some((k) => env[k] != null);
  const pricing =
    entry.pricing && Object.keys(entry.pricing).length ? entry.pricing : null;
  return {
    tier,
    alias,
    id: entry.id || null,
    env,
    env_count: envCount,
    pricing,
    has_alt_endpoint: hasAlt,
    builtin: tier === 'builtin',
    imported_from: entry.importedFrom || null,
  };
}

function readSingleModel(tier, projectSettingsPath, alias) {
  if (tier === 'builtin') {
    if (!(alias in BUILTIN_MODELS)) return null;
    return makeRow('builtin', alias, {
      id: BUILTIN_MODELS[alias],
      env: {},
      pricing: null,
    });
  }
  const map = readTierAliases(tier, projectSettingsPath);
  if (!(alias in map)) return null;
  return makeRow(tier, alias, map[alias]);
}

function listAllModels(projectSettingsPath) {
  const all = [];
  for (const [alias, modelId] of Object.entries(BUILTIN_MODELS)) {
    all.push(
      makeRow('builtin', alias, { id: modelId, env: {}, pricing: null }),
    );
  }
  for (const [alias, entry] of Object.entries(
    readTierAliases('user', projectSettingsPath),
  )) {
    all.push(makeRow('user', alias, entry));
  }
  if (projectSettingsPath) {
    for (const [alias, entry] of Object.entries(
      readTierAliases('project', projectSettingsPath),
    )) {
      all.push(makeRow('project', alias, entry));
    }
  }
  return all;
}

/**
 * Write rules:
 * - id and pricing live in settings.json (committed)
 * - env lives in settings.local.json (gitignored)
 * - if env exists, settings.json entry MUST be object form {id} so the
 *   within-tier deepMerge({id}, {env}) preserves both. String form is
 *   the default when env is empty (minimal JSON).
 */
function writeModelEntry(
  tier,
  projectSettingsPath,
  alias,
  { id, env, pricing },
) {
  const settingsPath = tierSettingsPath(tier, projectSettingsPath);
  if (!settingsPath) {
    throw new Error(`tier "${tier}" has no writable settings path`);
  }

  const safeEnv = {};
  for (const [k, v] of Object.entries(env || {})) {
    if (typeof k !== 'string' || k === '') continue;
    if (isReservedKey(k)) continue;
    if (typeof v !== 'string') continue;
    safeEnv[k] = v;
  }
  const hasEnv = Object.keys(safeEnv).length > 0;

  // settings.json side: id (always written) + pricing (optional)
  const base = readJsonOr(settingsPath, {});
  if (!base.worca) base.worca = {};
  if (!base.worca.models) base.worca.models = {};
  if (!base.worca.pricing) base.worca.pricing = {};
  if (!base.worca.pricing.models) base.worca.pricing.models = {};

  if (id) {
    base.worca.models[alias] = hasEnv ? { id } : id;
  } else {
    delete base.worca.models[alias];
  }

  const pricingClean = {};
  for (const field of PRICING_FIELDS) {
    const v = pricing?.[field];
    if (v != null && Number.isFinite(Number(v))) {
      pricingClean[field] = Number(v);
    }
  }
  if (Object.keys(pricingClean).length > 0) {
    base.worca.pricing.models[alias] = pricingClean;
  } else {
    delete base.worca.pricing.models[alias];
  }

  atomicWriteSync(settingsPath, `${JSON.stringify(base, null, 2)}\n`);

  // settings.local.json side: env (if any), strip env from local if empty
  const localPath = localPathFor(settingsPath);
  const local = readJsonOr(localPath, {});
  if (!local.worca) local.worca = {};
  if (!local.worca.models) local.worca.models = {};
  if (hasEnv) {
    local.worca.models[alias] = { env: safeEnv };
  } else {
    delete local.worca.models[alias];
  }
  atomicWriteSync(localPath, `${JSON.stringify(local, null, 2)}\n`);
}

function deleteModelEntry(tier, projectSettingsPath, alias) {
  const settingsPath = tierSettingsPath(tier, projectSettingsPath);
  if (!settingsPath) throw new Error(`tier "${tier}" not writable`);

  let fromBase = false;
  let fromLocal = false;
  if (existsSync(settingsPath)) {
    const base = readJsonOr(settingsPath, {});
    let changed = false;
    if (base?.worca?.models && alias in base.worca.models) {
      delete base.worca.models[alias];
      changed = true;
    }
    if (base?.worca?.pricing?.models && alias in base.worca.pricing.models) {
      delete base.worca.pricing.models[alias];
      changed = true;
    }
    if (changed) {
      atomicWriteSync(settingsPath, `${JSON.stringify(base, null, 2)}\n`);
      fromBase = true;
    }
  }
  const localPath = localPathFor(settingsPath);
  if (existsSync(localPath)) {
    const local = readJsonOr(localPath, {});
    if (local?.worca?.models && alias in local.worca.models) {
      delete local.worca.models[alias];
      atomicWriteSync(localPath, `${JSON.stringify(local, null, 2)}\n`);
      fromLocal = true;
    }
  }
  return { fromBase, fromLocal };
}

/**
 * Find templates (across all tiers we can read from disk) that reference a
 * given alias name in `config.agents.<name>.model`. Used by the editor's
 * "Applied by" section.
 *
 * Reads project + user template.json files directly off disk. Builtin
 * templates are skipped — they're shipped inside the worca-cc Python
 * package and reaching their on-disk path from the JS server would require
 * spawning Python; the cost isn't worth it for an advisory list. Best-effort
 * — silently returns [] when nothing is found or directories don't exist.
 *
 * @returns {Array<{tier: string, template_id: string, agent: string}>}
 */
function findReferencingTemplates(alias, projectSettingsPath) {
  const refs = [];

  const projectDir = projectSettingsPath
    ? join(dirname(projectSettingsPath), 'templates')
    : null;
  const userDir = templatesDir();

  for (const [tier, dir] of [
    ['project', projectDir],
    ['user', userDir],
  ]) {
    if (!dir || !existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const manifestPath = resolvePath(dir, entry, 'template.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const st = statSync(manifestPath);
        if (!st.isFile()) continue;
        const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
        const agents = data?.config?.agents || {};
        for (const [agentName, agentCfg] of Object.entries(agents)) {
          if (
            agentCfg &&
            typeof agentCfg === 'object' &&
            agentCfg.model === alias
          ) {
            refs.push({
              tier,
              template_id: data.id || entry,
              agent: agentName,
            });
          }
        }
      } catch {
        // skip unreadable / malformed template.json
      }
    }
  }
  return refs;
}

export function createModelsRouter({ settingsPath: staticPath } = {}) {
  const router = Router({ mergeParams: true });

  function resolveProjectSettingsPath(req) {
    return req.project?.settingsPath || staticPath || null;
  }

  // GET /  — list all aliases across tiers (flat, each row carries `tier`)
  router.get('/', (req, res) => {
    const projectPath = resolveProjectSettingsPath(req);
    try {
      res.json({ ok: true, models: listAllModels(projectPath) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /:tier/:alias  — single entry
  router.get('/:tier/:alias', (req, res) => {
    const { tier, alias } = req.params;
    if (!['builtin', 'user', 'project'].includes(tier)) {
      return res.status(400).json({ ok: false, error: 'invalid tier' });
    }
    const projectPath = resolveProjectSettingsPath(req);
    const entry = readSingleModel(tier, projectPath, alias);
    if (!entry) {
      return res.status(404).json({ ok: false, error: 'not found' });
    }
    res.json({
      ok: true,
      model: entry,
      applied_by: findReferencingTemplates(alias, projectPath),
    });
  });

  // PUT /:tier/:alias  — create or update (supports rename via body.alias)
  router.put('/:tier/:alias', (req, res) => {
    const { tier, alias: urlAlias } = req.params;
    if (tier === 'builtin') {
      return res
        .status(403)
        .json({ ok: false, error: 'builtin tier is read-only' });
    }
    if (!['user', 'project'].includes(tier)) {
      return res.status(400).json({ ok: false, error: 'invalid tier' });
    }
    const projectPath = resolveProjectSettingsPath(req);
    if (tier === 'project' && !projectPath) {
      return res
        .status(501)
        .json({ ok: false, error: 'project settings path not configured' });
    }

    const body = req.body || {};
    const newAlias =
      typeof body.alias === 'string' && body.alias ? body.alias : urlAlias;
    if (!ALIAS_RE.test(newAlias)) {
      return res.status(400).json({
        ok: false,
        error: 'alias must match [a-zA-Z0-9_-], 1-64 chars',
      });
    }
    if (typeof body.id !== 'string' || !body.id) {
      return res.status(400).json({ ok: false, error: 'id is required' });
    }

    const env = body.env || {};
    if (typeof env !== 'object' || Array.isArray(env)) {
      return res
        .status(400)
        .json({ ok: false, error: 'env must be an object' });
    }
    for (const [k, v] of Object.entries(env)) {
      if (typeof k !== 'string' || k === '') {
        return res
          .status(400)
          .json({ ok: false, error: 'env keys must be non-empty strings' });
      }
      if (isReservedKey(k)) {
        return res.status(400).json({
          ok: false,
          key: k,
          error: `Key "${k}" is reserved and cannot be used as a model env var`,
        });
      }
      if (typeof v !== 'string') {
        return res.status(400).json({
          ok: false,
          key: k,
          error: `value for "${k}" must be a string`,
        });
      }
    }

    const pricingRaw = body.pricing || {};
    if (typeof pricingRaw !== 'object' || Array.isArray(pricingRaw)) {
      return res
        .status(400)
        .json({ ok: false, error: 'pricing must be an object' });
    }
    const pricing = {};
    for (const field of PRICING_FIELDS) {
      const v = pricingRaw[field];
      if (v == null || v === '') continue;
      const num = Number(v);
      if (Number.isNaN(num) || num < 0) {
        return res.status(400).json({
          ok: false,
          field,
          error: `pricing.${field} must be a non-negative number`,
        });
      }
      pricing[field] = num;
    }

    // Rename collision check
    if (newAlias !== urlAlias) {
      const existing = readSingleModel(tier, projectPath, newAlias);
      if (existing) {
        return res.status(409).json({
          ok: false,
          error: `alias "${newAlias}" already exists in ${tier} tier`,
        });
      }
    }

    try {
      if (newAlias !== urlAlias) {
        // Rename: delete the old entry first so we don't leave a stale
        // sibling behind in either settings.json or settings.local.json.
        const existing = readSingleModel(tier, projectPath, urlAlias);
        if (existing) deleteModelEntry(tier, projectPath, urlAlias);
      }
      writeModelEntry(tier, projectPath, newAlias, {
        id: body.id,
        env,
        pricing,
      });
      const result = readSingleModel(tier, projectPath, newAlias);
      res.json({ ok: true, model: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // DELETE /:tier/:alias  — remove from both settings.json and settings.local.json
  router.delete('/:tier/:alias', (req, res) => {
    const { tier, alias } = req.params;
    if (tier === 'builtin') {
      return res
        .status(403)
        .json({ ok: false, error: 'builtin tier is read-only' });
    }
    if (!['user', 'project'].includes(tier)) {
      return res.status(400).json({ ok: false, error: 'invalid tier' });
    }
    const projectPath = resolveProjectSettingsPath(req);
    if (tier === 'project' && !projectPath) {
      return res
        .status(501)
        .json({ ok: false, error: 'project settings path not configured' });
    }
    try {
      const result = deleteModelEntry(tier, projectPath, alias);
      res.json({
        ok: true,
        alias,
        removed: result.fromBase || result.fromLocal,
        from_base: result.fromBase,
        from_local: result.fromLocal,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /:tier/:alias/duplicate  — copy to a destination tier+alias
  router.post('/:tier/:alias/duplicate', (req, res) => {
    const { tier: srcTier, alias: srcAlias } = req.params;
    const body = req.body || {};
    const dstTier = body.dst_tier || 'project';
    const dstAlias = body.dst_alias;
    if (!['user', 'project'].includes(dstTier)) {
      return res.status(400).json({ ok: false, error: 'invalid dst_tier' });
    }
    if (typeof dstAlias !== 'string' || !ALIAS_RE.test(dstAlias)) {
      return res.status(400).json({
        ok: false,
        error: 'dst_alias must match [a-zA-Z0-9_-], 1-64 chars',
      });
    }
    const projectPath = resolveProjectSettingsPath(req);
    if (dstTier === 'project' && !projectPath) {
      return res
        .status(501)
        .json({ ok: false, error: 'project settings path not configured' });
    }

    const src = readSingleModel(srcTier, projectPath, srcAlias);
    if (!src) {
      return res.status(404).json({ ok: false, error: 'source not found' });
    }

    const existing = readSingleModel(dstTier, projectPath, dstAlias);
    if (existing) {
      return res.status(409).json({
        ok: false,
        error: `alias "${dstAlias}" already exists in ${dstTier} tier`,
      });
    }

    try {
      writeModelEntry(dstTier, projectPath, dstAlias, {
        id: src.id,
        env: src.env || {},
        pricing: src.pricing || {},
      });
      const result = readSingleModel(dstTier, projectPath, dstAlias);
      res.json({ ok: true, model: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
