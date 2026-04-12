// server/versions.js — version fetching + caching for worca-cc and @worca/ui
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPreferences } from './preferences.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTALL_DIR = dirname(__dirname); // worca-ui root

/** Cache: { data, timestamp } */
let _cache = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Compare two semver-ish strings. Returns -1, 0, or 1.
 * Strips pre-release suffixes for comparison (e.g. "rc", "dev", "alpha").
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  if (!a || !b) return 0;
  const parse = (v) =>
    v.split('.').map((s) => {
      const n = parseInt(s, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  const pa = parse(a);
  const pb = parse(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

/**
 * Parse a PyPI pre-release version like "0.6.0rc7" → { base: "0.6.0", rc: 7 }
 * Returns null if not an RC version.
 * @param {string} versionStr
 * @returns {{ base: string, rc: number } | null}
 */
export function parsePyPIPreRelease(versionStr) {
  const match = versionStr.match(/^(.+?)rc(\d+)$/);
  if (!match) return null;
  return { base: match[1], rc: parseInt(match[2], 10) };
}

/**
 * Fetch latest + latestRc versions from npm registry.
 * @param {string} packageName
 * @returns {Promise<{ latest: string|null, latestRc: string|null }>}
 */
export async function fetchNpmVersions(packageName) {
  const nullResult = { latest: null, latestRc: null };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let res;
    try {
      res = await fetch(`https://registry.npmjs.org/${packageName}`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return nullResult;
    const data = await res.json();
    const distLatest = data['dist-tags']?.latest || null;
    let latestRc = data['dist-tags']?.rc || null;

    // Scan all versions for the highest stable and highest RC
    let bestStable = null;
    let bestRc = null;
    let bestRcNum = -1;
    if (data.versions) {
      for (const ver of Object.keys(data.versions)) {
        const rcMatch = ver.match(/^(.+)-rc\.(\d+)$/);
        if (rcMatch) {
          const rcNum = parseInt(rcMatch[2], 10);
          const base = rcMatch[1];
          if (
            !bestRc ||
            compareVersions(base, bestRc.base) > 0 ||
            (compareVersions(base, bestRc.base) === 0 && rcNum > bestRcNum)
          ) {
            bestRc = { base, full: ver };
            bestRcNum = rcNum;
          }
        } else if (!ver.includes('-')) {
          // Stable version (no pre-release suffix)
          if (!bestStable || compareVersions(ver, bestStable) > 0) {
            bestStable = ver;
          }
        }
      }
    }
    if (!latestRc && bestRc) latestRc = bestRc.full;

    // Use dist-tags latest only if it's a stable version, otherwise fall back
    // to the highest stable version found in the registry
    const isRc = distLatest?.includes('-');
    const latest = isRc ? bestStable || distLatest : distLatest;

    return { latest, latestRc };
  } catch {
    return nullResult;
  }
}

/**
 * Fetch latest + latestRc versions from PyPI.
 * @param {string} packageName
 * @returns {Promise<{ latest: string|null, latestRc: string|null }>}
 */
export async function fetchPyPIVersions(packageName) {
  const nullResult = { latest: null, latestRc: null };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    let res;
    try {
      res = await fetch(`https://pypi.org/pypi/${packageName}/json`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return nullResult;
    const data = await res.json();
    const latest = data.info?.version || null;
    // Scan releases for highest rc version
    let latestRc = null;
    if (data.releases) {
      let bestRcNum = -1;
      let bestBase = null;
      for (const ver of Object.keys(data.releases)) {
        const parsed = parsePyPIPreRelease(ver);
        if (parsed) {
          if (
            !bestBase ||
            compareVersions(parsed.base, bestBase) > 0 ||
            (compareVersions(parsed.base, bestBase) === 0 &&
              parsed.rc > bestRcNum)
          ) {
            bestBase = parsed.base;
            bestRcNum = parsed.rc;
            latestRc = ver;
          }
        }
      }
    }
    return { latest, latestRc };
  } catch {
    return nullResult;
  }
}

/**
 * Get git describe info for a repo: commits ahead of tag + dirty state.
 * @param {string} repoPath
 * @param {string} tagPrefix - e.g. 'worca-cc-v' or 'worca-ui-v'
 * @returns {{ ahead: number, dirty: boolean } | null}
 */
function getGitDevStatus(repoPath, tagPrefix) {
  try {
    const desc = execFileSync(
      'git',
      ['describe', '--tags', '--long', '--match', `${tagPrefix}*`],
      { cwd: repoPath, encoding: 'utf8', timeout: 3000 },
    ).trim();
    // Format: tagPrefix0.10.0-3-gabcdef
    const m = desc.match(/-(\d+)-g[0-9a-f]+$/);
    const ahead = m ? parseInt(m[1], 10) : 0;

    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
      timeout: 3000,
    }).trim();
    const dirty = status.length > 0;

    return { ahead, dirty };
  } catch {
    return null;
  }
}

/**
 * Read versions from local dev path.
 * @param {string} sourceRepo - path to local worca-cc repo
 * @returns {{ worcaCc: string|null, worcaUi: string|null, worcaCcDev: object|null, worcaUiDev: object|null }}
 */
export function getDevPathVersions(sourceRepo) {
  const result = {
    worcaCc: null,
    worcaUi: null,
    worcaCcDev: null,
    worcaUiDev: null,
  };
  if (!sourceRepo) return result;
  try {
    const pyproject = readFileSync(join(sourceRepo, 'pyproject.toml'), 'utf8');
    const match = pyproject.match(/^version\s*=\s*"([^"]+)"/m);
    if (match) result.worcaCc = match[1];
  } catch {
    // pyproject.toml not found or unreadable
  }
  try {
    const pkg = JSON.parse(
      readFileSync(join(sourceRepo, 'worca-ui', 'package.json'), 'utf8'),
    );
    if (pkg.version) result.worcaUi = pkg.version;
  } catch {
    // package.json not found or unreadable
  }

  result.worcaCcDev = getGitDevStatus(sourceRepo, 'worca-cc-v');
  result.worcaUiDev = getGitDevStatus(sourceRepo, 'worca-ui-v');

  return result;
}

/**
 * Get globally installed @worca/ui version via npm.
 * Falls back to own package.json if npm query fails.
 * @returns {string|null}
 */
function getInstalledUiVersion() {
  try {
    const output = execFileSync('npm', ['list', '-g', '@worca/ui', '--json'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const data = JSON.parse(output);
    return data.dependencies?.['@worca/ui']?.version || null;
  } catch {
    return null;
  }
}

/**
 * Main orchestrator: fetch all version info with caching.
 * @param {{ prefsPath?: string|null, worcaVersion?: object|null, force?: boolean }} options
 * @returns {Promise<object>}
 */
export async function getVersionInfo({ prefsPath, worcaVersion, force } = {}) {
  // Return cached result if fresh
  if (!force && _cache && Date.now() - _cache.timestamp < CACHE_TTL_MS) {
    return _cache.data;
  }

  // Read source_repo from preferences
  let sourceRepo = null;
  if (prefsPath) {
    const prefs = readPreferences(prefsPath);
    sourceRepo = prefs.source_repo || null;
  }

  // Fetch in parallel
  const [npmResult, pypiResult] = await Promise.allSettled([
    fetchNpmVersions('@worca/ui'),
    fetchPyPIVersions('worca-cc'),
  ]);

  const npm =
    npmResult.status === 'fulfilled'
      ? npmResult.value
      : { latest: null, latestRc: null };
  const pypi =
    pypiResult.status === 'fulfilled'
      ? pypiResult.value
      : { latest: null, latestRc: null };

  // Dev path versions
  const devVersions = sourceRepo ? getDevPathVersions(sourceRepo) : null;

  // Installed versions
  const installedUi = getInstalledUiVersion();
  const installedCc = worcaVersion?.installed || null;

  const data = {
    ok: true,
    worcaCc: {
      installed: installedCc,
      latest: pypi.latest,
      latestRc: pypi.latestRc,
    },
    worcaUi: {
      installed: installedUi,
      latest: npm.latest,
      latestRc: npm.latestRc,
    },
    devPath: devVersions
      ? {
          path: sourceRepo,
          worcaCc: devVersions.worcaCc,
          worcaUi: devVersions.worcaUi,
          worcaCcDev: devVersions.worcaCcDev,
          worcaUiDev: devVersions.worcaUiDev,
        }
      : null,
    activeWorcaCc: devVersions?.worcaCc || installedCc,
    installDir: INSTALL_DIR,
    cachedAt: new Date().toISOString(),
  };

  _cache = { data, timestamp: Date.now() };
  return data;
}

/** Clear the cache (for testing). */
export function clearCache() {
  _cache = null;
}
