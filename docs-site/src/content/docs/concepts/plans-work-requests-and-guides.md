---
title: Plans, work requests & guides
description: How worca turns your input into a plan — and how a guide overrides everything.
sidebar:
  order: 5
---

Three kinds of input shape what a run does, in a strict order of authority.

## Work request

Every run starts from a **work request** — the task you give it: a prompt, a GitHub issue, a spec file, or a beads task. This is the *what*.

## Plan

The Planner turns the work request into a **plan** (`MASTER_PLAN.md`) — the concrete steps the pipeline will follow. The Coordinator then breaks the plan into tracked **beads** (tasks) with dependencies, which the Implementers claim and close. If you already have a plan, you can supply it and skip the Planner.

## Guides

A **guide** is a normative reference document — a migration spec, an RFC, a compliance requirement — that you attach to a run. It is the **highest-authority source**:

```
guide  >  plan  >  description
```

If the plan or the task description conflicts with the guide, the guide wins, and agents surface the conflict rather than silently picking a side. Guides are attached in the run launcher and apply to single, fleet, and workspace runs alike.

:::tip
Use a guide when correctness is defined by an external document — "implement exactly what this spec says." Use a plain prompt or issue for everyday, self-contained changes.
:::
