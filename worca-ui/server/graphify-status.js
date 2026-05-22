import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const GRAPHIFY_DEFAULTS = {
  enabled: false,
  mode: 'structural',
  backend: null,
  model_profile: null,
  out_dir: 'graphify-out',
  update_on: { preflight: true, guardian_post_commit: true },
  min_repo_files: 100,
  version_range: '>=4,<5',
};

export function _effectiveConfig(globalSettings, projectSettings) {
  const gGraphify = globalSettings?.worca?.graphify ?? {};
  const pGraphify = projectSettings?.worca?.graphify ?? {};

  const globalEnabled = gGraphify.enabled ?? GRAPHIFY_DEFAULTS.enabled;
  if (!globalEnabled) {
    return { ...GRAPHIFY_DEFAULTS, enabled: false, reason: 'global-off' };
  }

  const projectEnabled = pGraphify.enabled ?? globalEnabled;
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
    reason: null,
  };
}

export function _graphStats(projectRoot, outDir) {
  const reportPath = join(projectRoot, outDir, 'GRAPH_REPORT.md');
  if (!existsSync(reportPath)) return null;

  const stat = statSync(reportPath);
  const ageSeconds = Math.max(0, (Date.now() - stat.mtimeMs) / 1000);
  const htmlPath = join(projectRoot, outDir, 'graph.html');

  return {
    report_path: reportPath,
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
      ? _graphStats(projectRoot, effective.out_dir)
      : null;
    return { ok: true, effective, detection, graph_stats: graphStats };
  }

  return { detect, invalidate, getStatus };
}
