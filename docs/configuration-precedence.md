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
| Built-in defaults | `src/worca/schemas/keys.json` + `_DEFAULT_MODEL_MAP` in `src/worca/utils/settings.py` | silent fallback only — `opus` / `sonnet` / `haiku` resolve even if not listed | baseline values | — |
| Built-in templates | `src/worca/templates/<id>/template.json` | — | — | ships `feature`, `quick-fix`, `bugfix`, `refactor`, … |
| **User settings** | `~/.worca/settings.json` (+ `.local.json`) | deep-merge per alias | deep-merge per key | — |
| **User templates** | `~/.worca/templates/<id>/template.json` | — | — | **shadows** built-in by id |
| **Project settings** | `.claude/settings.json` (+ `.local.json`) | deep-merge per alias, wins over user | deep-merge per key, wins over user | — |
| **Project templates** | `.claude/templates/<id>/template.json` | — | — | **shadows** user + built-in by id |
| Selected template at run launch | resolved from the templates column above | rarely sets; overlays on top if it does | deep-merge, wins over project settings | (this row *is* the chosen template's body) |
| Run-specific overrides | CLI flags / `POST /runs` body | — | wins over everything | — |

### Legend

- **deep-merge** (models, pipeline config): per-key merge — a higher row overrides only the keys it sets; keys it doesn't mention pass through from below.
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

- **Models have only two real tiers**, not three. There is no built-in tier in the visible dict — `opus` / `sonnet` / `haiku` only have a silent code fallback in `resolve_model()`. To customize their `env` block (e.g. alt-endpoint routing), list them explicitly in user or project settings.
- **Templates never merge across tiers**. Project shadows user shadows built-in by id. To extend a built-in template, copy it into your project scope and edit there — don't expect partial overrides.
- **A selected template beats project Settings → Pipeline.** If your project sets `loops.implement_test: 3` and you launch with `quick-fix` (which sets `loops.implement_test: 0`), you get `0`, not `3`. This surprises users who expect Settings to be "the highest authority."
- **`.local.json` deep-merges into its sibling `.json`** at load time, per tier — that's how the W-051 split keeps `id` in `settings.json` and `env` in `settings.local.json` while presenting a unified `worca.models` to the rest of the pipeline.

## Code references

| Behavior | File | Symbol |
|---|---|---|
| User → project settings deep-merge | `src/worca/utils/settings.py` | `load_settings_with_global_fallback()` |
| `.json` + `.local.json` deep-merge per tier | `src/worca/utils/settings.py` | `load_settings()` |
| Model alias resolution + silent fallback | `src/worca/utils/settings.py` | `resolve_model()`, `_DEFAULT_MODEL_MAP` |
| Template scope search (project → user → built-in) | `worca-ui/server/project-routes.js` | `GET /api/projects/:id/templates` handler |
| Template config deep-merge over project settings | `src/worca/orchestrator/templates.py` | `apply()` / `deep_merge_config()` |
