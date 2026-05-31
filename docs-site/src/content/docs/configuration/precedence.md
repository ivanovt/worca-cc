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
| Built-in defaults | shipped in worca | silent fallback only — `opus` / `sonnet` / `haiku` resolve even if not listed | baseline values | — |
| Built-in templates | shipped in worca | — | — | `feature`, `quick-fix`, `bugfix`, `refactor`, … |
| **User settings** | `~/.worca/settings.json` (+ `.local.json`) | deep-merge per alias | deep-merge per key | — |
| **User templates** | `~/.worca/templates/<id>/template.json` | — | — | **shadows** built-in by id |
| **Project settings** | `.claude/settings.json` (+ `.local.json`) | deep-merge per alias, wins over user | deep-merge per key, wins over user | — |
| **Project templates** | `.claude/templates/<id>/template.json` | — | — | **shadows** user + built-in by id |
| Selected template at run launch | resolved from the templates column above | rarely sets; overlays on top if it does | deep-merge, wins over project settings | (this row *is* the chosen template's body) |
| Run-specific overrides | CLI flags / `POST /runs` body | — | wins over everything | — |

### Legend

- **deep-merge** (models, pipeline config): per-key merge. A higher row overrides only the keys it sets; keys it doesn't mention pass through from below.
- **shadow** (templates): first match by id wins; tiers do not merge. A project `feature` template *replaces* the built-in `feature` entirely.
- **—** : this layer doesn't contribute to that column.

## How the three columns come together at run launch

1. Compute the final `worca.models` dict by deep-merging user → project settings.
2. Compute the pipeline base by deep-merging user → project settings.
3. Resolve the chosen template id by walking the templates column top-down (project → user → built-in); first match wins.
4. Deep-merge that template's `config` over step 2's pipeline base.
5. Apply CLI / API overrides on top.
6. Resolve each agent's `model:` alias against step 1's `worca.models`.

## Key gotchas

:::caution[A selected template beats Settings → Pipeline]
If your project sets `loops.implement_test: 3` and you launch with the `quick-fix` template (which sets `loops.implement_test: 0`), you get **0**, not 3. This surprises users who expect Settings to be the highest authority. It isn't — the selected template sits on top of it.
:::

- **Models have only two real tiers**, not three. There is no built-in tier in the visible dict. `opus` / `sonnet` / `haiku` only have a silent code fallback — to customize their `env` block (e.g. alt-endpoint routing), list them explicitly in user or project settings so they appear in **Settings → Models**.
- **Templates never merge across tiers.** Project shadows user shadows built-in by id. To extend a built-in template, copy it into your project (or user) scope and edit there — don't expect partial overrides. The [`/worca-template`](/advanced/authoring-templates/) skill automates this.
- **`.local.json` deep-merges into its sibling `.json`** at load time, per tier. That's how the [secrets split](/configuration/secrets/) keeps committed `id` values separate from gitignored `env` blocks while presenting a unified `worca.models` to the rest of the pipeline.

## See also

- [Settings overview](/configuration/settings-overview/) — where the Settings panel writes, and the three on-disk files it spans.
- [Authoring, sharing & importing templates](/advanced/authoring-templates/) — how to create a project or user template that participates in the templates column above.
- [Agents & models](/configuration/agents-and-models/) — per-agent model selection and the `worca.models` alias dict.
