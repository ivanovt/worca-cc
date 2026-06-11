/**
 * Discord adapter — outbound only, REST POST /channels/{id}/messages (markdown).
 * @module adapters/discord
 */

import {
  DISCORD_STYLE,
  renderSegments,
  SEND_BACKOFF_DELAYS,
} from '../render-segments.js';

const DISCORD_API = 'https://discord.com/api/v10';

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

/**
 * Render a NormalizedMessage to Discord markdown.
 * @param {import('../adapter.js').NormalizedMessage} msg
 * @returns {string}
 */
export function renderToMarkdown(msg) {
  return renderSegments(msg, DISCORD_STYLE);
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   botToken: string,
 *   channelId?: string,
 *   fetchFn?: typeof fetch,
 *   _sleep?: (ms: number) => Promise<void>
 * }} options
 * @returns {import('../adapter.js').ChatAdapter}
 */
export function createDiscordAdapter({
  botToken,
  channelId: _defaultChannelId,
  fetchFn = globalThis.fetch,
  _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const authHeader = botToken.startsWith('Bot ') ? botToken : `Bot ${botToken}`;

  return {
    name: 'discord',
    supportsInbound: false,
    persistent: false,

    connectionState() {
      return { state: 'n/a', error: null };
    },

    async start() {},
    async stop() {},

    async send(chatId, msg) {
      const content = renderToMarkdown(msg);
      const url = `${DISCORD_API}/channels/${chatId}/messages`;
      const body = JSON.stringify({ content });
      const headers = {
        'Content-Type': 'application/json',
        Authorization: authHeader,
      };

      for (let attempt = 0; attempt <= SEND_BACKOFF_DELAYS.length; attempt++) {
        const res = await fetchFn(url, { method: 'POST', headers, body });
        if (res.status !== 429) {
          if (!res.ok)
            console.warn(`[discord] send failed: HTTP ${res.status}`);
          return;
        }
        if (attempt === SEND_BACKOFF_DELAYS.length) {
          console.warn('[discord] send dropped after retries (429)');
          return;
        }
        const data = await res.json().catch(() => ({}));
        const ms =
          (data.retry_after ?? 0) * 1000 || SEND_BACKOFF_DELAYS[attempt];
        await _sleep(ms);
      }
    },

    onInbound(_cb) {},
  };
}
