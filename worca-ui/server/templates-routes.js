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
import { raw as expressRaw, Router } from 'express';
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
const _OVERLAY_NAME_RE = /^[a-z0-9._-]{1,64}\.(md|block\.md)$/;
export { TEMPLATE_RE, TIERS };

function isValidTier(tier) {
  return TIERS.includes(tier);
}
function isMutableTier(tier) {
  return MUTABLE_TIERS.includes(tier);
}

function hasOverlays(tmplDir) {
  const agentsDir = join(tmplDir, 'agents');
  if (!existsSync(agentsDir)) return false;
  try {
    return readdirSync(agentsDir).some((f) => _OVERLAY_NAME_RE.test(f));
  } catch {
    return false;
  }
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
      const tmplDir = join(dir, entry.name);
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
        has_overlays: hasOverlays(tmplDir),
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
    } else if (combined.includes('partial_rename')) {
      code = 'partial_rename';
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

/**
 * Export a template bundle. Returns `{ json, data }` where `json` is
 * true for JSON bundles (data is parsed object) and false for zip bundles
 * (data is raw Buffer with filename in `filename`).
 */
function exportBundle(projectRoot, tier, id) {
  const tierDir = dirForTier(projectRoot, tier);
  const tmplDir = tierDir ? join(tierDir, id) : null;
  const useZip = tmplDir && hasOverlays(tmplDir);

  const dir = mkdtempSync(join(tmpdir(), 'worca-bundle-'));
  try {
    if (useZip) {
      const bundlePath = join(dir, `${id}-bundle.zip`);
      runWorcaTemplates(projectRoot, [
        'export',
        '--to',
        bundlePath,
        '--templates',
        id,
      ]);
      if (existsSync(bundlePath)) {
        return {
          json: false,
          filename: `${id}-bundle.zip`,
          data: readFileSync(bundlePath),
        };
      }
    }

    const bundlePath = join(dir, `${id}.json`);
    runWorcaTemplates(projectRoot, [
      'export',
      '--to',
      bundlePath,
      '--templates',
      id,
    ]);
    if (existsSync(bundlePath)) {
      return { json: true, data: JSON.parse(readFileSync(bundlePath, 'utf8')) };
    }
    return { json: true, data: { templates: [{ id }] } };
  } finally {
    cleanupTemp(dir);
  }
}

function handleZipImport(req, res) {
  const dstTier = req.query.dst_tier;
  if (!isValidTier(dstTier)) {
    return res.status(400).json({
      ok: false,
      error: `dst_tier must be one of: ${TIERS.join(', ')}`,
    });
  }
  if (rejectBuiltinWrite(res, dstTier, 'import to')) return;

  const zipBuffer = req.body;
  const tmpPath = join(
    tmpdir(),
    `worca-import-${Math.random().toString(36).slice(2)}.zip`,
  );
  try {
    writeFileSync(tmpPath, zipBuffer);
    const stdout = runWorcaTemplates(
      req.project.projectRoot,
      ['import', '--from', tmpPath, '--scope', dstTier, '--non-interactive'],
      { timeout: 60000 },
    );
    // Best-effort summary: the CLI may print imported template ids to stdout
    const imported = [];
    for (const line of (stdout || '').split('\n')) {
      const m = line.match(/imported[:\s]+([a-z0-9_-]+)/i);
      if (m) imported.push({ id: m[1], tier: dstTier });
    }
    res.json({ ok: true, count: imported.length || 1, imported });
  } catch (err) {
    res
      .status(statusForCliCode(err.cliCode))
      .json({ ok: false, error: err.message, code: err.cliCode });
  } finally {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

function handleJsonImport(req, res) {
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
      const { projectRoot, settingsPath } = req.project;
      const templates = listTemplatesFlat(projectRoot);
      // Include the project's default_template pointer in the same
      // response so the cards don't render once without the ★ Default
      // badge and then re-render after a second `/settings` round-trip
      // arrives. One request, both bits of state.
      let defaultTemplate = null;
      try {
        if (settingsPath && existsSync(settingsPath)) {
          const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
          defaultTemplate = parsed?.worca?.default_template || null;
        }
      } catch (_err) {
        // Bad settings.json shouldn't break the template list — just
        // omit the default. The Settings tab surfaces the real error.
      }
      res.json({ ok: true, templates, default_template: defaultTemplate });
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
   * Accepts two content types:
   *   application/zip  — raw zip bytes; dst_tier as query param
   *   application/json — { bundle: {templates: [...]}, dst_tier }
   */
  router.post(
    '/templates/import',
    expressRaw({ type: 'application/zip', limit: '1mb' }),
    (req, res) => {
      const ctype = req.headers['content-type'] || '';
      if (ctype.startsWith('application/zip')) {
        return handleZipImport(req, res);
      }
      return handleJsonImport(req, res);
    },
  );

  /**
   * POST /api/projects/:projectId/templates/validate
   * Body: { config }
   *
   * The validator is generic — it only inspects the posted `config`
   * against the schema; the (tier, id) of any existing template are
   * irrelevant. Keep the path tier-free so the editor can probe
   * arbitrary drafts without inventing a placeholder tier/id pair.
   *
   * Registered before `/templates/:tier` (and any other 1-segment
   * route below) so Express doesn't try to match "validate" as a
   * tier parameter.
   */
  router.post('/templates/validate', (req, res) => {
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
   * Delegates to `worca templates rename` — a single CLI call that runs
   * duplicate → pointer-rewrite → delete atomically in one process.
   * partial_rename (500) is surfaced when the CLI reports that duplicate
   * succeeded but delete failed (exit code 3, stderr contains
   * "partial_rename").
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
      runWorcaTemplates(projectRoot, [
        'rename',
        '--src-id', srcId,
        '--src-scope', srcTier,
        '--dst-id', dstId,
        '--dst-scope', dstTier,
      ]);
    } catch (err) {
      if (err.cliCode === 'partial_rename') {
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
      return res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
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
   * GET /api/projects/:projectId/templates/:tier/:id/bundle
   *
   * Auto-detects format: zip when the template has overlays, JSON otherwise.
   * Optional ?format=zip forces zip output.
   */
  router.get('/templates/:tier/:id/bundle', (req, res) => {
    const { tier, id } = req.params;
    if (rejectInvalidTierId(res, tier, id)) return;
    try {
      const result = exportBundle(req.project.projectRoot, tier, id);
      if (!result.json) {
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${result.filename}"`,
        );
        res.send(result.data);
      } else {
        res.json({ ok: true, bundle: result.data });
      }
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * GET /api/projects/:projectId/templates/:tier/:id/overlays
   *
   * Returns every overlay .md file from <tmpl>/agents/, keyed by filename.
   */
  router.get('/templates/:tier/:id/overlays', (req, res) => {
    const { tier, id } = req.params;
    if (rejectInvalidTierId(res, tier, id)) return;
    const { projectRoot } = req.project;
    const tierDir = dirForTier(projectRoot, tier);
    const tmplDir = join(tierDir, id);
    if (!existsSync(join(tmplDir, 'template.json'))) {
      return res.status(404).json({
        ok: false,
        error: `Template "${id}" not found in ${tier} scope`,
      });
    }
    try {
      const agentsDir = join(tmplDir, 'agents');
      const overlays = {};
      if (existsSync(agentsDir)) {
        for (const f of readdirSync(agentsDir)) {
          if (!_OVERLAY_NAME_RE.test(f)) continue;
          try {
            overlays[f] = readFileSync(join(agentsDir, f), 'utf8');
          } catch {
            /* skip unreadable files */
          }
        }
      }
      res.json({ ok: true, overlays });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
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
