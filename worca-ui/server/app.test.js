import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('POST /api/projects/:project/runs/:runId/pr', () => {
  let httpServer;

  afterEach(async () => {
    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
      httpServer = null;
    }
  });

  it('returns 409 when a request is already in-flight for the same project/runId', async () => {
    let unblockFirst;
    let notifySpawnCalled;

    const spawnCalledSignal = new Promise((resolve) => {
      notifySpawnCalled = resolve;
    });

    // Mock spawner: signals when called, blocks until unblockFirst() is called
    const _spawnPrCreate = () => {
      notifySpawnCalled();
      return new Promise((resolve) => {
        unblockFirst = resolve;
      });
    };

    const app = createApp({ _spawnPrCreate });
    httpServer = createServer(app);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    const port = httpServer.address().port;

    const url = `http://localhost:${port}/api/projects/myproj/runs/run-001/pr`;

    // First request — blocks until unblockFirst is called
    const firstFetch = fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    // Wait until the spawner is registered (key is in the mutex map)
    await spawnCalledSignal;

    // Second request for the same project/runId must get 409
    const secondRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(secondRes.status).toBe(409);
    const secondJson = await secondRes.json();
    expect(secondJson.error).toBe('pr_creation_in_progress');

    // Clean up: let the first request complete
    unblockFirst({ stdout: '', stderr: '' });
    await firstFetch;
  });

  const PROVIDER_CASES = [
    ['GitHub', 'PR created: https://github.com/owner/repo/pull/42'],
    ['GitLab', 'PR created: https://gitlab.com/group/repo/-/merge_requests/42'],
    [
      'Bitbucket',
      'PR created: https://bitbucket.org/owner/repo/pull-requests/42',
    ],
    [
      'Azure DevOps',
      'PR created: https://dev.azure.com/org/proj/_git/repo/pullrequest/42',
    ],
  ];

  for (const [provider, stdout] of PROVIDER_CASES) {
    it(`extracts the pr_url from ${provider} CLI output`, async () => {
      const _spawnPrCreate = () => Promise.resolve({ stdout, stderr: '' });

      const app = createApp({ _spawnPrCreate });
      httpServer = createServer(app);
      await new Promise((resolve) => httpServer.listen(0, resolve));
      const port = httpServer.address().port;

      const res = await fetch(
        `http://localhost:${port}/api/projects/myproj/runs/run-002/pr`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.pr_url).toBe(stdout.replace('PR created: ', ''));
    });
  }
});
