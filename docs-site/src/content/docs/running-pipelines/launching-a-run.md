---
title: Launching a run
description: Start a pipeline from the dashboard — prompt, source, template, and the advanced options.
sidebar:
  order: 1
---

You launch every run from the dashboard's **Run Pipeline** button. There's no terminal command to learn for day-to-day work — describe the task, pick a template, and click **Launch**.

## Describe the work

A run needs a **work request**. The launcher accepts three sources:

- **Prompt** — type the task in plain language ("Add rate limiting to the public API").
- **GitHub issue** — point at an issue; worca reads its body, and if the issue links a plan file, the Planner is skipped.
- **Spec file** — point at a Markdown file already in the repo.

:::note[Screenshot — coming soon]
The Run Pipeline launcher: the source selector (prompt / issue / spec) and the prompt field.
:::

## Triage a GitHub issue (optional)

If your work starts from a GitHub issue, the **`/worca-analyze`** skill turns it into a well-scoped run in one pass. In a Claude Code session in your project:

```
/worca-analyze 127
```

It reads the issue, surfaces open design decisions with a recommended option for each, can append a `## Decisions` section back to the issue, **recommends the most appropriate template**, and can launch the run for you. Pass an issue number or a full issue URL.

## Pick a template

The **template** dropdown tailors the run to the kind of work — which stages run, how the agents are tuned, and the retry limits. `feature` is the default; the full set is described in [Pipeline templates](/concepts/pipeline-templates/).

Pick the template that matches your task before launching. If you're unsure, `feature` runs the complete pipeline with every gate active.

## Advanced options

The launcher exposes a few optional knobs:

- **Size / loop multipliers** — scale the per-agent turn budget and the retry-loop limits up for unusually large tasks.
- **Base branch** — the branch the run's worktree forks from (defaults to the project's current HEAD).
- **Plan file** — supply a pre-written plan to skip the Planner stage.

Leave these at their defaults for most runs.

:::note[Screenshot — coming soon]
The launcher's advanced section: size/loop multipliers, base branch, and the plan-file picker.
:::

## Launch

Click **Launch**. The run opens in its own git worktree — your working tree is never touched — and the dashboard switches to the [run detail view](/running-pipelines/monitoring-a-run/) so you can watch it live.

:::tip[Run modes]
The chevron next to **Run Pipeline** exposes **Run Fleet** and **Run Workspace** for multi-project work. See [Fleet & workspace runs](/running-pipelines/fleet-and-workspace-runs/).
:::
