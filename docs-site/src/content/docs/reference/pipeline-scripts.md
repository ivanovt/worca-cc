---
title: Pipeline scripts reference
description: Flags for the run_*.py entry points behind the run modes.
sidebar:
  order: 2
---

The run modes are backed by four scripts in `.claude/scripts/`. `worca run` wraps the single-run ones; fleet and workspace runs call their scripts directly. Run any with `--help` for the version-matched list.

:::tip
The [Run Pipeline launcher](/running-pipelines/launching-a-run/) is the recommended way to start single, worktree, fleet, and workspace runs — it sets the template, guide, parallelism, and tier order for you. These scripts are the low-level surface the launcher (and `worca run`) invokes; reach for them when scripting in CI or driving a run headlessly.
:::

## run_pipeline.py

Runs the pipeline **in place** against the current working tree. The lowest-level entry point — usually invoked via `worca run` or by `run_worktree.py`. Accepts `--prompt` / `--source`, `--plan`, `--template`, `--guide`, `--resume`, and the size/loop multipliers.

## run_worktree.py

Runs a single pipeline in a fresh **git worktree**, then registers it for the dashboard. This is what `worca run --worktree` calls.

| Flag | Purpose |
|---|---|
| `--prompt TEXT` / `--source REF` | The work request. |
| `--plan PATH` | Pre-written plan (skips the Planner). |
| `--branch BRANCH` | Base branch to fork the worktree from. |
| `--guide PATH` | Reference guide (repeatable). |
| `--fleet-id ID` | Internal — set when launched as a fleet child. |

## run_fleet.py

Fans one work request across N independent projects. See [Fleet runs](/advanced/fleet-runs/).

| Flag | Purpose |
|---|---|
| `--projects PATHS` / `--projects-file FILE` | Targets, inline or one-per-line. |
| `--prompt TEXT` / `--source REF` | The work request. |
| `--guide PATH` | Reference guide (repeatable). |
| `--plan PATH` | Shared plan; children skip the Planner. |
| `--plan-first [PROJECT]` | One reference child plans, the rest inherit. |
| `--head-template TMPL` | Per-child branch template. |
| `--base BRANCH` | Shared PR base branch. |
| `--max-parallel N` | Concurrent children (default 5). |
| `--fleet-failure-threshold RATIO` | Circuit-breaker ratio (default 0.30). |
| `--init-timeout SECONDS` | Per-target readiness timeout (default 60). |
| `--pause / --stop / --resume FLEET_ID` | Lifecycle actions on an existing fleet. |

`--branch` is rejected — use `--base` + `--head-template`.

## run_workspace.py

Coordinates one prompt across interdependent projects in DAG order. See [Workspace runs](/advanced/workspace-runs/).

| Flag | Purpose |
|---|---|
| `WORKSPACE_ROOT` | Positional: parent dir containing `workspace.json`. |
| `--prompt TEXT` / `--source REF` | The work request. |
| `--guide PATH` | Reference guide (repeatable). |
| `--branch TEMPLATE` | Branch template (`{workspace}`, `{project}`, `{slug}`). |
| `--skip-planning` | Each project plans independently. |
| `--workspace-plan PATH` | Reuse a `workspace-plan.json`. |
| `--project-plan NAME=PATH` | Per-project plan file (repeatable). |
| `--skip-integration` | Skip the cross-project integration test. |
| `--max-parallel N` | Concurrent children within a tier (default 5). |
| `--resume WORKSPACE_ID` | Resume a failed/halted run. |
| `--dry-run` | Print the DAG and exit. |

:::note
Some installs expose these under `.claude/worca/scripts/`. The runtime path depends on your worca version; `worca run` resolves it for you.
:::
