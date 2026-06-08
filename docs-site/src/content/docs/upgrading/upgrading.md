---
title: Upgrading worca
description: Keep the packages and each project's runtime in sync.
sidebar:
  order: 1
---

worca is two packages — the Python pipeline (the `worca` CLI) and the `@worca/ui` dashboard — and each project carries a copy of the pipeline runtime under `.claude/worca/`. Upgrading is two steps: bump the packages, then refresh each project's runtime (which you do from the dashboard).

## Step 1 — update the packages

The packages are installed globally, so this step is a CLI command — there's no in-app button for it. It does **not** touch any project's files:

```bash
pip install --upgrade worca-cc
npm install -g @worca/ui@latest
```

Restart the dashboard afterwards with `worca-ui restart` so it picks up the new version.

## Step 2 — refresh each project from the dashboard

Open **Settings → Projects** to see every registered project at a glance. Each row carries a version chip showing the worca runtime that project currently has installed — when it lags behind the package you just upgraded, the chip turns **orange** and an **Update** button appears.

![The Settings → Projects list with one row per project. The orange `worca-cc: <version>` chip flags projects whose runtime is behind the installed package; clicking Update triggers an in-place upgrade for that project.](/screenshots/upgrading/02-project-list.png)

Click **Update** — worca refreshes `.claude/worca/` for that project, merges any new default settings **non-destructively** (your tuned models, webhooks, and loop counts survive), and applies any required migrations. No file copying, no terminal.

Further down the same Settings page, the **Worca Versions** card shows the installed vs latest version for both packages plus the path the dashboard is running from — useful when you want to confirm a package-level upgrade actually took effect before refreshing project runtimes.

![Worca Versions card showing installed vs latest worca-cc and @worca/ui versions side by side, with a Refresh button.](/screenshots/upgrading/01-versions.png)

If a project's settings still carry keys that have since moved (for example to the global preferences file), Update also writes the relocated keys — saving any settings change applies it.

:::tip[Prefer the CLI?]
The dashboard runs `worca init --upgrade` for you. You can run it yourself inside a project — `worca init --check` previews the changes first. See the [CLI reference](/reference/cli/#init).
:::

## What the refresh handles for you

Whether you click it in Settings or run `worca init --upgrade`, the refresh:

- replaces the runtime copy from the installed package;
- merges new default settings keys without overwriting your values;
- applies key renames and path migrations deterministically;
- extracts naturally-global keys into `~/.worca/settings.json`;
- **(0.46+)** auto-migrates customized template-owned keys into an auto-generated `_legacy-settings` project template and pins it as `worca.default_template`, so existing behavior carries forward through the [Phase 1 strip semantics](/configuration/precedence/) with no observable change;
- adds missing `.gitignore` entries and initializes beads if needed.

It's idempotent — doing it twice is safe.

## Version-specific notes

Some releases carry breaking changes or one-time manual cleanup (notably projects that predate the v0.6.0 packaging migration). The authoritative, version-by-version changelog — including every removed flag, settings migration, and manual cleanup step — lives in [`MIGRATION.md`](https://github.com/SinishaDjukic/worca-cc/blob/master/MIGRATION.md) in the repo. Check it when jumping several versions.

:::tip
After upgrading, confirm the runtime matches the package: the Settings panel flags any drift, and `worca init --check` reports it from the CLI.
:::
