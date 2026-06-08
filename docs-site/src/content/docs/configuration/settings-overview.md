---
title: Settings overview
description: Where worca's configuration lives and how the Settings panel edits it.
sidebar:
  order: 1
---

Every project's configuration lives under a `worca` namespace in `.claude/settings.json`. You rarely edit that file by hand — the dashboard's **Settings** panel writes it for you, and changes take effect immediately without restarting.

## The Settings panel

Open a project's **Settings** — found in the sidebar under **Project Configuration → Project Settings**, alongside its sibling [**Pipeline Templates**](/configuration/pipeline-templates/) — to configure agent models and turns, stages, governance, circuit breaker, pricing, webhooks, integrations, and preflight checks. Both entries are hidden in global all-projects mode until you select a project. Saves are written to `.claude/settings.json` and are effective on the next run.

Saves are **locked while a pipeline is running** to prevent mid-run config drift — finish or stop the run before changing settings.

![The Project Configuration sidebar group with Project Settings open, its subpanels (Stages, Agents, Governance, Circuit Breaker, Webhooks) visible, and Pipeline Templates listed as its sibling entry.](/screenshots/settings-overview/01-sidebar-group.png)

## Three places config lives

| File | Scope | Holds |
|---|---|---|
| `.claude/settings.json` | Per project, committed | The bulk of worca config (stages, agents, governance, loops, webhooks). |
| `.claude/settings.local.json` | Per project, **gitignored** | [Secrets](/configuration/secrets/) — API keys, tokens. Deep-merged over `settings.json`. |
| `~/.worca/settings.json` | Global, all projects | Cross-project preferences: worktree cleanup policy, concurrency cap, disk-warning threshold, classifier model. |

The **Preferences** tab edits the global file; everything else edits the project file. If a project's `settings.json` still carries keys that belong in the global file, the panel shows a one-click migration banner.

:::tip
Secrets must never go in `settings.json` (it's committed). The Secrets panel writes exclusively to the gitignored `settings.local.json`. See [Secrets](/configuration/secrets/).
:::

The per-key reference is in [settings.json reference](/reference/settings/). For how these three files combine with user settings and named templates at run launch, see [Configuration precedence](/configuration/precedence/).
