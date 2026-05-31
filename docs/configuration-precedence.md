# Configuration precedence

worca's runtime configuration is assembled from three independent "things," each with its own merge story, that come together at run launch:

1. **Model aliases** (`worca.models`) — the dictionary mapping shorthand names like `opus` / `sonnet` to full model IDs plus optional `env` blocks.
2. **Pipeline base config** (`worca.stages`, `worca.agents`, `worca.loops`, `worca.circuit_breaker`, `worca.effort`, …) — the values that govern how a run executes.
3. **Named templates** — `feature`, `quick-fix`, `bugfix`, … — pre-baked pipeline-config bundles, selected by name at run launch.

The matrix below shows every layer that contributes to those columns, where it lives on disk, and how it merges.

## The matrix

Layered bottom-to-top: each row sits on top of the rows above it. **Bottom row wins** at runtime.

| Layer | Where it lives | Models (`worca.models`) | Pipeline base config | Named templates |
|---|---|---|---|---|
| Built-in templates | `src/worca/templates/<id>/template.json` (CLI) / `.claude/worca/templates/<id>/template.json` (UI runtime copy) | — | — | ships `feature`, `quick-fix`, `bugfix`, `refactor`, … |
| **User settings** | `~/.worca/settings.json` (+ `.local.json`) | deep-merge per alias for `worca.models` | **selective only** — see below | — |
| **User templates** | `~/.worca/templates/<id>/template.json` | — | — | **shadows** built-in by id |
| **Project settings** | `.claude/settings.json` (+ `.local.json`) | deep-merge per alias, wins over user | the pipeline base for every run in this project | — |
| **Project templates** | `.claude/templates/<id>/template.json` | — | — | **shadows** user + built-in by id (project > user > built-in) |
| Selected template at run launch | resolved from the templates column above | rarely sets; overlays on top if it does | deep-merge, wins over project settings | (this row *is* the chosen template's body) |
| Run-specific overrides | CLI flags / `POST /runs` body | — | for the specific keys each flag targets (e.g. `--mloops`, `--msize`, `--template`) | — |

### Legend

- **deep-merge**: per-key merge — a higher row overrides only the keys it sets; keys it doesn't mention pass through from below. Template configs additionally support an opt-out `__replace__: true` flag (`src/worca/orchestrator/templates.py:44`) that forces wholesale replacement of a key instead of recursive merge.
- **shadow** (templates): first match by id wins; tiers do not merge. A project `feature` template *replaces* the built-in `feature` entirely.
- **selective** (user settings → pipeline base): see "What user settings actually contribute" below — only a fixed handful of keys, not a full cascade.
- **—** : this layer doesn't contribute to that column.

## How the three columns come together at run launch

1. Load project `.claude/settings.json` (+ `.local.json`) as the pipeline base.
2. Build the final `worca.models` dict by deep-merging user → project entries.
3. For the specific user keys listed below, pull them in from `~/.worca/settings.json` and merge under the project base.
4. Resolve the chosen template id by walking project → user → built-in; first match wins.
5. Deep-merge that template's `config` over the result of step 1-3.
6. Apply CLI / API overrides for the specific keys each flag targets.
7. Resolve each agent's `model:` alias against step 2's `worca.models`.

## What user settings actually contribute

The user file (`~/.worca/settings.json`) is **not** a full cascade base for the project file. It's read in two distinct ways:

| Where | What it contributes | Code |
|---|---|---|
| `worca.models` dict | deep-merge per alias, project wins on collision | UI assembly + `resolve_model()` in `src/worca/utils/settings.py` |
| `circuit_breaker.classifier_model`, `parallel.cleanup_policy`, `parallel.max_concurrent_pipelines`, `ui.worktree_disk_warning_bytes` | merged in by name where the code explicitly asks for `load_global_settings()` | `src/worca/orchestrator/error_classifier.py`, runner.py CRG/graphify sites |

Anything else you put in `~/.worca/settings.json` (e.g., `worca.agents.implementer.model = "sonnet"`, custom `worca.stages.*`, custom `worca.loops.*`) **has no effect** — the orchestrator never reads it on those code paths. The settings.json reference (`src/worca/schemas/keys.json`) marks the global-only keys explicitly via `global_only_keys`, and `worca init --upgrade` surfaces a migration warning if it finds any of them sitting in a project file.

## Key gotchas

- **Templates never merge across tiers.** Project shadows user shadows built-in by id. To extend a built-in template, copy it into your project (or user) scope and edit there — don't expect partial overrides.
- **A selected template beats project Settings → Pipeline.** If your project sets `loops.implement_test: 3` and you launch with `quick-fix` (which sets `loops.implement_test: 0`), you get `0`, not `3`. The selected template sits on top of project settings, not under them.
- **Models have only two real tiers in the visible dict** (user, project). There's no built-in tier in the dict — `opus` / `sonnet` / `haiku` only have a silent code fallback in `resolve_model()` (`_DEFAULT_MODEL_MAP`). To customize their `env` block (alt-endpoint routing), list them explicitly in user or project settings.
- **`.local.json` deep-merges into its sibling `.json`** per tier at load time. That's how the W-051 split keeps `id` in `settings.json` and `env` in `settings.local.json` while presenting a unified `worca.models` to the rest of the pipeline. The merge applies to the project pair; for the user pair, only the code paths that call `load_settings()` (not the ones that `json.load()` global directly) honor `~/.worca/settings.local.json`.
- **CLI/API overrides aren't a free-form override layer** — each flag targets specific keys (`--mloops` → `loops.*`, `--msize` → effort sizing, `--template` → template id, `--param` → template params). There is no "override anything from the CLI" path.

## Code references

| Behavior | File | Symbol |
|---|---|---|
| `.json` + `.local.json` deep-merge per tier | `src/worca/utils/settings.py` | `load_settings()` |
| User-fallback merge for the *specific* keys that consult it | `src/worca/utils/settings.py` | `load_settings_with_global_fallback()` (consumers: `error_classifier.py`, CRG/graphify sites in `runner.py`) |
| Model alias resolution + silent fallback | `src/worca/utils/settings.py` | `resolve_model()`, `_DEFAULT_MODEL_MAP` |
| Template tier search (project → user → built-in) | `src/worca/orchestrator/templates.py` | `TemplateResolver.get()`, `TemplateResolver.list()` |
| Template config deep-merge over project settings | `src/worca/orchestrator/templates.py` | `TemplateResolver.apply()`, `deep_merge_config()` |
| Run launch wiring (load → apply template → write temp settings.json) | `src/worca/scripts/run_pipeline.py` | the `_template_id` block (≈ lines 247-294) |
