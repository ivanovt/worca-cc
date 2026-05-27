---
title: Events reference
description: The full catalog of event types worca emits.
sidebar:
  order: 4
---

Every event worca emits, by domain. See [Events overview](/integrations/events-overview/) for the envelope and how to subscribe. The source of truth is `src/worca/events/types.py` in the repo.

## `pipeline.*` — a single run

### `pipeline.run.*` — run lifecycle
`started`, `completed`, `failed`, `interrupted`, `cancelled`, `resumed`, `paused`, `resumed_from_pause`

### `pipeline.stage.*` — per-stage lifecycle
`started`, `completed`, `failed`, `interrupted`

### `pipeline.agent.*` — agent telemetry (high volume)
`spawned`, `tool_use`, `tool_result`, `text`, `completed`

### `pipeline.bead.*` — task tracker
`created`, `assigned`, `completed`, `failed`, `labeled`, `next`

### `pipeline.git.*` — git operations
`branch_created`, `commit`, `pr_created`, `pr_merged`

### `pipeline.test.*` — test loop
`suite_started`, `suite_passed`, `suite_failed`, `fix_attempt`

### `pipeline.review.*` — review loop
`started`, `verdict`, `fix_attempt`

### `pipeline.circuit_breaker.*` — error classification
`failure_recorded`, `retry`, `tripped`, `reset`

### `pipeline.cost.*` — cost/token telemetry
`stage_total`, `running_total`, `budget_warning`

### `pipeline.milestone.*`, `pipeline.loop.*` — control plane
`milestone.set`, `loop.triggered`, `loop.exhausted`

### `pipeline.hook.*` — governance telemetry
`blocked`, `test_gate`, `dispatch_blocked`, `dispatch_allowed`

### `pipeline.preflight.*`, `pipeline.learn.*`
`preflight.completed`, `preflight.skipped`, `learn.completed`, `learn.failed`

## `control.*` — inbound control signals
`control.milestone.approve`, `control.pipeline.pause`, `control.pipeline.resume`, `control.pipeline.abort`

External systems use these (typically a [control webhook](/integrations/webhooks/) response) to steer a run.

## `fleet.*` — fleet runs
`fleet.launched`, `fleet.halted`, `fleet.completed`, `fleet.failed`, `fleet.circuit_breaker.tripped`

## `workspace.*` — workspace runs
`launched`, `completed`, `failed`, `halted`, `paused`, `resumed`, `circuit_breaker.tripped`, `guide_conflict`

Plan: `plan.started`, `plan.completed`, `plan.failed`, `plan.loaded`, `plan.partial`

Tiers: `tier.started`, `tier.completed`, `tier.failed`

Integration: `integration_test.started`, `integration_test.passed`, `integration_test.failed`, `umbrella_issue.created`

## Chat-rendered subset

Chat integrations render a curated subset into messages — typically run completed/failed/interrupted, PR created/merged, circuit-breaker tripped, and budget warnings. Other events fire but aren't sent to chat unless a renderer is added. See [Chat integrations](/integrations/chat-integrations/).

:::note
Payload field additions are non-breaking; the envelope `schema_version` bumps only on a breaking change. Dedupe on the `event_id` (delivered as `X-Worca-Delivery`).
:::
