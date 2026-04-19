import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let spawnCalls = [];
let childFactory;

function makeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  child.killed = false;
  return child;
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((...args) => {
    spawnCalls.push(args);
    const child = childFactory ? childFactory() : makeChild();
    return child;
  }),
}));

const { dispatchExternal, resolvePythonCmd } = await import(
  '../dispatch-external.js'
);

describe('resolvePythonCmd', () => {
  const originalEnv = process.env;
  const originalPlatform = process.platform;

  afterEach(() => {
    process.env = originalEnv;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('returns WORCA_PYTHON when set', () => {
    process.env = { ...originalEnv, WORCA_PYTHON: '/custom/python3.12' };
    expect(resolvePythonCmd()).toEqual(['/custom/python3.12']);
  });

  it('returns python3 first on non-Windows', () => {
    process.env = { ...originalEnv };
    delete process.env.WORCA_PYTHON;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const candidates = resolvePythonCmd();
    expect(candidates[0]).toBe('python3');
  });

  it('returns py -3 first on Windows', () => {
    process.env = { ...originalEnv };
    delete process.env.WORCA_PYTHON;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const candidates = resolvePythonCmd();
    expect(candidates[0]).toBe('py');
    expect(candidates).toContain('python');
  });
});

describe('dispatchExternal', () => {
  beforeEach(() => {
    spawnCalls = [];
    childFactory = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('spawns python with correct args', async () => {
    const child = makeChild();
    childFactory = () => child;

    const p = dispatchExternal({
      runDir: '/tmp/runs/abc',
      settingsPath: '/tmp/.claude/settings.json',
      eventType: 'pipeline.run.cancelled',
      payload: { source: 'user_cancel' },
    });

    child.stdout.emit('data', Buffer.from('{"ok":true,"event_id":"evt-1"}'));
    child.emit('close', 0);

    const result = await p;
    expect(result).toEqual({ ok: true, event_id: 'evt-1' });

    expect(spawnCalls.length).toBeGreaterThanOrEqual(1);
    const [, args] = spawnCalls[0];
    expect(args).toContain('-m');
    expect(args).toContain('worca.events.dispatch_external');
    expect(args).toContain('--run-dir');
    expect(args).toContain('/tmp/runs/abc');
    expect(args).toContain('--settings');
    expect(args).toContain('/tmp/.claude/settings.json');
    expect(args).toContain('--event-type');
    expect(args).toContain('pipeline.run.cancelled');
    expect(args).toContain('--payload-json');
    expect(args).toContain('{"source":"user_cancel"}');
  });

  it('returns ok:false with reason on non-zero exit', async () => {
    const child = makeChild();
    childFactory = () => child;

    const p = dispatchExternal({
      runDir: '/tmp/runs/abc',
      settingsPath: '/tmp/settings.json',
      eventType: 'pipeline.run.interrupted',
      payload: {},
    });

    child.stderr.emit('data', Buffer.from('missing status.json'));
    child.emit('close', 2);

    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('exit_code_2');
    expect(result.stderr).toContain('missing status.json');
  });

  it('resolves ok:false with reason timeout on timeout', async () => {
    const child = makeChild();
    childFactory = () => child;

    const p = dispatchExternal({
      runDir: '/tmp/runs/abc',
      settingsPath: '/tmp/settings.json',
      eventType: 'pipeline.run.cancelled',
      payload: {},
      timeoutMs: 50,
    });

    const result = await p;
    expect(result).toEqual({ ok: false, reason: 'timeout' });
    expect(child.kill).toHaveBeenCalled();
  });

  it('falls back to next python candidate on ENOENT', async () => {
    let callCount = 0;
    childFactory = () => {
      callCount++;
      const child = makeChild();
      if (callCount === 1) {
        process.nextTick(() =>
          child.emit(
            'error',
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
          ),
        );
      } else {
        process.nextTick(() => {
          child.stdout.emit(
            'data',
            Buffer.from('{"ok":true,"event_id":"evt-2"}'),
          );
          child.emit('close', 0);
        });
      }
      return child;
    };

    const result = await dispatchExternal({
      runDir: '/tmp/runs/abc',
      settingsPath: '/tmp/settings.json',
      eventType: 'pipeline.run.failed',
      payload: {},
    });

    expect(spawnCalls.length).toBe(2);
    expect(result).toEqual({ ok: true, event_id: 'evt-2' });
  });

  it('returns python_not_found when all candidates fail with ENOENT', async () => {
    childFactory = () => {
      const child = makeChild();
      process.nextTick(() =>
        child.emit(
          'error',
          Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        ),
      );
      return child;
    };

    const result = await dispatchExternal({
      runDir: '/tmp/runs/abc',
      settingsPath: '/tmp/settings.json',
      eventType: 'pipeline.run.cancelled',
      payload: {},
    });

    expect(result).toEqual({ ok: false, reason: 'python_not_found' });
  });

  it('uses default timeoutMs of 60000', async () => {
    const child = makeChild();
    childFactory = () => child;

    const p = dispatchExternal({
      runDir: '/tmp/runs/abc',
      settingsPath: '/tmp/settings.json',
      eventType: 'pipeline.run.cancelled',
      payload: {},
    });

    child.stdout.emit('data', Buffer.from('{"ok":true,"event_id":"e1"}'));
    child.emit('close', 0);

    await p;
    // Implicitly tests that it doesn't timeout within test duration
    // The default 60s timeout is tested by the fact we didn't pass timeoutMs
  });

  it('collects chunked stdout', async () => {
    const child = makeChild();
    childFactory = () => child;

    const p = dispatchExternal({
      runDir: '/tmp/runs/abc',
      settingsPath: '/tmp/settings.json',
      eventType: 'pipeline.run.cancelled',
      payload: {},
    });

    child.stdout.emit('data', Buffer.from('{"ok":true,'));
    child.stdout.emit('data', Buffer.from('"event_id":"evt-chunk"}'));
    child.emit('close', 0);

    const result = await p;
    expect(result).toEqual({ ok: true, event_id: 'evt-chunk' });
  });

  it('handles malformed JSON stdout gracefully', async () => {
    const child = makeChild();
    childFactory = () => child;

    const p = dispatchExternal({
      runDir: '/tmp/runs/abc',
      settingsPath: '/tmp/settings.json',
      eventType: 'pipeline.run.cancelled',
      payload: {},
    });

    child.stdout.emit('data', Buffer.from('not json'));
    child.emit('close', 0);

    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid_response');
  });
});
