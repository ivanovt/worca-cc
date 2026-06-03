---
title: Controlling a run
description: Pause, resume, and stop a pipeline, plus the optional approval gates.
sidebar:
  order: 4
---

The run-detail header carries the lifecycle controls — **pause**, **resume**, and **stop** — with a live status badge that tracks every transition.

## Pause, resume, stop

| Action | What it does |
|---|---|
| **Pause** | The run stops at its next checkpoint and persists as `paused`. All progress is kept in the worktree. |
| **Resume** | Continues a paused run in place, picking up where it left off. |
| **Stop** | Ends the run immediately. It persists as `interrupted` — a terminal state, distinct from a failure. |

A paused or interrupted run keeps its worktree, so resuming loses nothing. A run you've stopped can still be resumed later, as long as its worktree hasn't been [cleaned up](/advanced/worktree-cleanup/).

:::note[Screenshot — coming soon]
The run-detail header: the status badge with pause / resume / stop buttons.
:::

## Approval gates

By default a run is fully autonomous — it goes from prompt to pull request without stopping. Two optional **approval gates** insert a human checkpoint:

- **Plan approval** — the run pauses after planning and waits for you to approve the plan before any code is written.
- **PR approval** — the run pauses just before the Guardian opens the pull request.

Both are off by default. Enable them per project in **Settings → Approval Gates**. When a gate is active, the run pauses and the run-detail view surfaces an approve control.

:::caution
PR approval ships **off** deliberately — leaving it on would hang every autonomous run at the final gate. Turn it on only when you want a human to sign off before a PR is created.
:::
