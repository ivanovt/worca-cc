---
title: CLI reference
description: Every worca subcommand and what it does.
sidebar:
  order: 1
---

The `worca` command is installed by `pip install worca-cc`. Run `worca --help` or `worca <command> --help` for the authoritative, version-matched flags.

```
worca {init,run,pause,stop,resume,status,multi-status,integrations,templates,cleanup,workspace,graphify}
```

## init

Initialize or upgrade worca in a project.

| Flag | Purpose |
|---|---|
| `--upgrade` | Upgrade an existing installation (migrates settings, refreshes the runtime). |
| `--force` | Overwrite everything (destructive reset to the template). |
| `--check` | Dry-run — show what would change. |
| `--source PATH` | Initialize from a local worca-cc checkout. |

## run

Run the pipeline. See [Running from the CLI](/advanced/running-from-the-cli/).

| Flag | Purpose |
|---|---|
| `--prompt TEXT` | Inline work request. |
| `--source REF` | External source (`gh:issue:42`, `bd:bd-abc`). |
| `--spec PATH` / `--plan PATH` | Spec file, or a plan that skips the Planner. |
| `--template ID` | Apply a template before running. |
| `--param KEY=VALUE` | Override a template parameter (repeatable). |
| `--msize N` / `--mloops N` | Turn / loop multipliers (1–10). |
| `--worktree` | Run in an isolated git worktree. |
| `--branch BRANCH` | Worktree base branch (`--worktree` only). |
| `--guide PATH` | Reference guide for planning (`--worktree` only, repeatable). |
| `--resume` | Resume from the last checkpoint. |

## pause / stop / resume / status

Lifecycle control for a run, by run ID:

```bash
worca pause <run-id>
worca stop <run-id>
worca resume <run-id>
worca status <run-id>
```

`worca multi-status` shows every parallel pipeline at once.

## templates

Manage pipeline templates. See [Authoring templates](/advanced/authoring-templates/).

| Subcommand | Purpose |
|---|---|
| `list [--json]` | List all resolvable templates. |
| `show <id>` | Show one template's definition. |
| `save <id> [--description ...] [--global]` | Snapshot current settings as a template. |
| `delete <id>` | Delete a project or user template. |

## cleanup

Remove finished worktrees. See [Worktree cleanup](/advanced/worktree-cleanup/).

| Flag | Purpose |
|---|---|
| `--all` | Remove all completed/failed worktrees. |
| `--run-id ID` | Remove one by run ID. |
| `--fleet-id ID` / `--workspace-id ID` | Remove a fleet/workspace and its children. |
| `--older-than DURATION` | e.g. `7d`, `24h`, `30m`. |
| `--dry-run` | Preview only. |

## workspace

| Subcommand | Purpose |
|---|---|
| `init <parent> [--force]` | Scaffold `workspace.json` from sibling git repos. |
| `migrate` | Convert a legacy `workspace.json` (`repos`) to the current schema (`projects`). |

See [Workspace runs](/advanced/workspace-runs/).

## graphify

Manage the [knowledge graph](/advanced/knowledge-graph/) integration.

| Subcommand | Purpose |
|---|---|
| `status` | Show effective config and detection state. |
| `recommend` | Survey the project and advise enable/skip. |
| `enable` / `disable` | Toggle Graphify for this project. |
| `update` | Build the current HEAD snapshot if missing. |
| `rebuild` | Delete and rebuild the current HEAD snapshot. |
| `gc` | Remove all cached snapshots for this repo. |

## integrations

`worca integrations status` shows chat-integration health from the UI server. See [Chat integrations](/integrations/chat-integrations/).
