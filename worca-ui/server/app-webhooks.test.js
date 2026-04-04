import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';

describe('POST /api/webhooks/test', () => {
  let httpServer;
  let port;
  let receivedRequests;
  let receiverServer;
  let receiverPort;

  beforeEach(async () => {
    const app = createApp({});
    httpServer = createServer(app);
    await new Promise((resolve) => httpServer.listen(0, resolve));
    port = httpServer.address().port;

    receivedRequests = [];
    receiverServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        receivedRequests.push({
          method: req.method,
          headers: req.headers,
          body,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => receiverServer.listen(0, resolve));
    receiverPort = receiverServer.address().port;
  });

  afterEach(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    await new Promise((resolve) => receiverServer.close(resolve));
  });

  it('rejects missing url with 400', async () => {
    const res = await fetch(`http://localhost:${port}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/url/i);
  });

  it('rejects empty url with 400', async () => {
    const res = await fetch(`http://localhost:${port}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '   ' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it('rejects invalid URL format with 400', async () => {
    const res = await fetch(`http://localhost:${port}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'not-a-url' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/url/i);
  });

  it('rejects non-http/https url with 400', async () => {
    const res = await fetch(`http://localhost:${port}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'ftp://example.com/hook' }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.error).toMatch(/url/i);
  });

  it('sends pipeline.test.ping POST to the webhook url', async () => {
    const webhookUrl = `http://localhost:${receiverPort}/hook`;
    const res = await fetch(`http://localhost:${port}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.status_code).toBe(200);
    expect(typeof json.response_ms).toBe('number');
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].method).toBe('POST');
    const body = JSON.parse(receivedRequests[0].body);
    expect(body.event_type).toBe('pipeline.test.ping');
    expect(body.schema_version).toBe('1');
    expect(typeof body.event_id).toBe('string');
  });

  it('sets Content-Type: application/json on outgoing request', async () => {
    const webhookUrl = `http://localhost:${receiverPort}/hook`;
    await fetch(`http://localhost:${port}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    expect(receivedRequests[0].headers['content-type']).toBe(
      'application/json',
    );
  });

  it('includes HMAC signature header when secret provided', async () => {
    const webhookUrl = `http://localhost:${receiverPort}/hook`;
    const res = await fetch(`http://localhost:${port}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret: 'mysecret' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(receivedRequests[0].headers['x-worca-signature']).toMatch(
      /^sha256=[0-9a-f]{64}$/,
    );
  });

  it('omits signature header when no secret provided', async () => {
    const webhookUrl = `http://localhost:${receiverPort}/hook`;
    await fetch(`http://localhost:${port}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    expect(receivedRequests[0].headers['x-worca-signature']).toBeUndefined();
  });

  it('returns ok:false with error when webhook url is unreachable', async () => {
    const res = await fetch(`http://localhost:${port}/api/webhooks/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://localhost:1/hook', timeout_ms: 500 }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(typeof json.error).toBe('string');
    expect(json.error.length).toBeGreaterThan(0);
  });
});
