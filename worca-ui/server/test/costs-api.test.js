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

/** Write a status.json for a run with the given stages/iterations. */
function writeRunStatus(worcaDir, runId, stages, extra = {}) {
  const runsDir = join(worcaDir, 'runs', runId);
  mkdirSync(runsDir, { recursive: true });
  const status = {
    run_id: runId,
    started_at: '2026-04-07T10:00:00Z',
    pipeline_status: 'completed',
    stages,
    ...extra,
  };
  writeFileSync(join(runsDir, 'status.json'), JSON.stringify(status));
}

describe('GET /api/costs', () => {
  let server, port, dir;

  beforeEach(async () => {
    dir = join(tmpdir(), `worca-costs-${Date.now()}`);
    mkdirSync(join(dir, 'worca'), { recursive: true });

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

  it('returns empty tokenData when no runs exist', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tokenData).toEqual({});
  });

  it('returns token data from status.json per-iteration token_usage', async () => {
    writeRunStatus(join(dir, 'worca'), 'test-run-1', {
      plan: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            token_usage: {
              input_tokens: 14,
              output_tokens: 9229,
              cache_read_input_tokens: 489722,
              cache_creation_input_tokens: 56131,
              model: 'claude-opus-4-6',
            },
          },
        ],
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tokenData['test-run-1']).toBeDefined();
    expect(res.body.tokenData['test-run-1'].plan).toHaveLength(1);
    expect(res.body.tokenData['test-run-1'].plan[0].inputTokens).toBe(14);
    expect(res.body.tokenData['test-run-1'].plan[0].outputTokens).toBe(9229);
    expect(res.body.tokenData['test-run-1'].plan[0].cacheReadInputTokens).toBe(
      489722,
    );
    expect(
      res.body.tokenData['test-run-1'].plan[0].cacheCreationInputTokens,
    ).toBe(56131);
    expect(res.body.tokenData['test-run-1'].plan[0].models).toEqual([
      'claude-opus-4-6',
    ]);
  });

  it('handles multiple stages and iterations', async () => {
    writeRunStatus(join(dir, 'worca'), 'multi-stage', {
      plan: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            token_usage: {
              input_tokens: 100,
              output_tokens: 200,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              model: 'opus',
            },
          },
        ],
      },
      implement: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            token_usage: {
              input_tokens: 300,
              output_tokens: 400,
              cache_read_input_tokens: 50,
              cache_creation_input_tokens: 60,
              model: 'sonnet',
            },
          },
          {
            number: 2,
            status: 'completed',
            token_usage: {
              input_tokens: 500,
              output_tokens: 600,
              cache_read_input_tokens: 70,
              cache_creation_input_tokens: 80,
              model: 'sonnet',
            },
          },
        ],
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.body.tokenData['multi-stage'].plan).toHaveLength(1);
    expect(res.body.tokenData['multi-stage'].implement).toHaveLength(2);
    expect(res.body.tokenData['multi-stage'].implement[1].inputTokens).toBe(
      500,
    );
  });

  it('returns empty tokenData when runs have no iterations', async () => {
    writeRunStatus(join(dir, 'worca'), 'empty-run', {
      plan: { status: 'pending', iterations: [] },
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.body.ok).toBe(true);
    expect(res.body.tokenData).toEqual({});
  });

  it('handles iterations without token_usage', async () => {
    writeRunStatus(join(dir, 'worca'), 'no-tokens', {
      plan: {
        status: 'completed',
        iterations: [{ number: 1, status: 'completed' }],
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.body.ok).toBe(true);
    const iter = res.body.tokenData['no-tokens'].plan[0];
    expect(iter.inputTokens).toBe(0);
    expect(iter.outputTokens).toBe(0);
    expect(iter.webSearchRequests).toBe(0);
  });

  it('includes webSearchRequests from token_usage', async () => {
    writeRunStatus(join(dir, 'worca'), 'web-search-run', {
      plan: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            token_usage: {
              input_tokens: 100,
              output_tokens: 200,
              web_search_requests: 5,
              model: 'claude-opus-4-6',
            },
          },
        ],
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.status).toBe(200);
    const iter = res.body.tokenData['web-search-run'].plan[0];
    expect(iter.webSearchRequests).toBe(5);
  });

  it('defaults webSearchRequests to 0 when field is absent', async () => {
    writeRunStatus(join(dir, 'worca'), 'no-search-run', {
      implement: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            token_usage: {
              input_tokens: 300,
              output_tokens: 400,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 20,
            },
          },
        ],
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.status).toBe(200);
    const iter = res.body.tokenData['no-search-run'].implement[0];
    expect(iter.webSearchRequests).toBe(0);
  });

  it('includes cacheEphemeral1hTokens and cacheEphemeral5mTokens', async () => {
    writeRunStatus(join(dir, 'worca'), 'cache-tier-run', {
      plan: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            token_usage: {
              input_tokens: 14,
              output_tokens: 9229,
              cache_read_input_tokens: 489722,
              cache_creation_input_tokens: 56131,
              cache_ephemeral_1h_tokens: 50000,
              cache_ephemeral_5m_tokens: 6131,
            },
          },
        ],
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.status).toBe(200);
    const iter = res.body.tokenData['cache-tier-run'].plan[0];
    expect(iter.cacheEphemeral1hTokens).toBe(50000);
    expect(iter.cacheEphemeral5mTokens).toBe(6131);
  });

  it('defaults cache ephemeral tokens to 0 when fields are absent', async () => {
    writeRunStatus(join(dir, 'worca'), 'no-cache-tier-run', {
      plan: {
        status: 'completed',
        iterations: [
          {
            number: 1,
            status: 'completed',
            token_usage: {
              input_tokens: 100,
              output_tokens: 200,
            },
          },
        ],
      },
    });

    const res = await fetch(`http://127.0.0.1:${port}/api/costs`);
    expect(res.status).toBe(200);
    const iter = res.body.tokenData['no-cache-tier-run'].plan[0];
    expect(iter.cacheEphemeral1hTokens).toBe(0);
    expect(iter.cacheEphemeral5mTokens).toBe(0);
  });
});
