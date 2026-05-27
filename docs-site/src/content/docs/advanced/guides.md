---
title: Guides & guide precedence
description: Attach a normative reference document that overrides everything else in a run.
sidebar:
  order: 10
---

A **guide** is a reference document — a migration spec, an RFC, a compliance requirement — that you attach to a run as the highest-authority source. Agents must conform to it, even when the plan or the prompt says otherwise.

## Attaching a guide

Pass `--guide` (repeatable) on any run mode:

```bash
worca run --worktree --prompt "Migrate to the v2 API" --guide ./migration-spec.md
```

```bash
python .claude/scripts/run_fleet.py \
  --projects /repos/frontend /repos/backend \
  --prompt "Migrate to the v2 API" \
  --guide ./migration-spec.md \
  --guide ./breaking-changes.md
```

From the dashboard, the launcher accepts guide file uploads. Guide paths are resolved to absolute before dispatch; combined guide content is capped at 64 KB (`worca.guide.max_bytes`), and exceeding the cap aborts the launch before any work starts.

## The authority order

When a guide is present, every agent treats this order as binding:

**guide > plan > graph > description**

- The **guide** is normative — it overrides everything.
- The **plan** is derived from the guide and the description; if they diverge, the guide wins.
- The **[knowledge graph](/advanced/knowledge-graph/)**, if enabled, is advisory orientation only.
- The **description** is task scope; a conflict with the guide is a bug in the description.

## How agents behave

| Agent | With a guide present |
|---|---|
| **Planner** | Produces a plan that conforms to the guide; reports any description-vs-guide conflict instead of silently picking a side. |
| **Reviewer** | Flags any plan instruction that contradicts the guide as a critical issue. |
| **Tester** | Notes guide-vs-description conflicts in proof artifacts — surfaces them, doesn't resolve them. |

This is why a guide is the right tool for a migration or compliance rollout: it carries the spec straight through planning, implementation, and review without being eroded by a loosely-worded prompt. In a [workspace run](/advanced/workspace-runs/), each tier's diff is also injected into the next tier as a guide, so downstream projects inherit upstream's actual changes.
