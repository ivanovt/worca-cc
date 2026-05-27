---
title: Governance
description: The safety rules worca enforces on every agent action.
sidebar:
  order: 3
---

worca is built on the idea that an autonomous pipeline needs guardrails. Governance is enforced by **hooks that run on every tool call** — not by asking the agents to behave. A blocked action simply fails.

## What's enforced

- **Only the Guardian commits.** Every other agent is blocked from running `git commit`. Code reaches your branch only after it's been implemented, tested, and reviewed, and the Guardian has verified the proof.
- **Dangerous operations are blocked.** Recursive force-deletes (`rm -rf`), force-pushes, and writes to environment files are denied outright.
- **A plan must exist first.** Source-file writes are blocked until the plan (`MASTER_PLAN.md`) is in place, so implementation can't start before there's a plan to follow.
- **A test gate halts runaway failures.** After repeated consecutive test-run failures, the pipeline stops rather than burning tokens on a broken approach.
- **Dispatch is scoped per agent.** Each agent can only invoke the tools, skills, and subagents on its allow-list; broad escape hatches like the `general-purpose` subagent are denied by default (a project can opt a specific agent in by naming it explicitly in its allow-list).

## Why hooks, not prompts

Prompt instructions can be ignored or drifted from. worca's guards are wired into Claude Code's tool lifecycle, so a blocked action fails deterministically regardless of what the agent "decides." You choose which guards are active per project in the Settings UI.

:::tip
Each guard can be toggled independently — but the defaults exist for good reasons. The full governance and dispatch model is detailed in the Reference section (coming soon).
:::
