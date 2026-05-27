---
title: settings.json reference
description: The worca configuration namespace, key by key.
sidebar:
  order: 3
---

worca configuration lives under a `worca` key in `.claude/settings.json`. The dashboard's [Settings panel](/configuration/settings-overview/) writes most of it; this is the key map for when you edit directly.

## Files

| File | Scope |
|---|---|
| `.claude/settings.json` | Per project, committed. The bulk of config. |
| `.claude/settings.local.json` | Per project, gitignored. [Secrets](/configuration/secrets/); deep-merged over `settings.json`. |
| `~/.worca/settings.json` | Global. Cross-project preferences. |

## The `worca` namespace

| Section | Controls | See |
|---|---|---|
| `worca.stages` | Enable/disable stages; override the agent per stage. | [Stages](/configuration/stages/) |
| `worca.agents` | Per-agent `model`, `max_turns`, `effort`. | [Agents & models](/configuration/agents-and-models/) |
| `worca.models` | Alias → model ID (string) or `{id, env}` profile. | [Adding & routing models](/advanced/adding-models/) |
| `worca.effort` | `auto_mode`, `auto_cap` for adaptive effort. | [Tuning effort](/advanced/tuning-effort/) |
| `worca.loops` | Max iterations for the test / review / planning loops. | [Loops & circuit breaker](/configuration/loops-and-circuit-breaker/) |
| `worca.circuit_breaker` | Error classification and halt thresholds. | [Loops & circuit breaker](/configuration/loops-and-circuit-breaker/) |
| `worca.governance` | Hook guards and the three-tier `dispatch` rules. | [Dispatch governance](/advanced/dispatch-governance/) |
| `worca.milestones` | Approval gates (`plan_approval`, `pr_approval`). | [Controlling a run](/running-pipelines/controlling-a-run/) |
| `worca.webhooks` | Outbound event subscriptions. | [Webhooks](/integrations/webhooks/) |
| `worca.graphify` | Knowledge-graph `enabled` / `mode`. | [Knowledge graph](/advanced/knowledge-graph/) |
| `worca.guide` | `max_bytes` cap on combined guide content. | [Guides](/advanced/guides/) |
| `worca.fleet` | Fleet defaults (e.g. `init_timeout_seconds`). | [Fleet runs](/advanced/fleet-runs/) |
| `worca.workspace` | Workspace defaults (`max_parallel`, `context_cap_bytes`, `failure_threshold`). | [Workspace runs](/advanced/workspace-runs/) |

## Global preferences

These four keys live in `~/.worca/settings.json` (under `worca.`), not the project file:

| Key | Default | Meaning |
|---|---|---|
| `parallel.cleanup_policy` | `never` | When finished worktrees are auto-removed. |
| `parallel.max_concurrent_pipelines` | `10` | Host-wide concurrent-run cap. |
| `ui.worktree_disk_warning_bytes` | `2000000000` | Worktree disk-warning threshold (2 GB). |
| `circuit_breaker.classifier_model` | `haiku` | Model that classifies errors as retryable or fatal. |

The Settings panel migrates these automatically if it finds them in the project file.

:::tip
Reserved environment keys (`WORCA_*`, `PATH`, `CLAUDECODE`) are stripped from any `env` map with a warning. Secrets must go in `settings.local.json`, never the committed file.
:::
