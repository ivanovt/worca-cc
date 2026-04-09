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

### Pipeline Templates (W-016)

Predefined pipeline templates that configure stage flow, agent selection, and governance rules for different work types. Templates are selected at run time via the dashboard's new-run page (styled dropdown with group headers, descriptions, and indentation) or CLI. Built-in templates include `feature`, `bugfix`, `quick-fix`, `incident-analysis`, and `refactor` — each with tailored stage flows to eliminate unnecessary stages, reducing both token cost and end-to-end run time. Template agent prompt overrides are wired through to the overlay resolver. ([#23](https://github.com/SinishaDjukic/worca-cc/issues/23))

### Rich Bead Tooltips (#74)

Hover tooltips on all bead views (Kanban, dependency graph, list) showing structured bead details with copy button and interactive content. Dependency graph nodes use `sl-tooltip` overlays.
