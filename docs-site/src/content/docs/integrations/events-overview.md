---
title: Events overview
description: The event stream worca emits, and the two ways to subscribe to it.
sidebar:
  order: 1
---

Everything the pipeline does emits a structured **event** — a run starting, a stage completing, a PR opening, a circuit breaker tripping. Around 80 event types flow through one dispatch system, and you subscribe to them in one of two ways.

## Event domains

Event types are dotted strings, grouped by domain:

| Domain | Covers |
|---|---|
| `pipeline.*` | A single run: lifecycle, stages, agents, beads, git, tests, review, cost, hooks. |
| `control.*` | Inbound control signals — pause / resume / abort a run from outside. |
| `fleet.*` | Fleet-level lifecycle across a fan-out. |
| `workspace.*` | Workspace-level lifecycle, tiers, integration tests, umbrella issue. |

The complete catalog is in the [Events reference](/reference/events/).

## The envelope

Every event is wrapped in a consistent envelope, so a subscriber can route on `event_type` and dedupe on `event_id` without parsing the payload:

```jsonc
{
  "schema_version": 1,
  "event_id": "<uuid>",
  "event_type": "pipeline.run.completed",
  "timestamp": "2026-05-21T14:32:01.123Z",
  "run_id": "<run_id>",
  "pipeline": { /* run context */ },
  "payload": { /* event-specific fields */ }
}
```

## Two ways to subscribe

| Mechanism | Best for | Configured in |
|---|---|---|
| **[Webhooks](/integrations/webhooks/)** | Programmatic integrations — CI, dashboards, paging, custom automation. Optional HMAC signing; can even pause/abort a run from the response. | `worca.webhooks` in `settings.json` (or the Webhooks panel). |
| **[Chat integrations](/integrations/chat-integrations/)** | Human notifications in Telegram, Discord, Slack, or a generic webhook. | `~/.worca/integrations/config.json` (or the Integrations panel). |

Webhooks deliver the raw event to any URL. Chat integrations render a curated subset of events into readable chat messages.
