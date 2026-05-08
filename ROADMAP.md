# Roadmap

A curated log of the major features that have shipped in worca-cc, plus a short look at what's coming next. For day-to-day issue tracking and smaller fixes, see [GitHub Issues](https://github.com/SinishaDjukic/worca-cc/issues); for per-version detail, see the [worca-cc CHANGELOG](src/worca/CHANGELOG.md) and [@worca/ui CHANGELOG](worca-ui/CHANGELOG.md).

---

## Major Features Shipped

Reverse-chronological — most recent first.

### Guided Issue Triage Skill, First-Class Worktree Runs, and Templates CLI (v0.24.0)

Three changes that tighten the loop between a GitHub issue and a running pipeline:

- **`/worca-analyze` skill** — end-to-end Claude Code skill that analyzes a GitHub issue, surfaces open design decisions with recommended options, optionally writes a `## Decisions` section back to the issue body, recommends the right pipeline template, and offers to launch a worktree-based pipeline.
- **`worca run --worktree`** — first-class CLI flag that mirrors the dashboard's "New Pipeline" path; falls back to in-place if `run_worktree.py` is missing in the project runtime.
- **`worca templates list --json`** — machine-readable enumeration of all resolvable templates with user > project > built-in tier resolution applied.

### Multi-Host PR Metadata ([W-051](https://github.com/SinishaDjukic/worca-cc/issues/136))

Generic multi-host PR metadata in guardian output and UI display. The `pr.json` schema gained `commit_sha`, `source_branch`, `target_branch`, `provider`, and `is_draft` fields. The `pr_url.py` parser auto-detects GitHub, GitLab, Bitbucket, Azure DevOps, and Gitea URL patterns. The dashboard surfaces a collapsible "PR details" subsection on the PR stage card with a provider badge, linked short SHA, branch flow, and draft/review status. Webhook subscribers receive the richer `GIT_PR_CREATED` payload automatically.

### Settings UI for Execution, Approval Gates, and Circuit Breaker ([W-049](https://github.com/SinishaDjukic/worca-cc/issues/118))

Four UI subpanels for previously JSON-only knobs: **Execution & Parallelism** (worktree base directory, default PR base branch, max concurrent pipelines, cleanup policy), **Approval Gates** (plan and PR approval), **Circuit Breaker** (max consecutive failures, classifier model), and a global **Preferences** tab backed by `~/.worca/settings.json` (cleanup policy, concurrency cap, worktree disk warning threshold, classifier model). Includes a server-side launch mutex enforcing `max_concurrent_pipelines` and an inline migration banner for projects with misplaced global keys or template-default milestone values.

### Worktree-Based Pipeline Isolation ([W-048](https://github.com/SinishaDjukic/worca-cc/issues/82))

Each pipeline now runs in its own git worktree by default — parallel runs no longer collide on the working tree. `run_worktree.py` is the single launcher (replacing the older `run_multi.py` and `run_batch.py` batch entry points), creating a worktree, registering it under `.worca/multi/pipelines.d/`, and spawning `run_pipeline.py` inside it. The unified runs list now fans out into worktree runs alongside root-project runs. Cleanup is on-demand via `worca cleanup` (`--all`, `--run-id`, `--dry-run`, `--older-than`). The "pipeline already running" block was removed from the new-run flow — multiple concurrent pipelines per project are first-class.

### Investigate Template Publishes Plans ([W-046](https://github.com/SinishaDjukic/worca-cc/issues/115))

The PR stage is now enabled in the `investigate` template, so investigation outputs land as reviewable PRs instead of staying local-only.

### Pipeline Integration Test Harness ([W-044](https://github.com/SinishaDjukic/worca-cc/issues/110))

`tests/integration/` runs the full pipeline state machine against a mock Claude CLI at `tests/mock_claude/mock_claude.py` — no API calls, no real LLM cost. Each test spins up a temp git repo + worca runtime; signal-handling tests are skipped on Windows. Subprocess-level coverage hooks (`WORCA_COVERAGE=1`) produce per-pipeline coverage fragments that `scripts/coverage.py` combines into a stable `coverage.json` schema.

### Unified Pipeline State Model and Universal Event Dispatch ([W-043](https://github.com/SinishaDjukic/worca-cc/issues/109))

Terminal state for user-initiated stops unified to `interrupted` (with discriminating `stop_reason`: `control_file`, `control_webhook`, `signal`, `force_cancelled`). The legacy `resuming` status was removed — pipelines go directly from `paused` to `running`. New `POST /runs/:id/delete` endpoint permanently removes a run directory. New `pipeline.run.cancelled` and `pipeline.run.interrupted` event types route through the universal dispatch pipeline (webhooks, integrations).

### Chat Integrations — Telegram, Discord, Slack, Webhook ([W-041](https://github.com/SinishaDjukic/worca-cc/issues/106))

Get pipeline notifications and control runs remotely via **Telegram** (two-way: push notifications + `/pause`, `/resume`, `/stop`, `/status`, `/cost`, `/pr`, `/error` commands), **Discord** (outbound bot push), **Slack** (outbound incoming-webhook push), or any **generic webhook** (multiple payload formats: `generic-json`, `slack-compatible`, `ntfy`, etc.). Integrations run in-process inside the UI server — no separate service. The dashboard's Integrations tab is a card catalog with real connection-health badges (polled every 10s while the tab is open), per-integration enable/disable toggles, and Edit/Remove buttons.

### Configurable Subagent Dispatch ([W-038](https://github.com/SinishaDjukic/worca-cc/issues/95))

Per-agent allowlists control which Claude Code subagents each pipeline agent may spawn. `general-purpose` is on an unbypassable denylist. Dispatch events render as green/red badges per iteration in the UI, and the Settings → Governance tab includes a tag editor for managing the allowlists per agent.

### Prompt Builder Template Extraction ([W-037](https://github.com/SinishaDjukic/worca-cc/issues/93))

Agent prompts split into composable block files with a section-level overlay merge model. Per-project overrides live flat in `.claude/agents/<agent>.md` with `## Override: <Section Name>` blocks targeting specific sections; `<!-- replace -->` mode replaces, `<!-- append -->` mode merges. Governance-protected sections cannot be replaced. The `stages.review.agent` setting was renamed from `guardian` to `reviewer` (auto-migrated by `worca init --upgrade`).

### Complete Usage & Cost Tracking ([W-035](https://github.com/SinishaDjukic/worca-cc/issues/70))

Per-agent token and cost tracking with model-specific pricing (Opus 4.6, Sonnet 4.6, Haiku 4.5), web search/fetch usage tracking, and cache tier breakdown (read/create/uncached). The dashboard displays cost badges per stage, a web searches summary card, and cache breakdown tooltips. Pricing is centralized in `settings.json` as the single source of truth.

### Global Multi-Project Dashboard ([W-032](https://github.com/SinishaDjukic/worca-cc/issues/58))

`worca-ui` runs in global mode by default and monitors all registered projects from one browser tab. Sidebar project picker with live status dots (green = healthy, red = errors) and run count badges; add-project dialog with path validation and Single project / Workspace modes; `worca-ui migrate --scan ~/dev` for batch registration of existing worca-enabled projects.

### pip/npm Distribution (W-062, [#69](https://github.com/SinishaDjukic/worca-cc/issues/69))

worca-cc is installable via `pip install worca-cc` and the dashboard via `npm install -g @worca/ui`. The `worca` CLI provides `init`, `run`, `multi`, `cleanup`, `templates`, and lifecycle commands. CI workflows publish to PyPI (trusted publishing) and npm on tag push, with GitHub Releases including artifacts and SHA-256 checksums.

### Pipeline Templates ([W-016](https://github.com/SinishaDjukic/worca-cc/issues/23))

Predefined pipeline templates that configure stage flow, agent selection, and governance rules per work type. Templates are selected at run time via the dashboard's new-run page (styled dropdown with group headers, descriptions, and indentation) or the CLI's `--template` flag. Built-in templates: `feature`, `bugfix`, `quick-fix`, `refactor`, `investigate`, `test-only` — each with tailored stage flows that eliminate unnecessary stages, reducing both token cost and end-to-end run time. Resolution order is user (`~/.worca/templates/`) > project (`.claude/templates/`) > built-in. Template agent prompt overrides are wired through to the overlay resolver.

### Rich Bead Tooltips ([#74](https://github.com/SinishaDjukic/worca-cc/issues/74))

Hover tooltips on every bead view (run-list, dependency graph, beads list) show structured bead details with a copy button and interactive content. Dependency graph nodes use `sl-tooltip` overlays.

### Feedback Loops from Test and Review Stages

The pipeline implements four feedback loops with configurable retry limits, all tracked in `status["loop_counters"]`:

- **Plan Review loop** — Plan Reviewer returns `revise` → critical issues fed back to Planner → re-plan with accumulated context (limit: `worca.loops.plan_review`, default 5)
- **Implement/Test loop** — Tester returns failures → failure analysis fed back to Implementer → fix and re-test (limit: `worca.loops.implement_test`, default 5)
- **PR Changes loop** — Reviewer returns `revise` with critical/major issues → Implementer reworks → re-review (limit: `worca.loops.pr_changes`, default 5)
- **Restart Planning loop** — Reviewer returns `restart_planning` → pipeline resets to PLAN stage (limit: `worca.loops.restart_planning`, default 5)

All loops are bounded, persist counters across resume, and cap context accumulation at 50 entries to prevent unbounded growth.

---

## Upcoming Features

A small selection of larger-scope items currently being designed. Anything not listed here lives in [GitHub Issues](https://github.com/SinishaDjukic/worca-cc/issues).

### W-040: Fleet Runs — Cross-Repository Fan-Out ([#101](https://github.com/SinishaDjukic/worca-cc/issues/101))

A first-class way to apply a single work-request to many independent project repositories in parallel. Existing parallel runners are intra-repo only — `run_worktree.py` (W-048) launches isolated pipelines within a single repo via git worktrees and cannot target a different repo. Fleet runs target the migration / compliance-sweep / repo-hygiene use case where the same prompt needs to land across 5–20 registered projects.

### W-047: Multi-Repo Coordinated Pipelines ([#116](https://github.com/SinishaDjukic/worca-cc/issues/116))

Where Fleet Runs (W-040) fan out an identical prompt to N independent repos, W-047 handles the harder case of a **single feature requiring coordinated changes across interdependent repos** — e.g. a backend adds an API endpoint, a shared library adds a type, and a frontend consumes both. Decomposes one prompt into repo-specific sub-prompts, orders child pipelines by dependency, tests across repo boundaries, and links the resulting PRs with dependency metadata.
