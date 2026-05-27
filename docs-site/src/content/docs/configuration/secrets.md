---
title: Secrets
description: Where API keys and tokens go, and why they never touch committed config.
sidebar:
  order: 4
---

Secrets — API keys, tokens, alternate-endpoint credentials — must never live in `.claude/settings.json`, because that file is committed to the repo. worca keeps them in a separate, gitignored file.

## The Secrets panel

The **Secrets** panel in Settings writes exclusively to `.claude/settings.local.json`. That file is gitignored (added automatically by `worca init`) and is **deep-merged over** `settings.json` at runtime — so a secret in the local file fills in or overrides the matching key without you duplicating the rest of the config.

:::note[Screenshot — coming soon]
The Secrets panel writing to settings.local.json.
:::

## Reserved keys

A handful of environment keys are managed by worca and can't be set as secrets — anything matching `WORCA_*`, `PATH`, or `CLAUDECODE` is silently stripped with a warning. This prevents a secret from clobbering the variables the pipeline relies on.

## Secrets in worktrees

Each run executes in an isolated git worktree. The parent project's `settings.local.json` secrets are **materialized into the worktree's own gitignored `settings.json`** so agents can use them — the same on-disk plaintext exposure model as `~/.aws/credentials`. They're never committed.

:::caution
Treat `settings.local.json` like any credentials file: it sits in your working tree in plaintext. It's gitignored, but back it up and protect it accordingly.
:::
