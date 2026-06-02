/**
 * REST API routes for pipeline templates.
 *
 * Thin shim over the `worca templates` CLI. All mutating operations
 * (create / update / delete / duplicate / import / rename) delegate to
 * the Python CLI so `worca/orchestrator/templates.TemplateResolver`
 * stays the single source of truth for validation, naming collisions,
 * and the on-disk layout.
 *
 * Resource model: `(tier, id)` is the primary key. Every route below
 * carries the tier explicitly so the editor / API never has to guess
 * which copy it's operating on. List does NOT dedup — built-ins
 * always render even when a project copy with the same id exists,
 * which lets the UI mark the shadow without hiding the original.
 *
 * Provides:
 *   GET    /templates                                 — list (flat, each entry tagged with tier)
 *   GET    /templates/:tier/:id                        — fetch exact (tier, id)
 *   POST   /templates/:tier                            — create — body { id, name?, description?, config?, params?, tags? }
 *   PUT    /templates/:tier/:id                        — upsert (rejects tier=builtin with 405)
 *   DELETE /templates/:tier/:id                        — delete (rejects tier=builtin with 405)
 *   POST   /templates/:tier/:id/duplicate              — body { dst_tier, dst_id }
 *   POST   /templates/:tier/:id/rename                 — body { dst_tier, dst_id }
 *   POST   /templates/:tier/:id/validate               — body { config }
 *   GET    /templates/:tier/:id/bundle                 — export (redacted)
 *   POST   /templates/import                           — body { bundle, dst_tier }
 *   PUT    /default-template                           — body { tier, id } | { tier: null, id: null } to clear
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Router } from 'express';
import { atomicWriteSync } from './atomic-write.js';
import { templatesDir } from './paths.js';

/**
 * Match template IDs: lowercase alphanumeric, hyphens, and underscores,
 * 1-64 chars. Underscores are allowed so worca init's auto-migrated
 * `_legacy-settings` template round-trips through the API without
 * 400-ing. Mirrors the Python `TemplateResolver.save()` validator.
 */
const TEMPLATE_RE = /^[a-z0-9_-]{1,64}$/;
const TIERS = ['project', 'user', 'builtin'];
const MUTABLE_TIERS = ['project', 'user'];
export { TEMPLATE_RE, TIERS };

function isValidTier(tier) {
  return TIERS.includes(tier);
}
function isMutableTier(tier) {
  return MUTABLE_TIERS.includes(tier);
}

function readTemplateJson(dirPath) {
  const manifestPath = join(dirPath, 'template.json');
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Directory for a given tier. Built-in is the runtime copy worca init
 * stages under .claude/worca/templates/.
 */
function dirForTier(projectRoot, tier) {
  switch (tier) {
    case 'project':
      return join(projectRoot, '.claude', 'templates');
    case 'user':
      return templatesDir();
    case 'builtin':
      return join(projectRoot, '.claude', 'worca', 'templates');
    default:
      return null;
  }
}

/**
 * Lists every template across all three tiers — NO dedup. Each entry
 * carries its own `tier` field. Callers (UI) are free to group / cross-
 * reference; the API surfaces the truth on disk.
 *
 * Output sort order matches `TemplateResolver.list` on the Python
 * side: builtins alpha → projects alpha → users newest-first.
 */
function listTemplatesFlat(projectRoot) {
  const out = [];
  for (const tier of TIERS) {
    const dir = dirForTier(projectRoot, tier);
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifest = readTemplateJson(join(dir, entry.name));
      if (!manifest) continue;
      const id = manifest.id || entry.name;
      out.push({
        tier,
        id,
        name: manifest.name || id,
        description: manifest.description || '',
        config: manifest.config || {},
        params: manifest.params || {},
        tags: manifest.tags || [],
        created_at: manifest.created_at,
        builtin: manifest.builtin === true || tier === 'builtin',
      });
    }
  }

  const tierOrder = { builtin: 0, project: 1, user: 2 };
  out.sort((a, b) => {
    if (a.tier !== b.tier) return tierOrder[a.tier] - tierOrder[b.tier];
    if (a.tier === 'user') {
      return (b.created_at || '').localeCompare(a.created_at || '');
    }
    return a.id.localeCompare(b.id);
  });
  return out;
}

/**
 * Look up a single (tier, id). Returns the parsed template.json + tier,
 * or null.
 */
function fetchTemplate(projectRoot, tier, id) {
  const dir = dirForTier(projectRoot, tier);
  if (!dir) return null;
  const manifest = readTemplateJson(join(dir, id));
  if (!manifest) return null;
  return { tier, template: manifest };
}

/**
 * Runs `worca templates …` with the given args.
 *
 * Returns trimmed stdout on success. On non-zero exit, throws an
 * Error whose `cliCode` field carries a normalized code parsed from
 * stderr ('name_collision' | 'not_found' | 'validation_error' |
 * 'unknown'), and whose `cliStderr` field carries the raw stderr.
 */
function runWorcaTemplates(projectRoot, args, opts = {}) {
  try {
    const stdout = execFileSync(
      'worca',
      ['templates', '--project-root', projectRoot, ...args],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: opts.timeout ?? 30000,
        input: opts.stdin,
      },
    );
    return typeof stdout === 'string' ? stdout.trim() : '';
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    const stdout = err.stdout?.toString?.() || '';
    const combined = `${stderr}\n${stdout}`.toLowerCase();
    let code = 'unknown';
    if (
      combined.includes('already exists') ||
      combined.includes('name_collision')
    ) {
      code = 'name_collision';
    } else if (
      combined.includes('not found') ||
      combined.includes('not_found')
    ) {
      code = 'not_found';
    } else if (
      combined.includes('validation') ||
      combined.includes('invalid')
    ) {
      code = 'validation_error';
    }
    const e = new Error(stderr.trim() || err.message || 'worca CLI failed');
    e.cliCode = code;
    e.cliStderr = stderr;
    throw e;
  }
}

function statusForCliCode(code) {
  switch (code) {
    case 'name_collision':
      return 409;
    case 'not_found':
      return 404;
    case 'validation_error':
      return 400;
    default:
      return 500;
  }
}

function validateConfig(projectRoot, config) {
  try {
    const stdout = runWorcaTemplates(
      projectRoot,
      ['validate', '--config', JSON.stringify(config || {})],
      { timeout: 10000 },
    );
    const issues = JSON.parse(stdout || '[]');
    return { issues: Array.isArray(issues) ? issues : [] };
  } catch {
    return { issues: [] };
  }
}

function writeTempJson(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'worca-tpl-'));
  const path = join(dir, 'template.json');
  writeFileSync(path, JSON.stringify(obj), 'utf8');
  return { path, dir };
}

function cleanupTemp(tempDir) {
  try {
    rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function saveTemplateViaCli(projectRoot, tier, id, payload) {
  const templateData = {
    id,
    name: payload.name || id,
    description: payload.description || '',
    tags: payload.tags || [],
    params: payload.params || {},
    config: payload.config || {},
  };
  const { path, dir } = writeTempJson(templateData);
  try {
    const args = ['create', '--from-file', path];
    if (tier === 'user') args.push('--global');
    runWorcaTemplates(projectRoot, args);
  } finally {
    cleanupTemp(dir);
  }
}

function deleteTemplateViaCli(projectRoot, tier, id) {
  const args = ['delete', id];
  if (tier === 'user') args.push('--global');
  runWorcaTemplates(projectRoot, args);
}

function duplicateTemplateViaCli(projectRoot, srcId, dstId, dstTier) {
  // CLI's `duplicate` reads source from any tier via precedence; for
  // strict (src_tier, src_id) reads we'd need a CLI extension. Today's
  // semantics: src is resolved by id with project > user > builtin
  // precedence — same as the run launcher. Acceptable since the most
  // common shadow-edit flow targets the highest-priority match anyway.
  runWorcaTemplates(projectRoot, [
    'duplicate',
    srcId,
    '--dst',
    dstId,
    '--dst-scope',
    dstTier,
  ]);
}

function exportBundle(projectRoot, id) {
  const dir = mkdtempSync(join(tmpdir(), 'worca-bundle-'));
  const bundlePath = join(dir, `${id}.json`);
  try {
    runWorcaTemplates(projectRoot, [
      'export',
      '--to',
      bundlePath,
      '--templates',
      id,
    ]);
    if (existsSync(bundlePath)) {
      return JSON.parse(readFileSync(bundlePath, 'utf8'));
    }
    return { templates: [{ id }] };
  } finally {
    cleanupTemp(dir);
  }
}

function importBundle(projectRoot, bundle, tier) {
  if (!bundle || !Array.isArray(bundle.templates)) {
    throw new Error('Bundle must contain a "templates" array');
  }
  const dir = mkdtempSync(join(tmpdir(), 'worca-import-'));
  const bundlePath = join(dir, 'bundle.json');
  try {
    writeFileSync(bundlePath, JSON.stringify(bundle), 'utf8');
    runWorcaTemplates(
      projectRoot,
      ['import', '--from', bundlePath, '--scope', tier, '--non-interactive'],
      { timeout: 60000 },
    );
    const targetDir = dirForTier(projectRoot, tier);
    const imported = [];
    for (const tmpl of bundle.templates) {
      const id = tmpl.id;
      const manifest = readTemplateJson(join(targetDir, id));
      if (manifest) {
        imported.push({
          id: manifest.id || id,
          name: manifest.name || id,
          tier,
        });
      }
    }
    return { imported, count: imported.length };
  } finally {
    cleanupTemp(dir);
  }
}

/**
 * Standard tier/id validation guard. Sends a 400 and returns true if
 * something is wrong; returns false when the route handler should
 * continue.
 */
function rejectInvalidTierId(res, tier, id, { idRequired = true } = {}) {
  if (!isValidTier(tier)) {
    res.status(400).json({
      ok: false,
      error: `tier must be one of: ${TIERS.join(', ')}`,
    });
    return true;
  }
  if (idRequired && (!id || !TEMPLATE_RE.test(id))) {
    res.status(400).json({
      ok: false,
      error: 'id must match ^[a-z0-9_-]{1,64}$',
    });
    return true;
  }
  return false;
}

/**
 * Built-in tier is immutable via the API. Returns true (and sends 405)
 * if the request would write to a built-in; false otherwise.
 */
function rejectBuiltinWrite(res, tier, op = 'modify') {
  if (tier === 'builtin') {
    res.status(405).json({
      ok: false,
      error: `Built-in templates are immutable — cannot ${op} via the API. Duplicate to project or user scope first.`,
    });
    return true;
  }
  return false;
}

/**
 * Creates the templates router. Must be mounted after projectResolver
 * middleware sets `req.project` with { projectRoot, settingsPath, … }.
 */
export function createTemplatesRoutes() {
  const router = Router({ mergeParams: true });

  /**
   * GET /api/projects/:projectId/templates
   * List every template across all tiers. No dedup, no shadows field —
   * each entry carries its own `tier`. The UI groups client-side.
   */
  router.get('/templates', (req, res) => {
    try {
      const { projectRoot } = req.project;
      const templates = listTemplatesFlat(projectRoot);
      res.json({ ok: true, templates });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/projects/:projectId/templates/:tier/:id
   */
  router.get('/templates/:tier/:id', (req, res) => {
    const { tier, id } = req.params;
    if (rejectInvalidTierId(res, tier, id)) return;
    try {
      const found = fetchTemplate(req.project.projectRoot, tier, id);
      if (!found) {
        return res.status(404).json({
          ok: false,
          error: `Template "${id}" not found in ${tier} scope`,
        });
      }
      res.json({ ok: true, template: found.template, tier: found.tier });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/projects/:projectId/templates/import
   *
   * Registered *before* `POST /templates/:tier` so Express's router
   * doesn't match the literal "import" path segment as a tier
   * parameter (which would 400 with "tier must be one of …").
   *
   * Body: { bundle: {templates: [...]}, dst_tier }
   */
  router.post('/templates/import', (req, res) => {
    const { bundle, dst_tier: dstTier } = req.body || {};
    if (!bundle || typeof bundle !== 'object') {
      return res
        .status(400)
        .json({ ok: false, error: 'bundle must be a JSON object' });
    }
    if (!isValidTier(dstTier)) {
      return res.status(400).json({
        ok: false,
        error: `dst_tier must be one of: ${TIERS.join(', ')}`,
      });
    }
    if (rejectBuiltinWrite(res, dstTier, 'import to')) return;
    try {
      const result = importBundle(req.project.projectRoot, bundle, dstTier);
      res.json({ ok: true, ...result });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * POST /api/projects/:projectId/templates/:tier
   * Body: { id, name?, description?, config?, params?, tags? }
   */
  router.post('/templates/:tier', (req, res) => {
    const { tier } = req.params;
    if (!isValidTier(tier)) {
      return res.status(400).json({
        ok: false,
        error: `tier must be one of: ${TIERS.join(', ')}`,
      });
    }
    if (rejectBuiltinWrite(res, tier, 'create in')) return;
    const { id, name, description, config, params, tags } = req.body || {};
    if (!id || typeof id !== 'string' || !TEMPLATE_RE.test(id)) {
      return res.status(400).json({
        ok: false,
        error: 'id is required and must match ^[a-z0-9_-]{1,64}$',
      });
    }
    const { projectRoot } = req.project;
    if (fetchTemplate(projectRoot, tier, id)) {
      return res.status(409).json({
        ok: false,
        error: `Template "${id}" already exists in ${tier} scope`,
      });
    }
    try {
      saveTemplateViaCli(projectRoot, tier, id, {
        name,
        description,
        config,
        params,
        tags,
      });
      res.status(201).json({ ok: true, tier, id });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * PUT /api/projects/:projectId/templates/:tier/:id
   * Body: { name?, description?, config?, params?, tags? }
   */
  router.put('/templates/:tier/:id', (req, res) => {
    const { tier, id } = req.params;
    if (rejectInvalidTierId(res, tier, id)) return;
    if (rejectBuiltinWrite(res, tier, 'update')) return;
    try {
      saveTemplateViaCli(req.project.projectRoot, tier, id, req.body || {});
      res.json({ ok: true, tier, id });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * DELETE /api/projects/:projectId/templates/:tier/:id
   */
  router.delete('/templates/:tier/:id', (req, res) => {
    const { tier, id } = req.params;
    if (rejectInvalidTierId(res, tier, id)) return;
    if (rejectBuiltinWrite(res, tier, 'delete')) return;
    const { projectRoot } = req.project;
    if (!fetchTemplate(projectRoot, tier, id)) {
      return res.status(404).json({
        ok: false,
        error: `Template "${id}" not found in ${tier} scope`,
      });
    }
    try {
      deleteTemplateViaCli(projectRoot, tier, id);
      res.json({ ok: true, deleted: true, tier, id });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * POST /api/projects/:projectId/templates/:tier/:id/duplicate
   * Body: { dst_tier, dst_id }
   */
  router.post('/templates/:tier/:id/duplicate', (req, res) => {
    const { tier: srcTier, id: srcId } = req.params;
    if (rejectInvalidTierId(res, srcTier, srcId)) return;
    const { dst_tier: dstTier, dst_id: dstId } = req.body || {};
    if (!isValidTier(dstTier)) {
      return res.status(400).json({
        ok: false,
        error: `dst_tier must be one of: ${TIERS.join(', ')}`,
      });
    }
    if (rejectBuiltinWrite(res, dstTier, 'duplicate to')) return;
    if (!dstId || !TEMPLATE_RE.test(dstId)) {
      return res.status(400).json({ ok: false, error: 'dst_id is required' });
    }
    try {
      duplicateTemplateViaCli(req.project.projectRoot, srcId, dstId, dstTier);
      res.json({
        ok: true,
        src_tier: srcTier,
        src_id: srcId,
        dst_tier: dstTier,
        dst_id: dstId,
      });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * POST /api/projects/:projectId/templates/:tier/:id/rename
   * Body: { dst_tier, dst_id }
   *
   * Same best-effort composition as before — duplicate then delete.
   * partial_rename (500) when the second leg fails after the first
   * lands on disk.
   */
  router.post('/templates/:tier/:id/rename', (req, res) => {
    const { tier: srcTier, id: srcId } = req.params;
    if (rejectInvalidTierId(res, srcTier, srcId)) return;
    if (rejectBuiltinWrite(res, srcTier, 'rename')) return;
    const { dst_tier: dstTier, dst_id: dstId } = req.body || {};
    if (!isValidTier(dstTier)) {
      return res.status(400).json({
        ok: false,
        error: `dst_tier must be one of: ${TIERS.join(', ')}`,
      });
    }
    if (rejectBuiltinWrite(res, dstTier, 'rename to')) return;
    if (!dstId || !TEMPLATE_RE.test(dstId)) {
      return res.status(400).json({ ok: false, error: 'dst_id is required' });
    }
    if (srcId === dstId && srcTier === dstTier) {
      return res.status(400).json({
        ok: false,
        error: 'No change requested (same tier and id as the source)',
      });
    }

    const { projectRoot } = req.project;
    if (!fetchTemplate(projectRoot, srcTier, srcId)) {
      return res.status(404).json({
        ok: false,
        error: `Template "${srcId}" not found in ${srcTier} scope`,
      });
    }

    try {
      duplicateTemplateViaCli(projectRoot, srcId, dstId, dstTier);
    } catch (err) {
      return res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
    try {
      deleteTemplateViaCli(projectRoot, srcTier, srcId);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        code: 'partial_rename',
        error: `Renamed to "${dstId}" (${dstTier}) but failed to remove the source "${srcId}" (${srcTier}): ${err.message}`,
        src_tier: srcTier,
        src_id: srcId,
        dst_tier: dstTier,
        dst_id: dstId,
      });
    }
    res.json({
      ok: true,
      src_tier: srcTier,
      src_id: srcId,
      dst_tier: dstTier,
      dst_id: dstId,
    });
  });

  /**
   * POST /api/projects/:projectId/templates/:tier/:id/validate
   * Body: { config }
   */
  router.post('/templates/:tier/:id/validate', (req, res) => {
    const { tier, id } = req.params;
    if (rejectInvalidTierId(res, tier, id)) return;
    const { config } = req.body || {};
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return res
        .status(400)
        .json({ ok: false, error: 'config must be a JSON object' });
    }
    try {
      const { issues } = validateConfig(req.project.projectRoot, config);
      res.json({ ok: true, issues });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/projects/:projectId/templates/:tier/:id/bundle
   */
  router.get('/templates/:tier/:id/bundle', (req, res) => {
    const { tier, id } = req.params;
    if (rejectInvalidTierId(res, tier, id)) return;
    try {
      const bundle = exportBundle(req.project.projectRoot, id);
      res.json({ ok: true, bundle });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * PUT /api/projects/:projectId/default-template
   *
   * Body: `{ tier, id }` to set, or `{ tier: null, id: null }` (also
   * accepts `{ id: null }`) to clear. Writes to settings.json under
   * `worca.default_template` as the object shape `{tier, id}`; the
   * Python run-launcher accepts both this and the legacy bare-string
   * form for backward compat.
   */
  router.put('/default-template', (req, res) => {
    const { tier, id } = req.body || {};
    const { settingsPath } = req.project;
    const clearing = !tier && !id;
    if (!clearing) {
      if (!isValidTier(tier)) {
        return res.status(400).json({
          ok: false,
          error: `tier must be one of: ${TIERS.join(', ')}`,
        });
      }
      if (!id || typeof id !== 'string' || !TEMPLATE_RE.test(id)) {
        return res
          .status(400)
          .json({ ok: false, error: 'Invalid template id' });
      }
    }
    try {
      let base = {};
      if (existsSync(settingsPath)) {
        base = JSON.parse(readFileSync(settingsPath, 'utf8')) || {};
      }
      if (!base.worca) base.worca = {};
      if (clearing) {
        delete base.worca.default_template;
      } else {
        base.worca.default_template = { tier, id };
      }
      mkdirSync(dirname(settingsPath), { recursive: true });
      atomicWriteSync(settingsPath, `${JSON.stringify(base, null, 2)}\n`);
      res.json({
        ok: true,
        default_template: base.worca.default_template || null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}
