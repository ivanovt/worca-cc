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
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { Router } from 'express';
import { fleetRunsDir as resolveFleetRunsDir } from './paths.js';

const GUIDE_CAP_BYTES_DEFAULT = 64 * 1024; // 64 KB

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
  // Atomic write: temp file + rename, mirroring write_fleet_manifest() in
  // src/worca/orchestrator/fleet_manifest.py. Without this a concurrent
  // reader (WS watcher, listManifests) can see a half-written file and
  // swallow a parse error — surfacing as a transient blank fleet event.
  // The temp suffix avoids the watcher's `.json` filename filter.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(tmp, p);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
    throw err;
  }
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

function _readChildRegistry(child) {
  const { project_path, run_id } = child;
  if (!project_path || !run_id) return null;
  const reg = join(
    project_path,
    '.worca',
    'multi',
    'pipelines.d',
    `${run_id}.json`,
  );
  if (!existsSync(reg)) return null;
  try {
    return JSON.parse(readFileSync(reg, 'utf8'));
  } catch {
    return null;
  }
}

function resolveChildStatus(child) {
  return _readChildRegistry(child)?.status ?? 'running';
}

// Reverse-lookup: scan every registered project's pipelines.d/ for runs that
// reference this fleet_id. Acts as a self-healing fallback when the manifest's
// children array was never populated (older dispatcher path) or when a child
// race-wrote its registry entry before the manifest update landed. Cheap:
// pipelines.d/ entries are already on disk, and the UI reads them anyway.
function _discoverChildrenFromRegistry(fleetId, prefsDir) {
  if (!fleetId || !prefsDir) return [];
  const projectsDir = join(prefsDir, 'projects.d');
  if (!existsSync(projectsDir)) return [];
  const discovered = [];
  let projectFiles;
  try {
    projectFiles = readdirSync(projectsDir);
  } catch {
    return [];
  }
  for (const file of projectFiles) {
    if (!file.endsWith('.json')) continue;
    let project;
    try {
      project = JSON.parse(readFileSync(join(projectsDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!project?.path) continue;
    const pipesDir = join(project.path, '.worca', 'multi', 'pipelines.d');
    if (!existsSync(pipesDir)) continue;
    let runFiles;
    try {
      runFiles = readdirSync(pipesDir);
    } catch {
      continue;
    }
    for (const f of runFiles) {
      if (!f.endsWith('.json')) continue;
      let entry;
      try {
        entry = JSON.parse(readFileSync(join(pipesDir, f), 'utf8'));
      } catch {
        continue;
      }
      if (entry?.fleet_id === fleetId && entry?.run_id) {
        discovered.push({
          project_path: project.path,
          run_id: entry.run_id,
        });
      }
    }
  }
  return discovered;
}

function _mergeChildren(manifestChildren, discoveredChildren) {
  const seen = new Set();
  const out = [];
  const keyOf = (c) => `${c.project_path ?? ''}\0${c.run_id ?? ''}`;
  for (const c of manifestChildren ?? []) {
    const k = keyOf(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  for (const c of discoveredChildren) {
    const k = keyOf(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function _resolveChildren(manifest, prefsDir) {
  const discovered = _discoverChildrenFromRegistry(manifest.fleet_id, prefsDir);
  return _mergeChildren(manifest.children, discovered);
}

function enrichChildren(manifest, prefsDir) {
  return _resolveChildren(manifest, prefsDir).map((c) => ({
    ...c,
    status: resolveChildStatus(c),
  }));
}

/**
 * Aggregate fleet-level metrics from the manifest plus each child's live
 * pipeline-registry entry. Returns:
 *   { children, cost_usd, last_activity_at }
 *
 * - `children`: compact records carrying the live status (not the stale
 *   manifest status) so the UI's fleet-card status tiles are accurate.
 * - `cost_usd`: sum of `iter.cost_usd` across every stage iteration of
 *   every dispatched child.
 * - `last_activity_at`: the latest `last_event_at` / `completed_at` /
 *   `started_at` observed across children, falling back to the manifest's
 *   `updated_at` when no child has reported yet.
 *
 * Cheap: each fleet's pipelines.d/<run_id>.json is already on disk and we
 * read it once per child; the dashboard previously did the same work
 * client-side via WS-pushed Run records, so the I/O is comparable.
 */
function aggregateFleetMetrics(manifest, prefsDir) {
  let cost_usd = 0;
  let last_activity_at = manifest.updated_at ?? null;
  const children = _resolveChildren(manifest, prefsDir).map((c) => {
    const reg = _readChildRegistry(c);
    const compact = {
      project_path: c.project_path,
      run_id: c.run_id ?? null,
      status: reg?.status ?? c.status ?? 'pending',
    };
    if (reg) {
      for (const stage of Object.values(reg.stages ?? {})) {
        for (const iter of stage.iterations ?? []) {
          cost_usd += iter.cost_usd ?? 0;
        }
      }
      const ts =
        reg.last_event_at ?? reg.completed_at ?? reg.started_at ?? null;
      if (ts && (!last_activity_at || ts > last_activity_at)) {
        last_activity_at = ts;
      }
    }
    return compact;
  });
  return { children, cost_usd, last_activity_at };
}

// ─── fleet status derivation ───────────────────────────────────────────────
//
// JS port of derive_fleet_status / poll_and_update_fleet_manifest from
// src/worca/orchestrator/fleet_manifest.py. The Python poller is only wired
// into tests — in production nothing re-derives a fleet's status after
// run_fleet.py exits (it launches detached children and returns within
// seconds, long before any child finishes). Without this server-side
// reconcile the manifest's stored `status` is frozen at "running" forever.

const _RUNNING_STATES = new Set(['running', 'resuming', 'paused']);
const _FAILURE_STATES = new Set(['failed', 'setup_failed', 'unrecoverable']);
// `interrupted` / `cancelled` are terminal-but-not-completed (and NOT
// failures — a deliberate stop must not inflate the circuit-breaker ratio).
const _TERMINAL_STATES = new Set([
  'completed',
  'interrupted',
  'cancelled',
  ..._FAILURE_STATES,
]);

/**
 * Pure derivation of fleet status from a list of child pipeline statuses.
 * Mirrors derive_fleet_status() in fleet_manifest.py. Exported for tests.
 *
 * @param {string[]} childStatuses
 * @param {number} threshold circuit-breaker failure ratio (default 0.30)
 * @returns {{ status: string, halt_reason: string|null }}
 */
export function deriveFleetStatus(childStatuses, threshold = 0.3) {
  if (!childStatuses.length) return { status: 'running', halt_reason: null };

  const total = childStatuses.length;
  const runningCount = childStatuses.filter((s) =>
    _RUNNING_STATES.has(s),
  ).length;
  const completedCount = childStatuses.filter((s) => s === 'completed').length;
  const failedCount = childStatuses.filter((s) =>
    _FAILURE_STATES.has(s),
  ).length;
  const terminalCount = childStatuses.filter((s) =>
    _TERMINAL_STATES.has(s),
  ).length;

  // Circuit breaker fires only while in-flight children still exist.
  if (runningCount > 0) {
    const minTerminal = Math.min(3, total);
    if (
      terminalCount >= minTerminal &&
      failedCount > 0 &&
      failedCount / terminalCount >= threshold
    ) {
      return { status: 'halted', halt_reason: 'circuit_breaker' };
    }
    return { status: 'running', halt_reason: null };
  }

  // All dispatched children are terminal.
  if (terminalCount === total) {
    return completedCount === total
      ? { status: 'completed', halt_reason: null }
      : { status: 'failed', halt_reason: null };
  }

  // Pending / untracked children not yet dispatched.
  return { status: 'running', halt_reason: null };
}

/**
 * Pure decision: given a manifest and live child statuses, return the
 * effective { status, halt_reason } the API/WS should report. Persists
 * nothing — safe for use in side-effect-free contexts (WS watcher).
 *
 * Sticky states are never re-derived:
 *   - halted / paused — operator actions (Halt / Stop / Pause), held until
 *     an explicit resume
 *   - completed / failed — terminal; only resume / relaunch leaves them
 * Only `running` and `resuming` reconcile. From `resuming` the status may
 * only advance to `running` — never straight to a terminal status, since a
 * just-resumed fleet's children may still carry their pre-resume terminal
 * registry state for a beat before the resumed runners flip them back.
 *
 * @param {object} manifest
 * @param {string[]} childStatuses
 * @returns {{ status: string, halt_reason: string|null }}
 */
export function effectiveFleetStatus(manifest, childStatuses) {
  const current = manifest.status ?? 'running';
  if (current !== 'running' && current !== 'resuming') {
    return { status: current, halt_reason: manifest.halt_reason ?? null };
  }

  const threshold = manifest.fleet_failure_threshold ?? 0.3;
  const { status, halt_reason } = deriveFleetStatus(childStatuses, threshold);

  if (current === 'resuming' && status !== 'running') {
    return { status: 'resuming', halt_reason: manifest.halt_reason ?? null };
  }
  return { status, halt_reason };
}

/**
 * Reconcile a manifest's stored status against the live child statuses and,
 * when it changed, persist it back. Returns the effective
 * { status, halt_reason } the API should report. Wraps effectiveFleetStatus
 * with persistence — the WS watcher should call effectiveFleetStatus instead
 * to avoid a write→watch→write loop.
 */
function reconcileFleetStatus(manifest, childStatuses, fleetRunsDir) {
  const current = manifest.status ?? 'running';
  const { status, halt_reason } = effectiveFleetStatus(manifest, childStatuses);

  if (status !== current || halt_reason !== (manifest.halt_reason ?? null)) {
    manifest.status = status;
    if (halt_reason != null) {
      manifest.halt_reason = halt_reason;
    } else if (status !== 'halted') {
      manifest.halt_reason = null;
    }
    manifest.updated_at = new Date().toISOString();
    try {
      saveManifest(fleetRunsDir, manifest);
    } catch {
      // Best-effort persistence — the derived value is still returned, and
      // the next read re-derives it anyway.
    }
  }
  return { status, halt_reason };
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

// run_fleet.py --pause / --stop fan a control file out to every in-flight
// child and stamp the manifest (paused / halted+stopped). They print
// "paused N in-flight…" / "stopped N…" — parse N back out for the response.
// fleetId is validated against FLEET_ID_RE before reaching here, and
// execFileSync (no shell) means no injection surface regardless.
function _runFleetLifecycle(flag, fleetId) {
  const out = execFileSync(
    'python3',
    ['-m', 'worca.scripts.run_fleet', flag, fleetId],
    { encoding: 'utf8' },
  );
  const m = /(\d+)/.exec(out || '');
  return m ? Number(m[1]) : 0;
}

function defaultPauseFleet(fleetId) {
  return { paused_count: _runFleetLifecycle('--pause', fleetId) };
}

function defaultStopFleet(fleetId) {
  return { stopped_count: _runFleetLifecycle('--stop', fleetId) };
}

// ─── router factory ────────────────────────────────────────────────────────

/**
 * @param {{
 *   fleetRunsDir?: string,
 *   prefsDir?: string,
 *   dispatchFleet?: (args: object) => Promise<object>,
 *   runCleanup?: (fleetId: string) => Promise<object>,
 *   pauseFleet?: (fleetId: string) => object,
 *   stopFleet?: (fleetId: string) => object,
 *   validateBaseBranch?: (project: string, branch: string) => Promise<boolean>,
 *   guideCapBytes?: number,
 * }} opts
 *
 * `prefsDir` enables the reverse-lookup path: when a fleet manifest's
 * `children` array is empty (older dispatcher) or out-of-sync, the router
 * scans every project under `<prefsDir>/projects.d/` for pipelines.d/
 * entries that reference the fleet_id and includes them in the response.
 */
export function createFleetRouter({
  fleetRunsDir: fleetRunsDirArg,
  prefsDir = null,
  dispatchFleet = null,
  runCleanup = defaultRunCleanup,
  pauseFleet = defaultPauseFleet,
  stopFleet = defaultStopFleet,
  validateBaseBranch = defaultValidateBaseBranch,
  guideCapBytes = GUIDE_CAP_BYTES_DEFAULT,
} = {}) {
  // Lazy resolution honors $WORCA_HOME at router-construction time, falling
  // back to ~/.worca/fleet-runs.  Issue #162.
  const fleetRunsDir = resolveFleetRunsDir(fleetRunsDirArg);
  const router = Router();

  // ── GET /api/fleet-runs ─────────────────────────────────────────────────
  //
  // Returns a list of fleet summaries. The payload includes a compact
  // `children` array (one slim record per dispatched child) so the UI can
  // render `fleetCardView` with the children strip without an extra
  // round-trip per fleet. The full per-child registry entry is still
  // fetched lazily via GET /api/fleet-runs/:id when the user drills in.
  router.get('/', (_req, res) => {
    try {
      const fleets = listManifests(fleetRunsDir).map((m) => {
        const agg = aggregateFleetMetrics(m, prefsDir);
        // Reconcile the stored status against the children's live registry
        // statuses — run_fleet.py never writes a terminal status back.
        const { status, halt_reason } = reconcileFleetStatus(
          m,
          agg.children.map((c) => c.status),
          fleetRunsDir,
        );
        return {
          fleet_id: m.fleet_id,
          fleet_id_short: m.fleet_id_short,
          work_request: m.work_request,
          status,
          halt_reason,
          halted_at: m.halted_at ?? null,
          archived: m.archived === true,
          archived_at: m.archived_at ?? null,
          children_count: agg.children.length,
          children: agg.children,
          head_template: m.head_template ?? null,
          base_branch: m.base_branch ?? null,
          plan: m.plan ? { mode: m.plan.mode ?? 'none' } : { mode: 'none' },
          created_at: m.created_at,
          updated_at: m.updated_at ?? null,
          last_activity_at: agg.last_activity_at,
          cost_usd: agg.cost_usd,
          guide: m.guide
            ? {
                bytes: m.guide.bytes,
                filenames: m.guide.filenames,
                uploaded: m.guide.uploaded,
              }
            : null,
        };
      });
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

      // Save uploaded guide files.
      // Validate total size BEFORE writing anything to disk — partial writes
      // would leave orphan files under <fleet_id>/guides/ that no manifest
      // points at (cleanup wouldn't find them).
      let guideEntry = null;
      if (guideFiles.length > 0) {
        const totalBytes = guideFiles.reduce(
          (sum, f) => sum + f.content.length,
          0,
        );
        if (totalBytes > guideCapBytes) {
          return res.status(400).json({
            ok: false,
            error: `Guide files exceed size cap of ${guideCapBytes} bytes`,
            guide_bytes: totalBytes,
            cap_bytes: guideCapBytes,
          });
        }

        // Resolve every filename to a unique sanitized name first — no I/O yet.
        const usedNames = new Set();
        const planned = guideFiles.map(({ filename, content }) => {
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
          return { safe, content };
        });

        // Now write — total size is validated, no orphan files possible.
        const guidesDir = join(fleetRunsDir, fleet_id, 'guides');
        mkdirSync(guidesDir, { recursive: true });
        const savedPaths = [];
        const savedFilenames = [];
        for (const { safe, content } of planned) {
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
          await dispatchFleet({
            fleet_id,
            manifest,
            manifest_path,
            projects,
          });
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
    const children = enrichChildren(manifest, prefsDir);
    // Reconcile the stored status against the children's live registry
    // statuses — run_fleet.py never writes a terminal status back.
    const { status, halt_reason } = reconcileFleetStatus(
      manifest,
      children.map((c) => c.status),
      fleetRunsDir,
    );
    res.json({
      ok: true,
      fleet: { ...manifest, status, halt_reason, children },
    });
  });

  // ── POST /api/fleet-runs/:id/archive ────────────────────────────────────
  // Hides a terminal fleet from the default list. Mirrors the pipeline
  // run archive endpoint: refuses to archive an in-flight fleet, idempotent
  // when already archived, stamps `archived` + `archived_at` on the manifest.
  router.post('/:id/archive', (req, res) => {
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
    if (manifest.status === 'running' || manifest.status === 'resuming') {
      return res
        .status(409)
        .json({ ok: false, error: 'Cannot archive an in-flight fleet' });
    }
    if (manifest.archived === true) {
      return res.json({ ok: true, archived_at: manifest.archived_at ?? null });
    }
    manifest.archived = true;
    manifest.archived_at = new Date().toISOString();
    saveManifest(fleetRunsDir, manifest);
    res.json({ ok: true, archived_at: manifest.archived_at });
  });

  // ── POST /api/fleet-runs/:id/unarchive ──────────────────────────────────
  router.post('/:id/unarchive', (req, res) => {
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
    if (manifest.archived !== true) {
      return res.json({ ok: true });
    }
    delete manifest.archived;
    delete manifest.archived_at;
    saveManifest(fleetRunsDir, manifest);
    res.json({ ok: true });
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
    // "Already stopped" — a non-in-flight state that is resumable, so cleanup
    // forfeits resume and a plain DELETE (Halt) is a no-op. `paused` joins
    // halted/failed here now that fleets can be paused.
    const alreadyHalted =
      currentStatus === 'halted' ||
      currentStatus === 'failed' ||
      currentStatus === 'paused';

    // Resume-loss gate (412) applies ONLY to the cleanup path. Plain DELETE
    // on a running fleet halts unstarted children; plain DELETE on an
    // already-stopped fleet is an idempotent no-op (no worktree deletion,
    // no resume-loss to warn about). See W-040 §13.6.
    if (cleanup === '1' && alreadyHalted && force !== '1') {
      return res.status(412).json({
        ok: false,
        error:
          'Fleet is in a resumable state. Pass ?force=1 to confirm cleanup will block future --resume attempts.',
        current_status: currentStatus,
      });
    }

    // Plain DELETE on an already-stopped fleet: no-op (200).
    if (cleanup !== '1' && alreadyHalted) {
      return res.json({
        ok: true,
        halted_count: 0,
        already_halted: true,
      });
    }

    const enriched = enrichChildren(manifest, prefsDir);
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

    // Only flip the manifest to `running` AFTER dispatch succeeds, so a
    // throwing dispatcher cannot leave the manifest stuck at `running` with
    // zero live children. The previous status (halted/failed/paused) is
    // preserved on failure, leaving the user free to retry resume.
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

    manifest.status = 'running';
    manifest.halt_reason = null;
    saveManifest(fleetRunsDir, manifest);

    res.json({ ok: true, relaunched_count });
  });

  // ── POST /api/fleet-runs/:id/pause ──────────────────────────────────────
  // Pause a running fleet: fan a `pause` control file out to every in-flight
  // child (each exits cleanly at its next iteration) and stamp the manifest
  // status="paused". Sticky until an explicit resume. Only valid while the
  // fleet is in flight — a terminal/halted fleet has nothing to pause.
  router.post('/:id/pause', (req, res) => {
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
    if (manifest.status !== 'running' && manifest.status !== 'resuming') {
      return res.status(409).json({
        ok: false,
        error: `Cannot pause a fleet in "${manifest.status}" state`,
        current_status: manifest.status,
      });
    }
    try {
      const result = pauseFleet(id) ?? {};
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res
        .status(500)
        .json({ ok: false, error: `Pause failed: ${err.message}` });
    }
  });

  // ── POST /api/fleet-runs/:id/stop ───────────────────────────────────────
  // Stop a running fleet: fan a `stop` control file out to every in-flight
  // child AND SIGTERM each child process, then stamp the manifest
  // status="halted" with halt_reason="stopped" (distinct from a plain Halt,
  // where in-flight children finish naturally). Sticky until resume.
  router.post('/:id/stop', (req, res) => {
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
    if (manifest.status !== 'running' && manifest.status !== 'resuming') {
      return res.status(409).json({
        ok: false,
        error: `Cannot stop a fleet in "${manifest.status}" state`,
        current_status: manifest.status,
      });
    }
    try {
      const result = stopFleet(id) ?? {};
      return res.json({ ok: true, ...result });
    } catch (err) {
      return res
        .status(500)
        .json({ ok: false, error: `Stop failed: ${err.message}` });
    }
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
