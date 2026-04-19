/**
 * Pipeline process lifecycle management.
 * Handles starting, stopping, and restarting pipeline processes.
 */

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchExternal } from './dispatch-external.js';

/** Byte threshold — must match claude_cli.py _ARG_INLINE_LIMIT */
const ARG_INLINE_LIMIT = 128 * 1024;

const TERMINAL_EVENTS = [
  'pipeline.run.interrupted',
  'pipeline.run.failed',
  'pipeline.run.completed',
];

function elapsedMsSince(startedAtIso) {
  if (!startedAtIso) return 0;
  const started = Date.parse(startedAtIso);
  if (Number.isNaN(started)) return 0;
  return Math.max(0, Date.now() - started);
}

/**
 * Write content to a temp file with restricted permissions (0o600) and return its path.
 * Used to avoid E2BIG when passing large prompts as CLI arguments.
 * @param {string} content
 * @returns {string} path to the temp file
 */
function writePromptFile(content) {
  const name = `worca_prompt_${randomBytes(8).toString('hex')}.md`;
  const filePath = join(tmpdir(), name);
  const fd = openSync(filePath, 'w', 0o600);
  try {
    writeSync(fd, content, 0, 'utf8');
  } finally {
    closeSync(fd);
  }
  return filePath;
}

/**
 * Try to delete a temp prompt file. Silently ignores errors.
 * @param {string|null} filePath
 */
function cleanupPromptFile(filePath) {
  if (!filePath) return;
  try {
    unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

/**
 * Pipeline process lifecycle manager.
 * Encapsulates all process management for a single project's .worca directory.
 */
export class ProcessManager {
  /**
   * @param {{ worcaDir: string, projectRoot?: string, settingsPath?: string }} options
   */
  constructor({ worcaDir, projectRoot, settingsPath }) {
    this.worcaDir = worcaDir;
    this.projectRoot = projectRoot || process.cwd();
    this.settingsPath = settingsPath ?? null;
  }

  /**
   * Check if a pipeline is currently running.
   * @param {string} [runId] - If provided, check per-run PID first
   * @returns {{ pid: number } | null}
   */
  getRunningPid(runId) {
    // Build candidate PID paths: per-run first, then project-level fallback
    const candidates = [];
    if (runId) {
      candidates.push(join(this.worcaDir, 'runs', runId, 'pipeline.pid'));
    }
    candidates.push(join(this.worcaDir, 'pipeline.pid'));

    for (const pidPath of candidates) {
      if (!existsSync(pidPath)) continue;
      try {
        const pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
        if (Number.isNaN(pid) || pid <= 0) {
          try {
            unlinkSync(pidPath);
          } catch {
            /* ignore */
          }
          continue;
        }
        process.kill(pid, 0); // throws if dead
        return { pid };
      } catch {
        // Stale PID file — clean up
        try {
          unlinkSync(pidPath);
        } catch {
          /* ignore */
        }
      }
    }
    return null;
  }

  /**
   * Reconcile stale "running" status when the pipeline process is dead.
   * Scans all runs with per-run PID files + the active_run pointer.
   * If pipeline_status is "running" but no process is alive, transitions
   * to "failed" with stop_reason="stale".
   * Preserves any existing stop_reason (e.g. "signal" set by Layer 1).
   *
   * @returns {boolean} true if any status was fixed
   */
  async reconcileStatus() {
    let fixed = false;
    const dispatches = [];

    // Collect run IDs to check: scan runs/*/pipeline.pid + active_run fallback
    const runIds = new Set();
    const runsDir = join(this.worcaDir, 'runs');
    if (existsSync(runsDir)) {
      try {
        for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
          if (
            entry.isDirectory() &&
            existsSync(join(runsDir, entry.name, 'pipeline.pid'))
          ) {
            runIds.add(entry.name);
          }
        }
      } catch {
        /* ignore */
      }
    }

    // Backward compat: also check active_run pointer
    const activeRunPath = join(this.worcaDir, 'active_run');
    if (existsSync(activeRunPath)) {
      try {
        const activeId = readFileSync(activeRunPath, 'utf8').trim();
        if (activeId) runIds.add(activeId);
      } catch {
        /* ignore */
      }
    }

    for (const runId of runIds) {
      // Check if this run's process is alive
      const alive = this.getRunningPid(runId);
      if (alive) continue;

      const statusPath = join(this.worcaDir, 'runs', runId, 'status.json');
      if (!existsSync(statusPath)) continue;

      let status;
      try {
        status = JSON.parse(readFileSync(statusPath, 'utf8'));
      } catch {
        continue;
      }

      if (status.pipeline_status !== 'running') continue;

      if (!status.stop_reason) {
        status.stop_reason = 'stale';
      }
      status.pipeline_status = 'failed';
      try {
        writeFileSync(
          statusPath,
          `${JSON.stringify(status, null, 2)}\n`,
          'utf8',
        );
        fixed = true;
      } catch {
        /* ignore */
      }

      // Append synthetic interrupted event if no terminal event exists yet
      const eventsPath = join(this.worcaDir, 'runs', runId, 'events.jsonl');
      let hasTerminalEvent = false;
      if (existsSync(eventsPath)) {
        try {
          const lines = readFileSync(eventsPath, 'utf8')
            .split('\n')
            .filter(Boolean);
          hasTerminalEvent = lines.some((line) => {
            try {
              const evt = JSON.parse(line);
              return TERMINAL_EVENTS.includes(evt.event_type);
            } catch {
              return false;
            }
          });
        } catch {
          /* ignore */
        }
      }
      if (!hasTerminalEvent) {
        const payload = {
          interrupted_stage: status.current_stage ?? 'unknown',
          elapsed_ms: elapsedMsSince(status.started_at),
          source: 'stale',
        };

        if (this.settingsPath) {
          // dispatchExternal writes to events.jsonl via Python's emit_event
          dispatches.push(
            dispatchExternal({
              runDir: join(this.worcaDir, 'runs', runId),
              settingsPath: this.settingsPath,
              eventType: 'pipeline.run.interrupted',
              payload,
            }).catch(() => {}),
          );
        } else {
          // No settingsPath → can't dispatch; write a local synthetic event
          try {
            const evt = {
              schema_version: '1',
              event_id: randomUUID(),
              event_type: 'pipeline.run.interrupted',
              timestamp: new Date().toISOString(),
              run_id: status.run_id ?? runId,
              pipeline: {
                branch: status.branch ?? null,
                work_request: status.work_request ?? null,
              },
              payload: { ...payload, source: 'reconcile' },
            };
            appendFileSync(eventsPath, `${JSON.stringify(evt)}\n`, 'utf8');
          } catch {
            /* ignore */
          }
        }
      }
    }

    await Promise.all(dispatches);
    return fixed;
  }

  /**
   * Start a new pipeline run.
   * @param {{ inputType?: string, inputValue?: string, msize?: number, mloops?: number, planFile?: string, resume?: boolean, projectRoot?: string }} opts
   * @returns {Promise<{ pid: number }>}
   */
  async startPipeline(opts = {}) {
    const cwd = opts.projectRoot || this.projectRoot;
    const scriptPath = join(cwd, '.claude/worca/scripts/run_pipeline.py');
    if (!existsSync(scriptPath)) {
      const err = new Error(`Pipeline script not found at ${scriptPath}`);
      err.code = 'script_not_found';
      throw err;
    }

    const args = ['.claude/worca/scripts/run_pipeline.py'];
    let promptFilePath = null; // track for cleanup on spawn failure

    if (opts.resume) {
      args.push('--resume');
      if (opts.runId) {
        args.push('--status-dir', join(this.worcaDir, 'runs', opts.runId));
      }
    } else if (opts.sourceType !== undefined) {
      // New format: separate source and prompt args
      if (opts.sourceType === 'source') args.push('--source', opts.sourceValue);
      else if (opts.sourceType === 'spec')
        args.push('--spec', opts.sourceValue);
      if (opts.prompt) {
        if (Buffer.byteLength(opts.prompt, 'utf8') > ARG_INLINE_LIMIT) {
          promptFilePath = writePromptFile(opts.prompt);
          args.push('--prompt-file', promptFilePath);
        } else {
          args.push('--prompt', opts.prompt);
        }
      }
    } else {
      // Legacy format: inputType/inputValue
      const flag =
        opts.inputType === 'source'
          ? '--source'
          : opts.inputType === 'spec'
            ? '--spec'
            : '--prompt';
      if (
        flag === '--prompt' &&
        opts.inputValue &&
        Buffer.byteLength(opts.inputValue, 'utf8') > ARG_INLINE_LIMIT
      ) {
        promptFilePath = writePromptFile(opts.inputValue);
        args.push('--prompt-file', promptFilePath);
      } else {
        args.push(flag, opts.inputValue);
      }
    }

    if (opts.msize && opts.msize > 1) {
      args.push('--msize', String(opts.msize));
    }
    if (opts.mloops && opts.mloops > 1) {
      args.push('--mloops', String(opts.mloops));
    }
    if (opts.planFile) {
      args.push('--plan', opts.planFile);
    }
    if (opts.branch) {
      args.push('--branch', opts.branch);
    }
    if (opts.template) {
      args.push('--template', opts.template);
    }

    const env = { ...process.env };
    delete env.CLAUDECODE;

    return new Promise((resolve, reject) => {
      const child = spawn('python3', args, {
        detached: true,
        stdio: 'ignore',
        cwd,
        env,
      });

      const timeout = setTimeout(() => {
        cleanup();
        child.unref();
        resolve({ pid: child.pid });
      }, 2000);

      function cleanup() {
        clearTimeout(timeout);
        child.removeAllListeners('error');
        child.removeAllListeners('exit');
      }

      child.on('error', (spawnErr) => {
        cleanup();
        cleanupPromptFile(promptFilePath);
        const err = new Error(`Failed to start pipeline: ${spawnErr.message}`);
        err.code = 'spawn_error';
        reject(err);
      });

      child.on('exit', (code, signal) => {
        cleanup();
        if (code !== null && code !== 0) {
          cleanupPromptFile(promptFilePath);
          const err = new Error(
            `Pipeline exited immediately with code ${code}`,
          );
          err.code = 'spawn_error';
          reject(err);
        } else if (signal) {
          cleanupPromptFile(promptFilePath);
          const err = new Error(`Pipeline killed by signal ${signal}`);
          err.code = 'spawn_error';
          reject(err);
        }
        // code === 0 or code === null (still running) — resolve
        // run_pipeline.py handles prompt file cleanup after reading
        child.unref();
        resolve({ pid: child.pid });
      });
    });
  }

  /**
   * Stop a running pipeline.
   * PID file is the sole source of truth — no pgrep fallback.
   * @param {string} [runId] - If provided, look up PID from per-run directory first
   * @returns {{ pid: number, stopped: boolean }}
   */
  stopPipeline(runId) {
    let pid = null;
    let foundPidPath = null;

    // Check per-run PID file first, then project-level fallback
    const candidates = [];
    if (runId) {
      candidates.push(join(this.worcaDir, 'runs', runId, 'pipeline.pid'));
    }
    candidates.push(join(this.worcaDir, 'pipeline.pid'));

    for (const pidPath of candidates) {
      if (!existsSync(pidPath)) continue;
      try {
        pid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
        process.kill(pid, 0); // verify alive
        foundPidPath = pidPath;
        break;
      } catch {
        try {
          unlinkSync(pidPath);
        } catch {
          /* ignore */
        }
        pid = null;
      }
    }

    if (!pid) {
      const err = new Error('No running pipeline found');
      err.code = 'not_running';
      throw err;
    }

    // Belt-and-suspenders: write control.json so the orchestrator gets a clean signal
    const effectiveRunId = runId || this._readActiveRunId();
    if (effectiveRunId) {
      try {
        const controlDir = join(this.worcaDir, 'runs', effectiveRunId);
        mkdirSync(controlDir, { recursive: true });
        writeFileSync(
          join(controlDir, 'control.json'),
          `${JSON.stringify(
            {
              action: 'stop',
              requested_at: new Date().toISOString(),
              source: 'ui',
            },
            null,
            2,
          )}\n`,
          'utf8',
        );
      } catch {
        /* non-fatal */
      }
    }

    try {
      process.kill(pid, 'SIGTERM');
    } catch (e) {
      try {
        if (foundPidPath) unlinkSync(foundPidPath);
      } catch {
        /* ignore */
      }
      const err = new Error(`Failed to stop pipeline: ${e.message}`);
      err.code = 'not_running';
      throw err;
    }

    // Watchdog: SIGKILL after 10s if still alive, then reconcile status
    const worcaDir = this.worcaDir;
    const { settingsPath } = this;
    const watchdog = setTimeout(() => {
      try {
        process.kill(pid, 0); // check alive
        process.kill(pid, 'SIGKILL');
        setTimeout(() => reconcileStatus(worcaDir, settingsPath), 500);
      } catch {
        reconcileStatus(worcaDir, settingsPath);
      }
    }, 10000);
    watchdog.unref();

    // Clean up PID files (per-run + project-level)
    for (const pidPath of candidates) {
      try {
        unlinkSync(pidPath);
      } catch {
        /* ignore */
      }
    }

    return { pid, stopped: true };
  }

  /**
   * Synchronous-style stop: control.json + signal + poll for exit.
   * @param {string} runId
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ pid: number, exitCode: null, forced?: boolean }>}
   */
  async stopPipelineSync(runId, { timeoutMs } = {}) {
    if (timeoutMs === undefined) {
      timeoutMs = process.platform === 'win32' ? 30000 : 5000;
    }

    const running = this.getRunningPid(runId);
    if (!running) {
      const e = new Error('not running');
      e.code = 'not_running';
      throw e;
    }
    const { pid } = running;

    const controlDir = join(this.worcaDir, 'runs', runId);
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(
      join(controlDir, 'control.json'),
      `${JSON.stringify({ action: 'stop', requested_at: new Date().toISOString(), source: 'ui' }, null, 2)}\n`,
      'utf8',
    );

    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already dead */
      }
    } else {
      this._killAgentSubprocess(runId);
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return { pid, exitCode: null };
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already dead */
    }
    return { pid, exitCode: null, forced: true };
  }

  /**
   * Kill the agent subprocess (claude CLI) via agent.pid.
   * Used on Windows where SIGTERM doesn't propagate to child processes.
   * @param {string} runId
   */
  _killAgentSubprocess(runId) {
    const pidPath = join(this.worcaDir, 'runs', runId, 'agent.pid');
    if (!existsSync(pidPath)) return;
    try {
      const agentPid = parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
      if (!Number.isNaN(agentPid) && agentPid > 0) {
        process.kill(agentPid, 'SIGTERM');
      }
    } catch {
      /* agent already dead or pid file invalid */
    }
  }

  /**
   * Read the active_run file to get the current run ID.
   * @returns {string|null}
   */
  _readActiveRunId() {
    const activeRunPath = join(this.worcaDir, 'active_run');
    if (!existsSync(activeRunPath)) return null;
    try {
      const id = readFileSync(activeRunPath, 'utf8').trim();
      return id || null;
    } catch {
      return null;
    }
  }

  /**
   * Delete a run directory and clean up references.
   * Refuses if the pipeline is currently running.
   * @param {string} runId
   * @returns {{ deleted: boolean }}
   */
  deleteRun(runId) {
    const running = this.getRunningPid(runId);
    if (running) {
      const err = new Error(
        'Cannot delete a running pipeline — stop or cancel it first',
      );
      err.code = 'still_running';
      throw err;
    }

    const runDir = join(this.worcaDir, 'runs', runId);
    if (!existsSync(runDir)) {
      const err = new Error(`Run "${runId}" not found`);
      err.code = 'not_found';
      throw err;
    }

    rmSync(runDir, { recursive: true, force: true });

    // Clear active_run pointer if it references this run
    const activeRunPath = join(this.worcaDir, 'active_run');
    if (existsSync(activeRunPath)) {
      try {
        const activeId = readFileSync(activeRunPath, 'utf8').trim();
        if (activeId === runId) unlinkSync(activeRunPath);
      } catch {
        /* ignore */
      }
    }

    return { deleted: true };
  }

  /**
   * Pause a running pipeline by writing a control file.
   * @param {string} runId - Pipeline run identifier
   * @returns {{ runId: string, paused: boolean }}
   */
  pausePipeline(runId) {
    const controlDir = join(this.worcaDir, 'runs', runId);
    mkdirSync(controlDir, { recursive: true });
    writeFileSync(
      join(controlDir, 'control.json'),
      `${JSON.stringify(
        {
          action: 'pause',
          requested_at: new Date().toISOString(),
          source: 'ui',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    return { runId, paused: true };
  }

  /**
   * Restart a failed stage by resetting it and spawning with --resume.
   * @param {string} stageKey - The stage key to restart
   * @param {{ projectRoot?: string }} opts
   * @returns {Promise<{ pid: number, stage: string }>}
   */
  async restartStage(stageKey, opts = {}) {
    const running = this.getRunningPid();
    if (running) {
      const err = new Error(`Pipeline already running (PID ${running.pid})`);
      err.code = 'already_running';
      throw err;
    }

    const cwd = opts.projectRoot || this.projectRoot;
    const scriptPath = join(cwd, '.claude/worca/scripts/run_pipeline.py');
    if (!existsSync(scriptPath)) {
      const err = new Error(`Pipeline script not found at ${scriptPath}`);
      err.code = 'script_not_found';
      throw err;
    }

    // Find status.json — check active_run first, then legacy
    let statusPath = null;
    const activeRunPath = join(this.worcaDir, 'active_run');
    if (existsSync(activeRunPath)) {
      try {
        const runId = readFileSync(activeRunPath, 'utf8').trim();
        const candidate = join(this.worcaDir, 'runs', runId, 'status.json');
        if (existsSync(candidate)) statusPath = candidate;
      } catch {
        /* ignore */
      }
    }
    if (!statusPath) {
      const legacy = join(this.worcaDir, 'status.json');
      if (existsSync(legacy)) statusPath = legacy;
    }

    if (!statusPath) {
      const err = new Error('No status.json found');
      err.code = 'no_status';
      throw err;
    }

    const status = JSON.parse(readFileSync(statusPath, 'utf8'));

    if (!status.stages || !status.stages[stageKey]) {
      const err = new Error(`Stage "${stageKey}" not found`);
      err.code = 'stage_not_found';
      throw err;
    }

    if (status.stages[stageKey].status !== 'error') {
      const err = new Error(
        `Stage "${stageKey}" is not in error state (current: ${status.stages[stageKey].status})`,
      );
      err.code = 'stage_not_error';
      throw err;
    }

    // Reset the stage
    status.stages[stageKey].status = 'pending';
    delete status.stages[stageKey].error;
    delete status.stages[stageKey].completed_at;
    writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');

    // Spawn with --resume
    const env = { ...process.env };
    delete env.CLAUDECODE;

    return new Promise((resolve, reject) => {
      const child = spawn(
        'python3',
        ['.claude/worca/scripts/run_pipeline.py', '--resume'],
        {
          detached: true,
          stdio: 'ignore',
          cwd,
          env,
        },
      );

      const timeout = setTimeout(() => {
        cleanup();
        child.unref();
        resolve({ pid: child.pid, stage: stageKey });
      }, 2000);

      function cleanup() {
        clearTimeout(timeout);
        child.removeAllListeners('error');
        child.removeAllListeners('exit');
      }

      child.on('error', (spawnErr) => {
        cleanup();
        const err = new Error(`Failed to restart stage: ${spawnErr.message}`);
        err.code = 'spawn_error';
        reject(err);
      });

      child.on('exit', (code, signal) => {
        cleanup();
        if (code !== null && code !== 0) {
          const err = new Error(
            `Pipeline exited immediately with code ${code}`,
          );
          err.code = 'spawn_error';
          reject(err);
        } else if (signal) {
          const err = new Error(`Pipeline killed by signal ${signal}`);
          err.code = 'spawn_error';
          reject(err);
        }
        child.unref();
        resolve({ pid: child.pid, stage: stageKey });
      });
    });
  }
}

// ─── Backward-compatible free-function exports ──────────────────────────────
// These delegate to a one-off ProcessManager instance so existing callers
// (app.js, ws.js, tests) continue to work without changes during Phase 0.

/** @param {string} worcaDir @param {string} [runId] */
export function getRunningPid(worcaDir, runId) {
  return new ProcessManager({ worcaDir }).getRunningPid(runId);
}

/** @param {string} worcaDir @param {string} [settingsPath] */
export function reconcileStatus(worcaDir, settingsPath) {
  return new ProcessManager({ worcaDir, settingsPath }).reconcileStatus();
}

/** @param {string} worcaDir @param {object} opts */
export async function startPipeline(worcaDir, opts = {}) {
  return new ProcessManager({
    worcaDir,
    projectRoot: opts.projectRoot,
  }).startPipeline(opts);
}

/** @param {string} worcaDir @param {string} [runId] */
export function stopPipeline(worcaDir, runId) {
  return new ProcessManager({ worcaDir }).stopPipeline(runId);
}

/** @param {string} worcaDir @param {string} runId */
export function pausePipeline(worcaDir, runId) {
  return new ProcessManager({ worcaDir }).pausePipeline(runId);
}

/** @param {string} worcaDir @param {string} stageKey @param {object} opts */
export async function restartStage(worcaDir, stageKey, opts = {}) {
  return new ProcessManager({
    worcaDir,
    projectRoot: opts.projectRoot,
  }).restartStage(stageKey, opts);
}
