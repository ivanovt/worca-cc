---
title: Agents & models
description: Set the model, turn budget, and effort for each pipeline agent.
sidebar:
  order: 3
---

Each stage is run by an agent, and you can tune three things per agent: the **model**, the **max turns**, and the reasoning **effort**.

Per-agent settings live inside **Pipeline Templates**, not Project Settings — every run uses an active template, so the template owns the agent config. To change it: open **Pipeline Templates**, pick the template you want to edit (or duplicate a built-in), and use the **Agents** tab. See [Configuration precedence](/configuration/precedence/) for the full strip-and-merge rules.

## Model and turns

- **Model** — which Claude model the agent runs. Defaults track stage complexity: the reasoning-heavy stages (Planner, Plan Reviewer, Coordinator, Reviewer, Guardian, Learner) typically run Opus, while the build-and-test stages run a faster model.
- **Max turns** — the per-iteration turn budget. Raise it for agents that hit the ceiling on large tasks.

Models are referenced by short aliases (`opus`, `sonnet`, `haiku`) that map to full model IDs. To change what an alias points at, route a model through an alternate endpoint, or add a new profile, see [Adding & routing models](/advanced/adding-models/).

![The Agents panel: per-agent model dropdown and max-turns field.](/screenshots/agents-and-models/01-panel.png)

## Effort

Each agent also has a reasoning **effort** level (`low` → `max`) that controls how much reasoning budget it spends — orthogonal to the model. Effort is governed pipeline-wide by an automatic mode that can escalate on retries, and the level an iteration actually used shows as a badge in the run-detail view.

The defaults are sensible (heavy upfront reasoning for the Planner, mechanical verification for the Tester). The full model — modes, escalation, and the ceiling — is covered in [Tuning effort](/advanced/tuning-effort/).

:::tip
Leaving an agent's effort unset is often the right call: under the default `adaptive` mode, the Coordinator classifies each task's complexity and the Implementer starts from that. An explicit value overrides the classification.
:::
