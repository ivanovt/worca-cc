import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture spawn calls to inspect args
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
    // Simulate a child that stays alive (timeout resolves the promise)
    return fakeChild;
  }),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

const { startPipeline } = await import('../process-manager.js');

describe('startPipeline arg building', () => {
  let tmpDir, worcaDir;

  beforeEach(() => {
    spawnCalls = [];
    fakeChild.on.mockReset();
    fakeChild.unref.mockReset();

    tmpDir = mkdtempSync(join(tmpdir(), 'pm-args-test-'));
    worcaDir = join(tmpDir, '.worca');
    mkdirSync(worcaDir, { recursive: true });

    // Create the script file so existsSync passes
    const scriptDir = join(tmpDir, '.claude', 'worca', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, 'run_pipeline.py'), '# stub');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function getArgs() {
    expect(spawnCalls.length).toBe(1);
    return spawnCalls[0][1]; // spawn(cmd, args, options)
  }

  // --- New format: sourceType + prompt ---

  it('builds --source arg when sourceType=source', async () => {
    const _p = startPipeline(worcaDir, {
      sourceType: 'source',
      sourceValue: 'gh:issue:42',
      projectRoot: tmpDir,
    });
    // Trigger the timeout resolve via the 'on' mock
    // The promise resolves after 2s timeout, so we need to handle it
    // Actually, fakeChild.on doesn't fire events, so the timeout fires
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--source');
    expect(args[args.indexOf('--source') + 1]).toBe('gh:issue:42');
    expect(args).not.toContain('--prompt');
  });

  it('builds --spec arg when sourceType=spec', async () => {
    startPipeline(worcaDir, {
      sourceType: 'spec',
      sourceValue: 'docs/spec.md',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--spec');
    expect(args[args.indexOf('--spec') + 1]).toBe('docs/spec.md');
    expect(args).not.toContain('--prompt');
  });

  it('builds --prompt arg when sourceType=none with prompt', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'Add user auth',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--prompt');
    expect(args[args.indexOf('--prompt') + 1]).toBe('Add user auth');
    expect(args).not.toContain('--source');
    expect(args).not.toContain('--spec');
  });

  it('builds --source + --prompt when both provided', async () => {
    startPipeline(worcaDir, {
      sourceType: 'source',
      sourceValue: 'gh:issue:42',
      prompt: 'focus on auth',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--source');
    expect(args[args.indexOf('--source') + 1]).toBe('gh:issue:42');
    expect(args).toContain('--prompt');
    expect(args[args.indexOf('--prompt') + 1]).toBe('focus on auth');
  });

  it('builds only --plan when plan-only (no source, no prompt)', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      planFile: 'docs/plans/my-plan.md',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--plan');
    expect(args[args.indexOf('--plan') + 1]).toBe('docs/plans/my-plan.md');
    expect(args).not.toContain('--source');
    expect(args).not.toContain('--spec');
    expect(args).not.toContain('--prompt');
  });

  it('builds --spec + --prompt + --plan when all provided', async () => {
    startPipeline(worcaDir, {
      sourceType: 'spec',
      sourceValue: 'docs/spec.md',
      prompt: 'extra instructions',
      planFile: 'docs/plans/my-plan.md',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--spec');
    expect(args[args.indexOf('--spec') + 1]).toBe('docs/spec.md');
    expect(args).toContain('--prompt');
    expect(args[args.indexOf('--prompt') + 1]).toBe('extra instructions');
    expect(args).toContain('--plan');
    expect(args[args.indexOf('--plan') + 1]).toBe('docs/plans/my-plan.md');
  });

  // --- Legacy format: inputType/inputValue ---

  it('legacy: builds --prompt from inputType=prompt', async () => {
    startPipeline(worcaDir, {
      inputType: 'prompt',
      inputValue: 'Add user auth',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--prompt');
    expect(args[args.indexOf('--prompt') + 1]).toBe('Add user auth');
  });

  it('legacy: builds --source from inputType=source', async () => {
    startPipeline(worcaDir, {
      inputType: 'source',
      inputValue: 'gh:issue:42',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--source');
    expect(args[args.indexOf('--source') + 1]).toBe('gh:issue:42');
  });

  it('legacy: builds --spec from inputType=spec', async () => {
    startPipeline(worcaDir, {
      inputType: 'spec',
      inputValue: 'docs/spec.md',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--spec');
    expect(args[args.indexOf('--spec') + 1]).toBe('docs/spec.md');
  });

  // --- Other options ---

  it('passes --claude-md-mode when claudeMdMode is set', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'test',
      claudeMdMode: 'project',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--claude-md-mode');
    expect(args[args.indexOf('--claude-md-mode') + 1]).toBe('project');
  });

  it('omits --claude-md-mode when claudeMdMode is null', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'test',
      claudeMdMode: null,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).not.toContain('--claude-md-mode');
  });

  it('passes --max-beads 0 when maxBeads=0 (Auto override)', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'test',
      maxBeads: 0,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--max-beads');
    expect(args[args.indexOf('--max-beads') + 1]).toBe('0');
  });

  it('passes --max-beads when maxBeads > 0', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'test',
      maxBeads: 3,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--max-beads');
    expect(args[args.indexOf('--max-beads') + 1]).toBe('3');
  });

  it('omits --max-beads when maxBeads is null', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'test',
      maxBeads: null,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).not.toContain('--max-beads');
  });

  it('omits --max-beads when maxBeads is absent', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'test',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).not.toContain('--max-beads');
  });

  it('includes --msize and --mloops when > 1', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'test',
      msize: 3,
      mloops: 2,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--msize');
    expect(args[args.indexOf('--msize') + 1]).toBe('3');
    expect(args).toContain('--mloops');
    expect(args[args.indexOf('--mloops') + 1]).toBe('2');
  });

  it('omits --msize and --mloops when 1', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'test',
      msize: 1,
      mloops: 1,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).not.toContain('--msize');
    expect(args).not.toContain('--mloops');
  });

  it('includes --branch when provided', async () => {
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: 'test',
      branch: 'feature/my-branch',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--branch');
    expect(args[args.indexOf('--branch') + 1]).toBe('feature/my-branch');
  });

  it('uses --resume when resume=true', async () => {
    startPipeline(worcaDir, {
      resume: true,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--resume');
    expect(args).not.toContain('--source');
    expect(args).not.toContain('--prompt');
  });

  it('passes --status-dir as the worca root for resume (not the per-run dir)', async () => {
    // The runner derives worca_dir from dirname(status_path) and builds the
    // run dir as <worca_dir>/runs/<run_id>/. Passing the per-run dir would
    // make it nest a fresh runs/<run_id>/ underneath and write status to a
    // shadow path the UI never reads.
    startPipeline(worcaDir, {
      resume: true,
      runId: 'run-20260101-abc',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--resume');
    expect(args).toContain('--status-dir');
    expect(args[args.indexOf('--status-dir') + 1]).toBe(worcaDir);
    // Must NOT be the per-run dir.
    expect(args[args.indexOf('--status-dir') + 1]).not.toContain(
      'run-20260101-abc',
    );
  });

  it('omits --status-dir when resume=true but no runId', async () => {
    startPipeline(worcaDir, {
      resume: true,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--resume');
    expect(args).not.toContain('--status-dir');
  });

  it('resume of a worktree-registered run spawns inside the worktree cwd', async () => {
    // Set up a separate worktree path with its own .claude/worca runtime and
    // register the run in the parent's pipelines.d/.
    const runId = '20260317-084204-001-wtres';
    const worktreePath = join(tmpDir, '.worktrees', `pipeline-${runId}`);
    const wtScriptDir = join(worktreePath, '.claude', 'worca', 'scripts');
    mkdirSync(wtScriptDir, { recursive: true });
    writeFileSync(join(wtScriptDir, 'run_pipeline.py'), '# stub');
    mkdirSync(join(worktreePath, '.worca', 'runs', runId), { recursive: true });
    mkdirSync(join(worcaDir, 'multi', 'pipelines.d'), { recursive: true });
    writeFileSync(
      join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: worktreePath }),
    );

    // Note: NOT passing projectRoot — that's what the resume route does.
    startPipeline(worcaDir, { resume: true, runId });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const opts = spawnCalls[0][2];
    expect(opts.cwd).toBe(worktreePath);

    // status-dir is the worktree's worca root, not the per-run dir.
    const args = getArgs();
    expect(args).toContain('--status-dir');
    expect(args[args.indexOf('--status-dir') + 1]).toBe(
      join(worktreePath, '.worca'),
    );

    // registry-base must point at the parent's .worca so update_pipeline()
    // lands on the registered entry (the worktree's own .worca has no
    // pipelines.d/<id>.json — the entry only exists in the parent).
    expect(args).toContain('--registry-base');
    expect(args[args.indexOf('--registry-base') + 1]).toBe(worcaDir);
  });

  it('resume of a NON-worktree (local) run does NOT pass --registry-base', async () => {
    // Local in-place runs have status.json under the project's .worca/runs/
    // and no pipelines.d/ entry, so --registry-base is unnecessary noise.
    const runId = '20260317-084204-001-local';
    const localRunDir = join(worcaDir, 'runs', runId);
    mkdirSync(localRunDir, { recursive: true });
    writeFileSync(join(localRunDir, 'status.json'), '{}');

    startPipeline(worcaDir, {
      resume: true,
      runId,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).not.toContain('--registry-base');
  });

  it('resume flips terminal pipeline_status (interrupted/failed) to "resuming"', async () => {
    // _find_active_runs filters out pipeline_status in {completed, interrupted}.
    // The runner won't pick up an interrupted run for resume unless we flip
    // its status to a non-terminal value first.
    const runId = '20260317-084204-001-flip';
    const worktreePath = join(tmpDir, '.worktrees', `pipeline-${runId}`);
    const wtScriptDir = join(worktreePath, '.claude', 'worca', 'scripts');
    mkdirSync(wtScriptDir, { recursive: true });
    writeFileSync(join(wtScriptDir, 'run_pipeline.py'), '# stub');
    const wtRunDir = join(worktreePath, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    const statusPath = join(wtRunDir, 'status.json');
    writeFileSync(
      statusPath,
      JSON.stringify({
        run_id: runId,
        pipeline_status: 'interrupted',
        stop_reason: 'signal',
        work_request: { title: 't' },
      }),
    );
    mkdirSync(join(worcaDir, 'multi', 'pipelines.d'), { recursive: true });
    writeFileSync(
      join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: worktreePath }),
    );

    startPipeline(worcaDir, { resume: true, runId });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const updated = JSON.parse(readFileSync(statusPath, 'utf8'));
    expect(updated.pipeline_status).toBe('resuming');
    expect(updated.stop_reason).toBeUndefined();
  });

  it('resume leaves non-terminal pipeline_status alone', async () => {
    // If pipeline_status is already 'paused' or 'running', don't clobber it.
    const runId = '20260317-084204-001-keep';
    const worktreePath = join(tmpDir, '.worktrees', `pipeline-${runId}`);
    const wtScriptDir = join(worktreePath, '.claude', 'worca', 'scripts');
    mkdirSync(wtScriptDir, { recursive: true });
    writeFileSync(join(wtScriptDir, 'run_pipeline.py'), '# stub');
    const wtRunDir = join(worktreePath, '.worca', 'runs', runId);
    mkdirSync(wtRunDir, { recursive: true });
    const statusPath = join(wtRunDir, 'status.json');
    writeFileSync(
      statusPath,
      JSON.stringify({
        run_id: runId,
        pipeline_status: 'paused',
        work_request: { title: 't' },
      }),
    );
    mkdirSync(join(worcaDir, 'multi', 'pipelines.d'), { recursive: true });
    writeFileSync(
      join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: worktreePath }),
    );

    startPipeline(worcaDir, { resume: true, runId });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const updated = JSON.parse(readFileSync(statusPath, 'utf8'));
    expect(updated.pipeline_status).toBe('paused');
  });

  it('resume of a worktree run ignores projectRoot in favor of the worktree', async () => {
    // The WebSocket resume-run handler passes projectRoot unconditionally.
    // For worktree-hosted runs the worktree must still win.
    const runId = '20260317-084204-001-wsres';
    const worktreePath = join(tmpDir, '.worktrees', `pipeline-${runId}`);
    const wtScriptDir = join(worktreePath, '.claude', 'worca', 'scripts');
    mkdirSync(wtScriptDir, { recursive: true });
    writeFileSync(join(wtScriptDir, 'run_pipeline.py'), '# stub');
    mkdirSync(join(worktreePath, '.worca', 'runs', runId), { recursive: true });
    mkdirSync(join(worcaDir, 'multi', 'pipelines.d'), { recursive: true });
    writeFileSync(
      join(worcaDir, 'multi', 'pipelines.d', `${runId}.json`),
      JSON.stringify({ run_id: runId, worktree_path: worktreePath }),
    );

    startPipeline(worcaDir, {
      resume: true,
      runId,
      projectRoot: tmpDir, // simulate the WS handler
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    expect(spawnCalls[0][2].cwd).toBe(worktreePath);
  });
});

// --- Large prompt offloading ---

const ARG_INLINE_LIMIT = 128 * 1024;

describe('large prompt offloading', () => {
  let tmpDir, worcaDir;

  beforeEach(() => {
    spawnCalls = [];
    fakeChild.on.mockReset();
    fakeChild.unref.mockReset();

    tmpDir = mkdtempSync(join(tmpdir(), 'pm-args-test-'));
    worcaDir = join(tmpDir, '.worca');
    mkdirSync(worcaDir, { recursive: true });

    const scriptDir = join(tmpDir, '.claude', 'worca', 'scripts');
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, 'run_pipeline.py'), '# stub');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function getArgs() {
    expect(spawnCalls.length).toBe(1);
    return spawnCalls[0][1];
  }

  it('writePromptFile creates a file with restricted permissions (0o600)', async () => {
    const largePrompt = 'X'.repeat(ARG_INLINE_LIMIT + 1);
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: largePrompt,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    const promptFilePath = args[args.indexOf('--prompt-file') + 1];
    expect(promptFilePath).toBeTruthy();

    const stat = statSync(promptFilePath);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }

    // Verify the file content matches the prompt
    const content = readFileSync(promptFilePath, 'utf8');
    expect(content).toBe(largePrompt);

    // Clean up the temp file
    rmSync(promptFilePath, { force: true });
  });

  it('uses --prompt-file when prompt exceeds ARG_INLINE_LIMIT', async () => {
    const largePrompt = 'A'.repeat(ARG_INLINE_LIMIT + 100);
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: largePrompt,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--prompt-file');
    expect(args).not.toContain('--prompt');

    const promptFilePath = args[args.indexOf('--prompt-file') + 1];
    expect(promptFilePath).toMatch(/worca_prompt_.*\.md$/);
    expect(existsSync(promptFilePath)).toBe(true);

    // Clean up
    rmSync(promptFilePath, { force: true });
  });

  it('legacy format uses --prompt-file when prompt exceeds ARG_INLINE_LIMIT', async () => {
    const largePrompt = 'B'.repeat(ARG_INLINE_LIMIT + 100);
    startPipeline(worcaDir, {
      inputType: 'prompt',
      inputValue: largePrompt,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--prompt-file');
    expect(args).not.toContain('--prompt');

    const promptFilePath = args[args.indexOf('--prompt-file') + 1];
    expect(promptFilePath).toMatch(/worca_prompt_.*\.md$/);

    const content = readFileSync(promptFilePath, 'utf8');
    expect(content).toBe(largePrompt);

    // Clean up
    rmSync(promptFilePath, { force: true });
  });

  it('small prompts still use --prompt inline', async () => {
    const smallPrompt = 'Add user auth';
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: smallPrompt,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--prompt');
    expect(args).not.toContain('--prompt-file');
    expect(args[args.indexOf('--prompt') + 1]).toBe(smallPrompt);
  });

  it('prompt exactly at ARG_INLINE_LIMIT uses --prompt inline', async () => {
    const exactPrompt = 'C'.repeat(ARG_INLINE_LIMIT);
    startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: exactPrompt,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--prompt');
    expect(args).not.toContain('--prompt-file');
    expect(args[args.indexOf('--prompt') + 1]).toBe(exactPrompt);
  });

  it('cleans up prompt file on spawn error', async () => {
    const largePrompt = 'D'.repeat(ARG_INLINE_LIMIT + 100);
    const promise = startPipeline(worcaDir, {
      sourceType: 'none',
      prompt: largePrompt,
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    const promptFilePath = args[args.indexOf('--prompt-file') + 1];
    expect(existsSync(promptFilePath)).toBe(true);

    // Find and trigger the 'error' event handler registered on fakeChild
    const errorCall = fakeChild.on.mock.calls.find(
      ([event]) => event === 'error',
    );
    expect(errorCall).toBeTruthy();
    const errorHandler = errorCall[1];
    errorHandler(new Error('spawn ENOENT'));

    await expect(promise).rejects.toThrow('Failed to start pipeline');
    expect(existsSync(promptFilePath)).toBe(false);
  });
});
