---
title: Agents & models
description: Set the model, turn budget, and effort for each pipeline agent.
sidebar:
  order: 3
---

Each stage is run by an agent, and you can tune three things per agent from **Settings → Agents**: the **model**, the **max turns**, and the reasoning **effort**.

:::caution[Agents are template-owned]
`worca.agents` is a **template-owned** key. When a template is in play (explicit at launch or via `worca.default_template`), the values you set in **Settings → Agents** are **stripped** before the template's config applies — the active template's agent config takes over. To change agent config for a specific template, edit that template. See [Configuration precedence](/configuration/precedence/).
:::

## Model and turns

- **Model** — which Claude model the agent runs. Defaults track stage complexity: the reasoning-heavy stages (Planner, Plan Reviewer, Coordinator, Reviewer, Guardian, Learner) typically run Opus, while the build-and-test stages run a faster model.
- **Max turns** — the per-iteration turn budget. Raise it for agents that hit the ceiling on large tasks.

Models are referenced by short aliases (`opus`, `sonnet`, `haiku`) that map to full model IDs. To change what an alias points at, route a model through an alternate endpoint, or add a new profile, see [Adding & routing models](/advanced/adding-models/).

:::note[Screenshot — coming soon]
The Agents panel: per-agent model dropdown and max-turns field.
:::

## Effort

Each agent also has a reasoning **effort** level (`low` → `max`) that controls how much reasoning budget it spends — orthogonal to the model. Effort is governed pipeline-wide by an automatic mode that can escalate on retries, and the level an iteration actually used shows as a badge in the run-detail view.

The defaults are sensible (heavy upfront reasoning for the Planner, mechanical verification for the Tester). The full model — modes, escalation, and the ceiling — is covered in [Tuning effort](/advanced/tuning-effort/).

:::tip
Leaving an agent's effort unset is often the right call: under the default `adaptive` mode, the Coordinator classifies each task's complexity and the Implementer starts from that. An explicit value overrides the classification.
:::
