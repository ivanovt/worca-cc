---
title: Secrets
description: Where API keys and tokens go, and why they never touch committed config.
sidebar:
  order: 4
---

Secrets — API keys, tokens, alternate-endpoint credentials — must never live in `.claude/settings.json`, because that file is committed to the repo. worca keeps them in a separate, gitignored file.

## Where secrets enter the system

You don't hand-edit a secrets file. Two UI surfaces write secrets to `.claude/settings.local.json` for you:

- **Model Editor** ([Models page](/configuration/models/)) — the **Environment variables** table on each model card writes its values to `settings.local.json`. The `id` field above it writes to `settings.json`. The id/env file split is enforced by the editor, so `ANTHROPIC_AUTH_TOKEN` for an alt-endpoint alias goes to the gitignored side automatically.
- **Settings → Secrets** (global Settings) — a free-form key/value editor for variables that aren't per-model (e.g. `GITHUB_TOKEN` for the guardian's PR creation).

Both write to the same `.claude/settings.local.json` file, which is gitignored (added automatically by `worca init`) and **deep-merged over** `settings.json` at runtime.

![The Model Editor showing the alias id field (writes to settings.json) and the Environment variables table beneath it (writes to settings.local.json). Each row carries a key/value pair with a delete button.](/screenshots/secrets/01-models-env.png)

## Reserved keys

A handful of environment keys are managed by worca and can't be set as secrets — anything matching `WORCA_*`, `PATH`, or `CLAUDECODE` is silently stripped with a warning. This prevents a secret from clobbering the variables the pipeline relies on.

## Secrets in worktrees

Each run executes in an isolated git worktree. The parent project's `settings.json` **and** `settings.local.json` are read by `worca init --worktree-propagation`; secrets from the parent are then **materialized into the worktree's own gitignored `settings.json`** so agents can use them — the same on-disk plaintext exposure model as `~/.aws/credentials`. They're never committed.

:::caution
Treat `settings.local.json` like any credentials file: it sits in your working tree in plaintext. It's gitignored, but back it up and protect it accordingly.
:::

## Sharing config without sharing secrets

When you export a template bundle (`worca templates export`), the export reads `settings.json` for structure and `settings.local.json` only to splice the alias `env` blocks back into the bundle's `models.json` member — and that splice runs through two passes of redaction before anything is written. A structural allowlist controls which config subtrees can leave the machine; a per-value scan replaces known-secret-format values (Anthropic, GitHub, Slack, AWS prefixes) with the placeholder `<YOUR-SECRET-HERE>` while keeping the env-var keys intact.

On import, an alias whose `env` contains `<YOUR-SECRET-HERE>` shows a danger **Not configured** badge on the Models page card and a red-bordered value cell in the editor. Save stays enabled — the badge is the discoverability signal that the recipient still needs to fill the placeholder in locally.

See [Share via export/import bundles](/advanced/authoring-templates/#share-via-exportimport-bundles) for the full mechanics, including the trust-boundary caveats around HTTPS sources.
