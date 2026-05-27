---
title: The pipeline & stages
description: What each stage of a worca run does, and which run by default.
sidebar:
  order: 1
---

A worca run is a fixed sequence of stages. Each stage is handled by a specialized agent with one responsibility, and stages hand off to each other until a pull request exists.

```
Preflight → Planner → Plan Reviewer → Coordinator → Implementer(s) → Tester → Reviewer → Guardian → Learner
```

## The stages

- **Preflight** — language-agnostic environment checks (git state, dependencies, config). Runs before any tokens are spent, so broken setups fail fast.
- **Planner** — explores the codebase and writes a detailed implementation plan (the `MASTER_PLAN.md`).
- **Plan Reviewer** — audits the plan for gaps, feasibility, and fit; loops back to the Planner on critical issues. *Off by default.*
- **Coordinator** — decomposes the plan into tracked tasks (beads) with dependencies and parallel groups.
- **Implementer** — claims a task, implements it test-first, commits, and closes it. Independent tasks can run on parallel implementers.
- **Tester** — runs the test suite, verifies coverage, and collects proof artifacts.
- **Reviewer** — reviews the changes for bugs, quality, and convention adherence; approves or sends work back.
- **Guardian** — verifies the test proof, commits, and opens the pull request. It's the only agent allowed to commit — see [Governance](/concepts/governance/).
- **Learner** — analyzes the finished run and produces ranked, copyable suggestions for next time. *Off by default.*

## Loops

The pipeline isn't strictly linear. Implement and Test iterate until the tests pass, the Reviewer can send changes back to the Implementer, and the Plan Reviewer can return a plan to the Planner. Each loop has a configurable iteration limit so a stuck run can't spin forever.

:::note
Plan Review and Learn ship disabled. Enable them per project in the Settings UI when you want the extra plan rigor or the post-run retrospective.
:::
