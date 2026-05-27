---
title: Webhooks
description: Deliver pipeline events to any URL, with optional HMAC signing and control responses.
sidebar:
  order: 2
---

A **webhook** POSTs every matching event to a URL you control. Configure subscribers from the **Webhooks** settings panel, or directly under `worca.webhooks` in `settings.json`.

## Subscriber config

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
Put the `secret` in `settings.local.json`, not the committed `settings.json`. See [Secrets](/configuration/secrets/).
:::

## Delivery headers

Each POST carries headers you can route and verify on:

| Header | Value |
|---|---|
| `X-Worca-Event` | the `event_type` string |
| `X-Worca-Delivery` | the `event_id` (UUID) — use it to dedupe |
| `X-Worca-Signature` | `sha256=<hex>` — present only when a `secret` is set |

## Verifying the signature

When a `secret` is configured, worca signs the body with HMAC-SHA256 and sends it in `X-Worca-Signature`. Verify it with a **timing-safe** comparison — recompute the HMAC over the raw request body with your shared secret and compare against the header. Never compare with a plain `==`.

## Control webhooks

A webhook can also *steer* the run. Set both `"control": true` and a `"secret"` (required for control mode). The pipeline calls control webhooks **synchronously** at milestones and reads an action from the response body:

```jsonc
{ "control": { "action": "pause" } }   // "pause" | "abort" | "continue"
```

This lets an external system gate the pipeline — for example, holding a run until a deploy window opens.

:::tip[Testing without a run]
Use the `/worca-webhook-test` skill to sign and POST a synthetic event to your URL — it verifies HMAC, reachability, and (for control webhooks) the control-action response, without launching a pipeline.
:::
