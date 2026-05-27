---
title: Customizing dispatch governance
description: Control which tools, skills, and subagents each agent may invoke.
sidebar:
  order: 9
---

Beyond the always-on safety hooks described in [Governance](/concepts/governance/), worca lets you control exactly which **tools**, **skills**, and **subagents** each pipeline agent may dispatch. All three share one three-tier model under `worca.governance.dispatch`.

## The three tiers

Each section (`tools`, `skills`, `subagents`) has the same structure:

| Tier | Key | Meaning |
|---|---|---|
| 1 | `always_disallowed` | Hard deny. Editable, but rarely should be — these are footguns no agent should invoke. |
| 2 | `default_denied` | Blocked **unless** an agent names it in `per_agent_allow`. The `"*"` wildcard does *not* include these. |
| 3 | `per_agent_allow` | Per-agent allow list, with a `_defaults` fallback. |

## Resolution

For a given `(section, agent, candidate)`:

1. Matches `always_disallowed`? → **deny**.
2. Look up `per_agent_allow[agent]`, falling back to `_defaults`.
3. If the list has `"*"`: allow anything not in `default_denied` (a name listed explicitly opts in past `default_denied`).
4. If the list has no `"*"`: allow only names listed explicitly; deny the rest.

Interactive sessions (no `WORCA_AGENT` set) are never gated — this only applies to pipeline agents.

## The allow-list dialects

`per_agent_allow` entries read like this:

| Form | Meaning |
|---|---|
| `["*"]` | Everything except the deny tiers (the default). |
| `["*", "review"]` | Wildcard **plus** an explicit opt-in to a `default_denied` item. |
| `["Read", "Grep"]` | Only these named items. |
| `[]` | Falls through to `_defaults` — clearing the list doesn't brick the agent. |
| `["none"]` | Explicit lockdown — nothing allowed in this section. |

## Examples

Let the reviewer use the (normally denied) `review` skill:

```jsonc
"skills": {
  "per_agent_allow": {
    "_defaults": ["*"],
    "reviewer": ["*", "review"]
  }
}
```

Lock the coordinator out of all subagent dispatch while leaving everyone else open:

```jsonc
"subagents": {
  "per_agent_allow": {
    "_defaults": ["*"],
    "coordinator": ["none"]
  }
}
```

Restrict the reviewer to a read-only tool subset:

```jsonc
"tools": {
  "per_agent_allow": {
    "_defaults": ["*"],
    "reviewer": ["Read", "Grep"]
  }
}
```

A named tool list auto-includes `Skill` and `Agent` so worca's own skill/subagent governance still fires.

## What `--tools` does and doesn't cover

The `tools` section maps to the agent subprocess's `--tools` / `--disallowedTools` flags, which restrict only the **built-in** tool set. **MCP tools (`mcp_*`) are not covered** — they flow through separate channels and a named tool allowlist won't block them.

:::tip
This repo provides a `worca-dispatch-governance-reviewer` subagent that audits changes to this config. The default config and full resolution algorithm are documented under `docs/governance.md` in the source repo.
:::
