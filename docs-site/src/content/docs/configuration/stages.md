---
title: Stages
description: Enable or disable pipeline stages and preflight checks.
sidebar:
  order: 2
---

The pipeline's nine stages are described in [The pipeline & stages](/concepts/the-pipeline-and-stages/). **Every stage except Preflight has an on/off toggle.** The **Settings → Stages** panel lists all eight agent stages — Plan, Plan Review, Coordinate, Implement, Test, Review, PR, Learn — each with an enable switch. In practice you'll change the stage set by picking a [template](/concepts/pipeline-templates/) rather than flipping switches by hand.

:::caution[Stage toggles are template-owned]
`worca.stages` (excluding `stages.preflight`) is a **template-owned** key. When a template is in play, the on/off toggles you flip in **Settings → Stages** are **stripped** before the template's config applies — the active template decides what runs. The stage toggles in Settings only take effect when no template is selected. `stages.preflight` is a cross-template carve-out and always survives, so project preflight checks apply regardless of template. See [Configuration precedence](/configuration/precedence/).
:::

:::note[Screenshot — coming soon]
The Settings → Stages panel: every agent stage with its enable toggle and assigned agent.
:::

## Off by default

Two stages ship **disabled** — turn them on for extra rigor:

| Stage | Turn it on when |
|---|---|
| **Plan Review** | You want a second agent to audit the plan for gaps before any code is written. Adds a Planner → Plan Reviewer loop. |
| **Learn** | You want a post-run retrospective with ranked, copyable suggestions after the PR. |

## On by default — but a template can switch them off

The other stages start enabled, but **"on by default" doesn't mean "always runs"** — the active template decides. Several built-ins disable stages to match their kind of work:

| Template | Stage set |
|---|---|
| **quick-fix** | Plan → Implement only — **no Test, Review, or PR** (the change is left on the branch). |
| **investigate** | Plan → PR, to publish a report — **no Coordinate, Implement, Test, or Review** (and Plan Review on). |
| **feature / refactor** | The full pipeline, with Plan Review and Learn enabled. |

So whether Test, Review, or PR runs depends on the template you launch with. See [Pipeline templates](/concepts/pipeline-templates/).

## Preflight checks

**Preflight** is the one stage without a simple agent toggle — it's a script-based stage that validates the environment before any tokens are spent (git state, dependencies, configuration). Each individual check can be toggled independently in **Settings → Preflight**, so you can relax a check that doesn't apply to your project without disabling the whole stage.

:::note[Screenshot — coming soon]
The Preflight panel with per-check toggles.
:::
