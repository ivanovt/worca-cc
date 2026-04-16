// server/version-check.js — worca-cc version compatibility check
import { execFile } from 'node:child_process';

/** Minimum worca-cc version required by this @worca/ui release. */
export const MIN_WORCA_CC = '0.6.0';

/**
 * Parse the version string from `worca --version` output.
 * Expected format: "worca-cc X.Y.Z" or "worca-cc X.Y.Zrc3"
 * @param {string} output - stdout from `worca --version`
 * @returns {string|null} version string or null if unparseable
 */
export function parseWorcaVersion(output) {
  const match = output.trim().match(/^worca-cc\s+(\S+)/);
  return match ? match[1] : null;
}

/**
 * Compare two semver-ish versions, ignoring pre-release suffixes.
 * "0.6.0rc3" satisfies ">= 0.6.0".
 * @param {string} installed - installed version (e.g. "0.6.0rc3")
 * @param {string} minimum - minimum required version (e.g. "0.6.0")
 * @returns {boolean} true if installed >= minimum
 */
export function meetsMinimum(installed, minimum) {
  const parse = (v) =>
    v.split('.').map((s) => {
      const n = parseInt(s, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  const inst = parse(installed);
  const min = parse(minimum);
  const len = Math.max(inst.length, min.length);
  for (let i = 0; i < len; i++) {
    const a = inst[i] || 0;
    const b = min[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true; // equal
}

/**
 * Parse a version string into comparable parts, tracking RC suffixes.
 * "0.6.0rc7" → { parts: [0, 6, 0], rc: 7 }
 * "0.6.0"    → { parts: [0, 6, 0], rc: Infinity } (stable > any rc)
 * "0.1.0-rc.5" → { parts: [0, 1, 0], rc: 5 }
 */
export function parseVersion(v) {
  if (!v) return { parts: [], rc: Infinity };
  const rcMatch = v.match(/^(.+?)[-.]?rc\.?(\d+)$/);
  const base = rcMatch ? rcMatch[1] : v;
  const rc = rcMatch ? parseInt(rcMatch[2], 10) : Infinity;
  const parts = base.split('.').map((s) => parseInt(s, 10) || 0);
  return { parts, rc };
}

/**
 * Returns true if `project` version is strictly behind `active`.
 * RC-aware: "0.6.0rc3" is behind "0.6.0". Returns false if either arg is falsy.
 */
export function isVersionBehind(project, active) {
  if (!project || !active) return false;
  const p = parseVersion(project);
  const a = parseVersion(active);
  const len = Math.max(p.parts.length, a.parts.length);
  for (let i = 0; i < len; i++) {
    const pv = p.parts[i] || 0;
    const av = a.parts[i] || 0;
    if (pv < av) return true;
    if (pv > av) return false;
  }
  // Same base version — compare RC numbers
  if (p.rc < a.rc) return true;
  return false;
}

/**
 * Run `worca --version` and check compatibility.
 * @returns {Promise<{ok: boolean, installed: string|null, minimum: string, message: string}>}
 */
export async function checkWorcaVersion() {
  const minimum = MIN_WORCA_CC;
  try {
    const output = await new Promise((resolve, reject) => {
      execFile('worca', ['--version'], { timeout: 5000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout);
      });
    });
    const installed = parseWorcaVersion(output);
    if (!installed) {
      return {
        ok: false,
        installed: null,
        minimum,
        message: `worca CLI not found — install with 'pip install worca-cc'`,
      };
    }
    const ok = meetsMinimum(installed, minimum);
    return {
      ok,
      installed,
      minimum,
      message: ok
        ? `worca-cc ${installed} — compatible`
        : `WARNING: worca-cc ${installed} found, minimum ${minimum} required — run 'pip install --upgrade worca-cc'`,
    };
  } catch {
    return {
      ok: false,
      installed: null,
      minimum,
      message: `worca CLI not found — install with 'pip install worca-cc'`,
    };
  }
}
