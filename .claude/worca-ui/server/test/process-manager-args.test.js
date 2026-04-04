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

  it('includes --status-dir when resume=true and runId provided', async () => {
    startPipeline(worcaDir, {
      resume: true,
      runId: 'run-20260101-abc',
      projectRoot: tmpDir,
    });
    await vi.waitFor(() => expect(spawnCalls.length).toBe(1), { timeout: 100 });

    const args = getArgs();
    expect(args).toContain('--resume');
    expect(args).toContain('--status-dir');
    expect(args[args.indexOf('--status-dir') + 1]).toContain(
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
    // 0o600 = owner read/write only (octal 33152 on Linux = 0o100600, mode & 0o777 = 0o600)
    expect(stat.mode & 0o777).toBe(0o600);

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
