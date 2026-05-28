import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { repoCacheDir, snapshotDir } from './graphify-status.js';

// Mirror of _CRG_DEFAULTS in src/worca/utils/code_review_graph.py — keep in sync.
const CRG_DEFAULTS = {
  enabled: false,
  embeddings: false,
  update_on: {
    preflight: true,
    post_implement: true,
    guardian_post_commit: true,
  },
  freshness: 'clean_only',
  min_repo_files: 100,
  version_range: '>=2,<3',
  fastmcp_min: '3.2.4',
  preflight_timeout_seconds: 300,
  stage_tools: null,
};

// Mirror of effective_crg_config() in src/worca/utils/code_review_graph.py.
// Enablement is project-level: the project opts in via code_review_graph.enabled.
// Global code_review_graph.enabled is purely a kill-switch — an EXPLICIT global
// `false` disables everywhere; `true`/unset defer to the project. These rules
// MUST match the Python implementation; the parity is guarded by
// code-review-graph-status.test.js ("_effectiveCrgConfig parity with Python").
// Update both together.
export function _effectiveCrgConfig(globalSettings, projectSettings) {
  const gCrg = globalSettings?.worca?.code_review_graph ?? {};
  const pCrg = projectSettings?.worca?.code_review_graph ?? {};

  if (gCrg.enabled === false) {
    return _disabledConfig('global-off');
  }

  const projectEnabled = pCrg.enabled ?? false;
  if (!projectEnabled) {
    return _disabledConfig('project-off');
  }

  const merged = { ...CRG_DEFAULTS };
  for (const [k, v] of Object.entries(gCrg)) {
    if (v != null || k === 'enabled') merged[k] = v;
  }
  for (const [k, v] of Object.entries(pCrg)) {
    if (v != null || k === 'enabled') merged[k] = v;
  }

  const defaultsUpdateOn = { ...CRG_DEFAULTS.update_on };
  if (gCrg.update_on && typeof gCrg.update_on === 'object') {
    Object.assign(defaultsUpdateOn, gCrg.update_on);
  }
  if (pCrg.update_on && typeof pCrg.update_on === 'object') {
    Object.assign(defaultsUpdateOn, pCrg.update_on);
  }

  return {
    enabled: true,
    embeddings: merged.embeddings,
    update_on_preflight: defaultsUpdateOn.preflight ?? true,
    update_on_post_implement: defaultsUpdateOn.post_implement ?? true,
    update_on_guardian_post_commit:
      defaultsUpdateOn.guardian_post_commit ?? true,
    min_repo_files: merged.min_repo_files,
    version_range: merged.version_range,
    fastmcp_min: merged.fastmcp_min,
    preflight_timeout_seconds: merged.preflight_timeout_seconds,
    freshness: merged.freshness,
    stage_tools: merged.stage_tools,
    reason: null,
  };
}

function _disabledConfig(reason) {
  const d = CRG_DEFAULTS;
  const u = d.update_on;
  return {
    enabled: false,
    embeddings: d.embeddings,
    update_on_preflight: u.preflight,
    update_on_post_implement: u.post_implement,
    update_on_guardian_post_commit: u.guardian_post_commit,
    min_repo_files: d.min_repo_files,
    version_range: d.version_range,
    fastmcp_min: d.fastmcp_min,
    preflight_timeout_seconds: d.preflight_timeout_seconds,
    freshness: d.freshness,
    stage_tools: d.stage_tools,
    reason,
  };
}

// ─── Per-commit CRG graph stats ─────────────────────────────────────────

const _CRG_SUBDIR = 'code-review-graph';

export function _crgGraphStats(snapDir) {
  if (!snapDir) return null;
  const dbPath = join(snapDir, _CRG_SUBDIR, 'graph.db');
  if (!existsSync(dbPath)) return null;

  const stat = statSync(dbPath);
  const ageSeconds = Math.max(0, (Date.now() - stat.mtimeMs) / 1000);
  const htmlPath = join(snapDir, _CRG_SUBDIR, 'graph.html');

  return {
    db_path: dbPath,
    snapshot_dir: snapDir,
    age_seconds: ageSeconds,
    size_bytes: stat.size,
    has_html: existsSync(htmlPath),
  };
}

// ─── Detection (delegates to Python detect_code_review_graph) ───────────

function defaultDetect() {
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [
        '-c',
        'import json; from worca.utils.code_review_graph import detect_code_review_graph; d = detect_code_review_graph(); print(json.dumps({"installed": d.installed, "version": d.version, "compatible": d.compatible, "fastmcp_ok": d.fastmcp_ok, "error": d.error}))',
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
        fastmcp_ok: false,
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
        fastmcp_ok: false,
        error: stderr.trim() || `detect exited ${code}`,
      });
    });
  });
}

const DEFAULT_TTL_MS = 60_000;

export function createCrgStatus(opts = {}) {
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
    const effective = _effectiveCrgConfig(globalSettings, projectSettings);
    const detection = await detect();
    const graphStats = effective.enabled
      ? _crgGraphStats(snapshotDir(projectRoot))
      : null;
    return {
      ok: true,
      effective,
      detection,
      graph_stats: graphStats,
      cache_path: repoCacheDir(projectRoot),
    };
  }

  return { detect, invalidate, getStatus };
}
