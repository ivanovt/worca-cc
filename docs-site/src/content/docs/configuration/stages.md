---
title: Stages
description: Enable or disable pipeline stages and preflight checks.
sidebar:
  order: 2
---

The pipeline's nine stages are described in [The pipeline & stages](/concepts/the-pipeline-and-stages/). Two of them are optional, and you control which run from **Settings → Stages**.

## Optional stages

| Stage | Default | Turn it on when |
|---|---|---|
| **Plan Review** | off | You want a second agent to audit the plan for gaps before any code is written — extra rigor on high-stakes work. |
| **Learn** | off | You want a post-run retrospective with ranked, copyable suggestions. |

The other seven stages always run. Enabling Plan Review adds a Planner → Plan Reviewer loop; enabling Learn adds a retrospective after the PR.

:::note[Screenshot — coming soon]
The Stages panel with the Plan Review and Learn toggles.
:::

## Preflight checks

**Preflight** validates the environment before any tokens are spent — git state, dependencies, and configuration. Each check can be toggled independently in **Settings → Preflight**, so you can relax a check that doesn't apply to your project without disabling the stage.

:::note[Screenshot — coming soon]
The Preflight panel with per-check toggles.
:::

:::tip
Templates can flip stages on or off as part of their definition — the `quick-fix` template, for example, drops the test, review, and PR stages entirely. See [Pipeline templates](/concepts/pipeline-templates/).
:::
