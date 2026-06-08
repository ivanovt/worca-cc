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

![The Run Pipeline launcher: the source selector (prompt / issue / spec) and the prompt field.](/screenshots/launching-a-run/01-launcher.png)

## Triage a GitHub issue (optional)

If your work starts from a GitHub issue, the **`/worca-analyze`** skill turns it into a well-scoped run in one pass. In a Claude Code session in your project, call it by issue number, by full issue URL, or with a natural phrase:

```
/worca-analyze 127
/worca-analyze https://github.com/your-org/your-repo/issues/127
```

A bare number uses the current repo's `gh` default; a URL works against any repo. You can also just say *"analyze https://github.com/your-org/your-repo/issues/127"*.

It reads the issue, surfaces open design decisions with a recommended option for each, can append a `## Decisions` section back to the issue, **recommends the most appropriate template**, and can launch the run for you.

## Pick a template

The **Pipeline** dropdown tailors the run to the kind of work — which stages run, how the agents are tuned, and the retry limits. The full set is described in [Pipeline templates](/concepts/pipeline-templates/).

The first item in the dropdown reflects what runs if you don't pick a specific template:

- **`No template (raw settings.json)`** — no `worca.default_template` is pinned for this project; the run uses project Settings as written.
- **`★ Default template: <name>`** — `worca.default_template` is pinned and the dropdown will pre-select that template's behavior. Pick a different template from the list to override for just this run.

The remaining options are **grouped by tier**, with section labels separating each group, in this order:

1. **User** — templates from `~/.worca/templates/`.
2. **Project** — templates from `.claude/templates/`.
3. **Built-in** — the eight templates shipped with worca (`feature`, `feature-fast`, `feature-minor`, `bugfix`, `quick-fix`, `refactor`, `investigate`, `test-only`).

The pinned default carries a **★** suffix wherever it appears in the list, so you can spot it at a glance regardless of which group it's in.

Pick the template that matches your task before launching. If you're unsure and your project doesn't have a pinned default, `feature` runs the complete pipeline with every gate active.

![The launcher's Pipeline dropdown open, with the User, Project, and Built-in group labels separating the templates and the project default suffixed ★.](/screenshots/launching-a-run/02-template-dropdown.png)

## Advanced options

The launcher exposes a few optional knobs:

- **Size / loop multipliers** — scale the per-agent turn budget and the retry-loop limits up for unusually large tasks.
- **Base branch** — the branch the run's worktree forks from (defaults to the project's current HEAD).
- **Plan file** — supply a pre-written plan to skip the Planner stage.

Leave these at their defaults for most runs.

![The launcher's advanced section: size/loop multipliers, base branch, and the plan-file picker.](/screenshots/launching-a-run/03-advanced.png)

## Launch

Click **Launch**. The run opens in its own git worktree — your working tree is never touched — and the dashboard switches to the [run detail view](/running-pipelines/monitoring-a-run/) so you can watch it live.

:::tip[Run modes]
The chevron next to **Run Pipeline** exposes **Run Fleet** and **Run Workspace** for multi-project work. See [Fleet & workspace runs](/running-pipelines/fleet-and-workspace-runs/).
:::
