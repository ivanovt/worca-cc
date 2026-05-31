---
title: Authoring, sharing & importing templates
description: Create your own pipeline template — guided via the worca-template skill — then share it as a bundle, or import bundles from teammates.
sidebar:
  order: 6
---

A [template](/concepts/pipeline-templates/) bundles a pipeline configuration — which stages run, agent models and effort, loop limits, governance — behind a single name you pick at launch. This page covers the three things you'll do with templates beyond the built-ins: **author** one, **share** one (export), and **import** one a teammate made.

The easiest path for all three is the guided skill. CLI commands are documented further down for scripting and CI.

## The `/worca-template` skill (recommended for everything)

worca ships a guided skill that handles **authoring, exporting, and importing** in one place. In a Claude Code session in your project, trigger it by command or with a natural phrase. The skill picks which flow to run from what you say.

### Triggering it

```
/worca-template
```

Or a natural phrase — these all land on the same skill, which then decides whether to author, export, or import based on the wording:

| If you say something like… | The skill runs… |
|---|---|
| *"create a new pipeline template"* / *"new template for backend bug fixes"* / *"customize my pipeline"* | **Authoring** flow |
| *"export my templates"* / *"share my template"* / *"bundle templates"* | **Export** flow |
| *"import a template"* / *"load this bundle"* / *"install templates from a gist"* | **Import** flow |

You can also pass an explicit hint as an argument — `/worca-template export` or `/worca-template import` — if you want to skip the autodetect.

### Authoring flow

When you ask for a new template, the skill walks you through six phases:

1. **Enumerate existing templates.** Reads every built-in, project, and user template so it can reason about reuse.
2. **Intent interview.** Asks what kind of work the template is for, how strict the review needs to be, how cheap/fast vs. thorough it should be.
3. **Reuse-first proposal.** If an existing template already fits, it offers to point you there instead of creating a near-duplicate. If a close-but-imperfect match exists, it offers to extend it.
4. **Scope.** Asks whether the new template should be a **project template** (`.claude/templates/`, committable, shared with everyone on the repo) or a **user template** (`~/.worca/templates/`, available across every project on your machine). Never silently defaults — you always pick.
5. **Compose a minimal config delta.** Writes only the keys that *differ* from your baseline — not a full settings dump. This keeps the template robust across worca upgrades, because everything you didn't explicitly set continues to pick up the latest default.
6. **Validate and write via the CLI.** Runs through `worca templates create`, which validates the JSON shape, ID format, tag count/format, and rejects built-in ID collisions. Errors are returned per-field with a fix offer.

Then it offers next steps — a dry-run, a real launch, or a pointer to the launcher UI.

### Export flow

When you ask to share or export, the skill walks you through four choices and runs the CLI for you:

1. **Which templates to include.** Lists every project- and user-tier template (built-ins are excluded by default since they ship with worca). You multi-select.
2. **Models and pricing opt-in.** Asks whether to include your `worca.models` and/or `worca.pricing` from `settings.json`. Both default to **No**. When you opt in, the skill explains exactly what's carried and what's redacted (see [What's in a bundle](#whats-in-a-bundle-the-safety-model) below).
3. **Destination.** Three choices:
   - **Local file** — write to a path you specify (e.g. `./team-bundle.json`). Best for committing to a separate repo or attaching to an issue.
   - **GitHub gist (secret)** — unlisted, shareable via URL but not search-indexed. Best for sharing with a small group.
   - **GitHub gist (public)** — search-indexed, visible to everyone. Best for open-sourcing a template.
4. **Run the export and report results.** Surfaces the `_redacted` list (per-value secret replacements), the `_stripped` list (config subtrees removed wholesale), and the output location. Reminds you to inspect the bundle before sharing publicly.

### Import flow

When you ask to import or load a bundle, the skill walks you through three steps and handles every collision interactively:

1. **Source.** Three forms:
   - **Local file** — path to a `.json` bundle.
   - **HTTPS URL** — 1 MiB cap, redirects blocked, private/loopback/link-local hosts refused.
   - **GitHub gist** — gist URL or bare gist ID.

   Before fetching, the skill reminds you that bundles are config-as-data and warns about the [trust boundary](#trust-boundary).

2. **Target scope.** Either **project** (writes to `.claude/templates/`, merges models/pricing into `settings.json`) or **user** (writes to `~/.worca/templates/`; models and pricing are skipped because there's no user-level `settings.json`).

3. **Run the import, handle collisions, and follow up on placeholders.** For each template ID that already exists in the target scope, the skill asks **replace / skip / abort** — unrecognized input re-prompts, never silently skips. After the import:
   - If any `<YOUR-SECRET-HERE>` placeholder values landed, it lists every path needing a real secret and points you at [Secrets](/configuration/secrets/) for where to put them.
   - If the import landed templates that shadow built-ins, you get an `info:` line per shadow so it's visible, not silent.
   - On any failure, the rollback restores every replaced template and `settings.json` from the snapshots taken before mutation; nothing partial is ever committed.

### Why the skill is the recommended path

The minimal-delta authoring keeps your template forward-compatible; the interactive collision UI and placeholder follow-up keep imports safe; the destination/source pickers cover the cases you'd otherwise have to remember CLI flags for. CLI is still there when you need it — for CI, scripts, or one-shot operations — but the skill is the default.

## Direct CLI

For scripting, CI, and one-shot operations.

### Snapshot the current settings into a template

Alternatively, tune a project's settings until a run behaves the way you want, then snapshot them into a named template:

```bash
worca templates save my-workflow --description "Backend service changes with strict review"
```

This captures the project's current `worca` configuration as a **project template**. Add `--global` to save to your user scope (`~/.worca/templates/`) so it's available across every project:

```bash
worca templates save my-workflow --global --description "My standard workflow"
```

A snapshot captures everything, so trim it afterwards if you only meant to change a few keys — the skill avoids this by composing the delta directly.

### Manage templates

```bash
worca templates list
worca templates show my-workflow
worca templates delete my-workflow
worca templates create --from-file ./my-template.json   # or '-' for stdin
```

`worca templates list --json` emits a machine-readable array (id, name, description, tier, tags, builtin, created_at). Templates resolve in tiers — **project > user > built-in** — so a project template shadows a user one of the same name.

### Export to a bundle

```bash
# All non-builtin templates, to a local file:
worca templates export --to ./team-bundle.json

# Specific templates, plus model aliases:
worca templates export --to ./bundle.json \
  --templates my-workflow,backend-bugfix \
  --include-models

# Direct to a secret (unlisted) GitHub gist — prints the URL:
worca templates export --to gist

# Public, search-indexed gist:
worca templates export --to gist:public
```

Flags:

| Flag | Effect |
|---|---|
| `--to <dest>` | Destination: file path, `gist`, or `gist:public`. Required. |
| `--templates <ids>` | Comma-separated IDs to include. Default: all project + user templates. |
| `--include-models` | Carry `worca.models` from `settings.json` (env keys preserved, secret values redacted). |
| `--include-pricing` | Carry `worca.pricing` from `settings.json`. |

### Import from a bundle

```bash
# From a local file:
worca templates import --from ./team-bundle.json

# From an HTTPS URL (hardened — see Trust boundary below):
worca templates import --from https://example.com/bundles/team.json

# From a GitHub gist (URL or bare ID):
worca templates import --from https://gist.github.com/alice/abc123def456...

# Into the user scope instead of project:
worca templates import --from ./bundle.json --scope user

# CI / non-interactive: skip all collisions instead of prompting:
worca templates import --from ./bundle.json --non-interactive
```

Flags:

| Flag | Effect |
|---|---|
| `--from <src>` | Source: file path, HTTPS URL, or gist URL/ID. Required. |
| `--scope project\|user` | Where to install. Default `project`. User scope skips models/pricing (no user-level `settings.json`). |
| `--non-interactive` | Auto-skip every collision; never prompt. |

Collisions prompt interactively (`[r]eplace / [s]kip / [a]bort`); unrecognized input re-prompts. Imports are atomic with rollback (see [Rollback](#rollback-and-atomicity) below).

## What's in a bundle (the safety model)

Bundles are designed to be safe to share. Two layers run before anything is written.

**Layer 1 — config allowlist on `templates[*].config.*`.** Only known-safe pipeline behavior survives the export: `stages`, `agents`, `effort`, `loops`, `circuit_breaker`, `milestones`, `models`. Anything else — `webhooks`, `integrations`, `governance`, the `graphify` and `crg` knowledge-graph configs — is stripped wholesale and listed in the bundle's `_stripped` field for transparency. `graphify` and `crg` are stripped because they require external packages installed on the importer's machine; auto-importing them would silently change behavior once those packages appeared. Note that `governance.dispatch` is itself a template-owned key, but it's excluded from the bundle allowlist — built-ins rely on the orchestrator's `_DISPATCH_DEFAULTS`, and authored templates that need non-default dispatch must add it after import by editing the saved template directly.

**Layer 2 — per-value secret redaction** on what's left. Env-block **keys** are always preserved (so the importer sees which env vars are expected), but each **value** is checked against known secret prefixes — Anthropic `sk-…`, GitHub `ghp_…` / `github_pat_…`, Slack `xoxb-…` / `xoxp-…`, AWS `AKIA…`. Matches are replaced with the literal placeholder `<YOUR-SECRET-HERE>` and the JSON paths are listed in the bundle's `_redacted` field.

So a bundle export of a model with a real API key looks like this on the wire:

```jsonc
{
  "worca_bundle_version": 1,
  "exported_at": "2026-05-30T08:00:00Z",
  "templates": [ /* ... */ ],
  "models": {
    "opus": {
      "id": "claude-opus-4-6",
      "env": {
        "ANTHROPIC_BASE_URL": "https://proxy.example.com",  // preserved
        "ANTHROPIC_API_KEY": "<YOUR-SECRET-HERE>"            // value redacted, key kept
      }
    }
  },
  "_redacted": ["models.opus.env.ANTHROPIC_API_KEY"],
  "_stripped": ["templates[0].config.webhooks"]
}
```

The importer sees the env scaffold and knows *which* secret to fill in — without ever seeing yours.

The bundle never reads `settings.local.json` — your real secrets stay in the local file regardless of what you export.

:::caution
Redaction is a safety net for **accidental** secret inclusion. It only catches known-prefix patterns. If you've stored a non-standard token format, **inspect the bundle before sharing** — read the `_redacted` and `_stripped` arrays, then skim the file for anything you wouldn't paste into a public chat. A quick `worca templates export --to /tmp/preview.json` and a read is always the right move before posting publicly.
:::

### Filling in the placeholders

If the bundle landed any `<YOUR-SECRET-HERE>` values, the importer ends with a list of exactly which paths need real secrets:

```
info: 2 secret placeholder(s) landed — replace "<YOUR-SECRET-HERE>" before running the pipeline:
  - templates.my-workflow.config.agents.planner.env.ANTHROPIC_API_KEY
  - settings.worca.models.opus.env.FOO_TOKEN
```

Put the real values in `settings.local.json` (via the **Secrets** panel in Settings, or by hand) — see [Secrets](/configuration/secrets/) — and the placeholders are deep-merged away at runtime. The bundle on disk stays committable.

### Trust boundary

Bundles are **config as data**. On import they get merged into your `settings.json` and used to drive subsequent pipeline runs — so only import bundles from sources you trust.

worca hardens HTTPS fetches against the obvious slip-ups: redirects are blocked (the URL you typed *is* the bundle), and DNS resolution rejects private, loopback, link-local, reserved, and multicast addresses (no `http://169.254.169.254/`, no `https://localhost/`, no internal CIDRs). The size cap is 1 MiB. None of this defends against a hostile upstream — treat a bundle URL with the same care you'd treat a `curl | sh` URL.

### Rollback and atomicity

Imports are atomic with full rollback. Before any mutation, every existing template directory and `settings.json` is snapshotted to a `.bak-<rand>` sibling. If any step fails (disk full, cross-device `os.replace`, permission), every change is reverted and the backups restored. On success, the backups are deleted. No partial-write state is ever left behind.

### Schema forward compatibility

Bundles carry `worca_bundle_version`. The importer accepts the current major (`1`, `"1"`, `"1.0"`) and any forward-compat minor (`"1.1"`, `"1.5"`, …) — minor mismatches log a warning but proceed; unknown additive fields are preserved. A different major version is rejected outright.

## Where templates fit

Once saved, your template appears in the **Run Pipeline** launcher's dropdown and works with `worca run --template my-workflow`. When a template is in play, the **template-owned** keys in project settings — `worca.agents`, `worca.stages`, `worca.loops`, `worca.circuit_breaker`, `worca.effort`, `worca.governance.dispatch`, and `worca.milestones` — are stripped from the merge base before the template's `config` deep-merges over. Cross-template keys (`worca.models`, `worca.webhooks`, `worca.pricing`, `worca.governance.guards`, `worca.graphify`, `worca.code_review_graph`, and `stages.preflight` as a carve-out) still fall through from settings as before. A built-in template that doesn't declare a template-owned block falls to the runtime defaults baked into the orchestrator, **not** to your Settings values — so the built-ins ship with explicit declarations for every template-owned block. See [Configuration precedence](/configuration/precedence/) for the full strip-and-merge rules.

:::note
Templates can override agent **prompts** as well as config — see [Overriding agent prompts](/advanced/overriding-agent-prompts/).
:::
