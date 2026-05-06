/**
 * Worktree-blind callsite test for _killAgentSubprocess.
 *
 * Must FAIL before Phase 2 fix: the method reads agent.pid from
 * `this.worcaDir/runs/<runId>/agent.pid` (project-root path), not from
 * the worktree run dir. For worktree runs the file is absent at that path,
 * so the SIGTERM is never sent.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProcessManager } from '../process-manager.js';

function makeTmpDir() {
  const d = join(
    tmpdir(),
    `worca-killagent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(d, { recursive: true });
  return d;
}

describe('_killAgentSubprocess worktree-blind callsite', () => {
  let worcaDir;

  beforeEach(() => {
    worcaDir = makeTmpDir();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(worcaDir, { recursive: true, force: true });
  });

  it('reads agent.pid from worktree runDir when run is a worktree run', () => {
    const runId = 'run-wt-kill-001';
    const wtDir = makeTmpDir();
    try {
      const wtRunDir = join(wtDir, '.worca', 'runs', runId);
      mkdirSync(wtRunDir, { recursive: true });

      // Place agent.pid ONLY in the worktree run dir — not in worcaDir/runs/
      const agentPid = process.pid;
      writeFileSync(join(wtRunDir, 'agent.pid'), String(agentPid), 'utf8');

      // Register run in pipelines.d/
      const pipelinesDir = join(worcaDir, 'multi', 'pipelines.d');
      mkdirSync(pipelinesDir, { recursive: true });
      writeFileSync(
        join(pipelinesDir, `${runId}.json`),
        JSON.stringify({ run_id: runId, worktree_path: wtDir }),
        'utf8',
      );

      // Intercept process.kill so the test doesn't actually signal itself
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {});

      const pm = new ProcessManager({ worcaDir });
      pm._killAgentSubprocess(runId);

      // FAILS with current code: reads worcaDir/runs/<runId>/agent.pid which
      // doesn't exist → returns early → process.kill is never called.
      expect(killSpy).toHaveBeenCalledWith(agentPid, 'SIGTERM');
    } finally {
      rmSync(wtDir, { recursive: true, force: true });
    }
  });
});
