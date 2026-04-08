# Roadmap

This document outlines the major features planned for worca-cc. Items are listed in order of priority, not scheduled to specific dates. The roadmap is a living document — additional features and changes may be added as the project evolves.

For detailed tracking, see [GitHub Issues](https://github.com/SinishaDjukic/worca-cc/issues).

---

## Completed

### Parallel Pipeline Execution

Implemented as part of [W-032: Global Multi-Project worca-ui](docs/plans/W-032-global-multi-project-worca-ui.md) and [W-030](https://github.com/SinishaDjukic/worca-cc/issues/54). The `run_multi.py` entry point orchestrates N pipelines via `ThreadPoolExecutor`, each in its own git worktree with isolated `.worca/` state, `.beads/` database, and git branch. The global dashboard UI (`worca-ui`) provides multi-project monitoring with per-pipeline pause/stop/resume controls (global mode is the default; use `--project` to scope to a single project).

### Feedback Loops from Test and Review Stages

The pipeline implements four feedback loops with configurable retry limits, all tracked in `status["loop_counters"]`:

- **Plan Review loop** — Plan Reviewer returns `revise` → critical issues fed back to Planner → re-plan with accumulated context (limit: `worca.loops.plan_review`, default 5)
- **Implement/Test loop** — Tester returns failures → failure analysis fed back to Implementer → fix and re-test (limit: `worca.loops.implement_test`, default 5)
- **PR Changes loop** — Guardian returns `revise` with critical/major issues → Implementer reworks → re-review (limit: `worca.loops.pr_changes`, default 5)
- **Restart Planning loop** — Guardian returns `restart_planning` → pipeline resets to PLAN stage (limit: `worca.loops.restart_planning`, default 5)

All loops are bounded, persist counters across resume, and cap context accumulation at 50 entries to prevent unbounded growth.

### pip/npm Distribution (W-062)

worca-cc is now installable via `pip install worca-cc` and the dashboard via `npm install -g @worca/ui`. The `worca` CLI provides `init`, `run`, and `multi` commands. CI workflows publish to PyPI (trusted publishing) and npm on tag push, with GitHub Releases including artifacts and checksums. ([#69](https://github.com/SinishaDjukic/worca-cc/issues/69))

### Complete Usage & Cost Tracking (W-035)

Per-agent token and cost tracking with model-specific pricing (updated for Opus 4.6, Sonnet 4.6, Haiku 4.5), web search/fetch usage tracking, and cache tier breakdown (read/create/uncached). The dashboard displays cost badges per stage, a web searches summary card, and cache breakdown tooltips. Pricing is centralized in `settings.json` as the single source of truth. ([#70](https://github.com/SinishaDjukic/worca-cc/issues/70))

---

## Planned

### Pipeline Templates

Support predefined pipeline templates that configure stage flow, agent selection, and governance rules for different work types. ([#23](https://github.com/SinishaDjukic/worca-cc/issues/23))

**Problem.** The current pipeline uses a single fixed stage flow (Preflight → Plan → Coordinate → Implement → Test → Review → PR → Learn) regardless of the work type. A bugfix doesn't need the same planning depth as a new feature. An incident analysis doesn't need an Implementer. Users must manually toggle stages in settings for each run.

**Approach.** Introduce pipeline templates — named configurations that define which stages run, in what order, with which agents and settings. Templates are selected at run time, and the existing stage flow becomes the `default` template.

**Benefit.** Eliminates unnecessary stages per work type, reducing both token cost and end-to-end run time.

**Example templates:**
- **feature** — Full pipeline: Plan → Coordinate → Implement → Test → Review → PR → Learn
- **bugfix** — Abbreviated flow: skip deep planning, focus on reproducing the bug, fixing, and testing
- **incident-analysis** — Read-only investigation: Plan → Coordinate (analysis tasks) → Review → Learn, no code changes
- **refactor** — Emphasize Review and Test stages with stricter governance thresholds
