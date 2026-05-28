---
title: Anatomy of an agent prompt
description: How worca assembles each stage's prompt from three context layers, composable templates, and runtime variables.
sidebar:
  order: 8
---

Every pipeline stage talks to Claude through a prompt that worca assembles at runtime. That prompt is not a single block of text — it's three layers of context, two of them built from composable templates and filled with per-run variables. This page explains every part: where the pieces live, how they're merged, and exactly which variables each stage can use.

If you only want to *customize* a prompt, the practical how-to is [Overriding agent prompts](/advanced/overriding-agent-prompts/). This page is the model behind it.

## The three sources of context

Before a stage runs, the agent receives context from three distinct layers. Knowing which layer owns what is the key to putting information in the right place.

1. **`CLAUDE.md` — ambient & primary.** Claude Code automatically reads `CLAUDE.md` from the project root and loads it for **every** agent, on **every** stage, with no templating involved. It's the highest-traffic context layer and the one you most often control. This is where **project-wide, stage-agnostic** knowledge belongs: build and test commands, house style, architectural conventions, code-hosting quirks. If a fact is true regardless of which agent is running, it goes here — not in an agent prompt.
2. **The system prompt — per role.** The resolved core agent template (`planner.md`, `implementer.md`, …) defines *who the agent is*: its role, process, output contract, rules, and governance constraints. Stable across iterations of a run.
3. **The user message — per iteration.** The resolved stage block (`plan.block.md`, `implement.block.md`, …) carries the *dynamic* content: the work request, the assigned task, retry feedback, accumulated context. This is what changes between a first attempt and a retry.

:::tip[Where does it belong?]
- Generic project knowledge → **`CLAUDE.md`**
- An agent's role and behavior → **core agent template** (system prompt)
- Per-run / per-iteration data → **stage block** (user message)
:::

The rest of this page covers layers 2 and 3 — the templated halves worca builds itself.

## Where the pieces live

worca ships two kinds of template file, both under `src/worca/agents/core/` (copied into your runtime as `.claude/worca/agents/core/`):

| File | Role | Becomes |
|---|---|---|
| `<agent>.md` | Core agent template — role, rules, governance | The **system prompt** |
| `<block>.block.md` | Stage block — dynamic per-iteration content | The **user message** |

Each stage maps to one agent and one block:

| Stage | Agent template | Stage block |
|---|---|---|
| Plan | `planner.md` | `plan.block.md` |
| Plan Review | `plan_reviewer.md` | `plan-review.block.md` |
| Coordinate | `coordinator.md` | `coordinate.block.md` |
| Implement | `implementer.md` | `implement.block.md` |
| Test | `tester.md` | `test.block.md` |
| Review | `reviewer.md` | `review.block.md` |
| Guardian (PR) | `guardian.md` | `pr.block.md` |
| Learn | `learner.md` | `learn.block.md` |

The Preflight stage runs no agent — it's deterministic environment checking, so it has no prompt.

## The three-tier overlay chain

Neither file is read in isolation. Each is resolved through a **three-tier overlay chain** so a project (or a template) can customize a prompt without forking the shipped version:

1. **Core** — the shipped base (`.claude/worca/agents/core/<name>`).
2. **Project override** — your file in `.claude/agents/<name>`, layered on top.
3. **Template override** — a [pipeline template](/advanced/authoring-templates/) can ship its own layer, applied last.

Both agent templates and block files use the same chain and the same replace-vs-append merge rules, and governance-protected sections can never be overridden. Those mechanics — `<!-- replace -->`, `<!-- append -->`, `## Override:` section merge, `<!-- governance -->` — are documented in full on [Overriding agent prompts](/advanced/overriding-agent-prompts/). What matters here is that by the time a prompt is rendered, the overlay chain has already produced one merged template per layer.

## The template engine

Once a template is merged, worca resolves its tokens against a per-stage **context dictionary**. Four token forms are supported:

| Token | Meaning |
|---|---|
| `{{name}}` | Substitute the value of `name` from the context. |
| `{{name\|default text}}` | Substitute `name`, or `default text` if it's empty/unset. |
| `{{#if name}}…{{else}}…{{/if}}` | Include a region only when `name` is truthy. Nestable. |
| `{{block:name}}` | Insert another block file (resolved through the same overlay chain). Must sit on its own line. |

Resolution runs in a fixed order: **block insertions → conditionals (innermost first) → simple placeholders → cleanup.** Resolving inside-out is what lets a block wrap its body in `{{#if has_guide}}…{{/if}}` and have the guide appear only when one was attached.

:::note
The system prompt is resolved with the full engine (including `{{block:name}}` insertion), while a stage block routed to the user message is resolved for conditionals and placeholders. The shipped agents keep the two halves cleanly separated — system prompt for role, block for task — rather than embedding blocks into the system prompt, but `{{block:name}}` is available if you want to share a common fragment across templates.
:::

## The variable reference

The context dictionary is assembled fresh for each stage. Some variables are present everywhere; most are stage-specific. Empty values simply render as nothing (and gate their `{{#if}}` regions off).

### Universal variables

Available to every stage's block:

| Variable | Type | What it carries |
|---|---|---|
| `work_request` | text | The task: title + description (no heading — the block supplies it). |
| `assigned_task` | text | The assigned bead's ID, title, and description. Empty when no bead is assigned. |
| `guide_content` | text | The body of the attached `--guide` document, if any. |
| `has_guide` | bool | True when a guide is attached — gates the normative-guide block. |
| `accumulated_design_notes` | text | Advisory design notes recorded by sibling beads this run (capped, oldest dropped first). |
| `has_design_notes` | bool | True when sibling design notes exist. |
| `has_graphify` | bool | True when a queryable [code knowledge graph](/advanced/knowledge-graph/) is ready for this run. |

### Stage-specific variables

**Plan**

| Variable | Type | What feeds it |
|---|---|---|
| `claude_md` | text | `CLAUDE.md` content, surfaced into the planner's message *in addition to* the ambient auto-load (the planner reasons hardest about conventions). |
| `plan_revision_mode` | bool | True when looping back from Plan Review — switches the block into revision mode. |
| `plan_content` | text | The current `MASTER_PLAN.md` (revision mode only). |
| `plan_review_issues_formatted` | text | Plan Reviewer issues to address (revision mode). |
| `plan_review_history_formatted` | text | Prior plan-review attempts (revision mode). |

**Plan Review**

| Variable | Type | What feeds it |
|---|---|---|
| `plan_content` | text | The plan under review (from context, or read from `MASTER_PLAN.md`). |
| `plan_review_history_formatted` | text | Earlier review attempts, on iterations after the first. |

**Coordinate**

| Variable | Type | What feeds it |
|---|---|---|
| `plan_summary` | text | Approach + task outline distilled from the Planner's structured output. |
| `unresolved_plan_issues_formatted` | text | Plan-review issues carried forward unresolved. |

**Implement**

| Variable | Type | What feeds it |
|---|---|---|
| `is_retry` | bool | True on attempts after the first — switches the block into fix mode. |
| `issue_type` | text | What triggered the retry: `Test Failures`, `Review Issues`, or `Issues`. |
| `attempt_count` | number | Which attempt this is. |
| `test_failures_formatted` | text | Failing tests and their errors to fix. |
| `review_issues_formatted` | text | Reviewer issues to fix (severity, file:line, description). |
| `previous_attempts` | text | Summary of earlier failed attempts. |

**Test**

| Variable | Type | What feeds it |
|---|---|---|
| `implementation_summary` | text | Files changed and tests added by the Implementer. |

**Review**

| Variable | Type | What feeds it |
|---|---|---|
| `test_results` | text | Pass/fail, coverage, and proof artifacts from the Tester. |
| `files_changed_formatted` | text | Bullet list of changed files. |

**Guardian (PR)**

| Variable | Type | What feeds it |
|---|---|---|
| `plan_approach` | text | The plan's approach line — gates the `## Approach` section. |
| `pr_title_prefix` | text | Resolved at dispatch time to prefix the PR title. |

**Learn**

| Variable | Type | What feeds it |
|---|---|---|
| `termination_type` | text | How the run ended. |
| `run_id` | text | The run identifier. |
| `run_data` | text (JSON) | The full run status, truncated past 50&nbsp;KB. |
| `plan_content` | text | The plan the run executed. |
| `files_changed_since_git_head` | text | `git diff --stat` from the run's starting commit to HEAD — ground truth for what the pipeline produced. |

## How context accumulates across stages

The dictionary isn't static — each stage writes its structured output back into a shared context that downstream stages read. The Planner's approach feeds the Coordinator's `plan_summary`; the Tester's results feed the Reviewer's `test_results`; a Reviewer bounce feeds the Implementer's `review_issues_formatted` on the next attempt. This accumulated context is persisted to `prompt_context.json` (capped at 100&nbsp;KB, oldest keys dropped first) so a resumed run rebuilds the same picture. The retry loops are just this mechanism in a cycle: failure detail flows back into the next iteration's block.

## Authority & precedence of injected sources

When several sources describe what to do, agents follow a fixed order of authority:

```
guide  >  plan  >  graph  >  description
```

The prompt encodes this. An attached guide is injected under a **normative** header that explicitly tells the agent to treat any guide-vs-description conflict as a bug in the description and surface it. The knowledge graph and accumulated design notes are framed as **advisory** orientation, below the plan. See [Plans, work requests & guides](/concepts/plans-work-requests-and-guides/) for the concept, and [Knowledge graph](/advanced/knowledge-graph/) for the graph layer.

## Seeing the resolved prompt

Nothing about this is hidden at runtime. For every iteration, worca writes the fully-resolved system prompt to `agents/resolved/<stage>-<agent>-iter-N.md` inside the run directory, and records the rendered user message in the run status. In the dashboard, the expanded **Agent Instructions** panel separates the resolved system prompt from the work-request message, so you can read exactly what an agent was told. See [Monitoring a run](/running-pipelines/monitoring-a-run/).

## Worked example: an Implement retry

The clearest way to see the engine is to watch one block render. Here's the retry branch of `implement.block.md` (trimmed):

```text
{{#if is_retry}}
## PRIORITY: Fix {{issue_type}} (attempt {{attempt_count}})

{{#if review_issues_formatted}}
### Issues to Fix

{{review_issues_formatted}}
{{/if}}

{{#if previous_attempts}}
### Previous Attempts (all failed to resolve)

{{previous_attempts}}
{{/if}}

---

### Reference: Task & Plan (already implemented)

{{#if assigned_task}}
{{assigned_task}}
{{/if}}
{{work_request}}
{{/if}}
```

Now suppose the Reviewer bounced the work on the first attempt. The Implement stage runs again with this context:

| Variable | Value |
|---|---|
| `is_retry` | `true` |
| `issue_type` | `Review Issues` |
| `attempt_count` | `2` |
| `review_issues_formatted` | `1. [high] `src/auth/session.py:42`` … `Token TTL not enforced.` |
| `previous_attempts` | *(empty — only one prior attempt)* |
| `assigned_task` | Bead `wc-12`, "Add session expiry", … |
| `work_request` | "**Add session expiry** …" |

The engine resolves conditionals (dropping the empty `previous_attempts` region), substitutes the placeholders, and produces the user message:

```text
## PRIORITY: Fix Review Issues (attempt 2)

### Issues to Fix

1. [high] `src/auth/session.py:42`
   Token TTL not enforced — sessions never expire.

---

### Reference: Task & Plan (already implemented)

**Bead ID:** wc-12

**Title:** Add session expiry

**Description:** Enforce a 30-minute idle TTL on sessions.

**Add session expiry**

Sessions currently never expire…
```

That message is paired with the Implementer's role/rules system prompt and the ambient `CLAUDE.md`, and sent to Claude — the full prompt the agent acts on.
