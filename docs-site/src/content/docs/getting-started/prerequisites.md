---
title: Prerequisites
description: What to install before setting up worca.
sidebar:
  order: 1
---

worca needs a few tools on your machine before you install it.

| Tool | Why | Notes |
|---|---|---|
| **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** | Runs the agents (the `claude` command). | Required. |
| **Python 3.10+** | The pipeline and the `worca` CLI. | Installed with `pip` next. |
| **Node.js 22+** | The `worca-ui` dashboard. | Installed with `npm`. |
| **Git** | Worktrees, branches, commits. | Any recent version. |
| **[beads](https://github.com/gastownhall/beads)** (`bd`) | Task tracking the agents use to coordinate work. | Pin **0.49.0** — see below. |

:::caution[Pin beads to 0.49.0]
Install beads with `npm install -g @beads/bd@0.49.0`. Later versions require Dolt DB, which worca doesn't need.
:::

:::tip[The `worca` CLI must be on your PATH]
The dashboard installs worca into your projects by shelling out to the `worca` command. Installing `worca-cc` with `pip` (next step) puts it on your PATH — that's all that's required.
:::

Next: [install the packages](/getting-started/installation/).
