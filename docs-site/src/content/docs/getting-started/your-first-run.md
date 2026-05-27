---
title: Your first run
description: Launch a pipeline from the dashboard and watch it open a pull request.
sidebar:
  order: 4
---

With your project added, you're ready to run the pipeline — all from the dashboard.

## Launch a run

1. Select your project in the sidebar.
2. Click **Run Pipeline**.
3. Describe the work: type a **prompt**, or point at a **GitHub issue** or a **spec file**.
4. *(Optional)* Pick a **template** — `feature`, `bugfix`, `quick-fix`, `refactor`, `investigate`, or `test-only` — to tailor the stages and rules to the kind of work.
5. Click **Launch**.

:::note[Screenshot — coming soon]
The Run Pipeline launcher: the prompt field, the source selector (prompt / issue / spec), and the template dropdown.
:::

## Watch it run

The run opens in the **run detail** view. Stages stream live as the pipeline moves through Plan → Coordinate → Implement → Test → Review → PR — each showing iteration counts, cost, duration, and logs. Use the **pause / resume / stop** controls in the header at any time.

:::note[Screenshot — coming soon]
Run detail: the stage pipeline with per-stage cost, turns, and timing, plus the lifecycle controls in the header.
:::

The run executes in its **own git worktree**, so your working tree is never touched. When the pipeline finishes, the **Guardian** agent opens a pull request with the implemented, tested, and reviewed change.

:::tip[What's next]
That's a single run. To apply one task across many repositories, or to coordinate interdependent projects, see [Choosing a run mode](/introduction/choosing-a-run-mode/).
:::
