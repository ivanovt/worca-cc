# worca-cc

Autonomous software development pipeline with governance enforcement.

worca-cc is a multi-agent pipeline that plans, coordinates, implements, tests, reviews, and learns from code changes autonomously. It runs as a `.claude/` folder you drop into any project — fully configurable, with safety hooks at every stage.

![Pipeline stages — Preflight through PR with per-stage cost, turns, and duration](docs/screenshots/pipeline-stages.png)

## Features

### Pipeline

- **9-stage pipeline** — Preflight → Plan → Plan Review → Coordinate → Implement → Test → Review → PR → Learn
- **7 specialized agents** — Planner, Plan Reviewer, Coordinator, Guardian, Implementer, Tester, and Learner (model and max turns fully configurable per agent)
- **Pause, stop & resume** — pause mid-stage with clean checkpointing, stop with SIGTERM, resume from where you left off; the UI has pause/resume/stop buttons with real-time state transitions

![Lifecycle controls — Failed status badge with Resume and Stop buttons](docs/screenshots/lifecycle-controls.png)

- **Circuit breakers** — error classification with halt thresholds; when a stage fails too many times, the circuit breaker trips and prevents runaway cost
- **Preflight checks** — language-agnostic environment validation that always runs before spending tokens, catching git state issues, missing dependencies, and configuration problems

![Preflight settings](docs/screenshots/preflight-settings.png)

- **Post-run retrospective (LEARN stage)** — optional stage that analyzes what went well, what failed, and why; produces ranked observations with actionable suggestions and copy-to-clipboard prompts for improving future runs

![Learnings panel — observations ranked by importance with evidence](docs/screenshots/learn-stage.png)

### Work Sources & Integration

- **Multiple input modes** — prompt, spec file, GitHub issue (`gh:issue:42`), beads task (`bd:bd-abc`), or issue URL
- **GitHub issue lifecycle** — start from issues with `--source gh:issue:N`, auto-post progress comments, link PRs, close issues on completion
- **Smart title generation** — `--prompt` is optional; when omitted, the title is generated from the spec or plan file and sanitized for branch names
- **Pipeline events & webhooks** — 52 structured event types emitted as a real-time JSONL stream; subscribe via configurable webhooks with HMAC-SHA256 signing, retry logic, and secret management; control webhooks can pause or abort the pipeline

![Webhooks settings — event system toggles, budget limits, and webhook configuration](docs/screenshots/webhooks-settings.png)

### Governance & Safety

- **Governance hooks** — block dangerous operations (rm -rf, force push, env writes), enforce test gates, validate plans (each guard can be toggled independently)
- **Human approval gates** — optional checkpoints after planning, before merge, and before deploy (configurable per gate)
- **Token and cost tracking** — per-agent usage with model-specific pricing, budget warnings at configurable thresholds

### Customization

- **Agent prompt overlays** — add `.claude/agents/<agent>.md` to customize agent instructions per-project without modifying core templates; overlay blocks can **append** to or **replace** (via `<!-- replace -->`) targeted sections; governance-protected sections cannot be replaced
- **Local settings** — `settings.local.json` deep-merges machine-specific overrides that aren't committed to git
- **Loop controls** — configurable iteration limits for implement/test cycles, code review, and PR updates (per-loop-type limits + global multiplier)

### Multi-Project Dashboard

- **Global mode** — a single `worca-ui --global` instance monitors all registered projects from one browser tab
- **Sidebar project picker** — dropdown with live status dots (green = healthy, red = errors) and run count badges
- **Add-project dialog** — register projects via the UI with path validation and duplicate detection
- **Batch registration** — `worca-ui migrate --scan ~/dev` discovers and registers all worca-enabled projects in one command

![Sidebar project picker with status dots and 20 registered projects](docs/screenshots/sidebar-projects.png)

### Parallel Pipelines

- **`run_multi.py`** — run N pipelines concurrently, each isolated in its own git worktree with independent `.worca/` state, `.beads/` database, and git branch
- **Three-level UI** — projects → pipelines → stages, with per-pipeline pause/stop/resume controls
- **Configurable cleanup** — `on-success` (remove successful worktrees), `always`, or `never`
- **Registry tracking** — all running pipelines are tracked in `.worca/multi/pipelines.d/` for monitoring and stale process recovery

## Prerequisites

- Python 3.8+
- Node.js 22+ (for dashboard)
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude` command)
- Git
- [beads](https://github.com/nightconcept/beads) CLI for task management and work coordination
  ```bash
  npm install -g @beads/bd@0.49.0
  ```
  Use version 0.49.0 specifically — later versions require Dolt DB, which is not needed for this project.

## Installation

### Package install (recommended)

```bash
pip install worca-cc              # Python pipeline + CLI
npm install -g @worca/ui          # Dashboard
npm install -g @beads/bd@0.49.0   # Issue tracking
```

### Initialize a project

```bash
cd your-project
worca init                        # scaffolds .claude/ with pipeline files
```

### Updating

```bash
pip install --upgrade worca-cc
cd your-project && worca init --upgrade
```

## Usage

Four modes of operation:

```bash
# Interactive — open Claude with pipeline hooks active
cd your-project && claude

# Autonomous — run full pipeline from prompt
worca run --prompt "Add user authentication"

# From spec file or pre-made plan
worca run --spec spec.md --plan plan.md

# From GitHub issue
worca run --source gh:issue:42

# From the dashboard — click "New Pipeline" in worca-ui
worca-ui --global
```

### CLI flags

| Flag | Description |
|------|-------------|
| `--prompt TEXT` | Text prompt describing the work (optional — title auto-generated from spec/plan if omitted) |
| `--spec FILE` | Path to spec/requirements file |
| `--source TEXT` | Source reference (`gh:issue:42`, `bd:bd-abc`, or issue URL) |
| `--plan FILE` | Pre-made plan file (skips Plan stage) |
| `--resume` | Resume a previous run from status.json |
| `--branch NAME` | Use an existing branch instead of creating one |
| `--model MODEL` | Override the default model for all agents |
| `--msize [1-10]` | Task size multiplier — scales max_turns per stage |
| `--mloops [1-10]` | Loop multiplier — scales max loop iterations |
| `--settings FILE` | Path to settings.json (default: `.claude/settings.json`) |
| `--status-dir DIR` | Directory for pipeline status files (default: `.worca`) |

`--prompt`, `--spec`, and `--source` are mutually exclusive — provide one.

### Global Dashboard

Start a single worca-ui instance that monitors all registered projects:

```bash
worca-ui start --global          # single instance, port 3400
worca-ui projects add /path      # register a project
worca-ui projects list           # list registered projects
worca-ui migrate --scan ~/dev    # batch-register all worca-enabled projects
```

Projects are stored in `~/.worca/projects.d/` as individual JSON files. Each project auto-registers when the pipeline runs.

### Parallel Pipelines

Run multiple work requests concurrently, each in an isolated git worktree:

```bash
worca multi \
  --requests "Add auth" "Add search" "Add logging" \
  --max-parallel 3

worca multi \
  --sources gh:issue:1 gh:issue:2 \
  --cleanup always
```

| Flag | Description |
|------|-------------|
| `--requests TEXT [TEXT ...]` | Text prompts for each pipeline |
| `--sources TEXT [TEXT ...]` | Source references (`gh:issue:N`, `bd:bd-abc`) |
| `--max-parallel N` | Max concurrent pipelines (default: 3) |
| `--base-branch REF` | Git ref each worktree branches from (default: `main`) |
| `--cleanup POLICY` | Worktree cleanup: `on-success`, `always`, `never` |
| `--msize [1-10]` | Task size multiplier for all pipelines |
| `--mloops [1-10]` | Loop multiplier for all pipelines |

Results are saved to `.worca/multi/results-{timestamp}.json`.

## Dashboard (worca-ui)

```bash
worca-ui --global                         # Monitor all projects (port 3400)
worca-ui --project /path                  # Monitor single project
```

A real-time web dashboard for monitoring and controlling the pipeline. All updates stream via WebSocket — no polling, no page refreshes.

### Pipeline Detail

Stage pipeline with iteration counts, costs, duration, and a timing bar showing Thinking vs Tools breakdown. Expand any stage to drill into per-iteration metrics. Pause, resume, and stop controls in the header.

![Pipeline detail — stage pipeline with costs, turns, and timing bar](docs/screenshots/run-detail-stages.png)

Expand a stage to see individual iterations — each shows agent, turns, cost, duration, and outcome. The log viewer streams real-time agent output with per-stage filtering.

![Pipeline detail — IMPLEMENT expanded](docs/screenshots/pipeline-detail-implement.png)

### Learnings

After a run completes, the LEARN stage produces ranked observations and actionable suggestions. Copy-to-clipboard buttons let you feed insights directly into future runs or agent prompts.

![Learnings panel](docs/screenshots/learn-stage.png)

### Global Dashboard

In global mode (`--global`), the sidebar shows a project picker with all registered projects, live status indicators, and a "New Pipeline" button. Select a project to see its runs, beads, costs, and settings.

![Global dashboard — project-scoped history view with sidebar navigation](docs/screenshots/global-dashboard.png)

### Add Project

Click the **+** button next to the project picker to register a new project. The dialog validates the project path and auto-generates a slug for the project name.

![Add project dialog](docs/screenshots/add-project-dialog.png)

### Run History

Browse completed and interrupted runs sorted newest-first. Each card shows the branch, timing, and stage completion badges.

![Run History](docs/screenshots/history.png)

### New Pipeline

Start a run from a prompt, GitHub issue, or spec file. Advanced options for size/loop multipliers, branch selection, and pre-made plan files.

![New Pipeline](docs/screenshots/new-pipeline.png)

### Beads Task Board

Kanban view of tasks created by the Coordinator, filtered by run. Shows priority badges, dependency chains, and status across Open/In Progress/Closed columns. Badge shows closed/total count (e.g., "3/5 beads").

![Beads Kanban](docs/screenshots/beads-kanban.png)

### Token & Cost Dashboard

Per-run cost breakdown with a stage-proportional bar chart. Detailed table showing cost, turns, duration, and API duration per iteration.

![Cost Dashboard](docs/screenshots/costs.png)

### Settings

Configure agent models and max turns, pipeline stages, governance rules, pricing, webhooks, and preflight checks — all saved to `.claude/settings.json` and effective immediately without restarting.

![Settings](docs/screenshots/settings.png)

## Configuration

All configuration lives in `.claude/settings.json` under the `worca` key:

- **`worca.agents`** — model and max_turns per agent (planner, coordinator, implementer, tester, guardian, learner)
- **`worca.stages`** — enable/disable pipeline stages (preflight, plan, coordinate, implement, test, review, pr, learn), assign agents
- **`worca.loops`** — iteration limits (implement/test: 5, code review: 5, PR changes: 5, restart planning: 2)
- **`worca.governance`** — guards (block rm -rf, force push, env writes), test gate strike limit, dispatch rules
- **`worca.milestones`** — human approval gates (plan, PR, deploy)
- **`worca.pricing`** — per-model token pricing for cost tracking
- **`worca.circuit_breaker`** — max failures before halting, transient error retry logic
- **`worca.events`** — event emission and webhook configuration (HMAC signing, retry, secret management)
- **`worca.parallel`** — parallel pipeline settings (max_concurrent_pipelines: 3, default_base_branch, cleanup_policy: `on-success`|`always`|`never`, worktree_base_dir)

### Local overrides

Create `settings.local.json` next to `settings.json` for machine-specific overrides. It deep-merges on top of the base config and is gitignored.

### Agent prompt overlays

Add `.claude/agents/<agent>.md` files to customize agent prompts per-project. Use `## Override: <Section Name>` blocks to target specific sections. Add `<!-- replace -->` as the first line to replace instead of append. Governance-protected sections (marked `<!-- governance -->`) cannot be replaced.

## Architecture

```
Preflight → Planner → Plan Reviewer → Coordinator → Implementer(s) → Tester → Guardian → Learner
```

Plan Review and Learn are disabled by default; enable via `worca.stages.plan_review.enabled` / `worca.stages.learn.enabled` in settings.json.

| Agent | Role |
|-------|------|
| **Planner** | Reads work request, explores codebase, creates detailed implementation plan |
| **Plan Reviewer** | Validates plan for completeness, feasibility, and architecture fit; loops back to Planner on critical issues |
| **Coordinator** | Decomposes plan into beads tasks with dependencies and parallel groups |
| **Implementer** | Claims task, implements with TDD, commits code, closes task |
| **Tester** | Runs test suite, verifies coverage, collects proof artifacts |
| **Guardian** | Verifies test proof, reviews code, creates PR, manages human gates |
| **Learner** | Analyzes completed run, produces ranked observations and improvement suggestions |

Governance hooks run at every tool call — `pre_tool_use` enforces guards and plan validation, `post_tool_use` enforces test gates and links beads tasks. The event system emits structured events at each stage transition, bead assignment, error, and governance violation.

## Project Structure

After `worca init`, your project gets:

```
.claude/
  worca/                 # Runtime copy of pipeline (managed, overwritten on upgrade)
  agents/                # Your agent prompt overrides (never touched by upgrade)
  settings.json          # Pipeline configuration
```

## License

[MIT](LICENSE)
