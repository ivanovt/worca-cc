import { execFileSync } from 'node:child_process';

const CACHE_TTL_MS = 30_000;
const cache = new Map();

function _resolveDefaultBranch(projectRoot) {
  try {
    const out = execFileSync(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      { cwd: projectRoot, encoding: 'utf8', timeout: 5000 },
    );
    const branch = out.trim().replace(/^origin\//, '');
    if (branch) return branch;
  } catch {
    // no symbolic-ref configured — fall through
  }
  return 'main';
}

export function getDefaultBranch(projectRoot) {
  const now = Date.now();
  const hit = cache.get(projectRoot);
  if (hit && hit.expiresAt > now) return hit.value;
  const value = _resolveDefaultBranch(projectRoot);
  cache.set(projectRoot, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

export function _clearDefaultBranchCache() {
  cache.clear();
}
