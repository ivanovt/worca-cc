# W-041: Chat Integrations (Telegram + Outbound Discord/Slack/Webhook)

**Status:** Draft
**Priority:** P2
**Area:** ui (with a small `cc` carve-out for CLI status)
**Date:** 2026-04-16
**Depends on:** W-003 (pipeline events & webhooks — `src/worca/events/types.py`, `src/worca/events/webhook.py` — code shipped; plan doc still Draft), W-032 (global multi-project worca-ui — `~/.worca/projects.d/` semantics)

## Problem

Worca pipeline notifications today are confined to the browser UI. `worca-ui/server/app.js:252` receives pipeline events via `POST /api/webhooks/inbox` and broadcasts them over the WebSocket layer to connected dashboards, but users running autonomous pipelines from a server (`src/worca/scripts/run_pipeline.py:1`) or via `worca run` (`src/worca/cli/main.py`) get no signal when a run completes, fails, hits the budget warning, or opens a PR unless they have a browser tab open. The most valuable moment for a notification — *"my 3am autonomous run finished, did it merge?"* — is the moment nobody is watching.

There is also no read or control path from a phone. The REST API exposes per-run status (`worca-ui/server/project-routes.js:435`), runs list (`:213`), aggregate costs (`:1249`), and pause/resume/stop endpoints (`:624`, `:640`, `:679`), but only via the web UI. A developer away from their machine has no visibility and no way to say "pause that run, I'll look at it after my meeting."

User-facing impact: autonomous development loses its main value proposition (walk-away automation) because the user must stay at the laptop to know what happened *and* to intervene when it goes wrong.

## Proposal

Build the chat integrations as a module inside the `worca-ui` server process, not as a separate Python daemon. The UI server is already the global, long-running, multi-project component (W-032); it already receives every pipeline event, already enumerates registered projects, already owns the REST endpoints that map 1:1 to user commands, and is already the service users install once per machine.

Add `worca-ui/server/integrations/` with:

- Four adapters behind a shared `ChatAdapter` interface — **Telegram** (two-way, long-poll), **Discord** (outbound only, REST), **Slack** (outbound only, incoming webhook URL), **generic outbound webhook**.
- A subscriber that hangs off the existing webhook inbox, verifies HMAC at the subscriber level, and renders Tier 1 events to chat messages.
- A command parser + handlers that invoke UI REST endpoints via loopback HTTP (`127.0.0.1:<port>`) — no changes to existing route code.
- Per-chat state (`active_project`, mute) in `~/.worca/integrations/chat_context.json`.

Configuration lives at `~/.worca/integrations/config.json` (global, user-wide — same precedent as `~/.worca/projects.d/` and `~/.worca/preferences.json`). The integrations module boots with the UI server; stops with it. No PID file, no auto-spawn, no separate `install-service` — the UI server's existing lifecycle covers it.

One thin carve-out stays in `worca-cc`: a `worca integrations status` CLI command (~30 lines of Python) that HTTP-probes `http://127.0.0.1:3400/api/integrations/status` so headless users can check health from the shell.

**Zero breaking changes.** The existing inbox handler, control-response loop, WebSocket broadcasts, and pipeline signing behavior all continue to work exactly as today. Users who don't enable integrations see no observable difference.

## Design

### 1. Event source — non-invasive subscription to the existing inbox

- **Current state:** `worca-ui/server/app.js:252` handles `POST /api/webhooks/inbox`. It pushes into `webhookInbox.push(...)` (a ring buffer from `webhook-inbox.js:12`) and calls `app.locals.broadcast('webhook-inbox-event', stored)` (`app.js:270`) to fan out to WebSocket clients. The handler returns `{ control: { action: webhookInbox.getControlAction() } }` so pipelines can react to pause/abort signals.
- **Obstacle:** Integrations must receive every pipeline event without altering the inbox handler's contract or introducing any new reason for existing pipelines to fail.
- **Resolution:** Add a single optional call `app.locals.integrations?.onEvent(stored)` immediately after the existing broadcast. The inbox handler's accept behavior, response shape, and ring-buffer semantics are unchanged. If integrations is not configured or fails to load, `app.locals.integrations` is undefined and the optional-chaining no-ops.

```js
// worca-ui/server/app.js — additive change inside the inbox handler
const stored = webhookInbox.push({ headers, envelope, projectId });
if (shouldBroadcast) app.locals.broadcast('webhook-inbox-event', stored);
app.locals.integrations?.onEvent(stored);   // new — only line added
res.json({ control: { action: webhookInbox.getControlAction() } });
```

### 2. Module boundary & lifecycle

- **Current state:** `worca-ui/server/index.js:52-60` constructs the Express app and attaches it to the HTTP server. The UI has no sub-module lifecycle abstraction — modules just register on `app`.
- **Obstacle:** Integrations is long-lived (Telegram long-poll) and stateful (ring buffer, rate limiter, chat_context). It must boot with the server without introducing shutdown behavior that changes observable lifetime.
- **Resolution:** Factory pattern returning `{ onEvent, status }`. `index.js` constructs it after the app, assigns to `app.locals.integrations`. No custom SIGTERM handler — integrations state is crash-safe (see §11), so Node's default shutdown behavior is preserved.

```js
// worca-ui/server/index.js — after app creation (~line 60)
import { createIntegrations } from './integrations/index.js';

const integrations = createIntegrations({
  port, host,
  webhookInbox,
  prefsDir,
  configPath: join(prefsDir, 'integrations', 'config.json'),
});
app.locals.integrations = integrations;
```

Start-up is non-fatal: if `config.json` is missing or invalid, `createIntegrations` logs a warning and returns a no-op stub. UI server boots normally.

### 3. ChatAdapter interface

- **Current state:** No abstraction exists.
- **Obstacle:** Per-platform code paths would Balkanize. Need one shape so the router doesn't care which platform a message came from or is going to.
- **Resolution:** Duck-typed object with five methods.

```js
// worca-ui/server/integrations/adapter.js — JSDoc typedefs
/**
 * @typedef {{kind: 'text'|'bold'|'code'|'code_block'|'link', value: string, href?: string}} MessageSegment
 * @typedef {{title: string|null, body: MessageSegment[], severity: 'info'|'success'|'warning'|'error'}} NormalizedMessage
 * @typedef {{platform: string, chatId: string, userId: string, text: string, raw: object}} IncomingMessage
 *
 * @typedef {object} ChatAdapter
 * @property {string} name
 * @property {boolean} supportsInbound
 * @property {() => Promise<void>} start
 * @property {(chatId: string, msg: NormalizedMessage) => Promise<void>} send
 * @property {(cb: (msg: IncomingMessage) => void) => void} onInbound  // no-op if !supportsInbound
 */
```

Per-adapter file target: ~200 lines. Shared infra (router, command parser, rate limiter, chat_context, REST bridge) lives outside adapters.

### 4. Outbound — Tier 1 events (7)

- **Current state:** All seven event constants defined in `src/worca/events/types.py`: `RUN_COMPLETED` (:16), `RUN_FAILED` (:17), `RUN_INTERRUPTED` (:18), `GIT_PR_CREATED` (:57), `GIT_PR_MERGED` (:58), `CB_TRIPPED` (:83), `COST_BUDGET_WARNING` (:92). Payload shapes in matching `*_payload` functions.
- **Obstacle:** None of these are rendered for human consumption.
- **Resolution:** Per-event renderer in `worca-ui/server/integrations/renderers.js` maps `envelope.payload` → `NormalizedMessage`. User extends by adding event names to the per-adapter `events` config array.

| Event | Example render |
|---|---|
| `pipeline.run.completed` | ✓ W-042 done · 12m34s · $0.87 · PR #193 |
| `pipeline.run.failed` | ✗ W-042 failed at `implementer` · SyntaxError · $0.42 |
| `pipeline.run.interrupted` | ⏸ W-042 interrupted at `tester` (12m in) |
| `pipeline.git.pr_created` | 🔀 W-042 PR opened: `<url>` |
| `pipeline.git.pr_merged` | ✅ W-042 PR merged |
| `pipeline.circuit_breaker.tripped` | ⚠ 3× `api_error` in `implementer` — run halted |
| `pipeline.cost.budget_warning` | 💸 W-042 at 85% of $100 budget |

### 5. HMAC verification at the subscriber (not the inbox)

- **Current state:** `app.js:252` captures `x-worca-signature` but does not verify — events of any provenance are accepted. The Python emitter already signs with `X-Worca-Signature: sha256=<hmac>` (`src/worca/events/webhook.py:71`).
- **Obstacle:** Integrations must trust only genuine pipeline events. Enforcing HMAC at the inbox would break any user currently posting to the inbox unsigned (we promised no breaking changes).
- **Resolution:** Verify inside `integrations.onEvent()`, never at the inbox. The inbox remains permissive; the integrations subscriber is strict. Spoofed events still reach WebSocket clients (unchanged from today — see §12) but do not reach chat.

```js
// worca-ui/server/integrations/verify.js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody, sigHeader, secrets) {
  if (!sigHeader?.startsWith('sha256=')) return false;
  const received = Buffer.from(sigHeader.slice(7));
  for (const secret of secrets) {
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
    if (expected.length === received.length && timingSafeEqual(expected, received)) return true;
  }
  return false;
}
```

Verification accepts an *any-match* set of secrets (`WORCA_WEBHOOK_SECRET` singular or `WORCA_WEBHOOK_SECRETS` comma-separated plural). This preserves per-project secret diversity: users with N projects each signing with different secrets enroll all secrets into the plural form. Failed verifications drop silently with a debug log and increment `invalid_signature_events` in `/status`.

Because `integrations.onEvent` receives the already-parsed envelope (not the raw body), the inbox handler passes the raw body through via a `Symbol`-keyed side channel:

```js
// worca-ui/server/app.js
const stored = webhookInbox.push({ headers, envelope, projectId });
stored[RAW_BODY] = rawBody;        // Symbol, invisible to JSON serializers
app.locals.integrations?.onEvent(stored);
```

### 6. Inbound — commands (v1)

- **Current state:** Route handlers live in `worca-ui/server/project-routes.js`: status `:435`, runs `:213`, costs `:1249`, pause `:624`, resume `:640`, stop `:679`. Each is an inline closure over `(req, res)`.
- **Obstacle:** Commands need a project scope (W-032/W-039 users register many projects) and `run_id` disambiguation. They also need to call the UI's REST endpoints without touching existing route code.
- **Resolution:** Two layers — **global commands** operate across all registered projects; **project-scoped commands** require an active project set via `/use <project>`, and interpret `run_id` values relative to that project only. All commands issue loopback HTTP to the UI's own REST API (§13).

**Global commands (no project scope needed):**
| Command | Purpose | Backing |
|---|---|---|
| `/start` | Echoes `chat_id` for allowlist setup | n/a |
| `/help` | Command list | n/a |
| `/whoami` | `chat_id`, active project, mute state | n/a |
| `/projects` | List registered projects | `project-registry.js:readAll()` |
| `/use <project>` | Set active project for this chat | `chat_context.js` |
| `/active` | Running pipelines across all projects | registry iteration + status polls |
| `/mute [duration]` | Silence outbound (e.g. `/mute 1h`) | `chat_context.js` |
| `/unmute` | Restore outbound | `chat_context.js` |

**Project-scoped (requires active project):**
| Command | Purpose | Backing |
|---|---|---|
| `/status [run_id]` | Run status | `GET /api/projects/:id/runs/:runId/status` |
| `/runs [N]` | Recent runs (default 10) | `GET /api/projects/:id/runs` |
| `/last` | Most recent completed run | derived from `/runs` |
| `/cost [today\|week\|run_id]` | Cost summary | `GET /api/projects/:id/costs` |
| `/pr [run_id]` | PR URL | `pr_url` from status.json |
| `/pause [run_id]` | Pause active run | `POST /api/projects/:id/runs/:runId/pause` |
| `/resume [run_id]` | Resume paused run | `POST /api/projects/:id/runs/:runId/resume` |
| `/stop [run_id]` | Stop run (single-step — see §10) | `POST /api/projects/:id/runs/:runId/stop` |

**Convenience rules:**
- If exactly one project is registered, it is auto-selected on first inbound command (reply notes this).
- Multiple projects + no `/use` set → project-scoped commands reply: "No active project. `/projects` to list, `/use <name>` to select."
- `run_id` omission on project-scoped commands → resolves to the unique active run in the active project; multiple active → reply with disambiguation list.

Command parser is platform-agnostic: adapters hand `(text, chatId, userId, platform)` to the parser; parser tokenizes, strips bot mentions, consults `chat_context`, dispatches to shared handlers.

### 7. Per-adapter transport

- **Current state:** No adapter code exists.
- **Obstacle:** Each platform has its own auth model and transport. Bot-app registration cost differs by an order of magnitude (Telegram: BotFather, ~5 min; Discord/Slack Gateway/Socket Mode: hours).
- **Resolution:** v1 takes the minimum-friction path per platform.

| Adapter | Outbound | Inbound | Auth |
|---|---|---|---|
| Telegram | `sendMessage` (HTML parse_mode) | `getUpdates` long-poll (30s timeout, offset persisted at `~/.worca/integrations/telegram.cursor`) | `TELEGRAM_BOT_TOKEN` env |
| Discord | REST `POST /channels/{id}/messages` (markdown) | **— (v2)** | `DISCORD_BOT_TOKEN` env (or webhook URL) |
| Slack | `chat.postMessage` via incoming webhook URL (`mrkdwn`) | **— (v2)** | `SLACK_WEBHOOK_URL` env |
| Webhook out | `POST <url>` with templated payload | — | Optional bearer/basic/custom headers |

Generic webhook templates: `generic-json`, `slack-compatible`, `discord-compatible`, `teams-card`, `ntfy`, `plain-text`. Each is a pure function over `NormalizedMessage` — no template engine dependency.

### 8. Throughput & rate-limit budget

- **Current state:** Pipelines emit 52 distinct event types; Tier 1 covers 7. A typical run fires ~5 Tier 1 events.
- **Obstacle:** Platform rate limits — Telegram ~1 msg/sec per chat, Slack incoming webhooks ~1 msg/sec, Discord ~5 msg/sec per channel. Mass parallel runs (`run_multi.py`, `run_parallel.py`, W-040 fleet runs) can saturate.
- **Resolution:**
  - Per-adapter rate limit, default **20 outbound msg/min** (config-overridable as `<adapter>.rate_limit_per_min`).
  - In-memory ring buffer (size 100) of last-sent messages per adapter; on overflow drop oldest and increment `dropped_messages` counter exposed via `/api/integrations/status`.
  - Async outbound queue per adapter with backoff on platform `429`: 1s → 5s → 30s → drop with warning to `console.warn`.
  - Muted chats (§11) skip the outbound queue entirely; increments per-chat `muted_messages`.

### 9. Config schema

- **Current state:** `~/.worca/projects.d/*.json` and `~/.worca/preferences.json` establish the global-config precedent. No integrations config exists.
- **Obstacle:** Bot tokens and chat_ids are user-wide, not per-project. Project-scoped settings would force N copies and miss the "one UI for everything" semantic.
- **Resolution:** Global config at `~/.worca/integrations/config.json`. Validated on load by extending `worca-ui/server/settings-validator.js` (the existing 507-line validator already enforces this pattern).

```json
{
  "schema_version": 1,
  "enabled": true,
  "webhook_secret_env": "WORCA_WEBHOOK_SECRET",
  "webhook_secrets_env": "WORCA_WEBHOOK_SECRETS",
  "strict_inbox_verification": false,
  "telegram": {
    "enabled": true,
    "bot_token_env": "TELEGRAM_BOT_TOKEN",
    "chat_id": "123456789",
    "rate_limit_per_min": 20,
    "events": [
      "pipeline.run.completed", "pipeline.run.failed",
      "pipeline.run.interrupted", "pipeline.git.pr_created",
      "pipeline.git.pr_merged", "pipeline.circuit_breaker.tripped",
      "pipeline.cost.budget_warning"
    ]
  },
  "discord": {
    "enabled": false,
    "bot_token_env": "DISCORD_BOT_TOKEN",
    "channel_id": "...",
    "events": ["..."]
  },
  "slack": {
    "enabled": false,
    "webhook_url_env": "SLACK_WEBHOOK_URL",
    "events": ["..."]
  },
  "webhook_out": {
    "enabled": false,
    "endpoints": [
      {
        "name": "teams-dev",
        "url": "https://...",
        "format": "teams-card",
        "headers": {},
        "events": ["..."]
      }
    ]
  }
}
```

`webhook_secret_env` names an env var holding a single secret. `webhook_secrets_env` names an env var holding a comma-separated list of secrets (any-match) — use this when enrolled projects have distinct per-project secrets. Either may be set; both may be set (union).

### 10. Security

- **Current state:** UI server binds `127.0.0.1` by default (`index.js:11`). No auth on the REST API (localhost bind is the boundary). Inbox accepts unsigned events; control-plane endpoint `PUT /api/webhooks/inbox/control` (`app.js:301`) is unprotected.
- **Obstacle:** Integrations makes chat a control surface (`/stop`, `/pause`). Any hostile localhost process today can spoof events or flip controls. We must protect integrations' own path and offer users a way to close the broader gap.
- **Resolution:**
  - **HMAC verification at the subscriber (§5) is mandatory when integrations is enabled** — spoofed events never reach chat.
  - **Single user, strict allowlist.** `chat_id` / `channel_id` from config is the only allowed *target*. Inbound messages from other chats silently dropped (logged at debug, not echoed back — avoids information disclosure).
  - **Bot tokens via env vars only.** Config holds env var *names*, never secrets. Adapter refuses to start if its env var is unset.
  - **Destructive commands single-step.** `/stop` executes immediately via the allowlisted chat. Users must treat the bot token + phone as equivalent trust to shell access — documented prominently in `docs/spec/integrations/README.md`.
  - **Localhost bind only** — unchanged from today.
  - **Opt-in `strict_inbox_verification`** (§12) — one switch that closes the pre-existing inbox gap for users who want it.
  - **No persistence beyond in-memory ring buffer.** `chat_context.json` holds only per-chat preferences, never message content.

### 11. Per-chat state — `chat_context.json`

- **Current state:** No per-chat state exists.
- **Obstacle:** `/use`, `/mute`, and `/unmute` need to remember per-chat preferences across UI restarts. Storing in UI settings would pollute user config.
- **Resolution:** Dedicated file at `~/.worca/integrations/chat_context.json`. Single UI process owns it; Node's single-threaded event loop serializes read-modify-write naturally — no lock needed. Atomic write via `fs.writeFileSync` to `.tmp` + `fs.renameSync`.

```json
{
  "schema_version": 1,
  "chats": {
    "telegram:123456789": {
      "active_project": "worca-cc",
      "mute_until": "2026-04-16T18:30:00Z",
      "muted_messages": 7
    }
  }
}
```

`chat_id` keys namespaced by platform (`telegram:`, `discord:`, `slack:`). `mute_until` is ISO-8601 UTC; `null` means not muted. `/mute` with no arg sets `"9999-12-31T23:59:59Z"` (indefinite sentinel). `muted_messages` surfaced via `/whoami` and `/api/integrations/status`.

**Crash-safety:** every mutation (mute toggle, use selection, Telegram cursor update) is atomically fsynced before the command reply is sent. Hard-kill loses at most one in-flight update; `getUpdates` re-delivers on next boot. This is why §2 omits a SIGTERM drain.

### 12. Pre-existing inbox security gap — opt-in close-out

- **Current state:** `POST /api/webhooks/inbox` (`app.js:252`) accepts any localhost POST without signature verification. `PUT /api/webhooks/inbox/control` (`app.js:301`) accepts any localhost PUT and sets the control action returned to pipelines. Anything on localhost can (a) spoof events to WebSocket dashboards and (b) flip pipeline control to `pause`/`abort`.
- **Obstacle:** Integrations-level HMAC (§5) protects chat, but WebSocket dashboards and pipeline control responses remain exposed. We promised no breaking changes — we can't enforce inbox HMAC by default.
- **Resolution:** One opt-in config flag: `strict_inbox_verification: true` in `~/.worca/integrations/config.json`. When enabled, the inbox handler AND the control PUT handler both require a valid signature matching one of the configured secrets. Unsigned requests get `401`.

```js
// worca-ui/server/app.js — only active when strict_inbox_verification: true
if (app.locals.integrations?.strictInboxVerification) {
  if (!verify(rawBody, req.headers['x-worca-signature'], app.locals.integrations.secrets)) {
    return res.status(401).json({ ok: false, error: 'bad_signature' });
  }
}
// ...existing handler code unchanged
```

**Default is `false`** — users who upgrade without enabling integrations, or who enable integrations but don't opt into strict mode, see zero change from today. Integrations still works (chat path has its own HMAC check). Strict mode is advertised as recommended for multi-user machines, shared dev boxes, CI runners with shared localhost, and any environment where untrusted local software may run.

**When users flip `strict_inbox_verification: true`**, every pipeline posting to the inbox must sign with a secret that matches one of the configured integration secrets. Because pipelines already sign when `worca.webhooks[].secret` is set, the user action is: (a) ensure every project's settings has a secret, (b) enroll all those secrets via `WORCA_WEBHOOK_SECRET(S)`. Documented in `docs/spec/integrations/README.md`.

Asymmetry worth calling out to users: integrations can faithfully report *real* pipeline interruptions caused by control-plane tampering — the symptom shows up in chat as a legitimate `pipeline.run.interrupted` event. Without strict mode, you get accurate symptoms but can't tell induced from organic. Strict mode closes that loop.

### 13. Commands to REST — loopback HTTP

- **Current state:** Route handlers at `project-routes.js:213,435,624,640,679,1249` are coupled to Express `(req, res)` closures. No service layer exists.
- **Obstacle:** Integrations commands need to invoke these endpoints. Extracting a service layer is an internal refactor risk (touches existing code); we promised no breaking changes.
- **Resolution:** Integrations calls the UI's own REST API via loopback HTTP. Zero change to route code.

```js
// worca-ui/server/integrations/rest_client.js
export function createRestClient({ host, port }) {
  const base = `http://${host}:${port}`;
  return {
    async get(path) {
      const r = await fetch(`${base}${path}`);
      return { status: r.status, data: r.ok ? await r.json() : null };
    },
    async post(path, body) {
      const r = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      return { status: r.status, data: r.ok ? await r.json() : null };
    },
  };
}
```

Overhead is ~1 TCP round-trip on loopback — imperceptible for chat commands (commands are interactive-latency workloads, not hot-path). Security relies on the UI's existing localhost-bind boundary, same as any browser client.

### 14. Status endpoint & Python CLI carve-out

- **Current state:** `src/worca/cli/main.py` registers existing subcommands. Headless users without a browser can't check integrations health.
- **Obstacle:** Forcing headless users to `curl http://127.0.0.1:3400/api/integrations/status | jq` is ugly.
- **Resolution:**
  - **UI side:** new route `GET /api/integrations/status` returning:
    ```json
    {
      "enabled": true,
      "strict_inbox_verification": false,
      "secrets_configured": 2,
      "adapters": [
        {"name": "telegram", "enabled": true, "connected": true, "dropped_messages": 0, "invalid_signature_events": 0, "last_event_at": "2026-04-16T15:22:09Z"},
        {"name": "discord", "enabled": false}
      ],
      "chats": [
        {"platform": "telegram", "chat_id": "123***789", "active_project": "worca-cc", "muted_until": null, "muted_messages": 7}
      ]
    }
    ```
  - **CLI side:** `worca integrations status` in `src/worca/cli/main.py` — ~30 lines. Uses `urllib.request` (stdlib, no new dep). Hits `http://127.0.0.1:3400/api/integrations/status` (configurable via `WORCA_UI_URL` env). Formats a table. Errors cleanly if the UI isn't running.

No other `worca integrations` subcommands exist. `start`/`stop`/`install-service` are the UI server's existing commands — integrations has no separate lifecycle.

## Implementation Plan

### Phase 1 — Foundation
**Files:** `worca-ui/server/app.js`, `worca-ui/server/index.js`, `worca-ui/server/integrations/{index,adapter,chat_context,rate_limiter,renderers,verify,rest_client,allowlist}.js`

1. Add single-line `app.locals.integrations?.onEvent(stored)` call to inbox handler (§1). Existing behavior unchanged.
2. Pass raw body through `Symbol`-keyed channel on `stored` so subscriber can verify HMAC.
3. `createIntegrations` factory: loads config, boots adapters, wires `webhookInbox` subscription, exposes `onEvent`, `status`, `strictInboxVerification`, `secrets`.
4. `chat_context.js` — atomic read/write, namespaced keys, `get(chatId)` / `set(chatId, partial)`.
5. `rate_limiter.js` — token bucket per adapter, ring buffer of sent messages, `dropped_messages` counters.
6. `renderers.js` — Tier 1 event → `NormalizedMessage` with tests.
7. `verify.js` — any-match HMAC verification over a secret set.
8. `rest_client.js` — loopback HTTP helpers.
9. `allowlist.js` — chat-ID allowlist guard.
10. Config loader + validator extension for `~/.worca/integrations/config.json`.

### Phase 2 — Command parser + handlers
**Files:** `worca-ui/server/integrations/commands/{index,parser,global,project,control}.js`

1. Parser: tokenize, strip bot mentions, dispatch by first token.
2. Global handlers: `/start /help /whoami /projects /use /active /mute /unmute`.
3. Project-scoped read handlers: `/status /runs /last /cost /pr` — via `rest_client`.
4. Control handlers: `/pause /resume /stop` — via `rest_client`.
5. Auto-select single-project logic.
6. `run_id` disambiguation replies.

### Phase 3 — Telegram adapter
**Files:** `worca-ui/server/integrations/adapters/telegram.js`

1. `getUpdates` long-poll loop with cursor at `~/.worca/integrations/telegram.cursor` (fsynced per update).
2. `sendMessage` (HTML parse_mode) with `429`/`retry_after` handling.
3. `NormalizedMessage` → Telegram HTML renderer.

### Phase 4 — Outbound-only Discord, Slack, generic webhook
**Files:** `worca-ui/server/integrations/adapters/{discord,slack,webhook_out}.js`

1. Discord: `POST /channels/{id}/messages`, markdown renderer.
2. Slack: incoming webhook URL POST, `mrkdwn` renderer.
3. Generic webhook: 6 payload templates, optional headers, per-endpoint event filters.

### Phase 5 — Strict inbox verification
**Files:** `worca-ui/server/app.js`, `worca-ui/server/integrations/index.js`

1. When `strict_inbox_verification: true`, gate the inbox `POST` and control `PUT` handlers on `verify()` using the configured secrets.
2. Unsigned or bad-sig requests get `401`.
3. Default `false` — nothing changes for users who don't opt in.

### Phase 6 — Status endpoint + Python CLI
**Files:** `worca-ui/server/app.js`, `src/worca/cli/main.py`, `tests/test_cli_integrations_status.py`

1. UI: `GET /api/integrations/status` route.
2. Python: `worca integrations status` subcommand via `urllib`.

### Phase 7 — Tests + docs
1. Unit tests per JS module (vitest).
2. Integration tests: signed event POST → adapter `send()` asserted.
3. Manual E2E checklist for real Telegram test bot.
4. `docs/spec/integrations/README.md` and `README.md` section.

## Considerations

### Breaking changes
**None.** Specifically:
- Inbox handler (`app.js:252`) gains one optional call; default accept behavior, response shape, and ring-buffer semantics unchanged.
- `strict_inbox_verification` defaults to `false`. Users who don't opt in see no enforcement change.
- No existing route code modified. No existing test expectations changed.
- No new npm dependencies. No Node engine bump (native `fetch` since 18; already required).
- No changes to `.claude/settings.json` schema.
- SIGTERM behavior unchanged (crash-safe state eliminates the need for a drain).

### Trade-offs
- **Integrations lifecycle coupled to UI server.** If the UI is down, no notifications. Mitigated: headless users can run `pnpm worca:ui -- --host 127.0.0.1` with no browser, treating the UI as a long-running events service.
- **Release cadence coupled to `@worca/ui`.** Fine — UI releases are frequent.
- **Telegram-only inbound in v1.** Discord/Slack inbound (Gateway/Socket Mode) is a follow-up plan.
- **Destructive commands single-step.** Allowlist + bot token = the trust boundary. Documented prominently.
- **Pre-existing inbox gap stays open by default.** Closed by `strict_inbox_verification: true`. Explicit opt-in avoids breaking existing users.
- **Loopback HTTP for commands adds one TCP round-trip.** Imperceptible for chat workloads.

### Migration
- None — greenfield feature. Existing `worca.webhooks` config continues to work unchanged.

### Governance
- Integrations module **does not** run git, write source files, or call `bd`. It calls the UI's REST API via loopback (which itself enforces governance on pipeline actions) and makes outbound HTTPS to platform APIs. No pre/post tool-use hooks apply.

### Failure isolation
- Per-adapter try/catch boundaries plus a process-level `uncaughtException` handler (log to `console.error`, continue).
- Adapter failures increment per-adapter `failed_sends` surfaced in `/status`.
- UI server continues serving dashboards and REST traffic even if every adapter crashes.

### Dependencies
- Telegram adapter: native `fetch`. ~150 LOC.
- Discord adapter: native `fetch`. ~100 LOC.
- Slack adapter: native `fetch`. ~80 LOC.
- Generic webhook: native `fetch`. ~120 LOC.
- No new `package.json` dependencies.

### UI surface
- Out of scope for v1. Follow-up plan: "Integrations" panel showing per-adapter state, dropped/muted counts, last event, strict-mode toggle.

## Test Plan

### Unit tests (vitest)
| Layer | Test | Validates |
|---|---|---|
| JS | `verify.test.js` | Valid sig → true; bad sig → false; missing header → false; any-of-N match works |
| JS | `app-inbox-unchanged.test.js` | Unsigned POST to inbox still returns 200 when strict=off |
| JS | `app-inbox-strict.test.js` | With strict=on: valid sig → 200; bad sig → 401; missing → 401 |
| JS | `app-inbox-control-strict.test.js` | Control PUT with strict=on requires signature |
| JS | `renderers.test.js` per event | Each Tier 1 event renders to expected `NormalizedMessage` |
| JS | `adapters/telegram.test.js` | Segments → valid Telegram HTML |
| JS | `adapters/discord.test.js` | Segments → valid Discord markdown |
| JS | `adapters/slack.test.js` | Segments → valid `mrkdwn` |
| JS | `adapters/webhook_out.test.js` per template | `teams-card`, `ntfy`, `slack-compatible` payloads valid |
| JS | `commands/parser.test.js` | `/status W-042` → `("status", ["W-042"])`; `@bot /status` → same |
| JS | `chat_context.test.js` | Atomic write survives rapid successive writes; namespaced keys distinct |
| JS | `commands/global.test.js` — `test_use_persists_active_project` | `/use foo` → context file updated |
| JS | Same — `test_use_rejects_unknown_project` | `/use nonexistent` → error, unchanged |
| JS | Same — `test_auto_select_single_project` | One project → auto-selected on first command |
| JS | Same — `test_mute_blocks_outbound` | Mute set → `send` not called, `muted_messages` incremented |
| JS | Same — `test_mute_expires_after_duration` | `/mute 1h` + 61m advance → outbound resumes |
| JS | `commands/project.test.js` — `test_scoped_cmd_requires_active` | No active project, multi registered → helpful error |
| JS | Same — `test_status_invokes_rest_endpoint` | `/status` issues GET to `/api/projects/:id/runs/:runId/status` |
| JS | `commands/control.test.js` — `test_pause_unique_active_run` | `/pause` with one active → pauses |
| JS | Same — `test_pause_multi_disambiguates` | Multiple active → disambiguation reply, no REST call |
| JS | Same — `test_stop_invokes_rest_endpoint` | `/stop W-042` → POST to `/runs/W-042/stop` |
| JS | `rate_limiter.test.js` — `test_drops_oldest_on_overflow` | Overflow increments `dropped_messages` |
| JS | Same — `test_429_backoff` | Platform 429 triggers exponential backoff |
| JS | `allowlist.test.js` — `test_drops_unknown_chat` | Inbound from non-allowlisted chat silently dropped |
| JS | `integrations-onevent-invalid-sig.test.js` | Unsigned event reaches `onEvent` → dropped, `invalid_signature_events++` |
| JS | `app-integrations-status.test.js` | `GET /api/integrations/status` returns expected shape |
| Python | `tests/test_cli_integrations_status.py` | `worca integrations status` HTTP-probes and formats output |

### Integration tests (vitest)
- Signed webhook POST → full integrations pipeline → assert adapter `send()` called with expected rendered message.
- Unsigned webhook POST → inbox accepts (200) → integrations drops → no `send()` call.
- Simulated Telegram `/pause W-042` → parser → loopback REST → mocked `pauseRun` → reply formatted.
- `/use worca-cc` then `/status` → assert loopback GET scoped to `worca-cc`.
- `/mute 5m` → emit event → assert `send` not called → advance clock → assert resumed.

### E2E (manual)
- Real Telegram test bot: start pipeline, assert all 7 Tier 1 events arrive. Send each of the 16 commands, verify replies.
- Discord: POST test event via `curl` to signed inbox → message in channel.
- Slack: same.
- Generic webhook: each template, verify payload matches target platform's expected schema.
- Flip `strict_inbox_verification: true` → verify unsigned POSTs get 401.

### Existing tests to update
- None required. `worca-ui/server/app-webhooks.test.js` posts without signatures; continues to pass because strict mode is off by default.

## Files to Create/Modify

| File | Change |
|---|---|
| `worca-ui/server/app.js` | Add `app.locals.integrations?.onEvent(stored)` call + `RAW_BODY` Symbol passthrough in inbox handler; gate on strict mode for inbox POST and control PUT; add `GET /api/integrations/status` route |
| `worca-ui/server/index.js` | Construct integrations module after app; assign to `app.locals.integrations` |
| `worca-ui/server/integrations/index.js` | `createIntegrations` factory |
| `worca-ui/server/integrations/adapter.js` | JSDoc typedefs |
| `worca-ui/server/integrations/verify.js` | HMAC any-match verification |
| `worca-ui/server/integrations/chat_context.js` | Per-chat state store |
| `worca-ui/server/integrations/rate_limiter.js` | Token bucket + ring buffer |
| `worca-ui/server/integrations/renderers.js` | Tier 1 event → `NormalizedMessage` |
| `worca-ui/server/integrations/allowlist.js` | Chat-ID allowlist guard |
| `worca-ui/server/integrations/rest_client.js` | Loopback HTTP client |
| `worca-ui/server/integrations/commands/index.js` | Command dispatch entry |
| `worca-ui/server/integrations/commands/parser.js` | Tokenization, mention stripping |
| `worca-ui/server/integrations/commands/global.js` | `/start /help /whoami /projects /use /active /mute /unmute` |
| `worca-ui/server/integrations/commands/project.js` | `/status /runs /last /cost /pr` |
| `worca-ui/server/integrations/commands/control.js` | `/pause /resume /stop` |
| `worca-ui/server/integrations/adapters/telegram.js` | Telegram (two-way) |
| `worca-ui/server/integrations/adapters/discord.js` | Discord (outbound only) |
| `worca-ui/server/integrations/adapters/slack.js` | Slack (outbound only) |
| `worca-ui/server/integrations/adapters/webhook_out.js` | Generic outbound |
| `worca-ui/server/settings-validator.js` | Add `~/.worca/integrations/config.json` schema |
| `worca-ui/server/integrations/*.test.js` | Unit tests (one per module) |
| `worca-ui/server/app-inbox-unchanged.test.js` | Verifies non-strict path preserves current behavior |
| `worca-ui/server/app-inbox-strict.test.js` | Verifies strict path rejects unsigned |
| `worca-ui/server/app-integrations-status.test.js` | Status endpoint test |
| `src/worca/cli/main.py` | Add `worca integrations status` subcommand |
| `tests/test_cli_integrations_status.py` | Python CLI test |
| `docs/spec/integrations/README.md` | User-facing setup docs, including strict-mode guidance |
| `README.md` | Add integrations section |

## Out of Scope

- `/run` (starting new work from chat) — v2. Needs prompt/source/plan/branch args, budget confirmation — deserves its own design call.
- `/logs [run_id] [N]` — v2. Log-line width doesn't fit chat; needs truncation/pagination/pastebin design.
- `/plan [run_id]` — v2.
- `/subscribe /unsubscribe` — v2. Runtime event-filter mutation needs a clobber-safe overrides layer.
- Inline action buttons / interactive replies (Telegram inline keyboards, Slack Block Kit, Discord components) — v2.
- **Discord and Slack inbound (Gateway / Socket Mode WSS)** — v2 follow-up.
- Tier 2/Tier 3 events as defaults — users may add via per-adapter `events` array.
- WhatsApp, iMessage, Signal — not feasible at Tier 1 effort.
- Multi-user support with per-user subscription tiers — single-user only in v1.
- UI panel for integrations status — follow-up plan.
- Persistence of delivery history beyond in-memory ring buffer.
- Per-project integrations config (different bot per project) — intentionally global-only in v1.
- Enforcing inbox HMAC by default — v2 or later, once ecosystem migration cost is well-understood. Strict mode is the opt-in close-out for users who want it now.
- Separate Python daemon / `worca integrations start|stop|install-service` — obsoleted by module-in-UI architecture; only `worca integrations status` remains in Python.
