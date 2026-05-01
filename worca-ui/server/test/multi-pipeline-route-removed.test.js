/**
 * TDD: verify /multi-pipeline route is removed.
 * This test is written first and must initially fail.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../process-manager.js', () => {
  class ProcessManager {
    constructor(opts = {}) {
      this.worcaDir = opts.worcaDir;
      this.projectRoot = opts.projectRoot;
    }
    pausePipeline() {
      return { paused: true };
    }
    startPipeline() {
      return Promise.resolve({ pid: 1 });
    }
    stopPipeline() {
      return { pid: 1 };
    }
    getRunningPid() {
      return null;
    }
    reconcileStatus() {
      return false;
    }
    restartStage() {}
  }
  return { ProcessManager };
});

const { createApp } = await import('../app.js');

function startServer(worcaDir) {
  const app = createApp({ worcaDir });
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

describe('POST /api/multi-pipeline — route removed', () => {
  let tmpDir, server, base;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'multi-pipeline-removed-'));
    ({ server, base } = await startServer(tmpDir));
  });

  afterEach(async () => {
    if (server) await stopServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns 404 for POST /api/multi-pipeline (route no longer exists)', async () => {
    const res = await fetch(`${base}/api/multi-pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: ['add auth'] }),
    });
    expect(res.status).toBe(404);
  });
});
