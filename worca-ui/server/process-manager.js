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
import { join, resolve } from 'node:path';

import { dispatchExternal } from './dispatch-external.js';
import { readGlobalSettings } from './settings-reader.js';
import { removeWorktree } from './worktree-ops.js';

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
  constructor({ worcaDir, projectRoot, settingsPath, prefsDir }) {
    this.worcaDir = worcaDir;
    this.projectRoot = projectRoot || process.cwd();
    this.settingsPath = settingsPath ?? null;
    this.prefsDir = prefsDir ?? null;
  }

  /**
   * Resolve the worcaDir and runDir for a given run ID.
   * Checks root runs/ first, then pipelines.d/ registry for worktree_path.
   * @param {string} runId
   * @returns {{ worcaDir: string, runDir: string } | null}
   */
  resolveRunContext(runId) {
    const rootPath = join(this.worcaDir, 'runs', runId, 'status.json');
    if (existsSync(rootPath)) {
      return {
        worcaDir: this.worcaDir,
        runDir: join(this.worcaDir, 'runs', runId),
      };
    }
    const regPath = join(
      this.worcaDir,
      'multi',
      'pipelines.d',
      `${runId}.json`,
    );
    if (existsSync(regPath)) {
      try {
        const reg = JSON.parse(readFileSync(regPath, 'utf8'));
        if (reg.worktree_path) {
          const wtWorcaDir = join(reg.worktree_path, '.worca');
          return {
            worcaDir: wtWorcaDir,
            runDir: join(wtWorcaDir, 'runs', runId),
          };
        }
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  /**
   * Check if a pipeline is currently running.
   * @param {string} [runId] - If provided, check per-run PID first
   * @returns {{ pid: number } | null}
   */
  getRunningPid(runId) {
    // Build candidate PID paths: per-run first (with worktree overlay),
    // then project-level fallback. Worktree runs live under
    // <worktree_path>/.worca/runs/<id>/ and are routed via pipelines.d/.
    const candidates = [];
    if (runId) {
      const ctx = this.resolveRunContext(runId);
      if (ctx) {
        candidates.push(join(ctx.runDir, 'pipeline.pid'));
      } else {
        candidates.push(join(this.worcaDir, 'runs', runId, 'pipeline.pid'));
      }
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
   * Scans all runs with per-run PID files.
   * If pipeline_status is "running" but no process is alive, transitions
   * to "failed" with stop_reason="stale".
   * Preserves any existing stop_reason (e.g. "signal" set by Layer 1).
   *
   * @returns {boolean} true if any status was fixed
   */
  async reconcileStatus() {
    let fixed = false;
    const dispatches = [];

    // Collect run IDs to check: scan runs/*/pipeline.pid
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

    // Also scan pipelines.d/ for worktree PIDs (worktree runs never appear in runs/)
    const pipelinesDir = join(this.worcaDir, 'multi', 'pipelines.d');
    if (existsSync(pipelinesDir)) {
      try {
        for (const entry of readdirSync(pipelinesDir)) {
          if (!entry.endsWith('.json')) continue;
          const runId = entry.slice(0, -5);
          try {
            const reg = JSON.parse(
              readFileSync(join(pipelinesDir, entry), 'utf8'),
            );
            if (reg.worktree_path) {
              const wtPidPath = join(
                reg.worktree_path,
                '.worca',
                'runs',
                runId,
                'pipeline.pid',
              );
              if (existsSync(wtPidPath)) runIds.add(runId);
            }
          } catch {
            /* ignore malformed registry entry */
          }
        }
      } catch {
        /* ignore */
      }
    }

    for (const runId of runIds) {
      // Check if this run's process is alive
      const alive = this.getRunningPid(runId);
      if (alive) continue;

      // Route all paths through resolveRunContext so worktree runs use
      // their worktree dir rather than the project-root runs/ dir.
      const ctx = this.resolveRunContext(runId);
      if (!ctx) continue;
      const { runDir } = ctx;

      const statusPath = join(runDir, 'status.json');
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
      status.pipeline_status =
        status.stop_reason === 'signal' ? 'interrupted' : 'failed';
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

      // Append synthetic terminal event if none exists yet.
      // Use pipeline.run.interrupted for signal-killed runs, pipeline.run.failed otherwise.
      const eventsPath = join(runDir, 'events.jsonl');
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
        const eventType =
          status.stop_reason === 'signal'
            ? 'pipeline.run.interrupted'
            : 'pipeline.run.failed';
        const payload = {
          failed_stage: status.current_stage ?? 'unknown',
          elapsed_ms: elapsedMsSince(status.started_at),
          source: 'stale',
        };

        if (this.settingsPath) {
          dispatches.push(
            dispatchExternal({
              runDir,
              settingsPath: this.settingsPath,
              eventType,
              payload,
            }).catch(() => {}),
          );
        } else {
          try {
            const evt = {
              schema_version: '1',
              event_id: randomUUID(),
              event_type: eventType,
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

      this.maybeAutoCleanup(runId);
    }

    await Promise.all(dispatches);
    return fixed;
  }

  /**
   * Post-completion cleanup hook (§5b).
   * When cleanup_policy is 'on-success' and the run completed cleanly,
   * removes the worktree via worktree-ops and emits a worktree.auto_cleanup
   * event. 'never' (default) and 'manual-only' are both no-ops.
   * @param {string} runId
   * @returns {{ cleaned: boolean, runId?: string, path?: string, reason?: string }}
   */
  maybeAutoCleanup(runId) {
    const ctx = this.resolveRunContext(runId);
    const runDir = ctx ? ctx.runDir : join(this.worcaDir, 'runs', runId);
    const statusPath = join(runDir, 'status.json');

    if (!existsSync(statusPath)) return { cleaned: false };

    let status;
    try {
      status = JSON.parse(readFileSync(statusPath, 'utf8'));
    } catch {
      return { cleaned: false };
    }

    const worktreePath = status.worktree_path;
    if (!worktreePath) return { cleaned: false };

    const exitOk = status.pipeline_status === 'completed';
    if (!exitOk) return { cleaned: false };

    let policy = 'never';
    if (this.prefsDir) {
      try {
        const globalPrefs = readGlobalSettings(
          join(this.prefsDir, 'settings.json'),
        );
        policy = globalPrefs?.worca?.parallel?.cleanup_policy ?? 'never';
      } catch {
        // Fall back to default 'never'
      }
    }

    if (policy !== 'on-success') return { cleaned: false };

    removeWorktree(this.worcaDir, runId);

    try {
      const eventsPath = join(runDir, 'events.jsonl');
      const evt = {
        schema_version: '1',
        event_id: randomUUID(),
        event_type: 'worktree.auto_cleanup',
        timestamp: new Date().toISOString(),
        run_id: status.run_id ?? runId,
        payload: { runId, path: worktreePath, reason: 'on-success' },
      };
      appendFileSync(eventsPath, `${JSON.stringify(evt)}\n`, 'utf8');
    } catch {
      /* non-fatal */
    }

    return { cleaned: true, runId, path: worktreePath, reason: 'on-success' };
  }

  /**
   * Start a new pipeline run.
   * @param {{ inputType?: string, inputValue?: string, msize?: number, mloops?: number, planFile?: string, resume?: boolean, projectRoot?: string }} opts
   * @returns {Promise<{ pid: number }>}
   */
  async startPipeline(opts = {}) {
    // Resume must spawn inside the run's own working tree. Worktree-hosted
    // runs live under <worktree>/.worca/runs/<id>; if we spawn from the parent
    // project root, git operations and relative settings paths target the
    // wrong tree and the resumed pipeline corrupts state on the parent
    // branch. Worktree wins over opts.projectRoot for resume — callers
    // routinely pass proj.projectRoot without knowing whether the run is
    // worktree-hosted. Mirrors the cwd derivation in restartStage.
    let resumeCtx = null;
    if (opts.resume && opts.runId) {
      resumeCtx = this.resolveRunContext(opts.runId);
    }
    const cwd =
      resumeCtx && resumeCtx.worcaDir !== this.worcaDir
        ? join(resumeCtx.worcaDir, '..')
        : opts.projectRoot || this.projectRoot;
    const pipelineScriptRel = '.claude/worca/scripts/run_pipeline.py';
    const worktreeScriptRel = '.claude/worca/scripts/run_worktree.py';

    let scriptRel;
    if (opts.resume) {
      const pipelinePath = join(cwd, pipelineScriptRel);
      if (!existsSync(pipelinePath)) {
        const err = new Error(`Pipeline script not found at ${pipelinePath}`);
        err.code = 'script_not_found';
        throw err;
      }
      scriptRel = pipelineScriptRel;
    } else {
      const worktreePath = join(cwd, worktreeScriptRel);
      if (existsSync(worktreePath)) {
        scriptRel = worktreeScriptRel;
      } else {
        const pipelinePath = join(cwd, pipelineScriptRel);
        if (!existsSync(pipelinePath)) {
          const err = new Error(`Pipeline script not found at ${pipelinePath}`);
          err.code = 'script_not_found';
          throw err;
        }
        console.warn(
          '[worca] run_worktree.py not found, falling back to run_pipeline.py',
        );
        scriptRel = pipelineScriptRel;
      }
    }

    const args = [scriptRel];
    let promptFilePath = null; // track for cleanup on spawn failure

    if (opts.resume) {
      args.push('--resume');
      if (opts.runId) {
        // The runner derives worca_dir from os.path.dirname(status_path) and
        // builds the per-run dir as <worca_dir>/runs/<run_id>/. We must pass
        // the worca root, not the per-run dir — passing <worca>/runs/<id>
        // would make the runner compute a nested <worca>/runs/<id>/runs/<id>/
        // and write status updates there while the UI keeps reading the
        // original. _find_active_runs(worca_root) then locates the run.
        const statusDir = resumeCtx ? resumeCtx.worcaDir : this.worcaDir;
        args.push('--status-dir', statusDir);

        // Worktree runs: registry lives in the parent project's .worca, not
        // the worktree's. run_worktree.py passes --registry-base on initial
        // launch; resume must do the same so update_pipeline() lands on the
        // right registry entry. Without this, the runner's terminal /
        // resume-flip-to-running registry updates silently no-op against a
        // non-existent <worktree>/.worca/multi/pipelines.d/<id>.json.
        if (resumeCtx && resumeCtx.worcaDir !== this.worcaDir) {
          args.push('--registry-base', this.worcaDir);
        }

        // _find_active_runs filters out runs whose pipeline_status is in
        // {completed, interrupted}. To resume an interrupted/failed run, flip
        // the top-level status to "resuming" so the runner can pick it up;
        // it'll transition to "running" once it's processing.
        const statusPath = resumeCtx
          ? join(resumeCtx.runDir, 'status.json')
          : join(this.worcaDir, 'runs', opts.runId, 'status.json');
        try {
          const s = JSON.parse(readFileSync(statusPath, 'utf8'));
          if (
            s.pipeline_status === 'interrupted' ||
            s.pipeline_status === 'failed'
          ) {
            s.pipeline_status = 'resuming';
            delete s.stop_reason;
            writeFileSync(
              statusPath,
              `${JSON.stringify(s, null, 2)}\n`,
              'utf8',
            );
          }
        } catch {
          /* non-fatal — runner will surface a clearer error if the file is missing */
        }
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
    if (opts.maxBeads != null) {
      args.push('--max-beads', String(opts.maxBeads));
    }
    if (opts.claudeMdMode != null) {
      args.push('--claude-md-mode', String(opts.claudeMdMode));
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

    // run_worktree.py is a *launcher*: it performs all setup (PR-metadata
    // fetch, worktree checkout, registry write) and only exits 0 after the
    // real pipeline wrote its status.json (_await_pipeline_startup), printing
    // diagnostics to stderr and exiting non-zero on any failure. Its detached
    // grandchild redirects its own stdio to a log file, so it never holds our
    // pipes open. That makes the launcher's exit code an authoritative
    // success/failure signal — wait for it instead of guessing with a fixed
    // timer. The old 2s timer resolved "started" before slow failures (e.g. a
    // PR fetch followed by a worktree collision) surfaced, so the UI reported
    // success while nothing ran. run_pipeline.py (in-place / resume) is NOT a
    // launcher — it *is* the long-lived pipeline — so it keeps the timer path.
    const isFireAndForget = scriptRel === worktreeScriptRel;

    if (isFireAndForget) {
      return new Promise((resolve, reject) => {
        const child = spawn('python3', args, {
          detached: true,
          // Capture stderr to surface the launcher's error; ignore stdin/stdout
          // (stdout carries only run_id+path and is not needed).
          stdio: ['ignore', 'ignore', 'pipe'],
          cwd,
          env,
        });

        let settled = false;
        let stderr = '';
        const STDERR_CAP = 8192;
        // Generous safety net: the launcher normally exits within seconds, but
        // a hung gh/network call shouldn't block the launch request forever.
        const hardCap = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.removeAllListeners('error');
          child.removeAllListeners('exit');
          cleanupPromptFile(promptFilePath);
          const err = new Error(
            'Pipeline launcher did not finish within 180s — aborting launch',
          );
          err.code = 'spawn_timeout';
          reject(err);
        }, 180000);
        hardCap.unref?.();

        if (child.stderr) {
          child.stderr.on('data', (d) => {
            if (stderr.length < STDERR_CAP) stderr += d.toString();
          });
        }

        child.on('error', (spawnErr) => {
          if (settled) return;
          settled = true;
          clearTimeout(hardCap);
          cleanupPromptFile(promptFilePath);
          const err = new Error(
            `Failed to start pipeline: ${spawnErr.message}`,
          );
          err.code = 'spawn_error';
          reject(err);
        });

        child.on('exit', (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(hardCap);
          cleanupPromptFile(promptFilePath);
          if (code === 0) {
            child.unref();
            resolve({ pid: child.pid });
            return;
          }
          const detail = stderr.trim().split('\n').slice(-6).join('\n').trim();
          const reason =
            code !== null ? `exit code ${code}` : `signal ${signal}`;
          const err = new Error(
            `Pipeline failed to start (${reason})${detail ? `:\n${detail}` : ''}`,
          );
          err.code = 'spawn_error';
          reject(err);
        });
      });
    }

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

    const ctx = runId ? this.resolveRunContext(runId) : null;
    const effectiveWorcaDir = ctx ? ctx.worcaDir : this.worcaDir;

    // Check per-run PID file first, then project-level fallback
    const candidates = [];
    if (runId) {
      candidates.push(join(effectiveWorcaDir, 'runs', runId, 'pipeline.pid'));
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
    const effectiveRunId = runId;
    if (effectiveRunId) {
      try {
        const controlDir = join(effectiveWorcaDir, 'runs', effectiveRunId);
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

    // Watchdog: SIGKILL after 10s if still alive, then reconcile status.
    // Fire-and-forget: reconcileStatus is async but we intentionally don't
    // await it — this is a background cleanup path after the response is sent.
    const worcaDir = this.worcaDir;
    const { settingsPath, prefsDir } = this;
    const watchdog = setTimeout(() => {
      try {
        process.kill(pid, 0); // check alive
        process.kill(pid, 'SIGKILL');
        setTimeout(
          () => reconcileStatus(worcaDir, settingsPath, prefsDir),
          500,
        );
      } catch {
        reconcileStatus(worcaDir, settingsPath, prefsDir);
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

    const ctx = this.resolveRunContext(runId);
    const effectiveWorcaDir = ctx ? ctx.worcaDir : this.worcaDir;
    const controlDir = join(effectiveWorcaDir, 'runs', runId);
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

    const pollMs = timeoutMs > 10000 ? 500 : 100;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
      } catch {
        return { pid, exitCode: null };
      }
      await new Promise((r) => setTimeout(r, pollMs));
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
    const ctx = this.resolveRunContext(runId);
    const runDir = ctx ? ctx.runDir : join(this.worcaDir, 'runs', runId);
    const pidPath = join(runDir, 'agent.pid');
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

    const ctx = this.resolveRunContext(runId);
    const effectiveWorcaDir = ctx ? ctx.worcaDir : this.worcaDir;
    const runsParent = resolve(effectiveWorcaDir, 'runs');
    const runDir = ctx ? resolve(ctx.runDir) : resolve(runsParent, runId);
    if (!runDir.startsWith(runsParent)) {
      const err = new Error('Invalid runId');
      err.code = 'invalid_id';
      throw err;
    }
    if (!existsSync(runDir)) {
      const err = new Error(`Run "${runId}" not found`);
      err.code = 'not_found';
      throw err;
    }

    rmSync(runDir, { recursive: true, force: true });

    return { deleted: true };
  }

  /**
   * Pause a running pipeline by writing a control file.
   * @param {string} runId - Pipeline run identifier
   * @returns {{ runId: string, paused: boolean }}
   */
  pausePipeline(runId) {
    const ctx = this.resolveRunContext(runId);
    const controlDir = ctx ? ctx.runDir : join(this.worcaDir, 'runs', runId);
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
   *
   * Internal API — only called from worca-ui (project-routes.js). The signature
   * changed in W-048 from (stageKey, opts) to (runId, stageKey, opts) because
   * runs are now per-worktree and the manager can no longer infer "the active
   * run". Callers must pass an explicit runId.
   *
   * @param {string} runId - Run identifier to restart
   * @param {string} stageKey - The stage key to restart
   * @param {{ projectRoot?: string }} opts
   * @returns {Promise<{ pid: number, stage: string }>}
   */
  async restartStage(runId, stageKey, opts = {}) {
    const running = this.getRunningPid(runId);
    if (running) {
      const err = new Error(`Pipeline already running (PID ${running.pid})`);
      err.code = 'already_running';
      throw err;
    }

    const ctx = this.resolveRunContext(runId);
    const runDir = ctx ? ctx.runDir : join(this.worcaDir, 'runs', runId);
    // For worktree runs derive projectRoot from worcaDir parent (.worca/..)
    const cwd =
      opts.projectRoot ||
      (ctx && ctx.worcaDir !== this.worcaDir
        ? join(ctx.worcaDir, '..')
        : this.projectRoot);

    const scriptPath = join(cwd, '.claude/worca/scripts/run_pipeline.py');
    if (!existsSync(scriptPath)) {
      const err = new Error(`Pipeline script not found at ${scriptPath}`);
      err.code = 'script_not_found';
      throw err;
    }

    const statusPath = join(runDir, 'status.json');
    if (!existsSync(statusPath)) {
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

    // Spawn with --resume --status-dir so the pipeline finds the right run
    const env = { ...process.env };
    delete env.CLAUDECODE;

    return new Promise((resolve, reject) => {
      const child = spawn(
        'python3',
        [
          '.claude/worca/scripts/run_pipeline.py',
          '--resume',
          '--status-dir',
          runDir,
        ],
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

/** @param {string} worcaDir @param {string} [settingsPath] @param {string} [prefsDir] */
export function reconcileStatus(worcaDir, settingsPath, prefsDir) {
  return new ProcessManager({
    worcaDir,
    settingsPath,
    prefsDir,
  }).reconcileStatus();
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

/** @param {string} worcaDir @param {string} runId @param {string} stageKey @param {object} opts */
export async function restartStage(worcaDir, runId, stageKey, opts = {}) {
  return new ProcessManager({
    worcaDir,
    projectRoot: opts.projectRoot,
  }).restartStage(runId, stageKey, opts);
}
