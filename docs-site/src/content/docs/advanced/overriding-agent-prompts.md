---
title: Overriding agent prompts
description: Customize what a pipeline agent is told, layered over the shipped prompts.
sidebar:
  order: 7
---

Each pipeline agent runs from a prompt that ships with worca. You can customize any agent's prompt per project by dropping an override file into `.claude/agents/` — without forking the shipped templates.

## Where overrides go

| Type | Location | Example |
|---|---|---|
| Agent override | `.claude/agents/<agent>.md` | `.claude/agents/implementer.md` |
| Block override | `.claude/agents/<block>.block.md` | `.claude/agents/implement.block.md` |

The runtime resolves the shipped base prompt, then applies your override on top. (Don't confuse `.claude/agents/` — your overrides — with `.claude/worca/agents/core/`, which is the runtime copy worca manages.)

## Replace vs. append

An override file works in one of two modes:

- **Replace** *(default)* — the file replaces the base prompt entirely. No marker needed, or write `<!-- replace -->` to be explicit.
- **Append** — start the file with `<!-- append -->` and target sections with `## Override: <Section Name>` headings. Those sections are merged into the base prompt section-by-section, leaving the rest intact.

Append is usually what you want: add a project-specific instruction (a house style rule, a forbidden dependency) without restating the whole prompt.

## Governance-protected sections

Sections marked `<!-- governance -->` in the base prompt **cannot be replaced** by an override — an attempt to replace one is demoted to append with a warning. This keeps the safety-critical instructions (only-the-Guardian-commits, the test gate) intact no matter what an override says.

## Templates can carry prompt overrides too

A [template](/advanced/authoring-templates/) can ship agent-prompt overrides as part of its definition, so a workflow template can retune both *configuration* and *what the agents are told* in one package.

:::tip
This repo provides a `/worca-agent-override` skill that scaffolds an override file with the right markers. The resolution logic lives in `src/worca/orchestrator/overlay.py` if you want the details.
:::
