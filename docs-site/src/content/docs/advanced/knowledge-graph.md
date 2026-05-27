---
title: Knowledge graph (Graphify)
description: An optional code knowledge graph agents query for orientation during a run.
sidebar:
  order: 4
---

worca can build a per-commit **code knowledge graph** that pipeline agents query on demand for orientation — "where is X defined", "what depends on Y". It's powered by [graphify](https://github.com/safishamsi/graphify), is **opt-in**, and ships **off**. With it disabled, pipeline behavior is byte-identical to before.

## Enable it

Graphify needs the `graphify` CLI on your PATH. Install it with `uv` (or `pipx`) so the binary lands on PATH — note the PyPI package is `graphifyy` (double-y), but the command it installs is `graphify`:

```bash
uv tool install 'graphifyy>=0.8.16,<1'
```

Then enable it for a project — from the **Settings → Graphify** tab (pick the model profile, copy the install command, and trigger an async **Build**), or from the CLI:

```bash
worca graphify enable
worca graphify status
```

`worca graphify recommend` surveys the project and advises whether the graph is worth building. `rebuild`, `update`, and `gc` manage the cache.

## How agents use it

When enabled, the **Preflight** stage builds the graph for the current commit and caches it outside the repo tree (nothing is written into your working tree). During the run, every agent subprocess gets the graph location in its environment, so an agent can run a bare query and read the cached graph:

```bash
graphify query "what calls authenticate()"
```

Agents are **not** fed a graph report in their prompts — each stage prompt carries only a one-line "graph available" note, and the agents query it themselves when useful. The graph is **advisory**: the authority order is **guide > plan > graph > description**.

## Governance

The `pre_tool_use` hook lets agents **read** the graph (`query`, `explain`, `path`, `affected`, `diagnose`) but **blocks mutating** subcommands (`update`, `install`, `add`, …) — the pipeline owns all graph builds. This guard is on by default (`worca.governance.guards.block_graphify_mutation`).

## Settings

```jsonc
"worca": {
  "graphify": {
    "enabled": false,
    "mode": "structural"
  }
}
```

`mode` is `structural` (fully local) or `full` (adds an LLM semantic pass). A human-readable `GRAPH_REPORT.md` is also cached and surfaced in the dashboard's Graphify tab with a copy-able query snippet — for you, not the agents. When a graph is ready, each iteration in run detail shows a `Graphify: N` query-count badge.
