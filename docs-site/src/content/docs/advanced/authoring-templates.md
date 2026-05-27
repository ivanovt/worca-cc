---
title: Authoring templates
description: Create your own pipeline template by snapshotting a tuned configuration.
sidebar:
  order: 6
---

A [template](/concepts/pipeline-templates/) bundles a pipeline configuration — which stages run, agent models and effort, loop limits, governance — behind a single name you pick at launch. You *select* a template from the Run Pipeline launcher's dropdown; *authoring* a new one is a CLI/skill task, which is what this page covers.

## Snapshot the current settings

The simplest path: tune a project's settings until a run behaves the way you want, then snapshot them into a named template:

```bash
worca templates save my-workflow --description "Backend service changes with strict review"
```

This captures the project's current `worca` configuration as a **project template** stored under the project. Add `--global` to save it to your user scope (`~/.worca/templates/`) so it's available across every project:

```bash
worca templates save my-workflow --global --description "My standard workflow"
```

## Manage templates

```bash
worca templates list
worca templates show my-workflow
worca templates delete my-workflow
```

`worca templates list --json` emits a machine-readable array (id, name, description, tier, tags, builtin, created_at) — useful for tooling. Templates resolve in tiers: **user > project > built-in**, so a user template can shadow a project one of the same name.

## Where templates fit

Once saved, your template appears in the **Run Pipeline** launcher's template dropdown and works with `worca run --template my-workflow`. Templates deep-merge over the project's `worca` settings — they only need to carry the keys that *differ* from your project baseline; everything else falls through.

:::tip
This repo ships a `/worca-plan-new`-style guided authoring skill for templates. If you're building a template interactively, that skill walks through the stage, agent, and governance choices and writes the definition for you.
:::

:::note
Templates can override agent **prompts** as well as config — see [Overriding agent prompts](/advanced/overriding-agent-prompts/).
:::
