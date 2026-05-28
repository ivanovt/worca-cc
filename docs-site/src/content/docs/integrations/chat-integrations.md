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

:::note[Screenshot — coming soon]
The Integrations card catalog: Telegram connected, Discord and Slack configured.
:::

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
