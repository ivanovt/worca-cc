/**
 * Tests for POST /api/integrations/send — the route the worca-notify skill
 * targets. Stubs app.locals.integrations so we exercise just the route's
 * validation + response shape, leaving adapter-level behaviour to
 * send-outbound.test.js.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';

describe('POST /api/integrations/send', () => {
  let httpServer;
  let port;
  let prefsDir;
  let sendOutboundSpy;

  beforeEach(async () => {
    prefsDir = join(
      tmpdir(),
      `worca-send-route-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(prefsDir, { recursive: true });
    const app = createApp({ prefsDir });

    // Inject a stub integrations module — we test the route, not the
    // dispatch logic (covered by send-outbound.test.js).
    sendOutboundSpy = vi.fn(async ({ platforms, message, chatIdOverride }) => ({
      results: [
        {
          platform: platforms?.[0] ?? 'telegram',
          ok: true,
          echo: { message, chatIdOverride: chatIdOverride ?? null },
        },
      ],
    }));
    app.locals.integrations = {
      sendOutbound: sendOutboundSpy,
      status: () => ({ enabled: true }),
      enabledPlatforms: () => ['telegram'],
    };

    httpServer = createServer(app);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    rmSync(prefsDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const url = '/api/integrations/send';
  const post = (body) =>
    fetch(`http://localhost:${port}${url}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('200 with results array on a valid call', async () => {
    const res = await post({
      message: {
        title: 'hi',
        severity: 'info',
        body: [{ kind: 'text', value: 'hello' }],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0].ok).toBe(true);
    expect(sendOutboundSpy).toHaveBeenCalledOnce();
  });

  it('forwards platforms array to sendOutbound', async () => {
    await post({
      platforms: ['discord', 'slack'],
      message: { body: [{ kind: 'text', value: 'x' }], severity: 'info' },
    });
    const call = sendOutboundSpy.mock.calls[0][0];
    expect(call.platforms).toEqual(['discord', 'slack']);
  });

  it('forwards chat_id override as chatIdOverride', async () => {
    await post({
      chat_id: '999',
      message: { body: [{ kind: 'text', value: 'x' }], severity: 'info' },
    });
    const call = sendOutboundSpy.mock.calls[0][0];
    expect(call.chatIdOverride).toBe('999');
  });

  it('400 when message is missing', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/message is required/);
    expect(sendOutboundSpy).not.toHaveBeenCalled();
  });

  it('400 when message is not an object', async () => {
    const res = await post({ message: 'oops' });
    expect(res.status).toBe(400);
    expect(sendOutboundSpy).not.toHaveBeenCalled();
  });

  it('400 when platforms is not an array', async () => {
    const res = await post({
      platforms: 'telegram',
      message: { body: [] },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/platforms must be an array/);
    expect(sendOutboundSpy).not.toHaveBeenCalled();
  });

  it('400 when sendOutbound throws (caller-error input)', async () => {
    sendOutboundSpy.mockRejectedValueOnce(
      new Error('message.body must be an array'),
    );
    const res = await post({
      message: { body: 'bad' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/message\.body must be an array/);
  });
});

describe('POST /api/integrations/send — subsystem disabled', () => {
  let httpServer;
  let port;
  let prefsDir;

  beforeEach(async () => {
    prefsDir = join(
      tmpdir(),
      `worca-send-noop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(prefsDir, { recursive: true });
    const app = createApp({ prefsDir });
    app.locals.integrations = null;
    httpServer = createServer(app);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    rmSync(prefsDir, { recursive: true, force: true });
  });

  it('503 when integrations subsystem is unset', async () => {
    const res = await fetch(`http://localhost:${port}/api/integrations/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { body: [{ kind: 'text', value: 'x' }] },
      }),
    });
    expect(res.status).toBe(503);
  });
});
