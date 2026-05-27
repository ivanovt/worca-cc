---
title: Upgrading worca
description: Keep the packages and each project's runtime in sync.
sidebar:
  order: 1
---

worca is two packages — the Python pipeline (the `worca` CLI) and the `@worca/ui` dashboard — and each project carries a copy of the pipeline runtime under `.claude/worca/`. Upgrading means bumping the packages, then refreshing each project's runtime.

## The two steps

```bash
pip install --upgrade worca-cc
npm install -g @worca/ui@latest
```

This updates the packages globally. It does **not** touch any project's files — each project's runtime is refreshed separately.

## Refresh each project

The easiest path is the dashboard: open a project's **Settings** and use the in-place upgrade — it runs the runtime refresh for you, no file copying. Or from the CLI, inside the project:

```bash
worca init --upgrade
```

This refreshes `.claude/worca/`, deep-merges any new default settings **non-destructively** (your tuned models, webhooks, and loop counts survive), and applies any required key migrations. Preview what it would change first with `worca init --check`.

## What `--upgrade` handles for you

- Refreshes the runtime copy from the installed package.
- Merges new default settings keys without overwriting your values.
- Applies key renames and path migrations deterministically.
- Extracts naturally-global keys into `~/.worca/settings.json`.
- Adds missing `.gitignore` entries and initializes beads if needed.

It's idempotent — running it twice is safe.

## Version-specific notes

Some releases carry breaking changes or one-time manual cleanup (notably projects that predate the v0.6.0 packaging migration). The authoritative, version-by-version changelog — including every removed flag, settings migration, and manual cleanup step — lives in [`MIGRATION.md`](https://github.com/SinishaDjukic/worca-cc/blob/master/MIGRATION.md) in the repo. Check it when jumping several versions.

:::tip
After upgrading, confirm the runtime matches the package: `worca init --check` reports any drift, and the project's `.claude/worca/__init__.py` version should match `python -c "import worca; print(worca.__version__)"`.
:::
