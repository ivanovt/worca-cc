---
title: Loops & circuit breaker
description: Retry limits for the pipeline's loops, and the failure breaker that halts a stuck run.
sidebar:
  order: 5
---

The pipeline retries work automatically, but never forever. Two mechanisms bound it: per-loop iteration limits and a circuit breaker.

:::caution[Loops and circuit breaker are template-owned]
`worca.loops` and `worca.circuit_breaker` are **template-owned** keys. When a template is in play, the values you set in **Settings → Loop Limits** and **Settings → Circuit Breaker** are **stripped** before the template's config applies — the active template's limits and thresholds take over. The Settings values only take effect when no template is selected. To change loop/circuit-breaker behavior for a specific template, edit that template. See [Configuration precedence](/configuration/precedence/).
:::

## Loop limits

Three stages can send work back upstream:

- **Test → Implement** — the Tester loops back to the Implementer until the suite passes.
- **Review → Implement** — the Reviewer sends changes back when it finds issues.
- **Plan Review → Plan** — the Plan Reviewer returns a plan to the Planner on critical gaps (only when Plan Review is enabled).

Each loop has an iteration limit, set in **Settings → Loop Limits**, so a stuck run can't spin indefinitely. When a loop hits its limit, the run stops rather than burning tokens. The **size / loop multipliers** in the launcher scale these limits up for an unusually large task without changing the project defaults.

## Circuit breaker

The circuit breaker watches for repeated, classified failures and halts the run before it wastes a budget on a broken setup. Configure it in **Settings → Circuit Breaker**:

- **Max failures** — how many classified failures are tolerated before the run halts.
- **Classifier model** — the (small, fast) model that classifies whether an error is retryable or fatal. This is a global preference (`~/.worca/settings.json`), defaulting to `haiku`.

:::note[Screenshot — coming soon]
The Circuit Breaker panel: max-failures and classifier-model controls.
:::

:::tip
Fleet and workspace runs have their own, separate circuit breaker that halts the *fan-out* when too many child projects fail — see [Fleet runs](/advanced/fleet-runs/).
:::
