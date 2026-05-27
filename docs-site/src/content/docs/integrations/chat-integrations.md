---
title: Chat integrations
description: Send run notifications to Telegram, Discord, Slack, or a generic webhook.
sidebar:
  order: 3
---

Chat integrations turn the event stream into readable messages in your team's chat. worca ships adapters for **Telegram**, **Discord**, **Slack**, and a **generic webhook**.

## The Integrations panel

The dashboard's **Integrations** tab is a card catalog — one card per adapter with a live connection-health badge (polled every 10s while the tab is open), an enable/disable toggle, and Edit/Remove buttons. Adding or updating a project also auto-configures its outbound webhook so events route correctly with no manual wiring.

:::note[Screenshot — coming soon]
The Integrations card catalog: Telegram connected, Discord and Slack configured.
:::

## Config file

Chat adapters are configured at `~/.worca/integrations/config.json` (global, applies across projects):

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

## Secrets go in env vars

Secrets are **never** inlined. Every credential is referenced by the name of an environment variable — the `*_env` keys (`bot_token_env`, `webhook_secret_env`). The config validator rejects a config that inlines a token. Set the actual value in your environment, and the adapter reads it at send time.

## What gets sent

Adapters render a **curated subset** of events into chat messages — not the full firehose. The default set centers on the moments a human cares about: run completed / failed / interrupted, PR created / merged, circuit breaker tripped, and budget warnings. The per-adapter `events` filter narrows it further.

:::tip
Want a high-volume event (like every stage transition) in chat? It needs a renderer entry as well as an `events` match. Adding a new chat-notifiable event is what the `/worca-event-add` skill handles.
:::
