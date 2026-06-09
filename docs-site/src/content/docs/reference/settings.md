---
title: settings.json reference
description: The worca configuration namespace, key by key.
sidebar:
  order: 3
---

worca configuration lives under a `worca` key in `.claude/settings.json`. **The recommended way to edit it is the dashboard's [Settings panel](/configuration/settings-overview/)** — it writes every key below for you, validates as you go, and keeps secrets out of the committed file. This page is the underlying key map, for when you're scripting `settings.json`, reviewing a diff, or reaching for a key the UI doesn't surface. The **UI panel** column points to where each section lives in the dashboard.

## Files

| File | Scope |
|---|---|
| `.claude/settings.json` | Per project, committed. The bulk of config. |
| `.claude/settings.local.json` | Per project, gitignored. [Secrets](/configuration/secrets/); deep-merged over `settings.json`. |
| `~/.worca/settings.json` | Global. Cross-project preferences. |

## The `worca` namespace

Sections marked **† template-owned** are stripped from the merge base when a template is in play at run launch (explicit `--template` or `worca.default_template` fallback) — the selected template's `config` provides them instead. See [Configuration precedence](/configuration/precedence/).

| Section | Controls | UI panel | See |
|---|---|---|---|
| `worca.default_template` | Template id pinned as the project default; every run uses it unless `--template` overrides at launch. | Settings (per-project) | [Configuration precedence](/configuration/precedence/) |
| `worca.claude_md_mode` | Per-run CLAUDE.md load mode (`all` / `project` / `project+local` / `none`). Cross-template. | Pipeline Templates editor → Pipeline tab → CLAUDE.md Load Mode | [CLAUDE.md load mode](/configuration/claude-md-mode/) |
| `worca.stages` **†** | Enable/disable stages; override the agent per stage. `stages.preflight` is a cross-template carve-out and survives strip. | Pipeline Templates editor → Pipeline tab | [Stages](/configuration/stages/) |
| `worca.agents` **†** | Per-agent `model`, `max_turns`, `effort`. | Pipeline Templates editor → Agents tab | [Agents & models](/configuration/agents-and-models/) |
| `worca.models` | Alias → model ID (string) or `{id, env}` profile. | Models page (top-level) | [Models](/configuration/models/) · [Adding & routing models](/advanced/adding-models/) |
| `worca.pricing` | Per-model rates + project-wide currency, budgets, and `server_tools` rates. | Models page (per-alias accordion) + Settings → Costs & Budgets | [Models](/configuration/models/) |
| `worca.effort` **†** | `auto_mode`, `auto_cap` for adaptive effort. | Pipeline Templates editor → Agents tab → Effort mode | [Tuning effort](/advanced/tuning-effort/) |
| `worca.loops` **†** | Max iterations for the test / review / planning loops. | Pipeline Templates editor → Pipeline tab → Loops | [Loops & circuit breaker](/configuration/loops-and-circuit-breaker/) |
| `worca.circuit_breaker` **†** | Error classification and halt thresholds. | Pipeline Templates editor → Pipeline tab → Circuit Breaker | [Loops & circuit breaker](/configuration/loops-and-circuit-breaker/) |
| `worca.governance.dispatch` **†** | Per-agent `tools` / `skills` / `subagents` allowlists. | Pipeline Templates editor → Governance tab | [Dispatch governance](/advanced/dispatch-governance/) |
| `worca.governance.guards` | Hook guards (e.g. `block_graphify_mutation`). Cross-template. | Settings → Governance → Guard Rules | [Dispatch governance](/advanced/dispatch-governance/) |
| `worca.milestones` **†** | Approval gates (`plan_approval`, `pr_approval`, `deploy_approval`). | Pipeline Templates editor → Pipeline tab → Approval Gates | [Controlling a run](/running-pipelines/controlling-a-run/) |
| `worca.webhooks` | Outbound event subscriptions. | Settings → Webhooks | [Webhooks](/integrations/webhooks/) |
| `worca.graphify` | Knowledge-graph `enabled` / `mode`. | Settings → Graphify | [Knowledge graph](/advanced/knowledge-graph/) |
| `worca.guide` | `max_bytes` cap on combined guide content. | Settings → Fleet & guide | [Guides](/advanced/guides/) |
| `worca.fleet` | Fleet defaults (e.g. `init_timeout_seconds`). | Settings → Fleet & guide | [Fleet runs](/advanced/fleet-runs/) |
| `worca.workspace` | Workspace defaults (`max_parallel`, `context_cap_bytes`, `failure_threshold`). | File only | [Workspace runs](/advanced/workspace-runs/) |

## Global preferences

These four keys live in `~/.worca/settings.json` (under `worca.`), not the project file:

| Key | Default | Meaning |
|---|---|---|
| `parallel.cleanup_policy` | `never` | When finished worktrees are auto-removed. |
| `parallel.max_concurrent_pipelines` | `10` | Host-wide concurrent-run cap. |
| `ui.worktree_disk_warning_bytes` | `2000000000` | Worktree disk-warning threshold (2 GB). |
| `circuit_breaker.classifier_model` | `haiku` | Model that classifies errors as retryable or fatal. |

All four are editable in the dashboard — cleanup policy and the disk-warning threshold under **Settings → Worktrees**, the concurrency cap and classifier model under **Settings → Pipeline Execution**. The Settings panel also migrates them automatically if it finds them in the project file.

:::tip
Reserved environment keys (`WORCA_*`, `PATH`, `CLAUDECODE`) are stripped from any `env` map with a warning. Secrets must go in `settings.local.json`, never the committed file.
:::
