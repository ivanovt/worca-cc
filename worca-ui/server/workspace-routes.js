/**
 * Workspace REST endpoints (W-047 §10.10).
 *
 * Two routers: `workspaces` for workspace definitions (workspace.json)
 * and `workspaceRuns` for workspace run lifecycle (manifests, plans, guides).
 *
 * Pointer files live at ~/.worca/workspace-runs/<workspace_id>.json.
 * Workspace definitions live at <workspace_root>/workspace.json.
 * Manifests live at <workspace_root>/.worca/workspace-runs/<ws_id>/workspace-manifest.json.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { Router } from 'express';

const DEFAULT_WS_RUNS_DIR = join(homedir(), '.worca', 'workspace-runs');
const DEFAULT_WORKSPACES_DIR = join(homedir(), '.worca', 'workspaces.d');
const GUIDE_CAP_BYTES_DEFAULT = 64 * 1024;

const WS_ID_RE = /^ws_\d{12}_[0-9a-f]{1,32}$/;

const ACTIVE_STATUSES = new Set([
  'planning',
  'running',
  'integration_testing',
  'blocked',
]);

const RESUMABLE_STATUSES = new Set([
  'halted',
  'failed',
  'integration_failed',
  'paused',
]);

const PLAN_EDITABLE_STATUSES = new Set(['planning', 'halted', 'failed']);

// ─── helpers ───────────────────────────────────────────────────────────────

function validateWsId(id) {
  return typeof id === 'string' && WS_ID_RE.test(id);
}

function readPointer(wsRunsDir, wsId) {
  const p = join(wsRunsDir, `${wsId}.json`);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readManifest(wsRunsDir, wsId) {
  const pointer = readPointer(wsRunsDir, wsId);
  if (!pointer?.workspace_root) return null;
  const manifestPath = join(
    pointer.workspace_root,
    '.worca',
    'workspace-runs',
    wsId,
    'workspace-manifest.json',
  );
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function runDir(manifest) {
  return join(
    manifest.workspace_root,
    '.worca',
    'workspace-runs',
    manifest.workspace_id,
  );
}

function saveManifest(manifest) {
  const dir = runDir(manifest);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'workspace-manifest.json');
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    renameSync(tmp, p);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

function listPointers(wsRunsDir) {
  if (!existsSync(wsRunsDir)) return [];
  const out = [];
  for (const file of readdirSync(wsRunsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const p = JSON.parse(readFileSync(join(wsRunsDir, file), 'utf8'));
      if (p?.workspace_id) out.push(p);
    } catch {
      // skip
    }
  }
  return out;
}

function listWorkspaceRegistrations(workspacesDir) {
  if (!existsSync(workspacesDir)) return [];
  const out = [];
  for (const file of readdirSync(workspacesDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(readFileSync(join(workspacesDir, file), 'utf8'));
      if (entry?.name) out.push(entry);
    } catch {
      // skip
    }
  }
  return out;
}

function readWorkspaceJson(wsRoot) {
  const p = join(wsRoot, 'workspace.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function detectCycle(repos) {
  const inDegree = {};
  const dependents = {};
  for (const r of repos) {
    inDegree[r.name] = 0;
    dependents[r.name] = [];
  }
  for (const r of repos) {
    for (const dep of r.depends_on || []) {
      if (!(dep in inDegree)) return `unknown dependency '${dep}'`;
      inDegree[r.name]++;
      dependents[dep].push(r.name);
    }
  }
  const queue = Object.keys(inDegree).filter((n) => inDegree[n] === 0);
  let processed = 0;
  const next = [...queue];
  while (next.length > 0) {
    const name = next.shift();
    processed++;
    for (const dep of dependents[name]) {
      inDegree[dep]--;
      if (inDegree[dep] === 0) next.push(dep);
    }
  }
  if (processed !== repos.length) {
    const remaining = Object.keys(inDegree)
      .filter((n) => inDegree[n] > 0)
      .sort();
    return `dependency cycle detected among repos: ${remaining.join(', ')}`;
  }
  return null;
}

function computeTiers(repos) {
  const inDegree = {};
  const dependents = {};
  for (const r of repos) {
    inDegree[r.name] = 0;
    dependents[r.name] = [];
  }
  for (const r of repos) {
    for (const dep of r.depends_on || []) {
      inDegree[r.name]++;
      dependents[dep].push(r.name);
    }
  }
  const tiers = [];
  let queue = Object.keys(inDegree)
    .filter((n) => inDegree[n] === 0)
    .sort();
  while (queue.length > 0) {
    tiers.push([...queue]);
    const nextQueue = [];
    for (const name of queue) {
      for (const dep of dependents[name]) {
        inDegree[dep]--;
        if (inDegree[dep] === 0) nextQueue.push(dep);
      }
    }
    queue = nextQueue.sort();
  }
  return tiers;
}

function generateWorkspaceId() {
  const now = new Date();
  const ts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
  ].join('');
  const rand = Math.random().toString(16).slice(2, 10).padStart(8, '0');
  return { workspace_id: `ws_${ts}_${rand}`, workspace_id_short: rand };
}

function sanitizeFilename(raw) {
  const name = basename(raw || 'guide')
    .replace(/[/\\]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_');
  return name || 'guide';
}

function scanForRepos(parentPath) {
  const repos = [];
  let entries;
  try {
    entries = readdirSync(parentPath);
  } catch {
    return repos;
  }
  for (const entry of entries) {
    const full = join(parentPath, entry);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (existsSync(join(full, '.git'))) {
      repos.push({
        name: entry,
        path: entry,
        role_hint: null,
      });
    }
  }
  return repos;
}

function enrichChildStatus(child) {
  if (!child.run_id || !child.worktree_path) return child;
  const regPath = join(
    child.worktree_path,
    '.worca',
    'multi',
    'pipelines.d',
    `${child.run_id}.json`,
  );
  if (!existsSync(regPath)) return child;
  try {
    const reg = JSON.parse(readFileSync(regPath, 'utf8'));
    return { ...child, status: reg.status ?? child.status };
  } catch {
    return child;
  }
}

function aggregateCost(manifest) {
  let cost = 0;
  for (const child of manifest.children ?? []) {
    if (!child.run_id || !child.worktree_path) continue;
    const regPath = join(
      child.worktree_path,
      '.worca',
      'multi',
      'pipelines.d',
      `${child.run_id}.json`,
    );
    if (!existsSync(regPath)) continue;
    try {
      const reg = JSON.parse(readFileSync(regPath, 'utf8'));
      for (const stage of Object.values(reg.stages ?? {})) {
        for (const iter of stage.iterations ?? []) {
          cost += iter.cost_usd ?? 0;
        }
      }
    } catch {
      // skip
    }
  }
  return cost;
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

function parseMultipart(body, contentType) {
  const m = /boundary=([^\s;,]+)/.exec(contentType);
  if (!m) return null;
  const boundary = m[1].replace(/^["']|["']$/g, '');
  const delim = Buffer.from(`\r\n--${boundary}`);
  const parts = [];
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

// ─── default injectables ──────────────────────────────────────────────────

function defaultValidateBaseBranch(repoPath, branch) {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoPath, 'branch', '--list', branch],
      { encoding: 'utf8' },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function defaultValidateGhAuth(_workspace) {
  return Promise.resolve([]);
}

function defaultHaltWorkspace(_wsId) {
  return true;
}

function defaultRunCleanup(_wsId) {
  return {};
}

function defaultRunIntegrationTest(_manifest) {
  return Promise.resolve({
    status: 'passed',
    exit_code: 0,
    log_path: null,
  });
}

// ─── router factory ────────────────────────────────────────────────────────

export function createWorkspaceRouter({
  workspaceRunsDir = DEFAULT_WS_RUNS_DIR,
  workspacesDir = DEFAULT_WORKSPACES_DIR,
  dispatchWorkspace = null,
  haltWorkspace = defaultHaltWorkspace,
  runCleanup = defaultRunCleanup,
  validateBaseBranch = defaultValidateBaseBranch,
  validateGhAuth = defaultValidateGhAuth,
  runIntegrationTest = defaultRunIntegrationTest,
  guideCapBytes = GUIDE_CAP_BYTES_DEFAULT,
} = {}) {
  const workspaces = Router();
  const workspaceRuns = Router();

  // ════════════════════════════════════════════════════════════════════════
  // workspaces router — mounted at /api/workspaces
  // ════════════════════════════════════════════════════════════════════════

  // ── POST /api/workspaces/scan ─────────────────────────────────────────
  workspaces.post('/scan', (req, res) => {
    const { parent_path } = req.body ?? {};
    if (!parent_path || typeof parent_path !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'parent_path is required' });
    }
    if (!existsSync(parent_path)) {
      return res
        .status(400)
        .json({ ok: false, error: `Path does not exist: ${parent_path}` });
    }
    try {
      const repos = scanForRepos(parent_path);
      res.json({ ok: true, repos });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/workspaces ──────────────────────────────────────────────
  workspaces.post('/', (req, res) => {
    const { name, parent_path, repos, integration_test, umbrella_repo } =
      req.body ?? {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ ok: false, error: 'name is required' });
    }
    if (!parent_path || typeof parent_path !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'parent_path is required' });
    }
    if (!Array.isArray(repos) || repos.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'repos must be a non-empty array' });
    }

    const cycleErr = detectCycle(repos);
    if (cycleErr) {
      return res.status(422).json({ ok: false, error: cycleErr });
    }

    const wsJson = { name, repos };
    if (integration_test) wsJson.integration_test = integration_test;
    if (umbrella_repo) wsJson.umbrella_repo = umbrella_repo;

    try {
      writeFileSync(
        join(parent_path, 'workspace.json'),
        `${JSON.stringify(wsJson, null, 2)}\n`,
        'utf8',
      );

      mkdirSync(workspacesDir, { recursive: true });
      const safeName = sanitizeFilename(name);
      writeFileSync(
        join(workspacesDir, `${safeName}.json`),
        `${JSON.stringify({ name, path: parent_path }, null, 2)}\n`,
        'utf8',
      );

      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/workspaces ───────────────────────────────────────────────
  workspaces.get('/', (_req, res) => {
    try {
      const registrations = listWorkspaceRegistrations(workspacesDir);
      const result = registrations.map((reg) => {
        const ws = readWorkspaceJson(reg.path);
        return {
          name: reg.name,
          path: reg.path,
          repos: ws?.repos ?? [],
          integration_test: ws?.integration_test ?? null,
          umbrella_repo: ws?.umbrella_repo ?? null,
        };
      });
      res.json({ ok: true, workspaces: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/workspaces/:name ─────────────────────────────────────────
  workspaces.get('/:name', (req, res) => {
    const name = sanitizeFilename(req.params.name);
    const regPath = join(workspacesDir, `${name}.json`);
    if (!existsSync(regPath)) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace "${name}" not found` });
    }

    try {
      const reg = JSON.parse(readFileSync(regPath, 'utf8'));
      const ws = readWorkspaceJson(reg.path);
      if (!ws) {
        return res.status(404).json({
          ok: false,
          error: `workspace.json not found at ${reg.path}`,
        });
      }
      res.json({ ok: true, workspace: ws });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── PUT /api/workspaces/:name ─────────────────────────────────────────
  workspaces.put('/:name', (req, res) => {
    const name = sanitizeFilename(req.params.name);
    const regPath = join(workspacesDir, `${name}.json`);
    if (!existsSync(regPath)) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace "${name}" not found` });
    }

    let reg;
    try {
      reg = JSON.parse(readFileSync(regPath, 'utf8'));
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }

    const pointers = listPointers(workspaceRunsDir);
    const hasActiveRuns = pointers.some((p) => {
      if (p.workspace_root !== reg.path) return false;
      const m = readManifest(workspaceRunsDir, p.workspace_id);
      return m && ACTIVE_STATUSES.has(m.status);
    });

    if (hasActiveRuns) {
      return res.status(409).json({
        ok: false,
        error:
          'Cannot edit workspace while active runs exist. Halt or wait for completion.',
      });
    }

    const updated = req.body ?? {};
    const repos = updated.repos ?? [];
    const cycleErr = detectCycle(repos);
    if (cycleErr) {
      return res.status(422).json({ ok: false, error: cycleErr });
    }

    try {
      writeFileSync(
        join(reg.path, 'workspace.json'),
        `${JSON.stringify(updated, null, 2)}\n`,
        'utf8',
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ════════════════════════════════════════════════════════════════════════
  // workspaceRuns router — mounted at /api/workspace-runs
  // ════════════════════════════════════════════════════════════════════════

  // ── POST /api/workspace-runs/validate-gh-auth ─────────────────────────
  workspaceRuns.post('/validate-gh-auth', async (req, res) => {
    const { workspace_name } = req.body ?? {};
    if (!workspace_name || typeof workspace_name !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'workspace_name is required' });
    }

    const safeWsName = sanitizeFilename(workspace_name);
    const regPath = join(workspacesDir, `${safeWsName}.json`);
    if (!existsSync(regPath)) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace "${workspace_name}" not found` });
    }

    try {
      const reg = JSON.parse(readFileSync(regPath, 'utf8'));
      const ws = readWorkspaceJson(reg.path);
      const missing_orgs = await validateGhAuth(ws);
      res.json({ ok: missing_orgs.length === 0, missing_orgs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/workspace-runs/validate-base ────────────────────────────
  workspaceRuns.post('/validate-base', async (req, res) => {
    const { workspace_name, base_branch } = req.body ?? {};
    if (!workspace_name || typeof workspace_name !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'workspace_name is required' });
    }
    if (!base_branch || typeof base_branch !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'base_branch is required' });
    }

    const safeWsName = sanitizeFilename(workspace_name);
    const regPath = join(workspacesDir, `${safeWsName}.json`);
    if (!existsSync(regPath)) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace "${workspace_name}" not found` });
    }

    try {
      const reg = JSON.parse(readFileSync(regPath, 'utf8'));
      const ws = readWorkspaceJson(reg.path);
      if (!ws) {
        return res.status(404).json({
          ok: false,
          error: `workspace.json not found at ${reg.path}`,
        });
      }

      const missing_in = [];
      for (const repo of ws.repos) {
        const repoPath = join(reg.path, repo.path);
        const exists = await validateBaseBranch(repoPath, base_branch);
        if (!exists) missing_in.push(repo.name);
      }
      res.json({ ok: missing_in.length === 0, missing_in });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── POST /api/workspace-runs ──────────────────────────────────────────
  workspaceRuns.post('/', async (req, res) => {
    try {
      const contentType = req.headers['content-type'] ?? '';
      const isMultipart = contentType.includes('multipart/form-data');

      let fields = {};
      const guideFiles = [];

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
            guideFiles.push({ filename: part.filename, content: part.content });
          } else if (part.name) {
            fields[part.name] = part.content.toString('utf8');
          }
        }
      } else {
        fields = req.body ?? {};
      }

      const {
        workspace_name,
        prompt,
        source,
        plan_mode,
        branch_template,
        max_parallel = 5,
      } = fields;

      if (!workspace_name) {
        return res
          .status(400)
          .json({ ok: false, error: 'workspace_name is required' });
      }
      if (!prompt && !source) {
        return res
          .status(400)
          .json({ ok: false, error: 'prompt or source is required' });
      }

      const safeWsName = sanitizeFilename(workspace_name);
      const regPath = join(workspacesDir, `${safeWsName}.json`);
      if (!existsSync(regPath)) {
        return res.status(404).json({
          ok: false,
          error: `Workspace "${workspace_name}" not found`,
        });
      }

      const reg = JSON.parse(readFileSync(regPath, 'utf8'));
      const wsRoot = reg.path;
      const ws = readWorkspaceJson(wsRoot);
      if (!ws) {
        return res.status(404).json({
          ok: false,
          error: `workspace.json not found at ${wsRoot}`,
        });
      }

      const cycleErr = detectCycle(ws.repos);
      if (cycleErr) {
        return res.status(422).json({ ok: false, error: cycleErr });
      }

      const { workspace_id, workspace_id_short } = generateWorkspaceId();
      const wsRunDir = join(wsRoot, '.worca', 'workspace-runs', workspace_id);
      mkdirSync(wsRunDir, { recursive: true });

      mkdirSync(workspaceRunsDir, { recursive: true });
      writeFileSync(
        join(workspaceRunsDir, `${workspace_id}.json`),
        `${JSON.stringify({ workspace_root: wsRoot, workspace_id }, null, 2)}\n`,
      );

      let guideEntry = null;
      if (guideFiles.length > 0) {
        const totalBytes = guideFiles.reduce((s, f) => s + f.content.length, 0);
        if (totalBytes > guideCapBytes) {
          return res.status(400).json({
            ok: false,
            error: `Guide files exceed size cap of ${guideCapBytes} bytes`,
          });
        }
        const guidesDir = join(wsRunDir, 'guides');
        mkdirSync(guidesDir, { recursive: true });
        const paths = [];
        const filenames = [];
        const usedNames = new Set();
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
          writeFileSync(join(guidesDir, safe), content);
          paths.push(join(guidesDir, safe));
          filenames.push(safe);
        }
        guideEntry = { paths, bytes: totalBytes, filenames, uploaded: true };
      }

      const tiers = computeTiers(ws.repos);
      const dagTiers = tiers.map((repos, i) => ({
        tier: i,
        repos,
        status: 'pending',
      }));

      const manifest = {
        workspace_id,
        workspace_id_short,
        workspace_name: ws.name,
        workspace_root: wsRoot,
        created_at: new Date().toISOString(),
        work_request: {
          title: (prompt || source || '').slice(0, 80),
          description: prompt ?? '',
          source: source ?? null,
        },
        guide: guideEntry,
        branch_template: branch_template ?? 'workspace/{slug}/{repo}',
        max_parallel: Number(max_parallel) || 5,
        skip_integration: false,
        skip_planning: plan_mode === 'skip',
        status: 'planning',
        halt_reason: null,
        dag: { tiers: dagTiers },
        children: [],
        integration_test: {
          status: 'pending',
          exit_code: null,
          log_path: null,
        },
      };

      saveManifest(manifest);

      if (dispatchWorkspace) {
        try {
          await dispatchWorkspace({
            workspace_id,
            workspace_root: wsRoot,
            manifest,
          });
        } catch (err) {
          manifest.status = 'failed';
          saveManifest(manifest);
          return res
            .status(500)
            .json({ ok: false, error: `Dispatch failed: ${err.message}` });
        }
      }

      res.status(201).json({ ok: true, workspace_id });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/workspace-runs ───────────────────────────────────────────
  workspaceRuns.get('/', (_req, res) => {
    try {
      const pointers = listPointers(workspaceRunsDir);
      const runs = [];
      for (const pointer of pointers) {
        const m = readManifest(workspaceRunsDir, pointer.workspace_id);
        if (!m) continue;
        runs.push({
          workspace_id: m.workspace_id,
          workspace_name: m.workspace_name,
          workspace_root: m.workspace_root,
          status: m.status,
          halt_reason: m.halt_reason ?? null,
          work_request: m.work_request,
          created_at: m.created_at,
          dag: m.dag,
          children_count: (m.children ?? []).length,
        });
      }
      res.json({ ok: true, workspace_runs: runs });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/workspace-runs/:id ───────────────────────────────────────
  workspaceRuns.get('/:id', (req, res) => {
    const { id } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }
    const children = (manifest.children ?? []).map(enrichChildStatus);
    const cost_usd = aggregateCost(manifest);
    res.json({ ok: true, manifest: { ...manifest, children }, cost_usd });
  });

  // ── DELETE /api/workspace-runs/:id ────────────────────────────────────
  workspaceRuns.delete('/:id', async (req, res) => {
    const { id } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }

    const { cleanup, force } = req.query;
    const status = manifest.status;
    const isResumable = RESUMABLE_STATUSES.has(status);

    if (cleanup === '1' && isResumable && force !== '1') {
      return res.status(412).json({
        ok: false,
        error:
          'Workspace is in a resumable state. Pass ?force=1 to confirm cleanup.',
        current_status: status,
      });
    }

    if (cleanup !== '1' && isResumable) {
      return res.json({ ok: true, already_halted: true });
    }

    haltWorkspace(id);

    if (cleanup === '1') {
      try {
        const cleanResult = (await runCleanup(id)) ?? {};
        return res.json({ ok: true, ...cleanResult });
      } catch (err) {
        return res
          .status(500)
          .json({ ok: false, error: `Cleanup failed: ${err.message}` });
      }
    }

    res.json({ ok: true });
  });

  // ── POST /api/workspace-runs/:id/resume ───────────────────────────────
  workspaceRuns.post('/:id/resume', async (req, res) => {
    const { id } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }

    if (manifest.status === 'running' || manifest.status === 'planning') {
      return res
        .status(409)
        .json({ ok: false, error: 'Workspace is already running' });
    }

    if (dispatchWorkspace) {
      try {
        await dispatchWorkspace({
          workspace_id: id,
          workspace_root: manifest.workspace_root,
          manifest,
          resume: true,
        });
      } catch (err) {
        return res
          .status(500)
          .json({ ok: false, error: `Resume failed: ${err.message}` });
      }
    }

    manifest.status = 'running';
    manifest.halt_reason = null;
    saveManifest(manifest);

    res.json({ ok: true });
  });

  // ── POST /api/workspace-runs/:id/relaunch ─────────────────────────────
  workspaceRuns.post('/:id/relaunch', async (req, res) => {
    const { id } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }

    const overrides = req.body ?? {};
    const { workspace_id: newId, workspace_id_short: newShort } =
      generateWorkspaceId();

    const newManifest = {
      ...manifest,
      workspace_id: newId,
      workspace_id_short: newShort,
      created_at: new Date().toISOString(),
      status: 'planning',
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
      integration_test: {
        status: 'pending',
        exit_code: null,
        log_path: null,
      },
    };

    if (newManifest.dag?.tiers) {
      newManifest.dag.tiers = newManifest.dag.tiers.map((t) => ({
        ...t,
        status: 'pending',
      }));
    }

    mkdirSync(workspaceRunsDir, { recursive: true });
    writeFileSync(
      join(workspaceRunsDir, `${newId}.json`),
      `${JSON.stringify({ workspace_root: manifest.workspace_root, workspace_id: newId }, null, 2)}\n`,
    );

    const newRunDir = join(
      manifest.workspace_root,
      '.worca',
      'workspace-runs',
      newId,
    );
    mkdirSync(newRunDir, { recursive: true });
    saveManifest(newManifest);

    if (dispatchWorkspace) {
      try {
        await dispatchWorkspace({
          workspace_id: newId,
          workspace_root: manifest.workspace_root,
          manifest: newManifest,
        });
      } catch (err) {
        newManifest.status = 'failed';
        saveManifest(newManifest);
        return res
          .status(500)
          .json({ ok: false, error: `Relaunch failed: ${err.message}` });
      }
    }

    res.status(201).json({ ok: true, new_workspace_id: newId });
  });

  // ── POST /api/workspace-runs/:id/re-run-integration ───────────────────
  workspaceRuns.post('/:id/re-run-integration', async (req, res) => {
    const { id } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }

    try {
      const result = await runIntegrationTest(manifest);
      manifest.integration_test = result;
      if (result.status === 'passed') {
        manifest.status = 'completed';
      } else {
        manifest.status = 'integration_failed';
      }
      saveManifest(manifest);
      res.json({ ok: true, integration_test: result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/workspace-runs/:id/plan ──────────────────────────────────
  workspaceRuns.get('/:id/plan', (req, res) => {
    const { id } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }

    const dir = runDir(manifest);
    const wantsJson = (req.headers.accept ?? '').includes('application/json');

    if (wantsJson) {
      const jsonPath = join(dir, 'workspace-plan.json');
      if (!existsSync(jsonPath)) {
        return res
          .status(404)
          .json({ ok: false, error: 'No plan found for this workspace run' });
      }
      try {
        const plan = JSON.parse(readFileSync(jsonPath, 'utf8'));
        res.json(plan);
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    } else {
      const mdPath = join(dir, 'workspace-plan.md');
      if (!existsSync(mdPath)) {
        return res
          .status(404)
          .json({ ok: false, error: 'No plan found for this workspace run' });
      }
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.send(readFileSync(mdPath, 'utf8'));
    }
  });

  // ── PUT /api/workspace-runs/:id/plan ──────────────────────────────────
  workspaceRuns.put('/:id/plan', (req, res) => {
    const { id } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }

    if (!PLAN_EDITABLE_STATUSES.has(manifest.status)) {
      return res.status(409).json({
        ok: false,
        error: `Cannot edit plan in "${manifest.status}" state`,
        current_status: manifest.status,
      });
    }

    const { plan_json } = req.body ?? {};
    if (!plan_json || typeof plan_json !== 'object') {
      return res
        .status(400)
        .json({ ok: false, error: 'plan_json is required' });
    }

    try {
      const dir = runDir(manifest);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'workspace-plan.json'),
        `${JSON.stringify(plan_json, null, 2)}\n`,
        'utf8',
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ── GET /api/workspace-runs/:id/guide ─────────────────────────────────
  workspaceRuns.get('/:id/guide', (req, res) => {
    const { id } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }

    const guide = manifest.guide;
    if (!guide?.paths?.length) {
      return res
        .status(404)
        .json({ ok: false, error: 'No guide attached to this workspace run' });
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
            hint: 'Guide was supplied via CLI from a path the UI server cannot read.',
          });
        }
        return res.status(500).json({ ok: false, error: err.message });
      }
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(chunks.join('\n\n---\n\n'));
  });

  // ── GET /api/workspace-runs/:id/integration-log ───────────────────────
  workspaceRuns.get('/:id/integration-log', (req, res) => {
    const { id } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }

    const logPath = manifest.integration_test?.log_path;
    if (!logPath || !existsSync(logPath)) {
      return res
        .status(404)
        .json({ ok: false, error: 'No integration test log available' });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(readFileSync(logPath, 'utf8'));
  });

  // ── GET /api/workspace-runs/:id/context/:repo ─────────────────────────
  workspaceRuns.get('/:id/context/:repo', (req, res) => {
    const { id, repo } = req.params;
    if (!validateWsId(id)) {
      return res.status(400).json({ ok: false, error: 'Invalid workspace ID' });
    }
    const manifest = readManifest(workspaceRunsDir, id);
    if (!manifest) {
      return res
        .status(404)
        .json({ ok: false, error: `Workspace run "${id}" not found` });
    }

    const safeRepo = basename(repo);
    const contextPath = join(
      runDir(manifest),
      'context',
      `${safeRepo}-diff.md`,
    );
    if (!existsSync(contextPath)) {
      return res.status(404).json({
        ok: false,
        error: `No context artifact found for repo "${safeRepo}"`,
      });
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send(readFileSync(contextPath, 'utf8'));
  });

  return { workspaces, workspaceRuns };
}
