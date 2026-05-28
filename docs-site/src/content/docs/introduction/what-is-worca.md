---
title: What is worca?
description: An overview of worca — an autonomous, governed software-development pipeline you drive from a web dashboard.
sidebar:
  order: 1
---

worca (Workflow Orchestration for Agents) is an **autonomous software-development pipeline**. You hand it a task — a prompt, a GitHub issue, or a spec — and a team of AI agents plans the work, implements it test-first, reviews the result, and opens a pull request. Every step runs under **governance**: safety hooks block dangerous operations, enforce test gates, and keep agents inside guardrails.

You run and watch everything from the **worca dashboard** (`worca-ui`), a real-time web UI. Add a project, click **Run Pipeline**, and follow each stage live — costs, token usage, logs, and the resulting PR.

## What you get

- **A reviewed pull request**, not just a diff — implemented, tested, and code-reviewed by separate agents.
- **Isolation by default** — each run executes in its own git worktree, so your working tree is never touched and runs can go in parallel.
- **Full visibility and control** — stream every stage in the dashboard; pause, resume, or stop a run at any time.
- **Governance you can trust** — only the final agent may commit, dangerous shell operations are blocked, and tests must pass before code ships.

## Who it's for

Developers and teams who want to delegate well-scoped changes — features, bug fixes, refactors, investigations — to an agent pipeline while keeping a human in the loop at review and merge time.

:::tip
New here? Head to [Getting started](/getting-started/prerequisites/) to install worca and run your first pipeline from the dashboard.
:::
