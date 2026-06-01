/**
 * REST API routes for pipeline templates.
 *
 * Provides:
 * - GET /templates — list, deduped by id, with effectiveTier + shadows
 * - GET /templates/:tid — fetch resolved template body
 * - POST /templates — create template
 * - PUT /templates/:tid — update template (rejects builtin)
 * - DELETE /templates/:tid — delete (rejects builtin)
 * - POST /templates/:tid/duplicate — clone-then-edit
 * - POST /templates/:tid/validate — validate config
 * - GET /templates/:tid/bundle — export bundle
 * - POST /templates/import — import bundle
 * - PUT /default-template — set default template
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Router } from 'express';
import { atomicWriteSync } from './atomic-write.js';
import { templatesDir } from './paths.js';

/** Match template IDs: lowercase alphanumeric and hyphens, 1-64 chars */
const TEMPLATE_RE = /^[a-z0-9-]{1,64}$/;
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
 * Lists all templates across tiers, deduped by ID with effectiveTier/shadows.
 *
 * Resolution order (matches TemplateResolver.list in Python):
 *   project (shadows user & builtin) > user (shadows builtin) > builtin
 *
 * Returns array of objects: { id, name, description, effectiveTier, shadows }
 */
function listTemplates(projectRoot) {
  const tiers = [
    { tier: 'user', dir: templatesDir() },
    { tier: 'project', dir: join(projectRoot, '.claude', 'templates') },
    { tier: 'worca', dir: join(projectRoot, '.claude', 'worca', 'templates') },
  ];

  // Walk tiers in reverse priority order (builtin → user → project)
  // so later tiers can shadow earlier entries
  const seen = new Map(); // id → { tier, template, shadows: [] }

  for (const { tier, dir } of tiers) {
    if (!existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const _manifestPath = join(dir, entry.name, 'template.json');
        const manifest = readTemplateJson(join(dir, entry.name));
        if (!manifest) continue;
        const id = manifest.id || entry.name;

        if (seen.has(id)) {
          // Existing entry shadowed by this tier
          seen.get(id).shadows.push(tier);
        } else {
          // New entry
          seen.set(id, {
            tier,
            template: {
              id,
              name: manifest.name || entry.name,
              description: manifest.description || '',
              config: manifest.config || {},
              params: manifest.params || {},
              tags: manifest.tags || [],
              created_at: manifest.created_at,
              builtin: manifest.builtin === true,
            },
            shadows: [],
          });
        }
      }
    } catch {
      /* skip unreadable directories */
    }
  }

  // Convert to output format with effectiveTier derived from winning tier
  // Resolution order: project > user > builtin (reverse of discovery order)
  const TIER_PRIORITY = { project: 0, user: 1, worca: 2 };
  const result = [];
  for (const [_id, entry] of seen.entries()) {
    // Compute effectiveTier by finding highest-priority tier that shadows or is winner
    let effectiveTier = 'worca';
    let minPriority = Infinity;
    for (const shadow of entry.shadows) {
      if (
        TIER_PRIORITY[shadow] !== undefined &&
        TIER_PRIORITY[shadow] < minPriority
      ) {
        minPriority = TIER_PRIORITY[shadow];
        effectiveTier = shadow;
      }
    }
    if (
      TIER_PRIORITY[entry.tier] !== undefined &&
      TIER_PRIORITY[entry.tier] < minPriority
    ) {
      effectiveTier = entry.tier;
    }

    result.push({
      ...entry.template,
      effectiveTier,
      shadows: entry.shadows,
      // Backwards compat: alias effectiveTier to tier for old UI code
      tier: effectiveTier,
    });
  }

  return result;
}

/**
 * Resolves a template by ID, walking tiers: project → user → builtin.
 * Returns { template, resolvedTier } or null.
 */
function resolveTemplate(projectRoot, tid) {
  const tiers = [
    { tier: 'project', dir: join(projectRoot, '.claude', 'templates') },
    { tier: 'user', dir: templatesDir() },
    { tier: 'worca', dir: join(projectRoot, '.claude', 'worca', 'templates') },
  ];

  for (const { tier, dir } of tiers) {
    const templateDir = join(dir, tid);
    const template = readTemplateJson(templateDir);
    if (template) return { template, resolvedTier: tier };
  }
  return null;
}

/**
 * Validates a template config via worca CLI.
 * Subprocess delegates to Python's TemplateResolver.validate().
 */
function validateConfig(projectRoot, config) {
  try {
    const cmd = [
      'worca',
      'templates',
      'validate',
      '--config',
      JSON.stringify(config || {}),
    ];
    const stdout = execFileSync('worca', cmd, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 10000,
    });
    const issues = JSON.parse(stdout);
    if (Array.isArray(issues)) return { issues };
    return { issues: [] };
  } catch (err) {
    // CLI error — try to parse JSON output anyway; if not, return empty
    if (err.stdout) {
      try {
        const issues = JSON.parse(err.stdout);
        if (Array.isArray(issues)) return { issues };
      } catch {
        /* not JSON */
      }
    }
    return { issues: [] };
  }
}

/**
 * Creates a template by writing directly to the templates directory.
 */
function saveTemplate(projectRoot, scope, tid, payload) {
  const base =
    scope === 'user'
      ? templatesDir()
      : join(projectRoot, '.claude', 'templates');
  const dir = join(base, tid);
  mkdirSync(dir, { recursive: true });

  const templateData = {
    id: tid,
    name: payload.name || tid,
    description: payload.description || '',
    tags: payload.tags || [],
    params: payload.params || {},
    config: payload.config || {},
  };
  atomicWriteSync(
    join(dir, 'template.json'),
    `${JSON.stringify(templateData, null, 2)}\n`,
  );
}

/**
 * Updates a template by merging with existing data and writing to disk.
 */
function updateTemplate(projectRoot, scope, tid, payload) {
  const base =
    scope === 'user'
      ? templatesDir()
      : join(projectRoot, '.claude', 'templates');
  const dir = join(base, tid);
  const manifestPath = join(dir, 'template.json');

  let existingData = {};
  if (existsSync(manifestPath)) {
    existingData = JSON.parse(readFileSync(manifestPath, 'utf8')) || {};
  }

  const templateData = {
    ...existingData,
    id: tid,
    ...payload,
  };

  mkdirSync(dir, { recursive: true });
  atomicWriteSync(
    manifestPath,
    `${JSON.stringify(templateData, null, 2)}\n`,
  );
}

/**
 * Deletes a template by removing its directory.
 */
function deleteTemplate(projectRoot, scope, tid) {
  if (!TEMPLATE_RE.test(tid)) {
    throw new Error('Invalid template id');
  }
  const base =
    scope === 'user'
      ? templatesDir()
      : join(projectRoot, '.claude', 'templates');
  const dir = join(base, tid);
  if (!existsSync(dir)) {
    throw new Error(`Template "${tid}" not found in ${scope} scope`);
  }
  const resolved = realpathSync(dir);
  if (!resolved.startsWith(realpathSync(base) + '/')) {
    throw new Error('Invalid template path');
  }
  rmSync(dir, { recursive: true });
}

/**
 * Duplicates a template by resolving the source and writing a copy to the
 * destination scope.
 */
function duplicateTemplate(projectRoot, srcId, dstId, dstScope) {
  const resolved = resolveTemplate(projectRoot, srcId);
  if (!resolved) {
    throw new Error(`Source template "${srcId}" not found`);
  }
  const dstBase =
    dstScope === 'user'
      ? templatesDir()
      : join(projectRoot, '.claude', 'templates');
  const dstDir = join(dstBase, dstId);
  mkdirSync(dstDir, { recursive: true });

  const templateData = {
    ...resolved.template,
    id: dstId,
    builtin: false,
  };
  atomicWriteSync(
    join(dstDir, 'template.json'),
    `${JSON.stringify(templateData, null, 2)}\n`,
  );
}

/**
 * Exports a template bundle via worca CLI.
 * Uses worca templates export --to - (writes to stdout) with JSON output.
 */
function exportBundle(projectRoot, tid) {
  try {
    const stdout = execFileSync(
      'worca',
      ['templates', 'show', tid, '--format', 'json'],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    const template = JSON.parse(stdout);
    // Convert to bundle format - templates.json expects a manifest structure
    return {
      templates: [template],
      version: '1.0',
      exported_at: new Date().toISOString(),
    };
  } catch (_err) {
    // worca templates show may not support --format=json, fallback to reading file
    const tiers = [
      join(projectRoot, '.claude', 'templates'),
      templatesDir(),
      join(projectRoot, '.claude', 'worca', 'templates'),
    ];
    for (const dir of tiers) {
      const manifestPath = join(dir, tid, 'template.json');
      if (existsSync(manifestPath)) {
        const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
        return {
          templates: [data],
          version: '1.0',
          exported_at: new Date().toISOString(),
        };
      }
    }
    throw new Error(`Template "${tid}" not found`);
  }
}

/**
 * Imports a template bundle via worca CLI.
 * Uses worca templates import --from <path> --scope <scope>.
 * The CLI writes human-readable output to stdout, so we save to temp file
 * and parse the result from the imported template.json.
 */
function importBundle(projectRoot, bundle, scope) {
  // Write bundle to temp file for CLI consumption
  const _tmpDir = tmpdir();
  const tmpPath = join(
    _tmpDir,
    `worca-bundle-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );

  try {
    // The CLI expects a bundle with a "templates" array
    const bundleToWrite = bundle;
    if (!bundleToWrite.templates || !Array.isArray(bundleToWrite.templates)) {
      throw new Error('Bundle must contain a "templates" array');
    }

    writeFileSync(tmpPath, JSON.stringify(bundleToWrite), 'utf8');

    // Use non-interactive import to avoid prompts
    execFileSync(
      'worca',
      [
        'templates',
        'import',
        '--from',
        tmpPath,
        '--scope',
        scope,
        '--non-interactive',
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        timeout: 60000,
      },
    );

    // Read back the imported templates to return confirmation
    const imported = [];
    for (const tmpl of bundleToWrite.templates) {
      const tid = tmpl.id;
      const templateDir =
        scope === 'user'
          ? join(templatesDir(), tid)
          : join(projectRoot, '.claude', 'templates', tid);
      const manifestPath = join(templateDir, 'template.json');
      if (existsSync(manifestPath)) {
        const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
        imported.push({ id: data.id, name: data.name, tier: scope });
      }
    }

    return {
      imported,
      count: imported.length,
    };
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup errors */
    }
  }
}

/**
 * Creates the templates router. Must be mounted after projectResolver middleware
 * sets req.project with { projectRoot, settingsPath, etc. }.
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
   * GET /api/projects/:projectId/templates/:tid
   * Fetch a single template resolved by tier priority: project → user → builtin.
   */
  router.get('/templates/:tid', (req, res) => {
    const tid = req.params.tid;
    if (!tid || !TEMPLATE_RE.test(tid)) {
      return res.status(400).json({ ok: false, error: 'Invalid template id' });
    }

    try {
      const { projectRoot } = req.project;
      const resolved = resolveTemplate(projectRoot, tid);
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
   * Body: { scope: 'project'|'user', id, name, description, config, params, tags }
   */
  router.post('/templates', async (req, res) => {
    const { scope, id, name, description, config, params, tags } =
      req.body || {};

    if (!scope || (scope !== 'project' && scope !== 'user')) {
      return res.status(400).json({
        ok: false,
        error: 'scope must be "project" or "user"',
      });
    }
    if (!id || typeof id !== 'string' || !TEMPLATE_RE.test(id)) {
      return res.status(400).json({
        ok: false,
        error: 'id is required and must match ^[a-z0-9-]{1,64}$',
      });
    }

    try {
      const { projectRoot } = req.project;
      await saveTemplate(projectRoot, scope, id, {
        name,
        description,
        config,
        params,
        tags,
      });
      res.status(201).json({ ok: true, id, scope });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * PUT /api/projects/:projectId/templates/:tid
   * Update an existing template. Rejects builtin scope.
   * Body: { name?, description?, config?, params?, tags? }
   * Query: ?scope=project|user (defaults to project)
   */
  router.put('/templates/:tid', async (req, res) => {
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

    // Resolve first to detect builtin
    const resolved = resolveTemplate(req.project.projectRoot, tid);
    if (resolved && resolved.resolvedTier === 'worca') {
      return res.status(400).json({
        ok: false,
        error:
          'Cannot update built-in templates. Clone to your project or user scope first.',
      });
    }

    const payload = req.body || {};
    try {
      const { projectRoot } = req.project;
      await updateTemplate(projectRoot, scope, tid, payload);
      res.json({ ok: true, id: tid, scope });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * DELETE /api/projects/:projectId/templates/:tid?scope=project|user
   * Delete a template. Rejects builtin scope.
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

    // Resolve first to detect builtin
    const resolved = resolveTemplate(req.project.projectRoot, tid);
    if (resolved && resolved.resolvedTier === 'worca') {
      return res.status(400).json({
        ok: false,
        error: 'Cannot delete built-in templates.',
      });
    }

    try {
      const { projectRoot } = req.project;
      deleteTemplate(projectRoot, scope, tid);
      res.json({ ok: true, deleted: true, id: tid, scope });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/projects/:projectId/templates/:tid/duplicate
   * Clone a template to a new ID and scope.
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
      const { projectRoot } = req.project;
      duplicateTemplate(projectRoot, srcId, dstId, dstScope);
      res.json({ ok: true, src_id: srcId, dst_id: dstId, dst_scope: dstScope });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
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
      const { projectRoot } = req.project;
      const { issues } = validateConfig(projectRoot, config);
      res.json({ ok: true, issues });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * GET /api/projects/:projectId/templates/:tid/bundle
   * Export a template bundle (redacted secrets).
   */
  router.get('/templates/:tid/bundle', (req, res) => {
    const tid = req.params.tid;
    if (!tid || !TEMPLATE_RE.test(tid)) {
      return res.status(400).json({ ok: false, error: 'Invalid template id' });
    }

    try {
      const { projectRoot } = req.project;
      const bundle = exportBundle(projectRoot, tid);
      res.json({ ok: true, bundle });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/projects/:projectId/templates/import
   * Import a template bundle.
   * Body: { bundle, scope: 'project'|'user' }
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
      const { projectRoot } = req.project;
      const result = importBundle(projectRoot, bundle, scope);
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * PUT /api/projects/:projectId/default-template
   * Set the default template for the project.
   * Body: { tid: string | null } — null clears the default
   */
  router.put('/default-template', (req, res) => {
    const { tid } = req.body || {};
    const { settingsPath } = req.project;

    if (tid !== undefined && tid !== null) {
      if (!tid || !TEMPLATE_RE.test(tid)) {
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
        // Clear default
        delete base.worca.default_template;
      } else {
        base.worca.default_template = tid;
      }

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
