/**
 * Fleet REST endpoints (W-040 §13.6).
 *
 * Manifests live at ~/.worca/fleet-runs/<fleet_id>.json.
 * Uploaded guide files land under ~/.worca/fleet-runs/<fleet_id>/guides/.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Router } from 'express';

const DEFAULT_FLEET_RUNS_DIR = join(homedir(), '.worca', 'fleet-runs');
const GUIDE_CAP_BYTES_DEFAULT = 64 * 1024; // 64 KB

// Number of pipeline stages that inject description into their prompt.
const PROMPT_STAGES = 7;

// Fleet IDs have the form f_<12 digits>_<hex>  — enforces no path traversal.
const FLEET_ID_RE = /^f_\d{12}_[0-9a-f]{1,32}$/;

// ─── helpers ───────────────────────────────────────────────────────────────

function validateFleetId(id) {
  return typeof id === 'string' && FLEET_ID_RE.test(id);
}

function manifestFilePath(fleetRunsDir, fleetId) {
  return join(fleetRunsDir, `${fleetId}.json`);
}

function readManifest(fleetRunsDir, fleetId) {
  const p = manifestFilePath(fleetRunsDir, fleetId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function saveManifest(fleetRunsDir, manifest) {
  mkdirSync(fleetRunsDir, { recursive: true });
  const p = manifestFilePath(fleetRunsDir, manifest.fleet_id);
  writeFileSync(p, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return p;
}

function listManifests(fleetRunsDir) {
  if (!existsSync(fleetRunsDir)) return [];
  const out = [];
  for (const file of readdirSync(fleetRunsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const m = JSON.parse(readFileSync(join(fleetRunsDir, file), 'utf8'));
      if (m?.fleet_id) out.push(m);
    } catch {
      // skip malformed
    }
  }
  return out;
}

function resolveChildStatus(child) {
  const { project_path, run_id } = child;
  if (!project_path || !run_id) return 'running';
  const reg = join(
    project_path,
    '.worca',
    'multi',
    'pipelines.d',
    `${run_id}.json`,
  );
  if (!existsSync(reg)) return 'running';
  try {
    return JSON.parse(readFileSync(reg, 'utf8'))?.status ?? 'running';
  } catch {
    return 'running';
  }
}

function enrichChildren(manifest) {
  return (manifest.children ?? []).map((c) => ({
    ...c,
    status: resolveChildStatus(c),
  }));
}

function generateFleetId() {
  const now = new Date();
  const ts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
  ].join('');
  const rand = Math.random().toString(16).slice(2, 10).padStart(8, '0');
  return { fleet_id: `f_${ts}_${rand}`, fleet_id_short: rand };
}

function sanitizeFilename(raw) {
  const name = basename(raw || 'guide')
    .replace(/[/\\]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  return name || 'guide';
}

// ─── multipart parser ──────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a multipart/form-data body into an array of parts.
 * Each part: { name: string|null, filename: string|null, content: Buffer }
 */
function parseMultipart(body, contentType) {
  const m = /boundary=([^\s;,]+)/.exec(contentType);
  if (!m) return null;
  const boundary = m[1].replace(/^["']|["']$/g, '');

  const delim = Buffer.from(`\r\n--${boundary}`);
  const parts = [];

  // Locate the opening delimiter
  const openStr = `--${boundary}\r\n`;
  let pos = body.indexOf(openStr);
  if (pos === -1) return parts;
  pos += openStr.length;

  while (pos < body.length) {
    const end = body.indexOf(delim, pos);
    if (end === -1) break;

    const partBuf = body.slice(pos, end);
    const hdrEnd = partBuf.indexOf('\r\n\r\n');
    if (hdrEnd !== -1) {
      const headerStr = partBuf.slice(0, hdrEnd).toString('utf8');
      const content = partBuf.slice(hdrEnd + 4);

      const headers = {};
      for (const line of headerStr.split('\r\n')) {
        const ci = line.indexOf(':');
        if (ci !== -1) {
          headers[line.slice(0, ci).toLowerCase().trim()] = line
            .slice(ci + 1)
            .trim();
        }
      }

      const cd = headers['content-disposition'] ?? '';
      const nm = /\bname="([^"]+)"/.exec(cd);
      const fn = /\bfilename="([^"]+)"/.exec(cd);

      parts.push({
        name: nm?.[1] ?? null,
        filename: fn?.[1] ?? null,
        content,
      });
    }

    pos = end + delim.length;
    const after = body.slice(pos, pos + 2).toString();
    if (after === '--') break;
    pos += 2;
  }

  return parts;
}

// ─── default injectable implementations ────────────────────────────────────

function defaultValidateBaseBranch(project, branch) {
  try {
    const out = execFileSync(
      'git',
      ['-C', project, 'branch', '--list', branch],
      { encoding: 'utf8' },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function defaultRunCleanup(fleetId) {
  execFileSync('worca', ['cleanup', '--fleet-id', fleetId, '--all']);
  return {};
}

// ─── router factory ────────────────────────────────────────────────────────

/**
 * @param {{
 *   fleetRunsDir?: string,
 *   dispatchFleet?: (args: object) => Promise<object>,
 *   runCleanup?: (fleetId: string) => Promise<object>,
 *   validateBaseBranch?: (project: string, branch: string) => Promise<boolean>,
 *   guideCapBytes?: number,
 * }} opts
 */
export function createFleetRouter({
  fleetRunsDir = DEFAULT_FLEET_RUNS_DIR,
  dispatchFleet = null,
  runCleanup = defaultRunCleanup,
  validateBaseBranch = defaultValidateBaseBranch,
  guideCapBytes = GUIDE_CAP_BYTES_DEFAULT,
} = {}) {
  const router = Router();

  // ── GET /api/fleet-runs ─────────────────────────────────────────────────
  router.get('/', (_req, res) => {
    try {
      const fleets = listManifests(fleetRunsDir).map((m) => ({
        fleet_id: m.fleet_id,
        fleet_id_short: m.fleet_id_short,
        work_request: m.work_request,
        status: m.status,
        halt_reason: m.halt_reason ?? null,
        children_count: (m.children ?? []).length,
        base_branch: m.base_branch ?? null,
        created_at: m.created_at,
        guide: m.guide
          ? {
              bytes: m.guide.bytes,
              filenames: m.guide.filenames,
              uploaded: m.guide.uploaded,
            }
          : null,
      }));
      res.json({ ok: true, fleets });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/fleet-runs/validate-base ──────────────────────────────────
  router.post('/validate-base', async (req, res) => {
    const { projects, base_branch } = req.body ?? {};
    if (!base_branch || typeof base_branch !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'base_branch is required' });
    }
    if (!Array.isArray(projects) || projects.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'projects must be a non-empty array' });
    }

    try {
      const missing_in = [];
      for (const proj of projects) {
        const exists = await validateBaseBranch(proj, base_branch);
        if (!exists) missing_in.push(proj);
      }
      res.json({ ok: missing_in.length === 0, missing_in });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/fleet-runs/estimate ───────────────────────────────────────
  router.post('/estimate', (req, res) => {
    const { guide_bytes = 0, projects = [] } = req.body ?? {};
    const fleet_size = Array.isArray(projects) ? projects.length : 0;
    const guide_tokens_est = Math.ceil(guide_bytes / 4);
    const total_overhead_est = guide_tokens_est * PROMPT_STAGES * fleet_size;
    res.json({
      ok: true,
      guide_bytes,
      guide_tokens_est,
      total_overhead_est,
      fleet_size,
      prompt_stages: PROMPT_STAGES,
    });
  });

  // ── POST /api/fleet-runs ────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    try {
      const contentType = req.headers['content-type'] ?? '';
      const isMultipart = contentType.includes('multipart/form-data');

      let fields = {};
      const guideFiles = []; // [{ filename: string, content: Buffer }]

      if (isMultipart) {
        const rawBody = await readRawBody(req);
        const parts = parseMultipart(rawBody, contentType);
        if (!parts) {
          return res
            .status(400)
            .json({ ok: false, error: 'Failed to parse multipart body' });
        }
        for (const part of parts) {
          if (part.filename != null) {
            guideFiles.push({
              filename: part.filename,
              content: part.content,
            });
          } else if (part.name) {
            fields[part.name] = part.content.toString('utf8');
          }
        }
        if (typeof fields.projects === 'string') {
          try {
            fields.projects = JSON.parse(fields.projects);
          } catch {
            // leave as string
          }
        }
      } else {
        fields = req.body ?? {};
      }

      const {
        projects = [],
        prompt,
        source,
        head_template,
        base_branch,
        plan_mode,
        max_parallel = 5,
        fleet_failure_threshold = 0.3,
      } = fields;

      if (!prompt && !source) {
        return res
          .status(400)
          .json({ ok: false, error: 'prompt or source is required' });
      }

      const { fleet_id, fleet_id_short } = generateFleetId();

      // Save uploaded guide files
      let guideEntry = null;
      if (guideFiles.length > 0) {
        const guidesDir = join(fleetRunsDir, fleet_id, 'guides');
        mkdirSync(guidesDir, { recursive: true });

        const usedNames = new Set();
        const savedPaths = [];
        const savedFilenames = [];
        let totalBytes = 0;

        for (const { filename, content } of guideFiles) {
          let safe = sanitizeFilename(filename);

          if (usedNames.has(safe)) {
            const dot = safe.lastIndexOf('.');
            const nameBase = dot !== -1 ? safe.slice(0, dot) : safe;
            const ext = dot !== -1 ? safe.slice(dot) : '';
            let counter = 1;
            while (usedNames.has(`${nameBase}-${counter}${ext}`)) counter++;
            safe = `${nameBase}-${counter}${ext}`;
          }
          usedNames.add(safe);

          totalBytes += content.length;
          if (totalBytes > guideCapBytes) {
            return res.status(400).json({
              ok: false,
              error: `Guide files exceed size cap of ${guideCapBytes} bytes`,
              guide_bytes: totalBytes,
              cap_bytes: guideCapBytes,
            });
          }

          writeFileSync(join(guidesDir, safe), content);
          savedPaths.push(join(guidesDir, safe));
          savedFilenames.push(safe);
        }

        guideEntry = {
          paths: savedPaths,
          bytes: totalBytes,
          filenames: savedFilenames,
          uploaded: true,
        };
      }

      const manifest = {
        fleet_id,
        fleet_id_short,
        created_at: new Date().toISOString(),
        work_request: {
          title: (prompt || source || '').slice(0, 80),
          description: prompt ?? '',
          source: source ?? null,
        },
        guide: guideEntry,
        plan: { mode: plan_mode ?? 'none', path: null },
        head_template: head_template ?? 'migration/{slug}/{project}',
        base_branch: base_branch ?? null,
        max_parallel: Number(max_parallel) || 5,
        fleet_failure_threshold: Number(fleet_failure_threshold) || 0.3,
        status: 'running',
        halt_reason: null,
        children: [],
      };

      const manifest_path = saveManifest(fleetRunsDir, manifest);

      if (dispatchFleet) {
        try {
          await dispatchFleet({ fleet_id, manifest, manifest_path });
        } catch (err) {
          manifest.status = 'failed';
          saveManifest(fleetRunsDir, manifest);
          return res.status(500).json({
            ok: false,
            error: `Fleet dispatch failed: ${err.message}`,
          });
        }
      }

      res.status(201).json({ ok: true, fleet_id, manifest_path });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/fleet-runs/:id ─────────────────────────────────────────────
  router.get('/:id', (req, res) => {
    const { id } = req.params;
    if (!validateFleetId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid fleet ID' });
    }
    const manifest = readManifest(fleetRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Fleet "${id}" not found` });
    }
    res.json({
      ok: true,
      fleet: { ...manifest, children: enrichChildren(manifest) },
    });
  });

  // ── DELETE /api/fleet-runs/:id ──────────────────────────────────────────
  router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (!validateFleetId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid fleet ID' });
    }

    const manifest = readManifest(fleetRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Fleet "${id}" not found` });
    }

    const { cleanup, force } = req.query;
    const currentStatus = manifest.status;

    // Resume-loss gate: 412 when halted/failed without ?force=1
    if (
      (currentStatus === 'halted' || currentStatus === 'failed') &&
      force !== '1'
    ) {
      return res.status(412).json({
        ok: false,
        error:
          'Fleet is in a resumable state. Pass ?force=1 to confirm cleanup will block future --resume attempts.',
        current_status: currentStatus,
      });
    }

    const enriched = enrichChildren(manifest);
    const halted_count = enriched.filter((c) => c.status === 'pending').length;

    manifest.status = 'halted';
    manifest.halt_reason = 'user';
    manifest.halted_at = new Date().toISOString();
    saveManifest(fleetRunsDir, manifest);

    if (cleanup === '1') {
      let cleanResult = {};
      try {
        cleanResult = (await runCleanup(id)) ?? {};
      } catch (err) {
        return res
          .status(500)
          .json({ ok: false, error: `Cleanup failed: ${err.message}` });
      }
      return res.json({ ok: true, halted_count, ...cleanResult });
    }

    res.json({ ok: true, halted_count });
  });

  // ── POST /api/fleet-runs/:id/resume ────────────────────────────────────
  router.post('/:id/resume', async (req, res) => {
    const { id } = req.params;
    if (!validateFleetId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid fleet ID' });
    }

    const manifest = readManifest(fleetRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Fleet "${id}" not found` });
    }

    if (manifest.status === 'running') {
      return res
        .status(409)
        .json({ ok: false, error: 'Fleet is already running' });
    }

    // 410 when any launched child (has run_id) is missing its registry entry
    const children = manifest.children ?? [];
    const cleanedChildren = children.filter((child) => {
      if (!child.run_id) return false;
      const reg = join(
        child.project_path,
        '.worca',
        'multi',
        'pipelines.d',
        `${child.run_id}.json`,
      );
      return !existsSync(reg);
    });

    if (cleanedChildren.length > 0) {
      return res.status(410).json({
        ok: false,
        error:
          'Resume is unavailable — one or more child worktrees have been cleaned.',
        cleaned_run_ids: cleanedChildren.map((c) => c.run_id),
      });
    }

    manifest.status = 'running';
    manifest.halt_reason = null;
    saveManifest(fleetRunsDir, manifest);

    let relaunched_count = 0;
    if (dispatchFleet) {
      try {
        const result = await dispatchFleet({
          fleet_id: id,
          manifest,
          resume: true,
        });
        relaunched_count = result?.relaunched_count ?? 0;
      } catch (err) {
        return res
          .status(500)
          .json({ ok: false, error: `Resume failed: ${err.message}` });
      }
    }

    res.json({ ok: true, relaunched_count });
  });

  // ── POST /api/fleet-runs/:id/relaunch ───────────────────────────────────
  router.post('/:id/relaunch', async (req, res) => {
    const { id } = req.params;
    if (!validateFleetId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid fleet ID' });
    }

    const manifest = readManifest(fleetRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Fleet "${id}" not found` });
    }

    const overrides = req.body ?? {};
    const { fleet_id: newId, fleet_id_short: newShort } = generateFleetId();

    const newManifest = {
      ...manifest,
      fleet_id: newId,
      fleet_id_short: newShort,
      created_at: new Date().toISOString(),
      status: 'running',
      halt_reason: null,
      children: [],
      work_request: {
        ...manifest.work_request,
        ...(overrides.prompt
          ? {
              description: overrides.prompt,
              title: overrides.prompt.slice(0, 80),
            }
          : {}),
      },
      ...(overrides.head_template != null
        ? { head_template: overrides.head_template }
        : {}),
      ...(overrides.base_branch !== undefined
        ? { base_branch: overrides.base_branch }
        : {}),
    };

    const manifest_path = saveManifest(fleetRunsDir, newManifest);

    if (dispatchFleet) {
      try {
        await dispatchFleet({
          fleet_id: newId,
          manifest: newManifest,
          manifest_path,
        });
      } catch (err) {
        newManifest.status = 'failed';
        saveManifest(fleetRunsDir, newManifest);
        return res
          .status(500)
          .json({ ok: false, error: `Relaunch failed: ${err.message}` });
      }
    }

    res.json({ ok: true, new_fleet_id: newId, manifest_path });
  });

  // ── GET /api/fleet-runs/:id/guide ───────────────────────────────────────
  router.get('/:id/guide', (req, res) => {
    const { id } = req.params;
    if (!validateFleetId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid fleet ID' });
    }

    const manifest = readManifest(fleetRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Fleet "${id}" not found` });
    }

    const guide = manifest.guide;
    if (!guide?.paths?.length) {
      return res
        .status(404)
        .json({ ok: false, error: 'No guide attached to this fleet' });
    }

    const chunks = [];
    for (const guidePath of guide.paths) {
      try {
        chunks.push(readFileSync(guidePath, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'EACCES') {
          return res.status(404).json({
            ok: false,
            error: 'guide_not_retrievable',
            hint: 'Guide was supplied via CLI from a path the UI server cannot read. View the original file on the launching machine.',
          });
        }
        return res.status(500).json({ ok: false, error: err.message });
      }
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(chunks.join('\n\n---\n\n'));
  });

  return router;
}
