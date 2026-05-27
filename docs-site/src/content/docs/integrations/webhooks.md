---
title: Webhooks
description: Deliver pipeline events to any URL, with optional HMAC signing and control responses.
sidebar:
  order: 2
---

A **webhook** POSTs every matching event to a URL you control. The simplest way to add one is the dashboard.

## The Webhooks panel

Open **Settings → Webhooks**. The panel lets you toggle the event system, set budget limits, add subscriber URLs, choose which events each one receives, and turn on HMAC-SHA256 signing — all without touching JSON. Saves take effect on the next run.

:::note[Screenshot — coming soon]
The Webhooks settings panel: event-system toggle, budget limits, and a subscriber row with its event filter and signing secret.
:::

## What it writes

Behind the panel, subscribers live under `worca.webhooks` in settings. The shape is worth knowing if you're scripting it or reviewing a diff:

```jsonc
"worca": {
  "webhooks": [
    {
      "url": "https://example.com/hook",
      "secret": "base64-encoded-secret",
      "timeout_ms": 5000,
      "max_retries": 3,
      "events": ["pipeline.run.completed", "pipeline.run.failed"]
    }
  ]
}
```

The `events` array accepts fnmatch patterns — `pipeline.run.*`, `workspace.*`, or a bare `*`. Omit it (or set `null`) to receive everything.

:::tip
The signing secret belongs in `settings.local.json`, not the committed `settings.json`. The panel's secret field routes there automatically — see [Secrets](/configuration/secrets/).
:::

## Delivery headers

Each POST carries headers you can route and verify on:

| Header | Value |
|---|---|
| `X-Worca-Event` | the `event_type` string |
| `X-Worca-Delivery` | the `event_id` (UUID) — use it to dedupe |
| `X-Worca-Signature` | `sha256=<hex>` — present only when a secret is set |

## Verifying the signature

When a secret is configured, worca signs the body with HMAC-SHA256 and sends it in `X-Worca-Signature`. Verify it with a **timing-safe** comparison — recompute the HMAC over the raw request body with your shared secret and compare against the header. Never compare with a plain `==`.

## Control webhooks

A webhook can also *steer* the run. Set both `"control": true` and a `"secret"` (required for control mode). The pipeline calls control webhooks **synchronously** at milestones and reads an action from the response body:

```jsonc
{ "control": { "action": "pause" } }
```

The action is `pause`, `abort`, or `continue` — letting an external system gate the pipeline, for example holding a run until a deploy window opens.

:::tip[Verifying delivery]
Point a new subscriber at an endpoint you control (or a request inspector) and launch a short run. Each POST carries `X-Worca-Delivery` (the event ID) so you can confirm receipt and dedupe, and `X-Worca-Signature` so you can validate your HMAC verification end-to-end.
:::
