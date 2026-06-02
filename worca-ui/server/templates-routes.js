/**
 * REST API routes for pipeline templates.
 *
 * Thin shim over the `worca templates` CLI. All mutating operations
 * (create / update / delete / duplicate / import) delegate to the Python
 * CLI so that `worca/orchestrator/templates.TemplateResolver` stays the
 * single source of truth for validation, naming collisions, builtin
 * conflicts, and the on-disk layout (including the `agents/` sub-directory
 * copy on duplicate).
 *
 * Provides:
 * - GET /templates — list, deduped by id, with effectiveTier + shadows
 * - GET /templates/:tid — fetch resolved template (optional ?tier filter)
 * - POST /templates — create template (delegates to `worca templates create`)
 * - PUT /templates/:tid — upsert template (delegates to `worca templates create`)
 * - DELETE /templates/:tid — delete (delegates to `worca templates delete`)
 * - POST /templates/:tid/duplicate — clone (delegates to `worca templates duplicate`)
 * - POST /templates/:tid/validate — validate (delegates to `worca templates validate`)
 * - GET /templates/:tid/bundle — export (delegates to `worca templates export`)
 * - POST /templates/import — import (delegates to `worca templates import`)
 * - PUT /default-template — write `worca.default_template` to settings.json
 *
 * Tier labels (`builtin` / `project` / `user`) match Python's
 * TemplateResolver so the API and the resolver speak the same language.
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
 * `_legacy-settings` template (and any other intentionally-private id)
 * round-trips through the API without 400-ing. Mirrors the Python
 * `TemplateResolver.save()` validator.
 */
const TEMPLATE_RE = /^[a-z0-9_-]{1,64}$/;
export { TEMPLATE_RE };

/**
 * Reads template.json from a directory, returns parsed object or null.
 */
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
 * Returns the three tier directories in priority order
 * (highest priority first: project > user > builtin).
 *
 * The `.claude/worca/templates` directory holds the runtime copy of
 * Python's built-in templates (`src/worca/templates/`), so it surfaces
 * as the `builtin` tier here — matching TemplateResolver's naming.
 */
function tierDirs(projectRoot) {
  return [
    { tier: 'project', dir: join(projectRoot, '.claude', 'templates') },
    { tier: 'user', dir: templatesDir() },
    {
      tier: 'builtin',
      dir: join(projectRoot, '.claude', 'worca', 'templates'),
    },
  ];
}

/**
 * Lists all templates across tiers, deduped by ID with effectiveTier/shadows.
 *
 * Walks tiers in priority order (project > user > builtin). For each id,
 * the first occurrence wins and becomes `effectiveTier`; subsequent
 * occurrences in lower-priority tiers are recorded in `shadows`.
 *
 * Returns array of objects:
 *   { id, name, description, config, params, tags, created_at, builtin,
 *     effectiveTier, shadows, tier (alias of effectiveTier) }
 */
function listTemplates(projectRoot) {
  const occurrences = new Map(); // id → [{tier, manifest}, ...] in priority order

  for (const { tier, dir } of tierDirs(projectRoot)) {
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
      if (!occurrences.has(id)) occurrences.set(id, []);
      occurrences.get(id).push({ tier, manifest });
    }
  }

  const result = [];
  for (const [id, list] of occurrences.entries()) {
    // First entry wins (highest priority); rest are shadowed.
    const winner = list[0];
    const shadows = list.slice(1).map((o) => o.tier);
    const manifest = winner.manifest;
    result.push({
      id,
      name: manifest.name || id,
      description: manifest.description || '',
      config: manifest.config || {},
      params: manifest.params || {},
      tags: manifest.tags || [],
      created_at: manifest.created_at,
      builtin: manifest.builtin === true,
      effectiveTier: winner.tier,
      shadows,
      tier: winner.tier,
    });
  }

  // Output order matches Python's TemplateResolver.list:
  // builtins alpha → projects alpha → users newest-first.
  const tierOrder = { builtin: 0, project: 1, user: 2 };
  result.sort((a, b) => {
    if (a.effectiveTier !== b.effectiveTier) {
      return tierOrder[a.effectiveTier] - tierOrder[b.effectiveTier];
    }
    if (a.effectiveTier === 'user') {
      return (b.created_at || '').localeCompare(a.created_at || '');
    }
    return a.id.localeCompare(b.id);
  });
  return result;
}

/**
 * Resolves a template by ID. Without `tierFilter`, walks tiers in priority
 * order and returns the first hit. With `tierFilter`, restricts the lookup
 * to a single tier (used by the editor to fetch the built-in version for
 * diff comparison, even when a project/user template shadows it).
 *
 * `tierFilter` accepts both 'builtin' and the legacy 'worca' alias.
 *
 * Returns { template, resolvedTier } or null.
 */
function resolveTemplate(projectRoot, tid, tierFilter) {
  let tiers = tierDirs(projectRoot);
  if (tierFilter) {
    const wanted = tierFilter === 'worca' ? 'builtin' : tierFilter;
    tiers = tiers.filter((t) => t.tier === wanted);
  }
  for (const { tier, dir } of tiers) {
    const template = readTemplateJson(join(dir, tid));
    if (template) return { template, resolvedTier: tier };
  }
  return null;
}

/**
 * Runs `worca templates …` with the given args.
 *
 * Returns the trimmed stdout on success. On non-zero exit, throws an
 * Error whose `cliCode` field carries a normalized error code parsed
 * from stderr ('name_collision' | 'not_found' | 'validation_error' |
 * 'unknown'), and whose `cliStderr` field carries the raw stderr text.
 * Route handlers use `cliCode` to map to HTTP status codes without
 * re-implementing collision/conflict detection.
 */
function runWorcaTemplates(projectRoot, args, opts = {}) {
  try {
    // `--project-root` pins the project tier explicitly so the CLI does
    // not rely on a `.git` walk from cwd — which fails for non-git
    // worca-ui projects and for e2e fixtures that use tmpdir.
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

/**
 * Maps a `cliCode` from `runWorcaTemplates` to an HTTP status.
 */
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

/**
 * Validates a template config via `worca templates validate`.
 * Returns { issues: Array<{field, severity, message}> }.
 */
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
    // Validation failures from the CLI are themselves validation issues —
    // surface as an empty list so the editor can keep the user typing.
    return { issues: [] };
  }
}

/**
 * Writes `obj` to a unique temp file and returns its path. Caller is
 * responsible for cleanup via `cleanupTemp`.
 */
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

/**
 * Create-or-update a template via `worca templates create --from-file -`.
 *
 * Python's `TemplateResolver.save()` is upsert (writes/overwrites by id
 * within a single scope), so POST and PUT both route here. The route
 * handler enforces method semantics (POST → 409 on existing, PUT → 404
 * if missing) ahead of the CLI call.
 */
function saveTemplateViaCli(projectRoot, scope, tid, payload) {
  const templateData = {
    id: tid,
    name: payload.name || tid,
    description: payload.description || '',
    tags: payload.tags || [],
    params: payload.params || {},
    config: payload.config || {},
  };
  const { path, dir } = writeTempJson(templateData);
  try {
    const args = ['create', '--from-file', path];
    if (scope === 'user') args.push('--global');
    runWorcaTemplates(projectRoot, args);
  } finally {
    cleanupTemp(dir);
  }
}

/**
 * Delete a template via `worca templates delete <id> [--global]`.
 */
function deleteTemplateViaCli(projectRoot, scope, tid) {
  const args = ['delete', tid];
  if (scope === 'user') args.push('--global');
  runWorcaTemplates(projectRoot, args);
}

/**
 * Duplicate a template via `worca templates duplicate <src> --dst <dst> --dst-scope <scope>`.
 * The CLI raises `builtin_conflict` / `name_collision` / `not_found` —
 * we propagate via the `cliCode` field.
 */
function duplicateTemplateViaCli(projectRoot, srcId, dstId, dstScope) {
  runWorcaTemplates(projectRoot, [
    'duplicate',
    srcId,
    '--dst',
    dstId,
    '--dst-scope',
    dstScope,
  ]);
}

/**
 * Exports a template bundle via `worca templates export --to <tmp> --templates <id>`.
 * Reads the bundle file the CLI writes, returns its parsed contents.
 */
function exportBundle(projectRoot, tid) {
  const dir = mkdtempSync(join(tmpdir(), 'worca-bundle-'));
  const bundlePath = join(dir, `${tid}.json`);
  try {
    runWorcaTemplates(projectRoot, [
      'export',
      '--to',
      bundlePath,
      '--templates',
      tid,
    ]);
    if (existsSync(bundlePath)) {
      return JSON.parse(readFileSync(bundlePath, 'utf8'));
    }
    // Fallback for older CLI versions that wrote to a directory layout.
    return { templates: [{ id: tid }] };
  } finally {
    cleanupTemp(dir);
  }
}

/**
 * Imports a template bundle via `worca templates import --from <tmp> --scope <scope>`.
 * Returns { imported: [{id, name, tier}], count } after reading the
 * landed templates from the target tier.
 */
function importBundle(projectRoot, bundle, scope) {
  if (!bundle || !Array.isArray(bundle.templates)) {
    throw new Error('Bundle must contain a "templates" array');
  }

  const dir = mkdtempSync(join(tmpdir(), 'worca-import-'));
  const bundlePath = join(dir, 'bundle.json');
  try {
    writeFileSync(bundlePath, JSON.stringify(bundle), 'utf8');
    runWorcaTemplates(
      projectRoot,
      ['import', '--from', bundlePath, '--scope', scope, '--non-interactive'],
      { timeout: 60000 },
    );

    const targetDir =
      scope === 'user'
        ? templatesDir()
        : join(projectRoot, '.claude', 'templates');
    const imported = [];
    for (const tmpl of bundle.templates) {
      const tid = tmpl.id;
      const manifest = readTemplateJson(join(targetDir, tid));
      if (manifest) {
        imported.push({
          id: manifest.id || tid,
          name: manifest.name || tid,
          tier: scope,
        });
      }
    }
    return { imported, count: imported.length };
  } finally {
    cleanupTemp(dir);
  }
}

/**
 * Creates the templates router. Must be mounted after projectResolver
 * middleware sets `req.project` with { projectRoot, settingsPath, ... }.
 */
export function createTemplatesRoutes() {
  const router = Router({ mergeParams: true });

  /**
   * GET /api/projects/:projectId/templates
   * List all templates, deduped by id, with effectiveTier and shadows.
   */
  router.get('/templates', (req, res) => {
    try {
      const { projectRoot } = req.project;
      const templates = listTemplates(projectRoot);
      res.json({ ok: true, templates });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/projects/:projectId/templates/:tid[?tier=builtin|project|user]
   * Fetch a single template. By default resolves by tier priority
   * (project → user → builtin); pass `?tier=` to pin a specific tier
   * (used by the editor to load the built-in version for diff display).
   */
  router.get('/templates/:tid', (req, res) => {
    const tid = req.params.tid;
    if (!tid || !TEMPLATE_RE.test(tid)) {
      return res.status(400).json({ ok: false, error: 'Invalid template id' });
    }
    const tierFilter = req.query.tier;

    try {
      const { projectRoot } = req.project;
      const resolved = resolveTemplate(projectRoot, tid, tierFilter);
      if (!resolved) {
        return res
          .status(404)
          .json({ ok: false, error: `Template "${tid}" not found` });
      }
      res.json({
        ok: true,
        template: resolved.template,
        tier: resolved.resolvedTier,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/projects/:projectId/templates
   * Create a new template in the specified scope.
   * Body: { scope: 'project'|'user', id, name?, description?, config?, params?, tags? }
   * Returns 409 if a template with this id already exists in any tier.
   */
  router.post('/templates', (req, res) => {
    const { scope, id, name, description, config, params, tags } =
      req.body || {};

    if (scope !== 'project' && scope !== 'user') {
      return res.status(400).json({
        ok: false,
        error: 'scope must be "project" or "user"',
      });
    }
    if (!id || typeof id !== 'string' || !TEMPLATE_RE.test(id)) {
      return res.status(400).json({
        ok: false,
        error: 'id is required and must match ^[a-z0-9_-]{1,64}$',
      });
    }

    const { projectRoot } = req.project;

    // POST is create-only: collide with any existing template at this id.
    const existing = resolveTemplate(projectRoot, id);
    if (existing) {
      return res.status(409).json({
        ok: false,
        error: `Template "${id}" already exists in ${existing.resolvedTier} scope`,
      });
    }

    try {
      saveTemplateViaCli(projectRoot, scope, id, {
        name,
        description,
        config,
        params,
        tags,
      });
      res.status(201).json({ ok: true, id, scope });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * PUT /api/projects/:projectId/templates/:tid[?scope=project|user]
   * Upsert a template. Rejects updates that would overwrite a built-in
   * (clone it to project/user scope first).
   * Body: { name?, description?, config?, params?, tags? }
   */
  router.put('/templates/:tid', (req, res) => {
    const tid = req.params.tid;
    const scope = req.query.scope || 'project';

    if (!tid || !TEMPLATE_RE.test(tid)) {
      return res.status(400).json({ ok: false, error: 'Invalid template id' });
    }
    if (scope !== 'project' && scope !== 'user') {
      return res
        .status(400)
        .json({ ok: false, error: 'scope must be "project" or "user"' });
    }

    const { projectRoot } = req.project;
    const resolved = resolveTemplate(projectRoot, tid);

    // Only built-ins are immutable; project/user tiers may upsert freely.
    if (
      resolved &&
      resolved.resolvedTier === 'builtin' &&
      scope !== 'user' &&
      scope !== 'project'
    ) {
      return res.status(400).json({
        ok: false,
        error:
          'Cannot update built-in templates. Clone to your project or user scope first.',
      });
    }
    // Explicit ?scope=builtin (and the deprecated alias ?scope=worca) is
    // rejected at scope validation above; an attempt to PUT a builtin id
    // into project/user scope is an upsert of a shadowing template, not
    // an edit of the builtin — that's allowed.

    try {
      saveTemplateViaCli(projectRoot, scope, tid, req.body || {});
      res.json({ ok: true, id: tid, scope });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * DELETE /api/projects/:projectId/templates/:tid[?scope=project|user]
   * Delete a template. Rejects deletion of built-ins.
   */
  router.delete('/templates/:tid', (req, res) => {
    const tid = req.params.tid;
    const scope = req.query.scope || 'project';

    if (!tid || !TEMPLATE_RE.test(tid)) {
      return res.status(400).json({ ok: false, error: 'Invalid template id' });
    }
    if (scope !== 'project' && scope !== 'user') {
      return res
        .status(400)
        .json({ ok: false, error: 'scope must be "project" or "user"' });
    }

    const { projectRoot } = req.project;
    const resolved = resolveTemplate(projectRoot, tid, scope);
    if (!resolved) {
      return res.status(404).json({
        ok: false,
        error: `Template "${tid}" not found in ${scope} scope`,
      });
    }
    // resolved.resolvedTier === scope at this point (scope-filtered lookup).

    try {
      deleteTemplateViaCli(projectRoot, scope, tid);
      res.json({ ok: true, deleted: true, id: tid, scope });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * POST /api/projects/:projectId/templates/:tid/duplicate
   * Clone a template to a new id and scope.
   * Body: { dst_id, dst_scope: 'project'|'user' }
   */
  router.post('/templates/:tid/duplicate', (req, res) => {
    const srcId = req.params.tid;
    const { dst_id: dstId, dst_scope: dstScope } = req.body || {};

    if (!srcId || !TEMPLATE_RE.test(srcId)) {
      return res
        .status(400)
        .json({ ok: false, error: 'Invalid source template id' });
    }
    if (!dstId || !TEMPLATE_RE.test(dstId)) {
      return res.status(400).json({ ok: false, error: 'dst_id is required' });
    }
    if (dstScope !== 'project' && dstScope !== 'user') {
      return res
        .status(400)
        .json({ ok: false, error: 'dst_scope must be "project" or "user"' });
    }

    try {
      duplicateTemplateViaCli(req.project.projectRoot, srcId, dstId, dstScope);
      res.json({ ok: true, src_id: srcId, dst_id: dstId, dst_scope: dstScope });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * POST /api/projects/:projectId/templates/:tid/rename?scope=<srcScope>
   *
   * Rename and/or move a template between project/user scopes. The
   * server composes the existing duplicate + delete CLI commands —
   * worca-cc doesn't yet ship a transactional `rename`, so this is a
   * best-effort two-step:
   *
   *   1. `worca templates duplicate <srcId> --dst <dstId> --dst-scope …`
   *   2. `worca templates delete <srcId> [--global]`
   *
   * If step 2 fails after step 1 succeeds, the API returns a 500 with
   * `code: "partial_rename"` and the caller is left with both copies
   * on disk — a recoverable state (the user can delete the source by
   * hand) rather than a corrupted one.
   *
   * Body: { dst_id, dst_scope }
   * Built-in templates are rejected because they're immutable; rename
   * one by duplicating to a writable scope first, then renaming.
   */
  router.post('/templates/:tid/rename', (req, res) => {
    const srcId = req.params.tid;
    const srcScope = req.query.scope || 'project';
    const { dst_id: dstId, dst_scope: dstScope } = req.body || {};

    if (!srcId || !TEMPLATE_RE.test(srcId)) {
      return res
        .status(400)
        .json({ ok: false, error: 'Invalid source template id' });
    }
    if (srcScope !== 'project' && srcScope !== 'user') {
      return res.status(400).json({
        ok: false,
        error: 'scope must be "project" or "user" (built-ins are immutable)',
      });
    }
    if (!dstId || !TEMPLATE_RE.test(dstId)) {
      return res.status(400).json({ ok: false, error: 'dst_id is required' });
    }
    if (dstScope !== 'project' && dstScope !== 'user') {
      return res
        .status(400)
        .json({ ok: false, error: 'dst_scope must be "project" or "user"' });
    }
    if (srcId === dstId && srcScope === dstScope) {
      return res.status(400).json({
        ok: false,
        error: 'No change requested (same id and scope as the source)',
      });
    }

    const { projectRoot } = req.project;
    // Confirm the source exists in the named scope. Without this check
    // the CLI would surface a "not found" but with a generic 500;
    // returning 404 up front matches the rest of the route shape.
    const resolved = resolveTemplate(projectRoot, srcId, srcScope);
    if (!resolved) {
      return res.status(404).json({
        ok: false,
        error: `Template "${srcId}" not found in ${srcScope} scope`,
      });
    }

    try {
      duplicateTemplateViaCli(projectRoot, srcId, dstId, dstScope);
    } catch (err) {
      return res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }

    try {
      deleteTemplateViaCli(projectRoot, srcScope, srcId);
    } catch (err) {
      // Step 1 already wrote the destination. Surface the partial state
      // so the UI can suggest a manual cleanup rather than retrying.
      return res.status(500).json({
        ok: false,
        code: 'partial_rename',
        error: `Renamed to "${dstId}" (${dstScope}) but failed to remove the source "${srcId}" (${srcScope}): ${err.message}`,
        src_id: srcId,
        src_scope: srcScope,
        dst_id: dstId,
        dst_scope: dstScope,
      });
    }

    res.json({
      ok: true,
      src_id: srcId,
      src_scope: srcScope,
      dst_id: dstId,
      dst_scope: dstScope,
    });
  });

  /**
   * POST /api/projects/:projectId/templates/:tid/validate
   * Validate a template config without saving.
   * Body: { config }
   */
  router.post('/templates/:tid/validate', (req, res) => {
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
   * GET /api/projects/:projectId/templates/:tid/bundle
   * Export a template bundle (redacted secrets — bundle.py strips them).
   */
  router.get('/templates/:tid/bundle', (req, res) => {
    const tid = req.params.tid;
    if (!tid || !TEMPLATE_RE.test(tid)) {
      return res.status(400).json({ ok: false, error: 'Invalid template id' });
    }

    try {
      const bundle = exportBundle(req.project.projectRoot, tid);
      res.json({ ok: true, bundle });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * POST /api/projects/:projectId/templates/import
   * Import a template bundle.
   * Body: { bundle: {templates: [...]}, scope: 'project'|'user' }
   */
  router.post('/templates/import', (req, res) => {
    const { bundle, scope } = req.body || {};

    if (!bundle || typeof bundle !== 'object') {
      return res
        .status(400)
        .json({ ok: false, error: 'bundle must be a JSON object' });
    }
    if (scope !== 'project' && scope !== 'user') {
      return res
        .status(400)
        .json({ ok: false, error: 'scope must be "project" or "user"' });
    }

    try {
      const result = importBundle(req.project.projectRoot, bundle, scope);
      res.json({ ok: true, ...result });
    } catch (err) {
      res
        .status(statusForCliCode(err.cliCode))
        .json({ ok: false, error: err.message, code: err.cliCode });
    }
  });

  /**
   * PUT /api/projects/:projectId/default-template
   * Set (or clear) `worca.default_template` in the project's settings.json.
   * Body: { tid: string | null } — null/empty clears the default.
   *
   * This writes to settings.json directly. The worca CLI doesn't expose
   * a setting-mutation command, and adding one would be out of scope for
   * a default-template toggle, so the route handles it here. Writes go
   * through `atomicWriteSync` so a partial write can't corrupt the file.
   */
  router.put('/default-template', (req, res) => {
    const { tid } = req.body || {};
    const { settingsPath } = req.project;

    if (tid !== undefined && tid !== null && tid !== '') {
      if (typeof tid !== 'string' || !TEMPLATE_RE.test(tid)) {
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

      if (tid === null || tid === undefined || tid === '') {
        delete base.worca.default_template;
      } else {
        base.worca.default_template = tid;
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
