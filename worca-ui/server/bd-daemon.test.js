import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    promisify:
      (fn) =>
      (...args) =>
        new Promise((resolve, reject) => {
          fn(...args, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout, stderr });
          });
        }),
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn() };
});

const { execFile } = await import('node:child_process');
const { existsSync } = await import('node:fs');
const { ensureBdDaemon } = await import('./bd-daemon.js');

function mockBdSuccess() {
  execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(null, '', '');
  });
}

function mockBdFailure(msg = 'not running') {
  execFile.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    const err = new Error(msg);
    err.code = 1;
    cb(err, '', '');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockImplementation((p) => !String(p).endsWith('daemon.stopped'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ensureBdDaemon', () => {
  it('returns true when daemon is already running', async () => {
    mockBdSuccess();
    const result = await ensureBdDaemon('/project/.worca');
    expect(result).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][1]).toEqual(['daemon', 'status']);
  });

  it('starts daemon when status returns non-zero', async () => {
    mockBdFailure();
    mockBdSuccess();
    const result = await ensureBdDaemon('/project/.worca');
    expect(result).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[0][1]).toEqual(['daemon', 'status']);
    expect(execFile.mock.calls[1][1]).toEqual(['daemon', 'start']);
  });

  it('returns false when beads dir does not exist', async () => {
    existsSync.mockReturnValue(false);
    const result = await ensureBdDaemon('/project/.worca');
    expect(result).toBe(false);
    expect(execFile).not.toHaveBeenCalled();
  });

  it('returns false when daemon is not running and sentinel blocks auto-start', async () => {
    // Sentinel exists AND daemon is not running → ensure must not auto-start.
    existsSync.mockReturnValue(true);
    mockBdFailure();
    const result = await ensureBdDaemon('/project/.worca');
    expect(result).toBe(false);
    // Status probe ran; start did not.
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][1]).toEqual(['daemon', 'status']);
  });

  it('returns true when sentinel exists but daemon is already running', async () => {
    // Sentinel must only block auto-start, not auto-detect. If a user
    // started the daemon manually after a deliberate stop, we report it.
    existsSync.mockReturnValue(true);
    mockBdSuccess();
    const result = await ensureBdDaemon('/project/.worca');
    expect(result).toBe(true);
    expect(execFile).toHaveBeenCalledTimes(1);
    expect(execFile.mock.calls[0][1]).toEqual(['daemon', 'status']);
  });

  it('returns false when both status and start fail', async () => {
    mockBdFailure();
    mockBdFailure('start failed');
    const result = await ensureBdDaemon('/project/.worca');
    expect(result).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('passes correct cwd and BEADS_DIR env', async () => {
    mockBdSuccess();
    await ensureBdDaemon('/project/.worca');
    const opts = execFile.mock.calls[0][2];
    expect(opts.cwd).toBe(resolve(join('/project/.worca', '..')));
    expect(opts.env.BEADS_DIR).toBe(
      resolve(join('/project/.worca', '..', '.beads')),
    );
  });

  it('resolves beads dir as sibling of worcaDir parent', async () => {
    mockBdSuccess();
    await ensureBdDaemon('/some/deep/project/.worca');
    const opts = execFile.mock.calls[0][2];
    expect(opts.env.BEADS_DIR).toBe(
      resolve(join('/some/deep/project/.worca', '..', '.beads')),
    );
    expect(opts.cwd).toBe(resolve(join('/some/deep/project/.worca', '..')));
  });

  it('sets timeout on subprocess calls', async () => {
    mockBdSuccess();
    await ensureBdDaemon('/project/.worca');
    const opts = execFile.mock.calls[0][2];
    expect(opts.timeout).toBe(5000);
  });

  it('uses same options for start as for status', async () => {
    mockBdFailure();
    mockBdSuccess();
    await ensureBdDaemon('/project/.worca');
    const statusOpts = execFile.mock.calls[0][2];
    const startOpts = execFile.mock.calls[1][2];
    expect(startOpts.cwd).toBe(statusOpts.cwd);
    expect(startOpts.env.BEADS_DIR).toBe(statusOpts.env.BEADS_DIR);
    expect(startOpts.timeout).toBe(statusOpts.timeout);
  });
});
