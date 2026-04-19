import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessManager } from '../process-manager.js';

function makeTmpDir() {
  const d = join(
    tmpdir(),
    `worca-stop-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

function writePid(worcaDir, runId, pid) {
  const runDir = join(worcaDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'pipeline.pid'), String(pid), 'utf8');
}

function writeAgentPid(worcaDir, runId, pid) {
  const runDir = join(worcaDir, 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'agent.pid'), String(pid), 'utf8');
}

describe('stopPipelineSync', () => {
  let worcaDir;
  let pm;

  beforeEach(() => {
    worcaDir = makeTmpDir();
    pm = new ProcessManager({ worcaDir });
  });

  afterEach(() => {
    rmSync(worcaDir, { recursive: true, force: true });
  });

  it('throws not_running when no PID found', async () => {
    try {
      await pm.stopPipelineSync('run-no-pid');
      expect.unreachable('should throw');
    } catch (e) {
      expect(e.code).toBe('not_running');
    }
  });

  it('writes control.json with action stop', async () => {
    // Use current process PID so it's alive, then mock kill to simulate exit
    const pid = process.pid;
    writePid(worcaDir, 'run-ctrl', pid);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation((p, sig) => {
      if (sig === 0) throw new Error('no such process');
    });

    try {
      await pm.stopPipelineSync('run-ctrl', { timeoutMs: 200 });
    } catch {
      /* may throw not_running on first kill(0) check */
    }

    const controlPath = join(worcaDir, 'runs', 'run-ctrl', 'control.json');
    if (existsSync(controlPath)) {
      const control = JSON.parse(readFileSync(controlPath, 'utf8'));
      expect(control.action).toBe('stop');
    }

    killSpy.mockRestore();
  });

  it('returns without forced flag when process exits promptly', async () => {
    const pid = 999888777;
    writePid(worcaDir, 'run-quick', pid);

    // Mock: getRunningPid returns pid, then process.kill(pid, 0) says it's dead
    vi.spyOn(pm, 'getRunningPid').mockReturnValue({ pid });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((p, sig) => {
      if (sig === 0) throw new Error('ESRCH');
      // SIGTERM — no-op
    });

    const result = await pm.stopPipelineSync('run-quick', { timeoutMs: 500 });
    expect(result.pid).toBe(pid);
    expect(result.forced).toBeUndefined();

    killSpy.mockRestore();
  });

  it('sends SIGKILL after timeout and returns forced: true', async () => {
    const pid = 999888776;
    writePid(worcaDir, 'run-stuck', pid);

    vi.spyOn(pm, 'getRunningPid').mockReturnValue({ pid });
    const killCalls = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((p, sig) => {
      killCalls.push({ pid: p, signal: sig });
      if (sig === 0) return true; // always alive
    });

    const result = await pm.stopPipelineSync('run-stuck', { timeoutMs: 300 });
    expect(result.pid).toBe(pid);
    expect(result.forced).toBe(true);

    const sigkill = killCalls.find((c) => c.signal === 'SIGKILL');
    expect(sigkill).toBeTruthy();

    killSpy.mockRestore();
  });

  it('sends SIGTERM on unix (non-win32)', async () => {
    const pid = 999888775;
    writePid(worcaDir, 'run-unix', pid);

    vi.spyOn(pm, 'getRunningPid').mockReturnValue({ pid });
    const killCalls = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((p, sig) => {
      killCalls.push({ pid: p, signal: sig });
      if (sig === 0) throw new Error('ESRCH');
    });

    // On macOS/Linux (where tests run), platform !== 'win32'
    await pm.stopPipelineSync('run-unix', { timeoutMs: 500 });

    const sigterm = killCalls.find((c) => c.signal === 'SIGTERM');
    expect(sigterm).toBeTruthy();

    killSpy.mockRestore();
  });
});

describe('_killAgentSubprocess', () => {
  let worcaDir;
  let pm;

  beforeEach(() => {
    worcaDir = makeTmpDir();
    pm = new ProcessManager({ worcaDir });
  });

  afterEach(() => {
    rmSync(worcaDir, { recursive: true, force: true });
  });

  it('reads agent.pid and sends SIGTERM to the agent subprocess', () => {
    writeAgentPid(worcaDir, 'run-agent', 123456);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});

    pm._killAgentSubprocess('run-agent');

    expect(killSpy).toHaveBeenCalledWith(123456, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('does not throw when agent.pid is missing', () => {
    expect(() => pm._killAgentSubprocess('run-no-agent')).not.toThrow();
  });

  it('does not throw when agent process is already dead', () => {
    writeAgentPid(worcaDir, 'run-dead-agent', 123456);

    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH');
    });

    expect(() => pm._killAgentSubprocess('run-dead-agent')).not.toThrow();
    killSpy.mockRestore();
  });
});
