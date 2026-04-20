import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 30_000;

export function resolvePythonCmd() {
  if (process.env.WORCA_PYTHON) {
    return [process.env.WORCA_PYTHON];
  }
  if (process.platform === 'win32') {
    return ['py', 'python3', 'python'];
  }
  return ['python3', 'python'];
}

export function dispatchExternal({
  runDir,
  settingsPath,
  eventType,
  payload,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const candidates = resolvePythonCmd();
  const args = [
    '-m',
    'worca.events.dispatch_external',
    '--run-dir',
    runDir,
    '--settings',
    settingsPath,
    '--event-type',
    eventType,
    '--payload-json',
    JSON.stringify(payload),
  ];

  let candidateIdx = 0;

  function trySpawn(resolve) {
    if (candidateIdx >= candidates.length) {
      resolve({ ok: false, reason: 'python_not_found' });
      return;
    }

    const cmd = candidates[candidateIdx];
    const spawnArgs = cmd === 'py' ? ['-3', ...args] : args;

    const child = spawn(cmd, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ ok: false, reason: 'timeout' });
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBuf += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk;
    });

    child.on('error', (err) => {
      if (!settled && err.code === 'ENOENT') {
        clearTimeout(timer);
        candidateIdx++;
        trySpawn(resolve);
        return;
      }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: 'spawn_error', stderr: err.message });
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (code !== 0) {
        resolve({
          ok: false,
          reason: `exit_code_${code}`,
          stderr: stderrBuf,
        });
        return;
      }

      try {
        const parsed = JSON.parse(stdoutBuf);
        resolve(parsed);
      } catch {
        resolve({ ok: false, reason: 'invalid_response', stdout: stdoutBuf });
      }
    });
  }

  return new Promise((resolve) => trySpawn(resolve));
}
