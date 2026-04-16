/**
 * Version comparison helpers shared between the settings view and the
 * add-project dialog. Understands RC suffixes (e.g. "0.6.0rc3" < "0.6.0").
 */

export function parseVersion(v) {
  // "0.6.0rc7" → { parts: [0, 6, 0], rc: 7 }
  // "0.6.0"    → { parts: [0, 6, 0], rc: Infinity } (stable > any rc)
  // "0.1.0-rc.5" → { parts: [0, 1, 0], rc: 5 }
  if (!v) return { parts: [], rc: Infinity };
  const rcMatch = v.match(/^(.+?)[-.]?rc\.?(\d+)$/);
  const base = rcMatch ? rcMatch[1] : v;
  const rc = rcMatch ? parseInt(rcMatch[2], 10) : Infinity;
  const parts = base.split('.').map((s) => parseInt(s, 10) || 0);
  return { parts, rc };
}

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
