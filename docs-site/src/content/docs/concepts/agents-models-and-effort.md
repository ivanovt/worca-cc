---
title: Agents, models & effort
description: Which model runs which stage, and how reasoning effort is allocated.
sidebar:
  order: 2
---

Each stage is run by an agent, and each agent is assigned a Claude model and a reasoning-effort level.

## Models per stage

worca doesn't impose fixed model tiers. The default model for each stage generally tracks the stage's complexity — the more reasoning-heavy stages (**Planner, Plan Reviewer, Coordinator, Reviewer, Guardian, and Learner**) are typically set to **Opus**, while the build-and-test stages run a faster model. This is configured per stage in the **template**, and you can override the model (and max turns) per agent in the Settings UI.

## Reasoning effort

Agents run at an **effort level** — `low`, `medium`, `high`, `xhigh`, or `max` — that controls how much reasoning budget they spend. Effort is governed pipeline-wide by a mode:

| Mode | Behavior |
|---|---|
| **adaptive** *(default)* | The Coordinator labels each task with a complexity level; the Implementer starts there and escalates on retries. |
| **reactive** | Agents start at their configured level and escalate when a loop sends work back. |
| **disabled** | Each agent stays pinned to its configured level — no automatic escalation. |

A ceiling (`auto_cap`, default `xhigh`) bounds how high runtime escalation can go, and the level an agent actually used is shown as a badge on each iteration in the dashboard.

:::note
Effort levels are model-aware — the shipped models expose a `low / medium / high / max` ladder. Tuning effort in depth is covered in the Advanced section (coming soon).
:::
