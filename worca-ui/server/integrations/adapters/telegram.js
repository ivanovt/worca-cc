/**
 * Telegram adapter — two-way, long-poll getUpdates + sendMessage (HTML parse_mode).
 * @module adapters/telegram
 */

import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  renderSegments,
  SEND_BACKOFF_DELAYS,
  TELEGRAM_HTML_STYLE,
} from '../render-segments.js';

const TELEGRAM_API = 'https://api.telegram.org';
const LONG_POLL_TIMEOUT_SEC = 30;

// ---------------------------------------------------------------------------
// HTML renderer
// ---------------------------------------------------------------------------

/**
 * Render a NormalizedMessage to Telegram HTML.
 * @param {import('../adapter.js').NormalizedMessage} msg
 * @returns {string}
 */
export function renderToHtml(msg) {
  return renderSegments(msg, TELEGRAM_HTML_STYLE);
}

// ---------------------------------------------------------------------------
// Cursor persistence (fsynced)
// ---------------------------------------------------------------------------

async function readCursor(cursorPath) {
  try {
    const data = await readFile(cursorPath, 'utf8');
    const n = parseInt(data.trim(), 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

async function writeCursor(cursorPath, offset) {
  await mkdir(dirname(cursorPath), { recursive: true });
  const fh = await open(cursorPath, 'w');
  try {
    await fh.write(String(offset));
    await fh.datasync();
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   token: string,
 *   cursorPath: string,
 *   fetchFn?: typeof fetch,
 *   _sleep?: (ms: number) => Promise<void>
 * }} options
 * @returns {import('../adapter.js').ChatAdapter}
 */
export function createTelegramAdapter({
  token,
  cursorPath,
  fetchFn = globalThis.fetch,
  _sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let inboundCb = null;
  let running = false;
  // Connection health tracking
  let connState = 'connecting'; // 'connecting' | 'connected' | 'disconnected'
  let connError = null;
  let lastPollOk = null; // ISO timestamp of last successful poll

  async function pollLoop() {
    let cursor = await readCursor(cursorPath);
    let firstPoll = true;
    while (running) {
      try {
        const pollTimeout = firstPoll ? 0 : LONG_POLL_TIMEOUT_SEC;
        const url =
          `${TELEGRAM_API}/bot${token}/getUpdates` +
          `?offset=${cursor}&timeout=${pollTimeout}`;
        const res = await fetchFn(url);
        firstPoll = false;
        if (res.status === 429) {
          const data = await res.json().catch(() => ({}));
          const ms = (data.parameters?.retry_after ?? 1) * 1000;
          await _sleep(ms);
          continue;
        }
        if (!res.ok) {
          connState = 'disconnected';
          connError = `HTTP ${res.status}`;
          if (running) await _sleep(5000);
          continue;
        }
        connState = 'connected';
        connError = null;
        lastPollOk = new Date().toISOString();
        const data = await res.json();
        if (data.ok && data.result.length > 0) {
          for (const update of data.result) {
            cursor = update.update_id + 1;
            if (inboundCb && update.message) {
              const m = update.message;
              inboundCb({
                platform: 'telegram',
                chatId: String(m.chat.id),
                userId: String(m.from?.id ?? m.chat.id),
                text: m.text ?? '',
                raw: update,
              });
            }
          }
          await writeCursor(cursorPath, cursor);
        }
      } catch (err) {
        connState = 'disconnected';
        connError = err.message;
        console.error('[telegram] poll error:', err.message);
        if (running) await _sleep(1000);
      }
    }
  }

  return {
    name: 'telegram',
    supportsInbound: true,
    persistent: true,

    connectionState() {
      // If the last successful poll is older than 2× the poll timeout,
      // the connection is stale (e.g. network dropped, fetch is hanging).
      let effectiveState = connState;
      let effectiveError = connError;
      if (connState === 'connected' && lastPollOk) {
        const staleMs = (LONG_POLL_TIMEOUT_SEC * 2 + 10) * 1000; // ~70s
        if (Date.now() - new Date(lastPollOk).getTime() > staleMs) {
          effectiveState = 'disconnected';
          effectiveError = 'Connection stale — no poll response';
        }
      }
      return { state: effectiveState, error: effectiveError, lastPollOk };
    },

    async start() {
      running = true;
      connState = 'connecting';
      connError = null;
      pollLoop().catch((err) =>
        console.error('[telegram] fatal poll error:', err.message),
      );
    },

    async stop() {
      running = false;
    },

    async send(chatId, msg) {
      const text = renderToHtml(msg);
      const url = `${TELEGRAM_API}/bot${token}/sendMessage`;
      const body = JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
      });
      const headers = { 'Content-Type': 'application/json' };

      for (let attempt = 0; attempt <= SEND_BACKOFF_DELAYS.length; attempt++) {
        const res = await fetchFn(url, { method: 'POST', headers, body });
        if (res.status !== 429) {
          if (!res.ok)
            console.warn(`[telegram] sendMessage failed: HTTP ${res.status}`);
          return;
        }
        if (attempt === SEND_BACKOFF_DELAYS.length) {
          console.warn('[telegram] sendMessage dropped after retries (429)');
          return;
        }
        const data = await res.json().catch(() => ({}));
        const ms =
          (data.parameters?.retry_after ?? 0) * 1000 ||
          SEND_BACKOFF_DELAYS[attempt];
        await _sleep(ms);
      }
    },

    onInbound(cb) {
      inboundCb = cb;
    },
  };
}
