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
| **Project settings** | `.claude/settings.json` (+ `.local.json`) | deep-merge per alias, wins over user | the pipeline base — **with template-owned keys stripped when a template is in play**; see below | — |
| **Project templates** | `.claude/templates/<id>/template.json` | — | — | **shadows** user + built-in by id (project > user > built-in) |
| Selected template at run launch | `--template` arg, or `POST /runs` body, or `worca.default_template` fallback | rarely sets; overlays on top if it does | deep-merge over the stripped project base — wins on every template-owned key | (this row *is* the chosen template's body) |
| Run-specific overrides | CLI flags / `POST /runs` body | — | for the specific keys each flag targets (e.g. `--mloops`, `--msize`, `--template`) | — |

### Legend

- **deep-merge**: per-key merge — a higher row overrides only the keys it sets; keys it doesn't mention pass through from below. Template configs additionally support an opt-out `__replace__: true` flag (`src/worca/orchestrator/templates.py:44`) that forces wholesale replacement of a key instead of recursive merge.
- **shadow** (templates): first match by id wins; tiers do not merge. A project `feature` template *replaces* the built-in `feature` entirely.
- **selective** (user settings → pipeline base): see "What user settings actually contribute" below — only a fixed handful of keys, not a full cascade.
- **—** : this layer doesn't contribute to that column.

## Template-driven keys

When a template is in play at run launch (explicit `--template`, `POST /runs` body, or `worca.default_template` fallback), these keys are **stripped from the project-settings merge base** before the template's config applies. The selected template owns them outright; project Settings values for these keys are silently ignored for that run:

- `worca.agents`
- `worca.stages`
- `worca.loops`
- `worca.circuit_breaker`
- `worca.effort`
- `worca.milestones`
- `worca.governance.dispatch`
- `worca.governance.test_gate_strikes`
- `worca.governance.plan_review_enforce`

These are the keys returned by `TEMPLATE_OWNED_KEYS` in `src/worca/orchestrator/templates.py`. Everything else under `worca.*` — including `worca.models`, `worca.webhooks`, `worca.pricing`, `worca.governance.guards`, `worca.graphify`, `worca.code_review_graph`, `worca.default_template` itself, and preflight check definitions — is **cross-template**: kept in the merge base regardless of which template is selected. These are project-machine concerns (creds, infra, integrations) that should be the same for every template the project runs.

If no template is in play (no `--template`, no body, no `default_template`), no stripping happens — project Settings values apply as written.

## How the three columns come together at run launch

1. Load project `.claude/settings.json` (+ `.local.json`) as the pipeline base.
2. Build the final `worca.models` dict by deep-merging user → project entries.
3. For the specific user keys listed below, pull them in from `~/.worca/settings.json` and merge under the project base.
4. Resolve the template id: prefer the explicit `--template` / `POST /runs` body; otherwise fall back to `worca.default_template`. Then walk the template tiers project → user → built-in; first match wins.
5. **If a template is in play, strip `TEMPLATE_OWNED_KEYS` from the pipeline base.** Deep-merge the template's `config` over the stripped base.
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
- **A selected template wipes project Settings for template-owned keys.** If your project sets `loops.implement_test: 3` and you launch with `quick-fix`, you get whatever `quick-fix` sets (or the code default if it doesn't set it) — not 3. Template-owned keys are *stripped* from the project base before the template applies, so Settings can't leak in on the keys the template doesn't explicitly touch. Cross-template keys (models, webhooks, etc.) survive untouched.
- **`worca.default_template` pins a project's pipeline.** Set it once and every run uses that template unless `--template` overrides at launch. Phase 1 of the template-driven pipelines work introduced this field; `worca init --upgrade` auto-migrates customized template-owned keys into a `_legacy-settings` template and pins it, so existing projects don't see a behavior change until they explicitly opt in.
- **Models have only two real tiers in the visible dict** (user, project). There's no built-in tier in the dict — `opus` / `sonnet` / `haiku` only have a silent code fallback in `resolve_model()` (`_DEFAULT_MODEL_MAP`). To customize their `env` block (alt-endpoint routing), list them explicitly in user or project settings.
- **`.local.json` deep-merges into its sibling `.json`** per tier at load time. That's how the W-051 split keeps `id` in `settings.json` and `env` in `settings.local.json` while presenting a unified `worca.models` to the rest of the pipeline. The merge applies to the project pair; for the user pair, only the code paths that call `load_settings()` (not the ones that `json.load()` global directly) honor `~/.worca/settings.local.json`.
- **CLI/API overrides aren't a free-form override layer** — each flag targets specific keys (`--mloops` → `loops.*`, `--msize` → effort sizing, `--template` → template id, `--param` → template params, `--max-beads` → coordinator bead cap). There is no "override anything from the CLI" path.
- **`worca.agents.coordinator.max_beads` has a three-level precedence:** per-run `--max-beads` CLI/API override (highest) → template `config.agents.coordinator.max_beads` → `0` (auto, lowest). Because `worca.agents` is template-owned, a project's raw `settings.json` value for `max_beads` is stripped when a template is in play — the template owns it outright. The key accepts integer `0`–`50`; `0` = auto (no cap), `1` = single-bead mandate, `>1` = advisory budget. Enforcement is soft (log on deviation, run proceeds as decomposed). The cap is suppressed when PR-revision mode is active (`has_review_comments`), where review-comment-to-bead rules take precedence.
- **`worca.claude_md_mode` controls which CLAUDE.md files Claude Code loads, with four-level precedence:** per-run `--claude-md-mode` CLI flag (highest) → template `config.claude_md_mode` (if the template explicitly sets it) → project `worca.claude_md_mode` in `settings.json` → `"all"` (built-in default). Unlike most template-owned keys (`worca.agents`, `worca.stages`, etc.), `claude_md_mode` is **not** stripped when a template is active — the project value flows through as the base and is only overridden when a template explicitly sets it in its `config`. This means `worca.claude_md_mode: "project"` in `settings.json` works correctly for hermetic runs regardless of which built-in template is used. Custom templates may still pin a specific mode. Valid values: `none` (no CLAUDE.md loading, auto-memory disabled), `project` (project-root CLAUDE.md only), `project+local` (adds CLAUDE.local.md), `all` (standard behaviour, no overlay written). The resolved mode and its source are recorded in `status.json` and emitted as `pipeline.claude_md.mode_resolved` at run start.

## Managing templates in the UI

The **Pipelines** section in the dashboard lets you browse, create, edit, duplicate, and delete templates without touching the CLI or editing JSON by hand. It also surfaces the dedup/shadowing relationships described above and marks the current default template. See the [Pipelines editor walkthrough](https://docs.worca.dev/configuration/pipelines-editor/) on the docs site.

## Code references

| Behavior | File | Symbol |
|---|---|---|
| `.json` + `.local.json` deep-merge per tier | `src/worca/utils/settings.py` | `load_settings()` |
| User-fallback merge for the *specific* keys that consult it | `src/worca/utils/settings.py` | `load_settings_with_global_fallback()` (consumers: `error_classifier.py`, CRG/graphify sites in `runner.py`) |
| Model alias resolution + silent fallback | `src/worca/utils/settings.py` | `resolve_model()`, `_DEFAULT_MODEL_MAP` |
| Template tier search (project → user → built-in) | `src/worca/orchestrator/templates.py` | `TemplateResolver.get()`, `TemplateResolver.list()` |
| Template config deep-merge over project settings | `src/worca/orchestrator/templates.py` | `TemplateResolver.apply()`, `deep_merge_config()` |
| Template-owned keys + strip helper | `src/worca/orchestrator/templates.py` | `TEMPLATE_OWNED_KEYS`, `strip_template_owned()` |
| Run launch wiring (load → resolve default → strip → apply template) | `src/worca/scripts/run_pipeline.py` | the `_template_id` block (≈ lines 247-310) |
| Auto-migration of legacy customizations into `_legacy-settings` template | `src/worca/cli/init.py` | `_migrate_to_legacy_template()` |
