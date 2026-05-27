---
title: How it works
description: The worca pipeline at a glance — nine stages, governance hooks, and a live dashboard.
sidebar:
  order: 2
---

A worca run moves a task through a sequence of specialized agents. Each stage has one job; the reasoning-heavy stages run on Claude Opus, while the build-and-test stages run on Sonnet.

## The pipeline

```
Preflight → Planner → Plan Reviewer → Coordinator → Implementer(s) → Tester → Reviewer → Guardian → Learner
```

| Stage | What it does |
|---|---|
| **Preflight** | Validates the environment (git state, dependencies, config) before spending tokens. |
| **Planner** | Explores the codebase and writes a detailed implementation plan. |
| **Plan Reviewer** | Checks the plan for gaps and feasibility *(off by default)*. |
| **Coordinator** | Breaks the plan into tracked tasks with dependencies. |
| **Implementer** | Implements each task test-first and commits. |
| **Tester** | Runs the test suite and collects proof artifacts. |
| **Reviewer** | Reviews the changes for bugs, quality, and conventions. |
| **Guardian** | Verifies the proof, commits, and opens the pull request. |
| **Learner** | Produces a retrospective with ranked suggestions *(off by default)*. |

Plan Review and Learn ship disabled — enable them per project when you want the extra rigor.

## Governance at every step

worca enforces its rules through hooks that run on **every tool call**:

- only the **Guardian** may run `git commit`;
- dangerous operations (`rm -rf`, force-push, environment writes) are blocked;
- a test gate halts the run after repeated test failures;
- each agent can only dispatch the tools, skills, and subagents it's allowed.

## A live dashboard

The **worca-ui** dashboard streams the whole run over WebSocket — stages, per-iteration cost, token usage, and logs, with pause / resume / stop controls. Nothing is polled; the page updates as the pipeline moves.

:::note
Want the detail behind each stage and the governance model? Those land soon in **Core concepts**. To get hands-on now, head to [Getting started](/getting-started/prerequisites/).
:::
