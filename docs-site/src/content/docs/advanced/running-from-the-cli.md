---
title: Running from the CLI
description: Launch and control pipelines from the terminal instead of the dashboard.
sidebar:
  order: 1
---

The dashboard is the primary way to run worca, but every run mode is also available from the `worca` CLI — useful for scripting, CI, and headless environments.

## Launch a run

`worca run` starts a pipeline. The everyday form launches into an isolated git worktree (parallel-safe), mirroring the dashboard's default:

```bash
worca run --worktree --prompt "Add rate limiting to the public API"
```

Common flags:

| Flag | Purpose |
|---|---|
| `--prompt TEXT` | Inline work request. |
| `--source REF` | External source — `gh:issue:42` or `bd:bd-abc123`. |
| `--spec PATH` / `--plan PATH` | A spec file, or a pre-written plan that skips the Planner. |
| `--template ID` | Apply a template before running (`feature`, `bugfix`, …). |
| `--worktree` | Run in an isolated worktree. Falls back to in-place if the runtime lacks `run_worktree.py`. |
| `--branch BRANCH` | Base branch the worktree forks from (`--worktree` only; default: HEAD). |
| `--guide PATH` | A normative reference guide injected into planning (`--worktree` only, repeatable). See [Guides](/advanced/guides/). |
| `--param KEY=VALUE` | Override a template parameter (repeatable). |

Run in-place (no worktree) by omitting `--worktree` — the pipeline runs against your working tree directly.

## Control a run

```bash
worca pause <run-id>
worca resume <run-id>
worca stop <run-id>
worca status <run-id>
```

`worca multi-status` shows every parallel pipeline at once.

## The underlying scripts

`worca run` is a thin wrapper over the pipeline entry-point scripts in `.claude/scripts/`. For fleet and workspace runs you call those scripts directly — `run_fleet.py` and `run_workspace.py` — covered in [Fleet runs](/advanced/fleet-runs/) and [Workspace runs](/advanced/workspace-runs/). The full flag tables for all four scripts are in the [Pipeline scripts reference](/reference/pipeline-scripts/).

:::caution[Governance]
Outside the dashboard you still get worca's governance — only the Guardian can commit, dangerous operations are blocked, and the test gate halts repeated failures. See [Governance](/concepts/governance/).
:::
