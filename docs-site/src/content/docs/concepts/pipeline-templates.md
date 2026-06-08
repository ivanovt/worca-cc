---
title: Pipeline templates
description: The ready-made pipeline configurations worca ships with, and when to use each.
sidebar:
  order: 1.5
---

A **template** preconfigures the pipeline for a kind of work — which stages run, how the agents are tuned, the governance rules, and the retry limits. You pick one when you launch a run (the **Run Pipeline** launcher has a template dropdown); `feature` is the sensible default.

worca ships with these built-in templates:

| Template | What it's for |
|---|---|
| **`feature`** | Substantial new work. Full pipeline with Plan Review and Learn enabled, higher retry limits, and all approval gates active. |
| **`feature-fast`** | Same coverage as `feature` (Plan Review + Learn, full pipeline), but Plan Review runs in `review_and_edit` mode — the plan reviewer can edit the plan directly instead of looping back to the Planner, trimming one Opus cold-start per revision. |
| **`feature-minor`** | A well-scoped feature a planner can handle confidently. Full implement/test/review/PR, but **no Plan Review, no Learn, and no approval gates** — runs autonomously. Lower retry limits and effort capped at `high`. |
| **`bugfix`** | A focused fix. The planner investigates the root cause, the coordinator creates tight tasks, the implementer fixes it. |
| **`quick-fix`** | Trivial changes. Plan and implement only — no test, review, or PR; the change is left on the branch for you to commit. |
| **`refactor`** | Behavior-preserving change. The reviewer enforces that behavior doesn't change, a PR is opened for human review, and Learn captures invariants surfaced along the way. |
| **`investigate`** | Analysis only. The planner explores and produces a report; the guardian publishes it to `docs/plans/` and opens a PR — no code changes. |
| **`test-only`** | Add test coverage without touching production code. Analyze the gaps, create per-module test tasks, write tests only. |

## Which stages each template runs

A template's main effect is the set of stages it enables. This matrix shows what runs where (Preflight always runs and is omitted):

| Stage | `feature` | `feature-fast` | `feature-minor` | `bugfix` | `quick-fix` | `refactor` | `investigate` | `test-only` |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Plan | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Plan Review | ✓ | ✓ | — | — | — | ✓ | ✓ | ✓ |
| Coordinate | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Implement | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Test | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | ✓ |
| Review | ✓ | ✓ | ✓ | ✓ | — | ✓ | — | ✓ |
| PR | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | ✓ |
| Learn | ✓ | ✓ | — | — | — | ✓ | — | — |

`feature` and `refactor` run the same stages — they differ in *tuning*, not stage set: `refactor` puts every agent on Opus and has the Reviewer enforce behavior preservation. `feature-fast` shares the same stage set as `feature` but puts Plan Review in `review_and_edit` mode so the reviewer rewrites the plan in place rather than looping back. `feature-minor` runs the same stages as `bugfix` (full implement→test→review→PR, no Plan Review or Learn) but is framed for well-scoped *features* rather than fixes, caps effort at `high`, uses lower retry limits, and disables the plan-approval gate so it runs unattended. `quick-fix` stops after Implement, leaving the change on the branch for you to commit. `investigate` skips coding entirely and uses the PR stage to publish its report.

## Pinning a default template

You can pin a template as the project default by setting `worca.default_template` in `settings.json` — every run then uses that template unless `--template` overrides at launch. `worca init --upgrade` does this automatically for existing projects that have customized template-owned settings: it captures those values into an auto-generated `_legacy-settings` template and pins it, so behavior carries forward without you choosing a template every time. See [Configuration precedence](/configuration/precedence/) for the full strip-and-merge story when a template is in play.

## Authoring your own

You can also author templates for project- or user-specific workflows — see [Authoring templates](/advanced/authoring-templates/).
