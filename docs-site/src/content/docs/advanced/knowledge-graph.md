---
title: Knowledge graph (Graphify)
description: An optional code knowledge graph agents query for orientation during a run.
sidebar:
  order: 4
---

worca can build a per-commit **code knowledge graph** that pipeline agents query on demand for orientation — "where is X defined", "what depends on Y". It's powered by [graphify](https://github.com/safishamsi/graphify), is **opt-in**, and ships **off**. With it disabled, pipeline behavior is byte-identical to before.

## Enable it from the dashboard

Open a project's **Settings → Graphify** tab. It's the simplest path — and it's where the integration is meant to be managed:

1. Pick the **model profile** the graph build should use.
2. Copy the **install command** the tab shows and run it once (the `graphify` CLI must be on your PATH — see below).
3. Click **Build** to generate the graph for the current commit. **Clear** removes the cached snapshots.

Once a graph is ready, each agent iteration in the run-detail view shows a `Graphify: N` query-count badge, so you can see how often the agents consulted it.

:::note[Screenshot — coming soon]
The Settings → Graphify tab: model-profile picker, the copy-able install command, and the Build / Clear controls.
:::

### One-time prerequisite

The graph builder is a separate CLI. Install it with `uv` (or `pipx`) so the binary lands on PATH — the Graphify tab surfaces this exact command to copy. Note the PyPI package is `graphifyy` (double-y), but the command it installs is `graphify`:

```bash
uv tool install 'graphifyy>=0.8.16,<1'
```

## How agents use it

When enabled, the **Preflight** stage builds the graph for the current commit and caches it outside the repo tree (nothing is written into your working tree). During the run, every agent subprocess gets the graph location in its environment, so an agent can query it directly when useful — for example `graphify query "what calls authenticate()"`.

Agents are **not** fed a graph report in their prompts — each stage prompt carries only a one-line "graph available" note, and the agents query it themselves. The graph is **advisory**: the authority order is **guide > plan > graph > description**.

## Governance

The `pre_tool_use` hook lets agents **read** the graph (`query`, `explain`, `path`, `affected`, `diagnose`) but **blocks mutating** subcommands (`update`, `install`, `add`, …) — the pipeline owns all graph builds. This guard is on by default (`worca.governance.guards.block_graphify_mutation`).

## The underlying settings

The Graphify tab writes two keys; you can also set them directly:

```jsonc
"worca": {
  "graphify": {
    "enabled": false,
    "mode": "structural"
  }
}
```

`mode` is `structural` (fully local) or `full` (adds an LLM semantic pass). A human-readable `GRAPH_REPORT.md` is also cached and surfaced in the Graphify tab with a copy-able query snippet — for you, not the agents.

:::note[From the CLI]
Headless environments can manage the graph with the `worca graphify` subcommands (`enable`, `disable`, `status`, `recommend`, `rebuild`, `update`, `gc`) — see the [CLI reference](/reference/cli/#graphify).
:::
