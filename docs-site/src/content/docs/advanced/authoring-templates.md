---
title: Authoring templates
description: Create your own pipeline template — guided via the worca-template skill, or by snapshotting settings.
sidebar:
  order: 6
---

A [template](/concepts/pipeline-templates/) bundles a pipeline configuration — which stages run, agent models and effort, loop limits, governance — behind a single name you pick at launch. You *select* a template from the Run Pipeline launcher's dropdown; *authoring* a new one is what this page covers. There are two ways to do it.

## Guided, with the `/worca-template` skill (recommended)

worca ships a guided authoring skill into every project. In a Claude Code session in your project, start it by command or with a natural phrase:

```
/worca-template
```

These all trigger it too:

- *"create a new pipeline template"*
- *"new pipeline template for backend bug fixes"*
- *"customize my pipeline"*

It interviews you about the kind of work the template is for, **proposes reusing or extending an existing template** before building from scratch, composes a **minimal config delta** (only the keys that differ from your baseline — not a full settings dump), and writes it through the CLI with validation.

This is the simplest path, and the minimal-delta output keeps the template robust across upgrades.

## Snapshot the current settings

Alternatively, tune a project's settings until a run behaves the way you want, then snapshot them into a named template:

```bash
worca templates save my-workflow --description "Backend service changes with strict review"
```

This captures the project's current `worca` configuration as a **project template**. Add `--global` to save it to your user scope (`~/.worca/templates/`) so it's available across every project:

```bash
worca templates save my-workflow --global --description "My standard workflow"
```

A snapshot captures everything, so trim it afterwards if you only meant to change a few keys — the skill avoids this by composing the delta directly.

## Manage templates

```bash
worca templates list
worca templates show my-workflow
worca templates delete my-workflow
```

`worca templates list --json` emits a machine-readable array (id, name, description, tier, tags, builtin, created_at). Templates resolve in tiers — **user > project > built-in** — so a user template shadows a project one of the same name.

## Where templates fit

Once saved, your template appears in the **Run Pipeline** launcher's dropdown and works with `worca run --template my-workflow`. Templates deep-merge over the project's `worca` settings — they only need to carry the keys that *differ* from your baseline; everything else falls through.

:::note
Templates can override agent **prompts** as well as config — see [Overriding agent prompts](/advanced/overriding-agent-prompts/).
:::
