---
title: Pipeline lifecycle & state
description: The states a run moves through, and how you control it.
sidebar:
  order: 4
---

Every run has a status you can see in the dashboard, and you can steer it at any time with the lifecycle controls.

## States

- **Running** — actively working through a stage.
- **Paused** — cleanly checkpointed at a stage boundary; resume to continue exactly where it left off.
- **Completed** — finished successfully; a pull request exists.
- **Failed** — stopped on an unrecoverable error.
- **Halted** — the circuit breaker tripped after too many failures, to prevent runaway cost.
- **Interrupted / Cancelled** — stopped by a signal or an operator action.

## Controlling a run

From the run's header in the dashboard:

- **Pause** — stop at the next safe checkpoint without losing progress.
- **Resume** — pick a paused (or interrupted) run back up.
- **Stop** — end the run now.

Because each run lives in its own git worktree, stopping or failing never leaves your main working tree in a half-finished state.

## Circuit breaker

worca classifies errors and counts failures. When failures cross the configured threshold, the run **halts** instead of retrying indefinitely — a backstop against a run that's stuck spending tokens with no progress. The threshold is configurable in the Settings UI.

:::note
The complete state-and-action matrix (which controls are available in which state) lives in the Reference section (coming soon).
:::
