import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Mirror of _GRAPHIFY_DEFAULTS in src/worca/utils/graphify.py — keep in sync.
const GRAPHIFY_DEFAULTS = {
  enabled: false,
  mode: 'structural',
  backend: null,
  model_profile: null,
  out_dir: 'graphify-out',
  update_on: { preflight: true, guardian_post_commit: true },
  min_repo_files: 100,
  version_range: '>=0.8.16,<1',
  preflight_timeout_seconds: 300,
  freshness: 'clean_only',
};

// Mirror of effective_graphify_config() in src/worca/utils/graphify.py.
// Enablement is project-level: the project opts in via graphify.enabled. Global
// graphify.enabled is purely a kill-switch — an EXPLICIT global `false` disables
// everywhere; `true`/unset defer to the project. These rules MUST match the
// Python implementation; the parity is guarded by graphify-status.test.js
// ("effective-config parity with Python"). Update both together.
export function _effectiveConfig(globalSettings, projectSettings) {
  const gGraphify = globalSettings?.worca?.graphify ?? {};
  const pGraphify = projectSettings?.worca?.graphify ?? {};

  // Only an explicit global `enabled: false` disables; `true`/unset defer.
  if (gGraphify.enabled === false) {
    return { ...GRAPHIFY_DEFAULTS, enabled: false, reason: 'global-off' };
  }

  const projectEnabled = pGraphify.enabled ?? false;
  if (!projectEnabled) {
    return { ...GRAPHIFY_DEFAULTS, enabled: false, reason: 'project-off' };
  }

  const merged = { ...GRAPHIFY_DEFAULTS };
  for (const [k, v] of Object.entries(gGraphify)) {
    if (v != null || k === 'enabled') merged[k] = v;
  }
  for (const [k, v] of Object.entries(pGraphify)) {
    if (v != null || k === 'enabled') merged[k] = v;
  }

  return {
    enabled: true,
    mode: merged.mode,
    backend: merged.backend,
    model_profile: merged.model_profile,
    out_dir: merged.out_dir,
    update_on: merged.update_on,
    min_repo_files: merged.min_repo_files,
    version_range: merged.version_range,
    preflight_timeout_seconds: merged.preflight_timeout_seconds,
    freshness: merged.freshness,
    reason: null,
  };
}

// ─── Per-commit cache resolution (mirrors utils/paths.py + utils/git.py) ────

export function cacheDir() {
  if (process.env.WORCA_CACHE) return process.env.WORCA_CACHE;
  const home = process.env.WORCA_HOME || join(homedir(), '.worca');
  return join(home, 'cache');
}

export function repoId(projectRoot) {
  try {
    const common = execFileSync(
      'git',
      ['-C', projectRoot, 'rev-parse', '--git-common-dir'],
      { encoding: 'utf-8' },
    ).trim();
    if (!common) return null;
    const abs = isAbsolute(common) ? common : join(projectRoot, common);
    const real = realpathSync(abs);
    return createHash('sha256').update(real).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export function headSha(projectRoot) {
  try {
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    return null;
  }
}

/** Absolute snapshot dir for the project's current HEAD, or null. */
export function snapshotDir(projectRoot) {
  const rid = repoId(projectRoot);
  const sha = headSha(projectRoot);
  if (!rid || !sha) return null;
  return join(cacheDir(), 'ast', rid, sha);
}

/** The per-project cache dir (<cache>/ast/<repo-id>/), or null if not a repo. */
export function repoCacheDir(projectRoot) {
  const rid = repoId(projectRoot);
  if (!rid) return null;
  return join(cacheDir(), 'ast', rid);
}

/** Remove all cached snapshots for the project's repo. Returns the path or null. */
export function clearRepoCache(projectRoot) {
  const repoCache = repoCacheDir(projectRoot);
  if (!repoCache) return null;
  rmSync(repoCache, { recursive: true, force: true });
  return repoCache;
}

/** Stats for a per-commit snapshot dir, or null if not complete/present. */
export function _graphStats(snapDir) {
  if (!snapDir || !existsSync(join(snapDir, '.complete'))) return null;
  const reportPath = join(snapDir, 'graphify', 'GRAPH_REPORT.md');
  if (!existsSync(reportPath)) return null;

  const stat = statSync(reportPath);
  const ageSeconds = Math.max(0, (Date.now() - stat.mtimeMs) / 1000);
  const htmlPath = join(snapDir, 'graphify', 'graph.html');
  const graphJsonPath = join(snapDir, 'graphify', 'graph.json');

  return {
    report_path: reportPath,
    // The queryable dataset for humans: `graphify query … --graph <path>`.
    // null when the snapshot lacks graph.json (older/partial builds).
    graph_json_path: existsSync(graphJsonPath) ? graphJsonPath : null,
    snapshot_dir: snapDir,
    age_seconds: ageSeconds,
    size_bytes: stat.size,
    has_html: existsSync(htmlPath),
  };
}

function defaultDetect() {
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [
        '-c',
        'import json; from worca.utils.graphify import detect_graphify; d = detect_graphify(); print(json.dumps({"installed": d.installed, "version": d.version, "compatible": d.compatible, "backend_env_present": d.backend_env_present, "error": d.error}))',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', () => {
      resolve({
        installed: false,
        version: null,
        compatible: false,
        backend_env_present: [],
        error: 'python3 not available',
      });
    });
    child.on('exit', (code) => {
      if (code === 0 && stdout.trim()) {
        try {
          resolve(JSON.parse(stdout.trim()));
          return;
        } catch {
          // fall through
        }
      }
      resolve({
        installed: false,
        version: null,
        compatible: false,
        backend_env_present: [],
        error: stderr.trim() || `detect exited ${code}`,
      });
    });
  });
}

const DEFAULT_TTL_MS = 60_000;

export function createGraphifyStatus(opts = {}) {
  const detectFn = opts.detectFn || defaultDetect;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;

  let cached = null;
  let cachedAt = 0;

  async function detect() {
    const now = Date.now();
    if (cached && now - cachedAt < ttlMs) return cached;
    cached = await detectFn();
    cachedAt = Date.now();
    return cached;
  }

  function invalidate() {
    cached = null;
    cachedAt = 0;
  }

  async function getStatus({ globalSettings, projectSettings, projectRoot }) {
    const effective = _effectiveConfig(globalSettings, projectSettings);
    const detection = await detect();
    const graphStats = effective.enabled
      ? _graphStats(snapshotDir(projectRoot))
      : null;
    return {
      ok: true,
      effective,
      detection,
      graph_stats: graphStats,
      // The cache path is a pure function of the repo location (it's null only
      // when projectRoot isn't a git repo), so resolve it regardless of whether
      // graphify is enabled. This lets the UI show the path immediately when
      // the user toggles graphify on in-memory, before the setting is saved.
      cache_path: repoCacheDir(projectRoot),
    };
  }

  return { detect, invalidate, getStatus };
}
