---
title: Configuration precedence
description: How model aliases, pipeline base config, and named templates merge at run launch — and which layer wins.
sidebar:
  order: 2
---

worca's runtime configuration is assembled from three independent "things," each with its own merge story, that come together when you launch a run:

1. **Model aliases** (`worca.models`) — shorthand names like `opus` / `sonnet` mapped to full model IDs, plus optional per-model environment for alt-endpoint routing.
2. **Pipeline base config** (`worca.stages`, `worca.agents`, `worca.loops`, `worca.circuit_breaker`, `worca.effort`, …) — the values that govern how a run executes.
3. **Named templates** — `feature`, `quick-fix`, `bugfix`, … — pre-baked pipeline-config bundles you select at launch.

The matrix below shows every layer that contributes, where it lives on disk, and how it merges. **Bottom rows win.**

## The matrix

| Layer | Where it lives | Models (`worca.models`) | Pipeline base config | Named templates |
|---|---|---|---|---|
| Built-in templates | shipped in worca | — | — | `feature`, `quick-fix`, `bugfix`, `refactor`, … |
| **User settings** | `~/.worca/settings.json` (+ `.local.json`) | deep-merge per alias | **selective only** — see below | — |
| **User templates** | `~/.worca/templates/<id>/template.json` | — | — | **shadows** built-in by id |
| **Project settings** | `.claude/settings.json` (+ `.local.json`) | deep-merge per alias, wins over user | the pipeline base for every run in this project | — |
| **Project templates** | `.claude/templates/<id>/template.json` | — | — | **shadows** user + built-in by id (project > user > built-in) |
| Selected template at run launch | resolved from the templates column above | rarely sets; overlays on top if it does | deep-merge, wins over project settings | (this row *is* the chosen template's body) |
| Run-specific overrides | CLI flags / `POST /runs` body | — | for the specific keys each flag targets | — |

### Legend

- **deep-merge** (models, pipeline config): per-key merge. A higher row overrides only the keys it sets; keys it doesn't mention pass through from below. Template configs additionally support a `__replace__: true` flag that forces wholesale replacement of a key instead of recursive merge.
- **shadow** (templates): first match by id wins; tiers do not merge. A project `feature` template *replaces* the built-in `feature` entirely.
- **selective** (user settings → pipeline base): see "What user settings actually contribute" below — only a fixed handful of keys, not a full cascade.
- **—** : this layer doesn't contribute to that column.

## How the three columns come together at run launch

1. Load project `.claude/settings.json` (+ `.local.json`) as the pipeline base.
2. Build the final `worca.models` dict by deep-merging user → project entries.
3. For the specific user keys listed below, pull them from `~/.worca/settings.json` and merge under the project base.
4. Resolve the chosen template id by walking project → user → built-in; first match wins.
5. Deep-merge that template's `config` over the result of steps 1-3.
6. Apply CLI / API overrides for the specific keys each flag targets.
7. Resolve each agent's `model:` alias against step 2's `worca.models`.

## What user settings actually contribute

:::caution[Most user-settings keys are silently ignored by the pipeline]
The user file (`~/.worca/settings.json`) is **not** a full cascade base for the project file. Only a fixed handful of keys are read by the orchestrator. If you put `worca.agents.implementer.model = "sonnet"` in your user file, **it has no effect** — the pipeline never reads it on that code path. Put per-agent overrides in **project** settings.
:::

| Where user settings contributes | Keys |
|---|---|
| Model alias dict (`worca.models`) | every alias, deep-merged with project winning on collision |
| Explicit global-only keys (consulted via `load_global_settings()`) | `circuit_breaker.classifier_model`, `parallel.cleanup_policy`, `parallel.max_concurrent_pipelines`, `ui.worktree_disk_warning_bytes` |

`worca init --upgrade` surfaces a migration warning if it finds any of these global-only keys sitting in a project file.

## Key gotchas

:::caution[A selected template beats Settings → Pipeline]
If your project sets `loops.implement_test: 3` and you launch with the `quick-fix` template (which sets `loops.implement_test: 0`), you get **0**, not 3. The selected template sits on top of project settings, not under them.
:::

- **Templates never merge across tiers.** Project shadows user shadows built-in by id. To extend a built-in template, copy it into your project (or user) scope and edit there — don't expect partial overrides. The [`/worca-template`](/advanced/authoring-templates/) skill automates this.
- **Models have only two real tiers in the visible dict** (user, project). `opus` / `sonnet` / `haiku` only have a silent code fallback — to customize their `env` block (alt-endpoint routing), list them explicitly in user or project settings so they appear in **Settings → Models**.
- **`.local.json` deep-merges into its sibling `.json`** at load time, per tier. That's how the [secrets split](/configuration/secrets/) keeps committed `id` values separate from gitignored `env` blocks while presenting a unified `worca.models` to the rest of the pipeline.
- **CLI/API overrides aren't a free-form layer.** Each flag targets specific keys (`--mloops` → `loops.*`, `--msize` → effort sizing, `--template` → template id, `--param` → template params).

## See also

- [Settings overview](/configuration/settings-overview/) — where the Settings panel writes, and the three on-disk files it spans.
- [Authoring, sharing & importing templates](/advanced/authoring-templates/) — how to create a project or user template that participates in the templates column above.
- [Agents & models](/configuration/agents-and-models/) — per-agent model selection and the `worca.models` alias dict.
