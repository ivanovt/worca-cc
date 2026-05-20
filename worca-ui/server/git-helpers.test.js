import { execFileSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

const { getDefaultBranch, _clearDefaultBranchCache } = await import(
  './git-helpers.js'
);

beforeEach(() => {
  _clearDefaultBranchCache();
  execFileSync.mockReset();
});

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
    execFileSync.mockReturnValue('origin/develop\n');
    expect(getDefaultBranch('/proj-strip')).toBe('develop');
  });

  it('falls back to main when symbolic-ref throws', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('not a symbolic ref');
    });
    expect(getDefaultBranch('/proj-throw')).toBe('main');
  });

  it('falls back to main when symbolic-ref returns empty string', () => {
    execFileSync.mockReturnValue('  \n');
    expect(getDefaultBranch('/proj-empty')).toBe('main');
  });
});

describe('getDefaultBranch - caching', () => {
  it('caches per projectRoot — repeat calls skip the git subprocess', () => {
    execFileSync.mockReturnValue('main\n');
    getDefaultBranch('/repo-a');
    getDefaultBranch('/repo-a');
    getDefaultBranch('/repo-a');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('keeps separate cache entries per projectRoot', () => {
    execFileSync.mockReturnValueOnce('main\n').mockReturnValueOnce('develop\n');
    expect(getDefaultBranch('/repo-a')).toBe('main');
    expect(getDefaultBranch('/repo-b')).toBe('develop');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it('cached fallback also avoids repeat subprocess calls when git fails', () => {
    execFileSync.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(getDefaultBranch('/repo-fail')).toBe('main');
    expect(getDefaultBranch('/repo-fail')).toBe('main');
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('_clearDefaultBranchCache forces a fresh resolution', () => {
    execFileSync.mockReturnValueOnce('main\n').mockReturnValueOnce('develop\n');
    expect(getDefaultBranch('/repo-c')).toBe('main');
    _clearDefaultBranchCache();
    expect(getDefaultBranch('/repo-c')).toBe('develop');
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });
});
