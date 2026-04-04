import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

function fetch(url) {
  return new Promise((resolve, reject) => {
    httpGet(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode, body: JSON.parse(body) }),
      );
      res.on('error', reject);
    }).on('error', reject);
  });
}

describe('GET /api/costs', () => {
  let server, port, dir;

  beforeEach(async () => {
    dir = join(tmpdir(), `worca-costs-${Date.now()}`);
    mkdirSync(join(dir, 'worca', 'results'), { recursive: true });

    const app = createApp({
      worcaDir: join(dir, 'worca'),
      settingsPath: join(dir, 'settings.json'),
      projectRoot: dir,
    });
    server = createServer(app);
    await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty tokenData when no results exist', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tokenData).toEqual({});
  });

  it('returns token data for runs with per-stage iter files', async () => {
    const runId = 'test-run-1';
    const stageDir = join(dir, 'worca', 'results', runId, 'plan');
    mkdirSync(stageDir, { recursive: true });

    writeFileSync(
      join(stageDir, 'iter-1.json'),
      JSON.stringify({
        total_cost_usd: 0.82,
        modelUsage: {
          'claude-opus-4-6': {
            inputTokens: 14,
            outputTokens: 9229,
            cacheReadInputTokens: 489722,
            cacheCreationInputTokens: 56131,
            costUSD: 0.82,
          },
        },
      }),
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tokenData[runId]).toBeDefined();
    expect(res.body.tokenData[runId].plan).toHaveLength(1);
    expect(res.body.tokenData[runId].plan[0].inputTokens).toBe(14);
    expect(res.body.tokenData[runId].plan[0].outputTokens).toBe(9229);
    expect(res.body.tokenData[runId].plan[0].cacheReadInputTokens).toBe(489722);
    expect(res.body.tokenData[runId].plan[0].cacheCreationInputTokens).toBe(
      56131,
    );
    expect(res.body.tokenData[runId].plan[0].models).toEqual([
      'claude-opus-4-6',
    ]);
  });

  it('handles multiple stages and iterations', async () => {
    const runId = 'multi-stage';
    mkdirSync(join(dir, 'worca', 'results', runId, 'plan'), {
      recursive: true,
    });
    mkdirSync(join(dir, 'worca', 'results', runId, 'implement'), {
      recursive: true,
    });

    writeFileSync(
      join(dir, 'worca', 'results', runId, 'plan', 'iter-1.json'),
      JSON.stringify({
        modelUsage: {
          opus: {
            inputTokens: 100,
            outputTokens: 200,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        },
      }),
    );
    writeFileSync(
      join(dir, 'worca', 'results', runId, 'implement', 'iter-1.json'),
      JSON.stringify({
        modelUsage: {
          sonnet: {
            inputTokens: 300,
            outputTokens: 400,
            cacheReadInputTokens: 50,
            cacheCreationInputTokens: 60,
          },
        },
      }),
    );
    writeFileSync(
      join(dir, 'worca', 'results', runId, 'implement', 'iter-2.json'),
      JSON.stringify({
        modelUsage: {
          sonnet: {
            inputTokens: 500,
            outputTokens: 600,
            cacheReadInputTokens: 70,
            cacheCreationInputTokens: 80,
          },
        },
      }),
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.body.tokenData[runId].plan).toHaveLength(1);
    expect(res.body.tokenData[runId].implement).toHaveLength(2);
    expect(res.body.tokenData[runId].implement[1].inputTokens).toBe(500);
  });

  it('ignores non-directory entries in results', async () => {
    writeFileSync(join(dir, 'worca', 'results', 'somefile.json'), '{}');
    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.body.ok).toBe(true);
    expect(res.body.tokenData).toEqual({});
  });

  it('skips malformed iter files gracefully', async () => {
    const runId = 'bad-data';
    mkdirSync(join(dir, 'worca', 'results', runId, 'plan'), {
      recursive: true,
    });
    writeFileSync(
      join(dir, 'worca', 'results', runId, 'plan', 'iter-1.json'),
      'not valid json!!!',
    );

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.body.ok).toBe(true);
    // Bad file is skipped, so plan stage has no valid iters — run entry exists but is empty
    expect(res.body.tokenData[runId]).toEqual({});
  });
});
