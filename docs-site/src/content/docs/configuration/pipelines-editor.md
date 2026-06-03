---
title: Pipelines editor
description: Browse, create, edit, duplicate, and delete pipeline templates from the dashboard.
sidebar:
  order: 3
---

The **Pipelines** section in the dashboard gives you full control over pipeline templates without touching the CLI or editing JSON by hand. You can browse every template across all three tiers (built-in, user, project), create new ones with a structured form, duplicate built-ins as a starting point, and set a project default — all from the same surface you use to launch runs.

## Opening the editor

Click **Pipelines** in the sidebar. The list view shows every template grouped by tier, with deduplication applied: if a template id exists in multiple tiers, you see one card with the winning tier highlighted and a "shadows" hint showing which tiers it overrides. The current project default is marked with a **★ Default** badge.

## Template tiers and shadowing

Templates resolve by id — project beats user beats built-in, with no cross-tier merging. The list view surfaces this explicitly:

| Badge | Meaning |
|---|---|
| **Project** | Defined in `.claude/templates/` — committed, shared with the team. |
| **User** | Defined in `~/.worca/templates/` — available across all your projects. |
| **Built-in** | Shipped with worca. Read-only — you can duplicate but not edit in place. |

When a project template shadows a built-in of the same id, the card shows "Shadows: built-in" so you know the built-in exists but isn't in effect.

For the full merge story — how templates interact with project settings, model aliases, and CLI overrides — see [Configuration precedence](/configuration/precedence/).

## Creating a template

Click **New template** in the list view. The editor opens with a structured form covering every template-owned key:

- **Stages** — toggle each of the nine pipeline stages on or off. Each row shows the agent it dispatches to.
- **Agents** — per-agent settings: model (picked from your `worca.models` aliases), max turns, and effort level.
- **Loops** — iteration limits for the implement/test, review, and plan-review retry loops.
- **Circuit breaker** — enable/disable, max consecutive failures, classifier toggles.
- **Governance dispatch** — per-agent allowlists for tools, skills, and subagents.

Pick a **scope** (project or user) and an **id** (the name you'll reference at launch), fill in the sections you want to customize, and save. Keys you leave blank inherit their defaults — the editor only writes the delta, keeping your template lean and upgrade-friendly.

:::tip[Start from a built-in]
Rather than authoring from scratch, duplicate an existing template and tweak it. The built-in templates (`feature`, `quick-fix`, `bugfix`, `refactor`, …) are good starting points.
:::

## Editing a template

Click **Edit** on any project or user template card to open the editor with the current values pre-filled. Changes are validated on save — the editor runs the same deep-merge simulation the pipeline uses at launch and flags any issues before writing.

Built-in templates are read-only. Clicking **Edit** on a built-in prompts you to duplicate it to your project or user scope first.

## JSON toggle

Every editor section has a **JSON** toggle that shows the raw config for that template. You can switch freely between the structured form and JSON — edits in one are reflected in the other. This is useful for power users who want to paste a config snippet or inspect the exact shape being written.

Saving from the JSON view runs server-side validation first, so malformed config is caught before it hits disk.

## Duplicating a template

Click **Duplicate** on any card. You'll be asked for a new id and a destination scope (project or user). The copy is independent — editing it won't affect the original.

Common workflow: duplicate a built-in → customize stages and agent models → set as default.

## Setting a project default

Click **Set as default** on any template card. This writes `worca.default_template` in your project's `.claude/settings.json`, so every run uses that template unless you override with `--template` at launch.

The **★ Default** badge moves to the newly selected card. To clear the default (so runs use raw project settings with no template), remove the `worca.default_template` key from Settings or use the **Clear default** action.

:::caution[Template-owned keys are stripped when a default is set]
Once a default template is in play, project settings for `agents`, `stages`, `loops`, `circuit_breaker`, `effort`, and `governance.dispatch` are stripped — the template owns those keys outright. Cross-template keys (models, webhooks, pricing, etc.) are unaffected. See [Template-driven keys](/configuration/precedence/#template-driven-keys).
:::

## Exporting and importing

- **Export:** click **Export bundle** on any template card. The bundle is a JSON file with secrets redacted — safe to share with teammates or commit to a repo.
- **Import:** click **Import** in the list view and upload a bundle file, paste a URL, or enter a GitHub gist ID. If the imported id collides with an existing template in the target scope, you'll be prompted to rename or overwrite.

For the full export/import workflow including CLI commands, see [Authoring, sharing & importing templates](/advanced/authoring-templates/).

## In-flight run guards

Deleting or editing a template that is currently used by running pipelines shows a confirmation dialog with the count of in-flight runs. This prevents accidental disruption — templates resolve at run start, so existing runs aren't affected, but the guard makes the relationship visible.

## See also

- [Configuration precedence](/configuration/precedence/) — how templates, settings, and CLI overrides merge at launch.
- [Settings overview](/configuration/settings-overview/) — where Settings writes and the three on-disk config files.
- [Authoring, sharing & importing templates](/advanced/authoring-templates/) — the CLI and `/worca-template` skill for scripting and CI.
