---
title: Fleet & workspace runs
description: Running one task across many projects — fleets in parallel, workspaces in dependency order.
sidebar:
  order: 6
---

A single run touches one project. For multi-project work, the **Run Pipeline** split-button (the chevron) exposes two more modes.

## Fleet runs

A **fleet** fans the *same* work request out to *many independent* projects in parallel — "upgrade the linter config across ten repos." Each target runs its own full pipeline in its own worktree and opens its own PR, all grouped under one fleet.

Launch one from **Run Pipeline ▸ Run Fleet**: multi-select the target projects, enter the prompt, optionally attach a guide, and set concurrency. The dashboard groups the children under a collapsible **fleet header** with an aggregate status badge and progress (`N/M completed · K failed`).

![The Fleets list: one card per fleet showing the prompt title, per-project chips, an aggregate status badge (e.g. running / halted), and a per-fleet failure tally.](/screenshots/fleet-and-workspace-runs/01-fleet-list.png)

## Workspace runs

A **workspace** carries *one* prompt across *interdependent* projects in the right order. Unlike a fleet, it decomposes the prompt into per-project sub-plans, runs them tier-by-tier (feeding each tier's changes to the next), runs cross-project integration tests, and opens linked PRs with dependency metadata.

Launch one from **Run Pipeline ▸ Run Workspace**: pick a registered workspace, enter the prompt, and choose a planning strategy. The detail page shows the dependency graph with propagation arrows and a per-project run card list.

![The workspace detail page: per-project run cards ordered by their tier — tier 0 completed first, tier 1 still running, tier 2 still pending — so the dependency graph reads top-to-bottom.](/screenshots/fleet-and-workspace-runs/02-workspace-detail.png)

## Global mode is required

Fleet and workspace grouping only appears in **global mode** (the dashboard's default — every registered project visible at once). In single-project mode the cross-project siblings are invisible, and the UI surfaces a notice prompting you to switch.

:::tip[Going deeper]
This page covers launching and watching multi-project runs from the dashboard. For the full CLI, lifecycle (pause / halt / stop / resume), circuit breaker, and `workspace.json` schema, see [Fleet runs](/advanced/fleet-runs/) and [Workspace runs](/advanced/workspace-runs/) in the Advanced section.
:::
