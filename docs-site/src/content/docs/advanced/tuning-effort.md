---
title: Tuning effort
description: How reasoning effort is allocated per agent, escalated on retries, and capped.
sidebar:
  order: 8
---

**Effort** is how much reasoning budget an agent spends per step — Claude Code's `low | medium | high | xhigh | max` scale, surfaced per agent and per iteration. It's orthogonal to the model and the turn budget.

You set a per-agent effort level in **Settings → Agents**, right alongside its model and max-turns (see [Agents & models](/configuration/agents-and-models/)), and the level each iteration actually ran at appears as a badge in the run-detail view. This page explains the model underneath those controls — how a value resolves, escalates on retries, and collapses onto a model's ladder. The pipeline-wide knobs (`auto_mode`, `auto_cap`) live under `worca.effort` in settings.

## Modes

`worca.effort.auto_mode` controls two things: where an agent's starting effort comes from, and whether a loopback bumps it.

| Mode | Starting point | Escalates on loopbacks? |
|---|---|---|
| `disabled` | Per-agent value, else model default | No |
| `reactive` | Per-agent value, else model default | Yes |
| `adaptive` *(default)* | Per-agent value if set, else the Coordinator's per-task complexity label | Yes |

Under `adaptive`, the Coordinator classifies each task's complexity during decomposition and the Implementer starts from that label — unless you set an explicit per-agent value, which always wins.

## Per-agent defaults

The shipped defaults set explicit effort where judgment matters and leave it unset where work is mechanical:

| Agent | Effort | Why |
|---|---|---|
| planner | `xhigh` | Plan quality compounds downstream. |
| coordinator | `high` | Complexity classification is a judgment call. |
| reviewer | `high` | Review quality controls how many fix loops run. |
| guardian | `high` | Commit and PR creation are irreversible. |
| implementer | *unset* | The adaptive label drives its starting point. |
| tester | *unset* | Deterministic pass/fail; model default suffices. |

Set explicit effort for high-stakes or heavy-reasoning stages; leave it unset for mechanical ones.

## Escalation and the cap

On a loopback (tests fail, changes requested), the re-running agent steps up the ladder — `+1` rung for a test failure, `+2` for a review change-request. `auto_cap` (default `xhigh`) is the ceiling escalation can reach.

```jsonc
"worca": {
  "effort": {
    "auto_mode": "adaptive",
    "auto_cap": "xhigh"
  }
}
```

## Model-aware ladders (the important caveat)

Effort rungs are **model-specific**, and the shipped aliases resolve to 4-rung models:

| Model | Rungs |
|---|---|
| Opus 4.7 | `low`, `medium`, `high`, `xhigh`, `max` |
| Opus 4.6 / Sonnet 4.6 *(shipped)* | `low`, `medium`, `high`, `max` — no `xhigh` |

On a 4-rung model, a requested `xhigh` collapses down to `high`, and `auto_cap: xhigh` rounds *up* to `max` — so a single test-failure loopback can take a `high`-base agent straight to `max`. To prevent auto-escalation to `max` on these models, pin the cap:

```jsonc
"worca": {
  "effort": {
    "auto_cap": "high"
  }
}
```

Pointing `worca.models.opus` at Opus 4.7 restores the 5-rung ladder and gentler escalation. See [Adding & routing models](/advanced/adding-models/).

## Reproduce the old (flat) behavior

```jsonc
"worca": {
  "effort": {
    "auto_mode": "disabled"
  }
}
```

This pins every agent to its configured value (or the model default) with no escalation.

:::note
`max` is reachable only via the env-var seam (`CLAUDE_CODE_EFFORT_LEVEL`), which worca uses internally — the plain settings field rejects it. Explicit opt-in or loopback escalation on a model lacking `xhigh` are the two ways a run reaches `max`. The level each iteration actually ran at is recorded and shown as a badge in run detail.
:::
