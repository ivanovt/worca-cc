/**
 * createIntegrations factory — boots enabled adapters, wires event fan-out
 * and inbound command dispatch.
 * @module integrations/index
 */

import { join } from 'node:path';
import { createDiscordAdapter } from './adapters/discord.js';
import { createSlackAdapter } from './adapters/slack.js';
import { createTelegramAdapter } from './adapters/telegram.js';
import { createWebhookOutAdapter } from './adapters/webhook_out.js';
import { createAllowlistGuard } from './allowlist.js';
import { createChatContext } from './chat_context.js';
import { createControlHandlers } from './commands/control.js';
import { createFleetHandlers } from './commands/fleet.js';
import { createGlobalHandlers } from './commands/global.js';
import { parseCommand } from './commands/parser.js';
import { createProjectHandlers } from './commands/project.js';
import { createWorkspaceHandlers } from './commands/workspace.js';
import { loadIntegrationsConfig } from './config-loader.js';
import { createRateLimiter } from './rate_limiter.js';
import { renderEvent } from './renderers.js';
import { createRestClient } from './rest_client.js';
import { verify } from './verify.js';

/** Symbol used to pass raw request body through the stored event for HMAC verification. */
export const RAW_BODY = Symbol('raw_body');

const NO_OP_STUB = {
  onEvent() {},
  status() {
    return { enabled: false };
  },
  enabledPlatforms() {
    return [];
  },
  async sendOutbound() {
    return {
      results: [
        {
          platform: '(none)',
          ok: false,
          error: 'integrations subsystem disabled',
        },
      ],
    };
  },
  strictInboxVerification: false,
  secrets: [],
};

// Chat-capable adapter names. `webhook_out` is excluded — it's an
// event-fan-out destination, not a chat platform users can address by name.
const CHAT_PLATFORMS = ['telegram', 'discord', 'slack'];

/**
 * Strip credentials from adapter error messages before surfacing them
 * through sendOutbound results. Adapters' underlying `fetch` failures
 * frequently embed the full request URL (including bot tokens for
 * Telegram and webhook secrets for Slack/Discord) in the error text;
 * one redaction pattern per known shape.
 *
 * Patterns covered:
 *   - Telegram bot URL token:          `bot<digits>:<token>`
 *   - Slack incoming-webhook URL:      `hooks.slack.com/services/T…/B…/<24>`
 *   - Discord webhook URL:             `discord(app)?.com/api/webhooks/<id>/<token>`
 *   - Slack OAuth tokens:              `xox[abprs]-<token>`
 *
 * Exported for tests; the per-platform error path in sendOutbound is the
 * sole production caller today.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function redactSecrets(input) {
  return String(input)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, 'bot<redacted>')
    .replace(
      /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
      'hooks.slack.com/services/<redacted>',
    )
    .replace(
      /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
      'discord.com/api/webhooks/<redacted>',
    )
    .replace(/xox[abprs]-[A-Za-z0-9-]+/g, 'xox<redacted>');
}

/**
 * @param {{
 *   port: number,
 *   host?: string,
 *   prefsDir: string,
 *   configPath: string,
 * }} opts
 * @returns {{ onEvent, status, strictInboxVerification: boolean, secrets: string[] }}
 */
export function createIntegrations({
  port,
  host = '127.0.0.1',
  prefsDir,
  configPath,
}) {
  let cfg = loadIntegrationsConfig(configPath);
  if (!cfg || !cfg.enabled) return NO_OP_STUB;

  let secrets = _loadSecrets(cfg);
  const integrationsDir = join(prefsDir, 'integrations');
  const chatContext = createChatContext(
    join(integrationsDir, 'chat_context.json'),
  );
  const restClient = createRestClient({ host, port });

  const globalHandlers = createGlobalHandlers({
    chatContext,
    prefsDir,
    restClient,
  });
  const projectHandlers = createProjectHandlers({ chatContext, restClient });
  const controlHandlers = createControlHandlers({ chatContext, restClient });
  const fleetHandlers = createFleetHandlers({ chatContext, restClient });
  const workspaceHandlers = createWorkspaceHandlers({
    chatContext,
    restClient,
  });
  const allHandlers = {
    ...globalHandlers,
    ...projectHandlers,
    ...controlHandlers,
    ...fleetHandlers,
    ...workspaceHandlers,
  };

  // Mutable adapter registry — keyed by adapter name
  const adapterMap = new Map(); // name → { adapter, adapterCfg }
  const rateLimiters = new Map();
  let allowlist = createAllowlistGuard(_collectAllowedIds(cfg));

  let invalidSigEvents = 0;
  let lastEventAt = null;

  // Boot initial adapters from config
  for (const entry of _bootAdapters(cfg, integrationsDir)) {
    _startEntry(entry);
  }

  function _startEntry({ adapter, adapterCfg }) {
    adapterMap.set(adapter.name, { adapter, adapterCfg });
    rateLimiters.set(
      adapter.name,
      createRateLimiter({ ratePerMin: adapterCfg.rate_limit_per_min ?? 20 }),
    );
    if (adapter.supportsInbound) {
      adapter.onInbound((msg) => _handleInbound(msg));
    }
    adapter
      .start()
      .catch((err) =>
        console.error(
          `[integrations] ${adapter.name} start error:`,
          err.message,
        ),
      );
  }

  async function _stopAdapter(name) {
    const entry = adapterMap.get(name);
    if (!entry) return;
    try {
      await entry.adapter.stop();
    } catch (err) {
      console.error(`[integrations] ${name} stop error:`, err.message);
    }
    adapterMap.delete(name);
    rateLimiters.delete(name);
  }

  /**
   * Hot-reload a single adapter: re-reads config, stops the old instance,
   * boots a new one. No-op if the adapter's config section is missing/disabled.
   */
  async function reloadAdapter(name) {
    cfg = loadIntegrationsConfig(configPath) || cfg;
    if (!cfg.enabled) return;
    secrets = _loadSecrets(cfg);
    allowlist = createAllowlistGuard(_collectAllowedIds(cfg));

    // Stop existing adapter — must complete before booting new one
    await _stopAdapter(name);

    // Boot new adapter from fresh config
    const entries = _bootAdapters({ [name]: cfg[name] }, integrationsDir);
    for (const entry of entries) {
      _startEntry(entry);
    }
  }

  /**
   * Remove a single adapter: stops and unregisters it, refreshes config.
   */
  async function removeAdapter(name) {
    await _stopAdapter(name);
    cfg = loadIntegrationsConfig(configPath) || cfg;
    secrets = _loadSecrets(cfg);
    allowlist = createAllowlistGuard(_collectAllowedIds(cfg));
  }

  async function _handleInbound(msg) {
    if (!allowlist.isAllowed({ platform: msg.platform, chatId: msg.chatId }))
      return;

    const parsed = parseCommand(msg.text);
    if (!parsed) return;

    const chatKey = `${msg.platform}:${msg.chatId}`;
    const handler = allHandlers[parsed.command];
    let reply;

    if (!handler) {
      reply = `Unknown command /${parsed.command}. Try /help.`;
    } else {
      try {
        reply = await handler(chatKey, parsed.args);
      } catch (err) {
        console.error('[integrations] command error:', err.message);
        reply = 'Internal error — try again.';
      }
    }

    if (reply) await _sendReply(msg.platform, msg.chatId, reply);
  }

  async function _sendReply(platform, chatId, text) {
    const entry = adapterMap.get(platform);
    if (!entry) return;
    const msg = {
      title: null,
      body: [{ kind: 'markdown', value: text }],
      severity: 'info',
    };
    const rl = rateLimiters.get(platform);
    if (rl) {
      await rl.send(msg, (m) => entry.adapter.send(chatId, m));
    } else {
      await entry.adapter.send(chatId, msg);
    }
  }

  /**
   * Names of chat-capable adapters currently booted (enabled in config and
   * successfully constructed). Drives the worca-notify skill's default
   * fan-out target list. Excludes webhook_out (not a chat platform).
   * @returns {string[]}
   */
  function enabledPlatforms() {
    return [...adapterMap.keys()].filter((n) => CHAT_PLATFORMS.includes(n));
  }

  /**
   * Send a NormalizedMessage to one or more chat platforms through the same
   * allowlist + rate-limiter pipeline as pipeline-event fan-out. Used by the
   * POST /api/integrations/send route (which the worca-notify skill calls).
   *
   * Per-platform failures are returned as individual result entries, never
   * thrown — the caller decides whether a partial success is acceptable. The
   * overall promise rejects only for caller-error inputs (invalid message).
   *
   * @param {{
   *   platforms?: string[],
   *   message: import('./adapter.js').NormalizedMessage,
   *   chatIdOverride?: string,
   * }} opts
   * @returns {Promise<{results: Array<{platform: string, ok: boolean, error?: string}>}>}
   */
  async function sendOutbound({ platforms, message, chatIdOverride }) {
    if (!message || typeof message !== 'object') {
      throw new Error('message must be an object');
    }
    if (!Array.isArray(message.body)) {
      throw new Error('message.body must be an array of segments');
    }
    if (
      chatIdOverride !== undefined &&
      chatIdOverride !== null &&
      typeof chatIdOverride !== 'string' &&
      typeof chatIdOverride !== 'number'
    ) {
      throw new Error('chat_id must be a string or number');
    }

    const targets =
      Array.isArray(platforms) && platforms.length > 0
        ? platforms
        : enabledPlatforms();

    const results = [];
    for (const name of targets) {
      const entry = adapterMap.get(name);
      if (!entry) {
        results.push({
          platform: name,
          ok: false,
          error: CHAT_PLATFORMS.includes(name)
            ? 'platform not enabled or not configured'
            : 'unknown platform',
        });
        continue;
      }

      const chatId =
        chatIdOverride !== undefined && chatIdOverride !== null
          ? String(chatIdOverride)
          : String(
              entry.adapterCfg.chat_id ?? entry.adapterCfg.channel_id ?? '',
            );

      if (!chatId) {
        results.push({
          platform: name,
          ok: false,
          error: 'no chat_id configured for this platform',
        });
        continue;
      }

      if (!allowlist.isAllowed({ platform: name, chatId })) {
        results.push({
          platform: name,
          ok: false,
          error: 'chat_id not in allowlist',
        });
        continue;
      }

      try {
        const rl = rateLimiters.get(name);
        const sendFn = (m) => entry.adapter.send(chatId, m);
        if (rl) {
          await rl.send(message, sendFn);
        } else {
          await sendFn(message);
        }
        results.push({ platform: name, ok: true });
      } catch (err) {
        // Strip credentials from the error before surfacing — adapters'
        // fetch failures can echo full request URLs that embed bot tokens
        // (Telegram), webhook secrets (Slack/Discord), or OAuth tokens.
        results.push({
          platform: name,
          ok: false,
          error: redactSecrets(err?.message ?? err),
        });
      }
    }

    return { results };
  }

  function onEvent(stored) {
    const rawBody = stored[RAW_BODY];
    const sigHeader = stored.headers?.['x-worca-signature'];

    if (secrets.length > 0) {
      if (!rawBody || !verify(rawBody, sigHeader, secrets)) {
        invalidSigEvents++;
        return;
      }
    }

    lastEventAt = new Date().toISOString();
    const envelope = stored.envelope;

    for (const [, { adapter, adapterCfg }] of adapterMap) {
      const events = adapterCfg.events ?? [];
      if (!events.includes(envelope?.event_type)) continue;

      const chatId = String(adapterCfg.chat_id ?? adapterCfg.channel_id ?? '');
      const chatKey = `${adapter.name}:${chatId}`;

      if (chatContext.isMuted(chatKey)) {
        chatContext.incrementMuted(chatKey);
        continue;
      }

      const msg = renderEvent(envelope);
      if (!msg) continue;

      const rl = rateLimiters.get(adapter.name);
      const sendFn = (m) => adapter.send(chatId, m);

      if (rl) {
        rl.send(msg, sendFn).catch((err) =>
          console.error(
            `[integrations] ${adapter.name} send error:`,
            err.message,
          ),
        );
      } else {
        sendFn(msg).catch((err) =>
          console.error(
            `[integrations] ${adapter.name} send error:`,
            err.message,
          ),
        );
      }
    }
  }

  function status() {
    return {
      enabled: true,
      strict_inbox_verification: cfg.strict_inbox_verification ?? false,
      secrets_configured: secrets.length,
      adapters: [...adapterMap.values()].map(({ adapter }) => {
        const conn = adapter.connectionState?.() ?? {
          state: 'n/a',
          error: null,
        };
        return {
          name: adapter.name,
          enabled: true,
          persistent: adapter.persistent ?? false,
          connection: conn.state,
          connection_error: conn.error,
          dropped_messages:
            rateLimiters.get(adapter.name)?.getStats().dropped_messages ?? 0,
          invalid_signature_events: invalidSigEvents,
          last_event_at: lastEventAt,
        };
      }),
      chats: _collectChatStatus(cfg, chatContext),
    };
  }

  return {
    onEvent,
    status,
    reloadAdapter,
    removeAdapter,
    enabledPlatforms,
    sendOutbound,
    /** @internal — used by detect endpoint to pause/resume adapter */
    _getAdapter: (name) => adapterMap.get(name) ?? null,
    strictInboxVerification: cfg.strict_inbox_verification ?? false,
    secrets,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _loadSecrets(cfg) {
  const secrets = [];
  if (cfg.webhook_secret_env) {
    const val = process.env[cfg.webhook_secret_env];
    if (val) secrets.push(val);
  }
  if (cfg.webhook_secrets_env) {
    const val = process.env[cfg.webhook_secrets_env];
    if (val) {
      for (const s of val.split(',')) {
        const trimmed = s.trim();
        if (trimmed) secrets.push(trimmed);
      }
    }
  }
  return secrets;
}

function _bootAdapters(cfg, integrationsDir) {
  const adapters = [];

  if (cfg.telegram?.enabled) {
    const token =
      cfg.telegram.bot_token ||
      process.env[cfg.telegram.bot_token_env || 'TELEGRAM_BOT_TOKEN'];
    if (!token) {
      console.warn('[integrations] telegram token not configured — skipping');
    } else {
      adapters.push({
        adapter: createTelegramAdapter({
          token,
          cursorPath: join(integrationsDir, 'telegram.cursor'),
        }),
        adapterCfg: cfg.telegram,
      });
    }
  }

  if (cfg.discord?.enabled) {
    const botToken =
      cfg.discord.bot_token ||
      process.env[cfg.discord.bot_token_env || 'DISCORD_BOT_TOKEN'];
    if (!botToken) {
      console.warn('[integrations] discord token not configured — skipping');
    } else {
      adapters.push({
        adapter: createDiscordAdapter({
          botToken,
          channelId: cfg.discord.channel_id,
        }),
        adapterCfg: cfg.discord,
      });
    }
  }

  if (cfg.slack?.enabled) {
    const webhookUrl =
      cfg.slack.webhook_url ||
      process.env[cfg.slack.webhook_url_env || 'SLACK_WEBHOOK_URL'];
    if (!webhookUrl) {
      console.warn(
        '[integrations] slack webhook URL not configured — skipping',
      );
    } else {
      adapters.push({
        adapter: createSlackAdapter({ webhookUrl }),
        adapterCfg: cfg.slack,
      });
    }
  }

  if (cfg.webhook_out?.enabled) {
    const endpoints = cfg.webhook_out.endpoints ?? [];
    if (endpoints.length > 0) {
      const events = [...new Set(endpoints.flatMap((ep) => ep.events ?? []))];
      adapters.push({
        adapter: createWebhookOutAdapter({ endpoints }),
        adapterCfg: { ...cfg.webhook_out, events },
      });
    }
  }

  return adapters;
}

function _collectAllowedIds(cfg) {
  const ids = [];
  if (cfg.telegram?.chat_id) ids.push(String(cfg.telegram.chat_id));
  if (cfg.discord?.channel_id) ids.push(String(cfg.discord.channel_id));
  if (cfg.slack?.chat_id) ids.push(String(cfg.slack.chat_id));
  return ids;
}

function _collectChatStatus(cfg, chatContext) {
  const chats = [];
  if (cfg.telegram?.chat_id) {
    const chatKey = `telegram:${cfg.telegram.chat_id}`;
    const id = cfg.telegram.chat_id;
    const state = chatContext.get(chatKey);
    const masked = id.length > 6 ? `${id.slice(0, 3)}***${id.slice(-3)}` : id;
    chats.push({
      platform: 'telegram',
      chat_id: masked,
      active_project: state.active_project,
      muted_until: state.mute_until,
      muted_messages: state.muted_messages,
    });
  }
  return chats;
}
