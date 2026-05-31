---
name: worca-template
description: Guided pipeline-template authoring, export, and import — interviews the user for intent, proposes reusing or extending existing templates, composes a minimal config delta, and writes it via CLI. Also exports template bundles (with secret redaction) and imports bundles from files, URLs, or gists. Triggers on "new template", "create pipeline template", "create template", "customize my pipeline", "export template", "import template", "share template", "bundle", "worca-template".
---

# Worca Template

Guided creation, export, and import of pipeline templates. Interviews the user, proposes reusing or extending existing templates before building from scratch, composes a *minimal config delta* (not a settings snapshot), and writes it via the CLI with full validation. Also supports exporting template bundles for sharing and importing bundles from files, URLs, or GitHub gists.

**Usage:**
- `/worca-template` — start the guided interview
- "create a new template" / "new pipeline template" / "customize my pipeline" — natural phrases
- "export template" / "share template" / "bundle templates" — export flow
- "import template" / "load bundle" — import flow

## Procedure

### Phase 0: Enumerate existing templates

Run the CLI to discover all templates across all three tiers (built-in, project, user):

```bash
worca templates list --json
```

This returns a JSON array with `{id, name, description, tier, tags, builtin, created_at}` per entry. The resolver enforces project > user > built-in priority on ID collision — the JSON reflects what will actually be applied at runtime.

For each template, also read its `config` to understand what it overrides. Use `worca templates show <id>` for each, or read the `template.json` files directly:
- Built-in: `.claude/worca/templates/*/template.json`
- Project: `.claude/templates/*/template.json`
- User: `~/.worca/templates/*/template.json`

Summarize the available templates to the user in one compact table: ID, tier, and a one-line diff summary (e.g. "disables test+review+PR, sonnet implementer" for `quick-fix`).

### Phase 1: Intent interview

Use **batched `AskUserQuestion`** — present each batch in a single message so the user answers them at once, not iteratively. `AskUserQuestion` caps each call at 4 questions and each question at 4 options, so the interview is split into two batches. Batch 2 also lets follow-ups (model tier, plan-review mode) react to Batch 1 answers.

**Batch 1 (4 questions — purpose, rigor, stage toggles):**

1. **Purpose / use-case** — "What kind of work is this template for?" Options: feature development, bug fixing, refactoring, investigation/analysis. (If none fit, the user picks "Other" — automatically offered by the harness — and types free-text.)

2. **Rigor vs speed** — "How thorough should the pipeline be?" Options:
   - Full rigor (plan review + learn + all approval gates)
   - Balanced (standard stages, no extra gates)
   - Fast (skip optional stages, minimal loops)
   - Minimal (bare minimum — plan + implement only)

3. **Core stages to toggle** — "Which production stages should be ON?" (multi-select, 3 options). Options:
   - Test (`stages.test.enabled`)
   - Code review (`stages.review.enabled`)
   - PR creation (`stages.pr.enabled`)

   Pre-select based on the rigor answer. Let the user override.

4. **Advanced governance stages to toggle** — "Which advanced governance stages should be ON?" (multi-select, 2 options). Options:
   - Plan review (`stages.plan_review.enabled`)
   - Learn (`stages.learn.enabled`)

   Pre-select based on the rigor answer (Full rigor → both on; Balanced/Fast/Minimal → both off).

**Batch 2 (2-3 questions — plan-review mode if enabled, governance override, model tier):**

5. **Plan review mode** — *only include this question in Batch 2 if Plan review was selected in Batch 1 (question 4).* "Which plan review mode?" Options:
   - Review (default) — reviewer sends feedback, planner revises in a loop. Preserves independent verification (two agents, two perspectives) but costs extra iterations (`stages.plan_review.mode = "review"`)
   - Review & Edit — reviewer can directly edit the plan, shortcutting the loop. Faster (often single-pass) but the reviewer is both critic and author, losing the independent-verification trade-off (`stages.plan_review.mode = "review_and_edit"`)

6. **Governance override** — "Should the project enforce a specific plan review mode?" Options:
   - Auto (default) — mode comes from the template or pipeline config, no enforcement (`governance.plan_review_enforce = "auto"`)
   - Enforce review — always use review mode regardless of template (`governance.plan_review_enforce = "review"`)
   - Enforce review & edit — always use review-and-edit regardless of template (`governance.plan_review_enforce = "review_and_edit"`)

7. **Model tier** — "Which model tier for key agents?" Options:
   - All Opus (thorough, slower)
   - Opus planning + Sonnet implementation (balanced — the default)
   - All Sonnet (fastest, lower quality on complex tasks)
   - Custom (will ask per-agent in a follow-up)

If the user selected "Custom" for model tier, ask a follow-up with per-agent model selection for planner, coordinator, implementer, tester, and reviewer.

**Do not combine the two batches into a single `AskUserQuestion` call** — six (or seven) questions exceeds the 4-question cap and the call will fail with `Invalid tool parameters`. Likewise, do not collapse the core + advanced stages back into a single 5-option question.

### Phase 2: Reuse-first proposal

Compare the user's stated needs against every existing template's `config`. For each existing template, compute how many config keys would need to change to match the user's intent.

Recommend one of three paths:

1. **Use an existing template as-is** — if one matches exactly. Name it and explain why it fits. Done (skip to Phase 6 — no template to create).

2. **Extend a close match** — if an existing template covers most needs with ≤3 key differences. Clone its `config` as the starting delta, list what changes. Name the differentiator explicitly, e.g. "this is `feature` minus `plan_review`, with `implementer` on `sonnet`".

3. **Build fresh** — if no existing template is close (>3 key differences from all candidates). Start from an empty config delta.

If two templates fit comparably, present both with their config deltas side by side and let the user pick the base.

Always explain the recommendation before proceeding. If the user disagrees, follow their lead.

### Phase 3: Scope (mandatory — never infer or default silently)

You **MUST** explicitly ask the user where to save the template. Do not infer scope from context, skip this step, or default silently.

Use `AskUserQuestion`:

**"Where should this template be saved?"**

| Option | Location | Visibility | Notes |
|--------|----------|------------|-------|
| **Project** (default) | `.claude/templates/` | Git-shared, team-wide | Checked into the repo; all team members get it |
| **User** | `~/.worca/templates/` | Personal, cross-project | Only on your machine; works across all your projects |

Explain: project-scope templates override user-scope templates on ID collision (project > user > built-in). Built-in IDs cannot be reused — the resolver rejects them.

The answer maps to the CLI flag: user scope → `--global`, project scope → default (no flag).

### Phase 4: Compose minimal config delta

Build a `template.json` payload with only the keys that differ from the project default settings. This is the core value — a minimal delta, not a full settings snapshot.

Required fields:
- `id` — lowercase alphanumeric + hyphens, 1-64 chars (regex: `^[a-z0-9-]{1,64}$`)
- `name` — human-readable, ≤80 chars
- `description` — one sentence explaining the template's purpose and key differentiators
- `tags` — ≤5 tags, each `^[a-z0-9-]{1,20}$`
- `config` — the minimal delta dict (only keys that differ from defaults)

Optional:
- `params` — `{key: {description, default}}` for any `{{placeholder}}` values used in the config

Propose the `id` and `name` to the user and let them adjust. The `id` must not collide with a built-in template.

Show the user the composed JSON before writing. Highlight what each config key does.

### Phase 5: Validate and write via CLI

Write the composed JSON to a temporary file, then create the template using the CLI:

```bash
# Project scope (default):
worca templates create --from-file /tmp/template-<id>.json

# User scope:
worca templates create --from-file /tmp/template-<id>.json --global
```

The CLI routes through `TemplateResolver.save()`, which validates all fields (`id` regex, `name` length, tag count/format, `config` is a dict) and rejects built-in ID collisions. If validation fails, it prints structured per-field error details — relay them to the user and offer to fix.

After successful creation, confirm with:

```bash
worca templates show <id>
```

### Phase 6: Offer dry-run and next steps

After the template is created (or if an existing template was selected in Phase 2), offer:

1. **Dry-run test** — "Want to test it? Run: `worca run --template <id> --dry-run`"
2. **Launch a pipeline** — "Ready to use it? `worca run --worktree --template <id> --source gh:issue:N`"
3. **UI launcher** — "Or select it from the template dropdown in the worca-ui launcher"

### Phase 7: Export (when user says "export", "share", "bundle")

Guides the user through exporting one or more templates as a portable bundle JSON file, with automatic secret redaction.

1. **Template selection** — Run `worca templates list --json` to enumerate available templates. Present a multi-select picker via `AskUserQuestion` showing only project and user-tier templates (builtins are excluded by default). Let the user pick which templates to include.

2. **Models and pricing opt-in** — Ask via `AskUserQuestion` whether to include:
   - `worca.models` from `settings.json` (model aliases and IDs — env-block keys are preserved as a scaffold, secret values are replaced with `<YOUR-SECRET-HERE>`)
   - `worca.pricing` from `settings.json` (cost tracking config)

   Default both to No. Explain that:
   - Env keys are **preserved** so the importer sees which vars to fill in; only values matching known secret patterns (Anthropic `sk-…`, GitHub `ghp_…` / `github_pat_…`, Slack `xoxb-…`/`xoxp-…`, AWS `AKIA…`) are replaced with `<YOUR-SECRET-HERE>`.
   - Inside each `templates[*].config`, only the safe-to-share subtrees (`stages`, `agents`, `effort`, `loops`, `circuit_breaker`, `models`) pass through. `webhooks`, `integrations`, `governance`, `graphify`, `crg` are stripped wholesale and listed under `_stripped`.
   - Only `settings.json` is read; `settings.local.json` is never opened.

3. **Destination** — Ask via `AskUserQuestion`:
   - **Local file** — write to a file path (e.g. `./my-templates.json`)
   - **GitHub gist (secret)** — unlisted gist, shareable via URL
   - **GitHub gist (public)** — search-indexed, visible to everyone

4. **Run the export:**

   ```bash
   worca templates export --to <dest> [--include-models] [--include-pricing] --templates <id1>,<id2>,...
   ```

   For gist destinations, use `--to gist` (secret) or `--to gist:public`.

5. **Report results** — Show the user:
   - The `_redacted` list (per-value secret matches, replaced with `<YOUR-SECRET-HERE>`)
   - The `_stripped` list (config subtrees removed wholesale by the allowlist — e.g. `templates[0].config.webhooks`)
   - The output location (file path or gist URL)
   - A reminder that the bundle never includes `settings.local.json` secrets
   - For each `<YOUR-SECRET-HERE>` value, the importer will need to fill in the real secret locally — the env scaffold tells them which keys are expected

### Phase 8: Import (when user says "import", "load bundle")

Guides the user through importing templates (and optionally models/pricing) from a bundle file, URL, or GitHub gist.

1. **Source selection** — Ask via `AskUserQuestion`:
   - **Local file** — path to a `.json` bundle file
   - **URL** — HTTPS URL to a hosted bundle (1 MiB size cap; redirects blocked; private/loopback/link-local hosts refused)
   - **GitHub gist** — gist URL or bare gist ID

   ⚠️ Imported bundles are config-as-data: they get merged into `settings.json` and drive subsequent pipeline runs. **Only import bundles from sources you trust** — the HTTPS hardening covers obvious SSRF cases but cannot defend against a malicious upstream.

2. **Target scope** — Ask via `AskUserQuestion`:
   - **Project** (default) — writes templates to `.claude/templates/`, merges models/pricing into the project `.claude/settings.json`
   - **User** — writes templates to `~/.worca/templates/` and merges models/pricing into the user-global `~/.worca/settings.json` (the file `load_global_settings()` reads at runtime; deep-merged under project settings on overlap)

3. **Run the import:**

   ```bash
   worca templates import --from <source> --scope <scope>
   ```

4. **Collision handling** — If the CLI detects collisions (template IDs that already exist in the target scope), relay the collision list to the user via `AskUserQuestion` with per-item choices:
   - **Replace** — overwrite the existing entry
   - **Skip** — keep the existing entry
   - **Abort** — cancel the entire import

   If all items are skipped or replaced, re-run with the appropriate flags. If the user aborts, stop.

   Same-id builtin templates do not collide (project-tier shadows builtin by design) but the CLI surfaces an `info: shadowing builtin template '<id>'` line so the user knows it's happening.

5. **Import is rolled back on failure** — the CLI snapshots every existing template directory and `settings.json` to `.bak-<rand>` siblings before mutating, then deletes them on success. If any step fails (disk full, permission, cross-device `os.replace`), all changes are reverted in place. No partial-write state is left behind.

6. **Forward-compat schema versioning** — `worca_bundle_version: 1` and any future `1.N` are accepted; minor mismatches log a warning but proceed. Major-version mismatches (e.g. `2`) are rejected.

7. **Placeholder follow-up** — if the bundle landed any `<YOUR-SECRET-HERE>` values into `settings.worca.models[*].env.*` or `templates[*].config.agents.*.env.*`, the CLI emits an `info:` list of the paths needing real secrets. Surface that list to the user verbatim and remind them to replace each placeholder before running the pipeline.

8. **Confirmation** — After a successful import, verify with:

   ```bash
   worca templates list --json
   ```

   Show the user the updated template list, highlighting the newly imported entries.

## Out of Scope (v1)

These are explicitly deferred to follow-up work:

- **Agent-prompt overrides** — `agents/<agent>.md` / `.block.md` overlays exist in the template system (`src/worca/orchestrator/overlay.py`) but authoring them via this skill is deferred.
- **UI-based template creation** — the UI stays list/select only.
- **UI-based import/export** — import/export is CLI + skill only; no UI integration.
- **Editing or cloning existing templates** — this skill creates new templates only. Use `worca templates delete` + re-create to replace.
- **Approval gate configuration** — `milestones.plan_approval`, `pr_approval`, `deploy_approval` are configurable in the config delta but not surfaced as a separate interview question in v1. Users who need them can specify via the "other" path or edit the composed JSON.
- **Loop limit tuning** — `loops.implement_test`, `loops.pr_changes`, etc. are settable in the config delta but not individually interviewed. The rigor level sets sensible defaults.
- **Encrypted bundles / signing** — the redaction approach prevents accidental secret leakage; intentional secret sharing requires a different mechanism.
- **Auth headers for private URLs** — fetching bundles from authenticated HTTPS endpoints is not supported in v1.
- **Bidirectional sync** — tracking an upstream gist for updates is deferred.

## Failure Modes

- **`worca` CLI not installed** — if `worca templates list --json` fails, fall back to reading `template.json` files directly from the three tier directories. If none exist, proceed with an empty baseline and note that only built-in templates will be available after `worca init`.
- **`worca templates create` fails validation** — relay the structured error details to the user. Offer to fix the offending fields and retry.
- **Built-in ID collision** — the CLI rejects it. Suggest an alternative ID (e.g. `my-bugfix` instead of `bugfix`).
