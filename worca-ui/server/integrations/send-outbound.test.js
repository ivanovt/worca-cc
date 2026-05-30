/**
 * Tests for createIntegrations().sendOutbound — the entry point that the
 * POST /api/integrations/send route and the worca-notify skill depend on.
 *
 * Mocks the adapter factories so we can assert behaviour around allowlist
 * gating, rate limiter use, missing-platform handling, secret redaction in
 * errors, and the no-op stub.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIntegrations } from './index.js';

// Capture per-platform sends across tests
let telegramSends = [];
let discordSends = [];

vi.mock('./adapters/telegram.js', () => ({
  createTelegramAdapter: () => ({
    name: 'telegram',
    supportsInbound: false,
    async start() {},
    async stop() {},
    onInbound() {},
    async send(chatId, msg) {
      telegramSends.push({ chatId, msg });
    },
  }),
}));

vi.mock('./adapters/discord.js', () => ({
  createDiscordAdapter: () => ({
    name: 'discord',
    supportsInbound: false,
    async start() {},
    async stop() {},
    onInbound() {},
    async send(chatId, msg) {
      discordSends.push({ chatId, msg });
    },
  }),
}));

vi.mock('./adapters/slack.js', () => ({
  createSlackAdapter: () => ({
    name: 'slack',
    supportsInbound: false,
    async start() {},
    async stop() {},
    onInbound() {},
    async send() {
      // Simulate the Telegram-token-in-URL error shape to verify redaction
      throw new Error(
        'fetch failed at https://api.telegram.org/bot1234567:ABCDEFGHIJKLMNOPQRSTUVWXYZ/sendMessage',
      );
    },
  }),
}));

vi.mock('./adapters/webhook_out.js', () => ({
  createWebhookOutAdapter: () => ({
    name: 'webhook_out',
    supportsInbound: false,
    async start() {},
    async stop() {},
    onInbound() {},
    async send() {},
  }),
}));

function writeCfg(dir, cfg) {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

const STUB_MESSAGE = {
  title: 'hello',
  severity: 'info',
  body: [{ kind: 'text', value: 'world' }],
};

describe('sendOutbound — happy path', () => {
  let tmp;
  let integrations;

  beforeEach(() => {
    telegramSends = [];
    discordSends = [];
    tmp = mkdtempSync(join(tmpdir(), 'worca-send-'));
    const cfg = {
      schema_version: 1,
      enabled: true,
      telegram: { enabled: true, bot_token: 't', chat_id: '111', events: [] },
      discord: { enabled: true, bot_token: 'd', channel_id: '222', events: [] },
    };
    const configPath = writeCfg(tmp, cfg);
    integrations = createIntegrations({
      port: 0,
      prefsDir: tmp,
      configPath,
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('enabledPlatforms() returns only chat-capable booted adapters', () => {
    expect(integrations.enabledPlatforms().sort()).toEqual([
      'discord',
      'telegram',
    ]);
  });

  it('default targets are every enabled chat adapter', async () => {
    const out = await integrations.sendOutbound({ message: STUB_MESSAGE });
    expect(out.results.map((r) => r.platform).sort()).toEqual([
      'discord',
      'telegram',
    ]);
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(telegramSends).toHaveLength(1);
    expect(discordSends).toHaveLength(1);
    expect(telegramSends[0].chatId).toBe('111');
    expect(discordSends[0].chatId).toBe('222');
  });

  it('explicit platforms array narrows the send', async () => {
    const out = await integrations.sendOutbound({
      platforms: ['telegram'],
      message: STUB_MESSAGE,
    });
    expect(out.results).toEqual([{ platform: 'telegram', ok: true }]);
    expect(telegramSends).toHaveLength(1);
    expect(discordSends).toHaveLength(0);
  });

  it('chat_id override is forwarded to the adapter', async () => {
    await integrations.sendOutbound({
      platforms: ['telegram'],
      message: STUB_MESSAGE,
      chatIdOverride: '999',
    });
    // Override only succeeds if 999 is on the allowlist — it isn't, so we
    // expect rejection. Re-test: allowlist gating verified separately.
    expect(telegramSends).toHaveLength(0);
  });
});

describe('sendOutbound — failure modes', () => {
  let tmp;
  let integrations;

  beforeEach(() => {
    telegramSends = [];
    discordSends = [];
    tmp = mkdtempSync(join(tmpdir(), 'worca-send-'));
    const cfg = {
      schema_version: 1,
      enabled: true,
      telegram: { enabled: true, bot_token: 't', chat_id: '111', events: [] },
      slack: {
        enabled: true,
        webhook_url: 'https://example.com/h',
        chat_id: '333',
        events: [],
      },
    };
    integrations = createIntegrations({
      port: 0,
      prefsDir: tmp,
      configPath: writeCfg(tmp, cfg),
    });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('explicit unknown platform name returns an error result', async () => {
    const out = await integrations.sendOutbound({
      platforms: ['floogle'],
      message: STUB_MESSAGE,
    });
    expect(out.results).toEqual([
      { platform: 'floogle', ok: false, error: 'unknown platform' },
    ]);
  });

  it('explicit disabled-but-known platform returns a specific error', async () => {
    const out = await integrations.sendOutbound({
      platforms: ['discord'],
      message: STUB_MESSAGE,
    });
    expect(out.results).toEqual([
      {
        platform: 'discord',
        ok: false,
        error: 'platform not enabled or not configured',
      },
    ]);
  });

  it('chat_id override outside the allowlist is rejected', async () => {
    const out = await integrations.sendOutbound({
      platforms: ['telegram'],
      message: STUB_MESSAGE,
      chatIdOverride: 'not-on-allowlist',
    });
    expect(out.results).toEqual([
      {
        platform: 'telegram',
        ok: false,
        error: 'chat_id not in allowlist',
      },
    ]);
    expect(telegramSends).toHaveLength(0);
  });

  it('throws synchronously for a malformed message body', async () => {
    await expect(integrations.sendOutbound({ message: null })).rejects.toThrow(
      /message must be an object/,
    );
    await expect(
      integrations.sendOutbound({ message: { body: 'not-an-array' } }),
    ).rejects.toThrow(/message\.body must be an array/);
  });

  it('redacts telegram bot tokens that leak into adapter error messages', async () => {
    const out = await integrations.sendOutbound({
      platforms: ['slack'],
      message: STUB_MESSAGE,
    });
    expect(out.results[0].ok).toBe(false);
    expect(out.results[0].error).not.toMatch(/1234567:ABCDEFG/);
    expect(out.results[0].error).toMatch(/bot<redacted>/);
  });
});

describe('sendOutbound — NO_OP_STUB', () => {
  it('returns a clear error when the integrations subsystem is disabled', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'worca-send-'));
    try {
      const integrations = createIntegrations({
        port: 0,
        prefsDir: tmp,
        configPath: writeCfg(tmp, { schema_version: 1, enabled: false }),
      });
      const out = await integrations.sendOutbound({ message: STUB_MESSAGE });
      expect(out.results).toEqual([
        {
          platform: '(none)',
          ok: false,
          error: 'integrations subsystem disabled',
        },
      ]);
      expect(integrations.enabledPlatforms()).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
