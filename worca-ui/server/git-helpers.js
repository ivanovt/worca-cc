import { execFileSync } from 'node:child_process';

export function getDefaultBranch(projectRoot) {
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
  return 'master';
}
