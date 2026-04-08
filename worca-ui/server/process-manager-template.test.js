/**
 * Tests: ProcessManager.startPipeline() passes --template arg when opts.template is set.
 * TDD: written before implementation.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process to capture spawn args
const mockChildOn = vi.fn();
const mockChildUnref = vi.fn();
const mockChild = {
  pid: 99999,
  on: mockChildOn,
  removeAllListeners: vi.fn(),
  unref: mockChildUnref,
};

const mockSpawn = vi.fn().mockReturnValue(mockChild);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: (...args) => mockSpawn(...args),
  };
});

const { ProcessManager } = await import('./process-manager.js');

describe('ProcessManager.startPipeline() --template arg', () => {
  let worcaDir;
  let projectRoot;

  beforeEach(() => {
    worcaDir = join(
      tmpdir(),
      `worca-pm-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    projectRoot = join(
      tmpdir(),
      `worca-proj-tpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(worcaDir, { recursive: true });
    mkdirSync(join(projectRoot, '.claude', 'worca', 'scripts'), {
      recursive: true,
    });
    // Create a stub pipeline script so the file-existence check passes
    writeFileSync(
      join(projectRoot, '.claude/worca/scripts/run_pipeline.py'),
      '# stub\n',
    );

    mockSpawn.mockClear();
    mockChildOn.mockClear();
    mockChildUnref.mockClear();

    // Default: child emits no events (resolves via timeout)
    mockChildOn.mockImplementation((event, cb) => {
      // Simulate immediate resolution for 'exit' with code 0
      if (event === 'exit') {
        setTimeout(() => cb(0, null), 10);
      }
      return mockChild;
    });
  });

  afterEach(() => {
    rmSync(worcaDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('does NOT add --template when opts.template is undefined', async () => {
    const pm = new ProcessManager({ worcaDir, projectRoot });
    await pm.startPipeline({ sourceType: 'none', prompt: 'hello' });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).not.toContain('--template');
  });

  it('adds --template <value> when opts.template is set', async () => {
    const pm = new ProcessManager({ worcaDir, projectRoot });
    await pm.startPipeline({
      sourceType: 'none',
      prompt: 'hello',
      template: 'my-template',
    });

    const args = mockSpawn.mock.calls[0][1];
    const idx = args.indexOf('--template');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('my-template');
  });

  it('adds --template correctly alongside --branch', async () => {
    const pm = new ProcessManager({ worcaDir, projectRoot });
    await pm.startPipeline({
      sourceType: 'none',
      prompt: 'hello',
      branch: 'main',
      template: 'fast-track',
    });

    const args = mockSpawn.mock.calls[0][1];
    expect(args).toContain('--branch');
    expect(args).toContain('--template');
    const tplIdx = args.indexOf('--template');
    expect(args[tplIdx + 1]).toBe('fast-track');
  });
});
