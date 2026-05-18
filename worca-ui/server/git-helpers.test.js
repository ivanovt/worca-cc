import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const { getDefaultBranch } = await import('./git-helpers.js');

describe('getDefaultBranch', () => {
  it('returns branch from git symbolic-ref when available', () => {
    execFileSync.mockReturnValue('  main  \n');
    const result = getDefaultBranch('/some/project');
    expect(result).toBe('main');
    expect(execFileSync).toHaveBeenCalledWith(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      { cwd: '/some/project', encoding: 'utf8', timeout: 5000 },
    );
  });

  it('strips origin/ prefix from symbolic-ref output', () => {
    execFileSync.mockReturnValue('origin/main\n');
    expect(getDefaultBranch('/proj')).toBe('main');
  });

  it('falls back to master when symbolic-ref throws', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('not a symbolic ref');
    });
    expect(getDefaultBranch('/proj')).toBe('master');
  });

  it('falls back to master when symbolic-ref returns empty string', () => {
    execFileSync.mockReturnValue('  \n');
    expect(getDefaultBranch('/proj')).toBe('master');
  });
});
