---
name: worca-notify
description: Send a chat notification through the worca-ui server's integrations subsystem (Telegram, Discord, Slack) using each platform's adapter — proper rendering (HTML / Markdown / mrkdwn), allowlist enforcement, rate limiting, and no raw API calls. Use when the user wants an out-of-band notification rather than a synchronous response. Triggers on `/worca-notify`, "notify me when X", "ping me when X", "send a chat message", "send a notification", "alert me via <platform>", or any phrase that names a chat platform ("via Telegram", "on Slack", "in Discord"). Does NOT fire on bare "tell me when…" or "let me know when…" — those are conversational and the user typically wants a sync answer.
---

# Worca Notify

Send a chat notification through the established adapter pipeline — the same path worca pipeline events take, so messages render natively per-platform (HTML on Telegram, Markdown on Discord, mrkdwn on Slack) and go through allowlist + rate limiter.

**Use this when the user asks for an asynchronous ping**, not a synchronous response:
- "Notify me when CI is green"
- "Ping me on Telegram when the deploy lands"
- "Send a chat message with the comparison summary"
- "Alert me via Slack when X fails"

**Do NOT use** for synchronous conversational asks:
- "Tell me when this finishes" → answer in chat directly
- "Let me know what happens" → keep the conversation going
- "Remind me to X" → use the `/schedule` skill (cron) or `ScheduleWakeup` (one-shot)

## Usage

The skill ships a Node script at `.claude/skills/worca-notify/send.mjs`. Invoke it from a Bash tool call:

```bash
node .claude/skills/worca-notify/send.mjs \
  --title "Build green" \
  --severity success \
  --text "CI for branch worca/foo-bar passed in 4m 12s. PR #251 is ready to merge."
```

Or pipe a long body via stdin (preferred for multi-line content):

```bash
cat <<'EOF' | node .claude/skills/worca-notify/send.mjs --title "Comparison results" --severity info
GLM-DS #1: 6.5/10
GLM-DS #2: 8.3/10
Anthropic #1: 8.7/10
Anthropic #2: 8.5/10
EOF
```

## Arguments

| Flag | Required | Default | Description |
|---|---|---|---|
| `--title <str>` | no | `null` | Bold first line; renders as a header per-platform. |
| `--text <str>` | no\* | — | Message body as plain text. Mutually exclusive with stdin. |
| (stdin) | no\* | — | Multi-line body. Read when `--text` is omitted. |
| `--severity <level>` | no | `info` | `info` / `success` / `warning` / `error`. Adapters surface this with color or emoji. |
| `--platform <name>` | no | (all enabled) | Repeatable. Send to specific adapter(s) only. Errors if the named platform isn't enabled. |
| `--chat-id <str>` | no | (configured) | Override the configured chat_id for one-off sends. Must be on the platform's allowlist. |
| `--ui-port <int>` | no | `3400` | Port of the running worca-ui server. |
| `--ui-host <host>` | no | `127.0.0.1` | Host of the running worca-ui server. |

\* At least one of `--text` or stdin must provide a body. Empty bodies are rejected (cheap guard against unsubstituted-variable bugs in `/loop`-driven sends).

## Output

Prints one line per platform:

```
  ok    telegram  — sent
  ok    discord   — sent
  fail  slack     — platform not enabled or not configured
```

Exit code: `0` if at least one platform succeeded; `1` if every send failed; `2` for caller errors (missing body, malformed args, UI server unreachable).

## What the skill does NOT do

- **Does not enable disabled adapters.** If you ask for `--platform slack` and Slack is `enabled: false` in `~/.worca/integrations/config.json`, the send fails with a clear error. Enable it via the UI Integrations panel first.
- **Does not bypass the allowlist.** The same `createAllowlistGuard` that protects the inbound command surface gates outbound sends.
- **Does not retry on its own.** Per-platform retry-on-429 (Telegram) and rate-limiter backoff are handled by the adapters; the skill is a one-shot.
- **Does not echo secrets.** Bot tokens and webhook URLs never appear in stdout or stderr, including error messages.

## Composing with autonomy primitives

- `/loop 5m <check + notify>` — recurring condition checks that ping when state changes.
- `ScheduleWakeup` + this skill — one-shot timed notifications ("ping me in 30 min if the deploy hasn't started").
- `/schedule` + this skill — recurring cron-driven summaries delivered to chat.

## Implementation

The skill hits `POST /api/integrations/send` on the running worca-ui server, which constructs a `NormalizedMessage` and dispatches it through `integrations.sendOutbound({platforms, message, chatIdOverride})` in `worca-ui/server/integrations/index.js`. That function runs the same allowlist + rate-limiter + adapter pipeline as the worca event fan-out path.

Requires the worca-ui server to be running. Start it from the project root with `pnpm worca:ui` (or check it's already up on port 3400).
