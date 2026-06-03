---
title: Add your project
description: Register a project in the dashboard — worca installs itself into it automatically.
sidebar:
  order: 3
---

You add projects from the dashboard. Adding a project both **registers** it and **installs worca into it** — there's no manual setup step.

## Steps

1. In the sidebar, click the **+** button next to the project picker.
2. Choose **Single project** (a normal repository) or **Workspace** (a folder that groups several related repositories).
3. Enter the project's path. The dialog validates it and generates a name.
4. Confirm. worca registers the project and runs its installer in the background.

![The Add Project dialog: Single project / Workspace toggle, project path filled in, and the project name auto-generated from the last path segment.](/screenshots/add-project/01-dialog.png)

Behind the scenes the dashboard runs `worca init --upgrade` inside the project, scaffolding the pipeline into `.claude/worca/`. The project appears in the sidebar once setup finishes.

:::tip
This is why the `worca` CLI must be on your PATH (from `pip install worca-cc`) — the dashboard calls it to perform the install.
:::

## Workspaces

Choose **Workspace** to register a parent folder that contains several interdependent project clones. That unlocks [workspace runs](/introduction/choosing-a-run-mode/), where one prompt is coordinated across all of them in dependency order.

Next: [run your first pipeline](/getting-started/your-first-run/).
