---
name: worca-template
description: Guided pipeline-template authoring — interviews the user for intent, proposes reusing or extending existing templates, composes a minimal config delta, and writes it via CLI. Triggers on "new template", "create pipeline template", "create template", "customize my pipeline", "worca-template".
---

# Worca Template

Guided creation of pipeline templates. Interviews the user, proposes reusing or extending existing templates before building from scratch, composes a *minimal config delta* (not a settings snapshot), and writes it via the CLI with full validation.

**Usage:**
- `/worca-template` — start the guided interview
- "create a new template" / "new pipeline template" / "customize my pipeline" — natural phrases

## Procedure

### Phase 0: Enumerate existing templates

Run the CLI to discover all templates across all three tiers (built-in, project, user):

```bash
worca templates list --json
```

This returns a JSON array with `{id, name, description, tier, tags, builtin, created_at}` per entry. The resolver enforces user > project > built-in priority on ID collision — the JSON reflects what will actually be applied at runtime.

For each template, also read its `config` to understand what it overrides. Use `worca templates show <id>` for each, or read the `template.json` files directly:
- Built-in: `.claude/worca/templates/*/template.json`
- Project: `.claude/templates/*/template.json`
- User: `~/.worca/templates/*/template.json`

Summarize the available templates to the user in one compact table: ID, tier, and a one-line diff summary (e.g. "disables test+review+PR, sonnet implementer" for `quick-fix`).

### Phase 1: Intent interview

Use **batched `AskUserQuestion`** — present all questions in a single message so the user answers them at once, not iteratively.

Ask these questions (adapt phrasing to what you already know from the conversation):

1. **Purpose / use-case** — "What kind of work is this template for?" Options: feature development, bug fixing, refactoring, investigation/analysis, test coverage, quick one-off fix, other.

2. **Rigor vs speed** — "How thorough should the pipeline be?" Options:
   - Full rigor (plan review + learn + all approval gates)
   - Balanced (standard stages, no extra gates)
   - Fast (skip optional stages, minimal loops)
   - Minimal (bare minimum — plan + implement only)

3. **Stages to toggle** — "Which optional stages should be ON?" (multi-select). Options:
   - Plan review (`stages.plan_review.enabled`)
   - Test (`stages.test.enabled`)
   - Code review (`stages.review.enabled`)
   - PR creation (`stages.pr.enabled`)
   - Learn (`stages.learn.enabled`)

   Pre-select based on the rigor answer. Let the user override.

4. **Model tier** — "Which model tier for key agents?" Options:
   - All Opus (thorough, slower)
   - Opus planning + Sonnet implementation (balanced — the default)
   - All Sonnet (fastest, lower quality on complex tasks)
   - Custom (will ask per-agent in a follow-up)

If the user selected "Custom" for model tier, ask a follow-up with per-agent model selection for planner, coordinator, implementer, tester, and reviewer.

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

Explain: user-scope templates override project-scope templates on ID collision (user > project > built-in). Built-in IDs cannot be reused — the resolver rejects them.

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

## Out of Scope (v1)

These are explicitly deferred to follow-up work:

- **Agent-prompt overrides** — `agents/<agent>.md` / `.block.md` overlays exist in the template system (`src/worca/orchestrator/overlay.py`) but authoring them via this skill is deferred.
- **UI-based template creation** — the UI stays list/select only.
- **Editing or cloning existing templates** — this skill creates new templates only. Use `worca templates delete` + re-create to replace.
- **Approval gate configuration** — `milestones.plan_approval`, `pr_approval`, `deploy_approval` are configurable in the config delta but not surfaced as a separate interview question in v1. Users who need them can specify via the "other" path or edit the composed JSON.
- **Loop limit tuning** — `loops.implement_test`, `loops.pr_changes`, etc. are settable in the config delta but not individually interviewed. The rigor level sets sensible defaults.

## Failure Modes

- **`worca` CLI not installed** — if `worca templates list --json` fails, fall back to reading `template.json` files directly from the three tier directories. If none exist, proceed with an empty baseline and note that only built-in templates will be available after `worca init`.
- **`worca templates create` fails validation** — relay the structured error details to the user. Offer to fix the offending fields and retry.
- **Built-in ID collision** — the CLI rejects it. Suggest an alternative ID (e.g. `my-bugfix` instead of `bugfix`).
