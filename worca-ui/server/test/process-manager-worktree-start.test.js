import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let spawnCalls = [];
const fakeChild = {
  pid: 99999,
  unref: vi.fn(),
  on: vi.fn(),
  removeAllListeners: vi.fn(),
};

vi.mock('node:child_process', () => ({
  spawn: vi.fn((...args) => {
    spawnCalls.push(args);
    return fakeChild;
  }),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

const { startPipeline } = await import('../process-manager.js');

describe('startPipeline script selection', () => {
  let tmpDir, worcaDir, scriptDir;

  beforeEach(() => {
    spawnCalls = [];
    fakeChild.on.mockReset();
    fakeChild.unref.mockReset();

    tmpDir = mkdtempSync(join(tmpdir(), 'pm-wt-test-'));
    worcaDir = join(tmpDir, '.worca');
    mkdirSync(worcaDir, { recursive: true });

    scriptDir = join(tmpDir, '.claude', 'worca', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, 'run_pipeline.py'), '# stub');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('startPipeline_uses_worktree: spawns run_worktree.py for new run when it exists', async () => {
    writeFileSync(join(scriptDir, 'run_worktree.py'), '# stub');

    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'Add feature',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const scriptArg = spawnCalls[0][1][0];
    expect(scriptArg).toContain('run_worktree.py');
    expect(scriptArg).not.toContain('run_pipeline.py');
  });

  it('startPipeline_resume_uses_pipeline: spawns run_pipeline.py for resume even when run_worktree.py exists', async () => {
    writeFileSync(join(scriptDir, 'run_worktree.py'), '# stub');

    startPipeline(worcaDir, {
      resume: true,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = spawnCalls[0][1];
    expect(args[0]).toContain('run_pipeline.py');
    expect(args[0]).not.toContain('run_worktree.py');
    expect(args).toContain('--resume');
  });

  it('falls back to run_pipeline.py with console warning when run_worktree.py is missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'Add feature',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const scriptArg = spawnCalls[0][1][0];
    expect(scriptArg).toContain('run_pipeline.py');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('run_worktree.py'),
    );

    warnSpy.mockRestore();
  });
});
