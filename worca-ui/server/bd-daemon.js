import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Ensure the bd daemon is running for the project at worcaDir.
 * Best-effort — all errors swallowed.
 *
 * Probes `bd daemon status` first. The `daemon.stopped` sentinel only blocks
 * auto-start; if the daemon is already running (e.g. started manually outside
 * worca), we report it as up regardless of the sentinel.
 */
export async function ensureBdDaemon(worcaDir) {
  const beadsDir = resolve(join(worcaDir, '..', '.beads'));
  if (!existsSync(beadsDir)) return false;

  const workspaceDir = dirname(beadsDir);
  const opts = {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, BEADS_DIR: beadsDir },
    cwd: workspaceDir,
  };

  try {
    await execFileAsync('bd', ['daemon', 'status'], opts);
    return true;
  } catch {
    // not running — sentinel may block auto-start below
  }

  if (existsSync(join(beadsDir, 'daemon.stopped'))) return false;

  try {
    await execFileAsync('bd', ['daemon', 'start'], opts);
    return true;
  } catch {
    return false;
  }
}
