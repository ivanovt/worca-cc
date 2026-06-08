---
title: Chat integrations
description: Send run notifications to Telegram, Discord, Slack, or a generic webhook.
sidebar:
  order: 3
---

Chat integrations turn the event stream into readable messages in your team's chat. worca ships adapters for **Telegram**, **Discord**, **Slack**, and a **generic webhook**.

## Set them up in the Integrations panel

The dashboard's **Integrations** tab is where you add and manage adapters — no JSON to hand-edit. It's a card catalog: one card per adapter with a live connection-health badge (polled every 10s while the tab is open), an enable/disable toggle, and Edit/Remove buttons.

To add one, open **Integrations → Add**, pick the adapter (Telegram / Discord / Slack / generic webhook), set its chat target, and choose the event filter. Credentials are entered through the [Secrets](/configuration/secrets/) panel rather than typed into the config — see below. Adding or updating a project also auto-configures its outbound webhook, so events route correctly with no manual wiring.

![The Integrations card catalog: Telegram connected, Discord and Slack configured.](/screenshots/chat-integrations/01-catalog.png)

## Secrets stay out of the config

Adapter credentials are **never** inlined. Each is referenced by the name of an environment variable — the `*_env` keys (`bot_token_env`, `webhook_secret_env`) — and the validator rejects a config that inlines a token. Set the values through the dashboard's **Secrets** panel (it writes them to the gitignored `settings.local.json`); the adapter reads them at send time. See [Secrets](/configuration/secrets/).

## Under the hood: the config file

The Integrations panel writes a global config at `~/.worca/integrations/config.json` (applies across projects). You rarely touch it by hand, but the shape is worth knowing if you're scripting it or reviewing a diff:

```jsonc
{
  "schema_version": 1,
  "enabled": true,
  "webhook_secret_env": "WORCA_WEBHOOK_SECRET",
  "adapters": {
    "telegram": {
      "enabled": true,
      "bot_token_env": "TELEGRAM_BOT_TOKEN",
      "chat_id": "123456789",
      "rate_limit_per_min": 20,
      "events": ["pipeline.run.completed", "pipeline.run.failed", "pipeline.git.pr_merged"]
    }
  }
}
```

`discord`, `slack`, and `webhook_out` follow the same shape. Each adapter takes its own `events` filter and a `rate_limit_per_min`.

## What gets sent

Adapters render a **curated subset** of events into chat messages — not the full firehose. The default set centers on the moments a human cares about: run completed / failed / interrupted, PR created / merged, circuit breaker tripped, and budget warnings. The per-adapter `events` filter narrows it further.

:::tip
Narrow what each adapter posts with its `events` filter — e.g. only `pipeline.run.*` plus `pipeline.git.pr_merged` for a channel that just wants outcomes, not every stage transition.
:::

## Send ad-hoc messages with `/worca-notify`

Pipeline events fan out automatically through the adapters above. For everything else — *"notify me when CI is green"*, *"ping me on Telegram with the comparison summary"*, *"alert me via Slack when X fails"* — the **`/worca-notify`** skill sends through the same allowlist + rate-limiter + adapter pipeline, so messages render natively per-platform (HTML on Telegram, Markdown on Discord, mrkdwn on Slack) without any raw API calls.

In a Claude Code session in your project, trigger it by command or with a natural phrase:

```
/worca-notify
```

Or just say:

- *"notify me when the deploy lands"*
- *"ping me on Telegram when CI is green"*
- *"send a chat message with the comparison summary"*
- *"alert me via Slack when the smoke test fails"*

The skill **does not** fire on bare conversational phrases like *"tell me when…"* or *"let me know what happens"* — those keep the conversation going in your terminal instead.

### What it does

The skill runs a small Node shim at `.claude/skills/worca-notify/send.mjs` that POSTs to the worca-ui server's `/api/integrations/send` endpoint. The server constructs a `NormalizedMessage`, dispatches it through `integrations.sendOutbound(...)`, and runs the same per-adapter rendering, allowlist gate, and rate limiter the event fan-out uses. Per-platform results come back as `{platform, ok, error?}` entries, redacted of any leaked tokens.

Default targets are **every chat adapter currently enabled** in your Integrations panel. Pass `--platform telegram` (repeatable) to narrow the send. The skill never silently skips a named-but-disabled platform — you get an explicit per-platform error instead, so a misconfigured adapter doesn't quietly swallow the notification.

### Common shapes

```bash
# Short message, defaults to all enabled adapters
node .claude/skills/worca-notify/send.mjs \
  --title "Build green" \
  --severity success \
  --text "CI for branch worca/foo-bar passed in 4m 12s."

# Multi-line body via stdin, Telegram only
cat <<'EOF' | node .claude/skills/worca-notify/send.mjs \
    --title "Comparison results" --severity info --platform telegram
GLM-DS #1: 6.5/10
GLM-DS #2: 8.3/10
Anthropic #1: 8.7/10
EOF
```

Severity is one of `info` / `success` / `warning` / `error` and surfaces per-platform (color blocks on Slack, emoji on Telegram). Exit codes: `0` if at least one platform succeeded, `1` if every send failed, `2` for caller errors.

### Requirements

The skill talks to the worca-ui server over loopback HTTP, so a few server configurations cause it to fail with a **terminal** status (not retryable):

| UI server state | Skill result | Fix |
|---|---|---|
| Not running | `cannot reach worca-ui server` | Start it: `pnpm worca:ui` |
| Single-project mode (`--project <path>`) | `HTTP 503 — integrations subsystem not initialized` | Restart in **global mode**: `pnpm worca:ui` with no `--project` flag |
| Non-loopback bind (`HOST=0.0.0.0`, `--host <public-ip>`) | `HTTP 403 — send endpoint is restricted to loopback binds` | Restart on a loopback bind (the default `127.0.0.1`) |
| Integrations subsystem `enabled: false` in config | `HTTP 503 — integrations subsystem disabled in config` | Enable via the **Integrations** panel and configure ≥1 adapter |

The loopback restriction is intentional: the UI server has no per-request auth, and exposing user-addressable chat to the LAN/internet would let any reachable host ping the configured Telegram/Discord/Slack channel.

### Composing with autonomy primitives

The skill is a one-shot send. Pair it with the autonomy primitives to build asynchronous monitoring:

- **`/loop 5m <check + notify>`** — recurring condition check that pings when state changes.
- **`ScheduleWakeup` + `/worca-notify`** — one-shot timed notification (*"ping me in 30 min if the deploy hasn't started"*).
- **`/schedule` + `/worca-notify`** — recurring cron-driven summary delivered to chat.

For the full argument list (`--chat-id` override, `--ui-port`, `--ui-host`, etc.) see the in-repo skill manifest at `src/worca/skills/worca-notify/SKILL.md`.
