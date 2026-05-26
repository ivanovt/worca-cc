# worca-cc

Autonomous software development pipeline combining orchestration with governance enforcement.

## Quick Start

```bash
# Install via /worca-install skill (recommended)
cd worca-cc && claude
# Then type: /worca-install /path/to/my-project

# Or manually copy .claude/ folder
cp -R .claude/ my-project/.claude/
cd my-project/worca-ui && npm install && npm run build && cd -

# Interactive mode
cd my-project && claude

# Autonomous mode (in-place)
python .claude/scripts/run_pipeline.py --prompt "Add user auth"

# Autonomous mode in an isolated git worktree (parallel-safe)
python .claude/scripts/run_worktree.py --prompt "Add user auth" [--branch main] [--guide spec.md]
# --branch: base branch for the new worktree (default: current HEAD)
# --guide: path to a reference guide injected into the plan prompt (repeatable, requires W-040)
```

## Architecture

9 stages: Preflight → Planner (Opus) → Plan Reviewer (Opus) → Coordinator (Opus) → Implementer(s) (Sonnet) → Tester (Sonnet) → Reviewer (Opus) → Guardian (Opus) → Learner (Opus)

Plan Review and Learn are disabled by default; enable via `worca.stages.plan_review.enabled` / `worca.stages.learn.enabled` in settings.json.

All governance enforced via Python hooks in `src/worca/claude_hooks/`.

The rationale behind major architectural choices — UI stack, state model, governance, modularity, webhooks — is consolidated in [`docs/design-principles.md`](./docs/design-principles.md). Read it before proposing structural changes.

## Project Structure

```
src/worca/               # Python package (pip-installable)
  orchestrator/          # Pipeline state machine, stages, prompt builder
  claude_hooks/          # Claude Code hook scripts (pre/post tool use, etc.)
  scripts/               # Pipeline entry points (run_pipeline.py, run_worktree.py)
  agents/core/           # Agent .md templates (planner, coordinator, etc.)
  schemas/               # JSON schemas for structured agent output
  state/                 # Status JSON read/write, iteration tracking
  utils/                 # Claude CLI, beads, git, gh_issues helpers
  cli/                   # CLI entry points (worca init, worca run, etc.)
.claude/
  worca/                 # Runtime copy (created by `worca init .`, gitignored)
  agents/                # User-specific agent overrides
  settings.json          # Pipeline config under the "worca" key
tests/                   # Python tests (pytest)
docs/plans/              # Feature plans (W-NNN-slug.md)
worca-ui/                # Web UI (lit-html + Shoelace + esbuild, top-level npm package)
  app/                   # Source files (views/, utils/, styles.css, main.js)
  server/                # Express API server
```

## Developer Setup (dogfooding)

```bash
pip install -e ".[dev]"   # Editable install — import worca points to src/worca/
worca init .              # Creates .claude/worca/ runtime copy (gitignored)
cd worca-ui && npm install && npm run build && cd -
```

After editing `src/worca/`, run `worca init --upgrade` to refresh `.claude/worca/`.
Tests import from the package directly (`from worca.xxx import yyy`), so they use live source via the editable install.

## Developer Tooling

Project-level skills and subagents (under `.claude/skills/` and `.claude/agents/`) automate recurring engineering rituals for worca-cc itself. They are **dev-time tooling** — separate from the runtime pipeline agents in `src/worca/agents/core/` that ship to consumer projects.

### Skills (invoke explicitly)

| Skill | When to use |
|---|---|
| `/worca-dev-precommit` | Before every commit. Picks the right subset of ruff / biome / vitest / playwright / npm-pack based on what the branch changed. |
| `/worca-plan-new` | Filing a new W-NNN feature plan. Allocates the next ID, scaffolds `docs/plans/W-NNN-*.md` from `_TEMPLATE.md`, creates the GitHub issue with correct title/labels/plan-link. |
| `/worca-issue` | Reading, listing, or filing GitHub issues. Wraps the `--json` workaround and the W-NNN-vs-bug title convention. |
| `/worca-pr-prep` | Before merging a PR. Verifies CI green, branch rebased, then merges via `gh pr merge --merge` (never local merge). |
| `/worca-coverage` | Running Python coverage. Wraps `scripts/coverage.py` for `ci`, step-by-step, and baseline comparison. |
| `/worca-release` | Cutting a stable release (worca-cc, @worca/ui, or both). |
| `/worca-rc` | Cutting a release candidate. |
| `/state-action-matrix` | Loading the pipeline state-action spec before touching states/transitions/gating. |
| `/worca-ui-add-page` | Scaffolding a new worca-ui section across all 4-5 routing wire-up points (view file, main dispatch, header title, sidebar entry, WS/fetch hooks). |
| `/worca-ui-add-card` | Scaffolding a new card view following `worca-ui/docs/card-layout.md` — top/meta/(stages)/actions with central variant map. |
| `/worca-event-add` | Scaffolding a new worca event type across `types.py`, the payload builder, tests, and (if Tier 1) the chat renderer. Reference: `docs/events.md`. |
| `/worca-webhook-test` | Signing and POSTing a synthetic event to a configured webhook URL — verifies HMAC, reachability, and (for control webhooks) the control-action response. |

### Subagents (dispatch via Agent tool)

All prefixed `worca-*` to distinguish them from pipeline agents (planner, coordinator, etc.). Dispatch them when the trigger condition fires — they run in isolated context and return a structured verdict.

| Subagent | Dispatch when |
|---|---|
| `worca-plan-template-reviewer` | After drafting or substantially editing a plan file in `docs/plans/`. Audits against `_TEMPLATE.md` conventions. |
| `worca-dispatch-governance-reviewer` | After editing `worca.governance.dispatch` in settings.json, any agent prompt in `src/worca/agents/core/`, or hook code in `src/worca/claude_hooks/`. |
| `worca-ui-design-reviewer` | After UI changes — checks badge color compliance, the lit-html template binding gotcha, and the npm `files` allowlist. |
| `worca-stage-key-reviewer` | After changes to code that reads `status.json` or compares `stages.*` — catches the silent `'guardian'` (agent) vs `'pr'` (stage key) confusion. |
| `worca-release-preflight` | Right before `/worca-release` or `/worca-rc`. Audits version-file parity, CI status, MIGRATION.md coverage. |
| `worca-ui-routing-reviewer` | After adding or modifying a worca-ui section. Audits all 5 wire-up points (view, dispatch, header, sidebar, WS/fetch). |
| `worca-ui-card-consistency-reviewer` | After changes to any `*-card.js` view. Audits the 4-section layout, `statusIcon`/`statusClass` usage, and per-domain variant map (no inline `variant="success"`). Spec: `worca-ui/docs/card-layout.md`. |
| `worca-ui-a11y-reviewer` | After non-trivial UI changes (new views, dialogs, form controls, status indicators). Raises the a11y floor on new code without forcing global retrofit. |
| `worca-event-payload-reviewer` | After changes under `src/worca/events/`, `tests/test_event_types.py`, or `worca-ui/server/integrations/renderers.js`. Audits payload consistency, test coverage, and Tier 1 renderer wiring. Spec: `docs/events.md`. |
| `worca-integrations-security-reviewer` | After changes to `src/worca/events/webhook.py`, `worca-ui/server/webhook-inbox.js`, or anything under `worca-ui/server/integrations/`. Audits HMAC handling, timing-safe compare, allowlist enforcement, and secret hygiene. |

### Why the prefix

Skills and subagents in this repo split into two scopes:
- **Pipeline agents** (`src/worca/agents/core/*.md`) — the product. Unprefixed names (`planner`, `coordinator`, etc.) ship to consumer projects via `worca init`.
- **Dev-time tooling** (`.claude/skills/worca-*`, `.claude/agents/worca-*`) — only useful in the worca-cc repo itself. The `worca-` prefix signals scope and groups them in skill/agent lists.

## Configuration

Agent config in `.claude/settings.json` under the `worca` namespace. Key sections:
- `worca.stages` — enable/disable stages, override agents
- `worca.agents` — model, max_turns, and effort per agent
- `worca.effort` — auto_mode, auto_cap for adaptive effort levels (see [`docs/effort.md`](./docs/effort.md))
- `worca.models` — shorthand→full model ID mapping (supports per-model env vars)
- `worca.loops` — max iterations for test/review/planning retry loops
- `worca.circuit_breaker` — error classification and halt thresholds
- `worca.governance` — hook guards and dispatch rules (see [`docs/governance.md`](./docs/governance.md) for the full reference)

### Model Profiles (`worca.models`)

Entries in `worca.models` are either a plain string (model ID) or `{id, env}` — the `env` map is merged into the subprocess environment when that model runs, useful for routing through alternative endpoints or tuning per-stage settings like `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.

Key gotchas:

- **Secrets** belong in `settings.local.json` (gitignored, deep-merged over `settings.json`). The UI Secrets panel writes exclusively to this file. Never inline secrets in `settings.json`.
- **Reserved keys** matching `WORCA_*`, `PATH`, or `CLAUDECODE` are silently stripped with a stderr warning. Denylist shared between Python (`src/worca/utils/env.py`) and JS (`worca-ui/server/reserved-env-keys.json`).
- **Worktree materialization:** parent's `settings.local.json` secrets are materialized into the worktree's `settings.json` (gitignored). Same on-disk plaintext exposure model as `~/.aws/credentials`.
- **`work_request.py` haiku coupling:** `extract_work_request` resolves its hardcoded `--model haiku` through `resolve_model()`, so customizing the `haiku` entry also retargets work-request title generation. Intentional.

### Effort Levels (`worca.effort`)

Per-agent reasoning effort (`low | medium | high | xhigh | max`) is configured via `worca.agents.<agent>.effort` and governed by a pipeline-level `worca.effort` block. Omitted `effort` means "use Claude Code's model default." Full reference: [`docs/effort.md`](./docs/effort.md).

`worca.effort.auto_mode` controls starting point and loopback escalation:

| Mode | Starting point | Escalation on loopbacks |
|---|---|---|
| `disabled` | Per-agent value or model default | No |
| `reactive` | Per-agent value or model default | Yes |
| `adaptive` (default) | Per-agent value if set, else coordinator's bead label | Yes |

Under `adaptive`, the coordinator classifies each bead's complexity via `worca-effort:<level>` labels during decomposition. The implementer uses that label as its starting point (unless an explicit per-agent value overrides it).

Key points:
- **`auto_cap`** (default `xhigh`) is the ceiling for runtime-resolved levels.
- **Model-aware ladders:** effort rungs are model-specific. The shipped models (Opus 4.6, Sonnet 4.6) lack `xhigh` — the 4-rung ladder is `low/medium/high/max`. Resolution collapses requested levels onto the model's ladder.
- **Env-var seam:** resolved effort passes through `CLAUDE_CODE_EFFORT_LEVEL`. This is the only non-interactive way to set `max`.
- Set `auto_mode: "disabled"` to reproduce pre-W-052 behavior (no escalation, no bead-label consumption).

## Code Hosting

This project uses **GitHub** with the `gh` CLI. PR creation command:

```bash
gh pr create --title "..." --body "..."
```

**Merging PRs:** Always use `gh pr merge <number> --merge` (not local `git merge` + push). This ensures GitHub auto-closes the PR and links the merge commit properly.

**Reading issues — always pass `--json`.** This repo has at least one classic-Projects-linked issue, and the default `gh issue view N` (and the unfiltered `gh issue list`) fail on the deprecated `repository.issue.projectCards` GraphQL field:

```
GraphQL: Projects (classic) is being deprecated in favor of the new Projects experience…
(repository.issue.projectCards)
```

Use `--json` with explicit fields to bypass it. Defaults that work:

```bash
gh issue view 119 --json number,title,body,labels,state,assignees,comments
gh issue list --json number,title,labels,state --limit 30
gh issue list --label area:cc --json number,title,labels --limit 30
```

For a human-readable view, post-process with `--jq` (e.g. `--jq '"#\(.number) \(.title)"'`) instead of falling back to the unfiltered command.

**Editing a PR/issue body — use the REST API, not `gh pr edit`.** `gh pr edit <N> --body …` hits the same classic-Projects deprecation (`repository.pullRequest.projectCards`) and **aborts without applying the change** — silently leaving the body unedited. Patch via REST instead (no `projectCards` path):

```bash
python3 -c "import json; print(json.dumps({'body': open('/tmp/body.md').read()}))" > /tmp/patch.json
gh api --method PATCH repos/SinishaDjukic/worca-cc/pulls/<N> --input /tmp/patch.json
# verify: gh pr view <N> --json body --jq .body
```

Build the JSON with `json.dumps` (or `jq`) so backticks/emoji in the body survive shell quoting and JSON escaping. Note: `gh pr merge` and `gh pr view --json …` do *not* trigger this — only the `gh pr edit` mutation does.

The guardian agent uses this when creating PRs. Adapt this section for GitLab (`glab`), Bitbucket, or other hosting platforms.

> Use `/worca-issue` to read/list/create issues — it bakes in the `--json` workaround, the W-NNN-vs-bug title rule, and the required label set. Use `/worca-pr-prep` to run the pre-merge gate.

## Development Approach

This project follows **TDD (Test-Driven Development)**:
1. Write a failing test first
2. Write minimal code to pass
3. Refactor

Implementer agents read this section to determine the testing methodology.

## Linting

```bash
ruff check .                                              # Python lint
cd worca-ui && npm run lint                       # UI lint (biome)
cd worca-ui && npm run lint:fix                   # Auto-fix UI lint issues
```

**CI enforces biome formatting strictly.** Always run `cd worca-ui && npm run lint` before committing any worca-ui changes (JS, server, app). Use `npm run lint:fix` to auto-fix formatting issues. Common biome rules: long ternaries must be split across lines, trailing commas required.

> Use `/worca-dev-precommit` to bundle ruff + biome + vitest + (conditional) playwright + npm-pack check — it picks the right subset based on what changed.

## Testing

```bash
pytest tests/                              # All Python tests
pytest tests/test_<module>.py              # Single module
pytest tests/integration/                  # Pipeline integration tests (uses mock claude)
npx vitest run worca-ui/server/    # UI server tests
cd worca-ui && npx playwright test --workers=1  # Browser e2e tests (must run serially)
```

Test naming: `tests/test_<module>.py` mirrors source module names. To skip a failing test, name it and verify it fails on the parent commit — aggregate dismissals ("pre-existing", "flaky", "unrelated") are not accepted.

**Integration tests** (`tests/integration/`) run the full pipeline with a mock Claude CLI (`tests/mock_claude/mock_claude.py`). They require `pip install -e ".[dev]"` and Unix (signal tests are skipped on Windows). Each test spins up a temp git repo + worca runtime, so they're slower (~30-60s for the full suite).

**Playwright note:** Browser e2e tests must run with `--workers=1` (serial). Parallel workers cause flaky failures due to browser context contamination between isolated test servers.

**Conditional Playwright runs (UI changes).** When the diff between `$WORCA_BASE_BRANCH` and `HEAD` touches any path under `worca-ui/app/` or `worca-ui/server/`, the tester MUST run Playwright in addition to vitest:

```bash
cd worca-ui && npx playwright test --workers=1
# Per-file if you hit port collisions:
cd worca-ui && npx playwright test e2e/<spec>.spec.js --workers=1
```

This closes the feedback loop inside the implementer → tester iteration instead of waiting for out-of-band CI. The per-failure attribution rules above apply: name each failing test, verify against the parent commit, or route the failure back to the implementer.

If the Chromium binary is missing (`npx playwright install chromium` was never run in this environment), state that explicitly in your verdict — do not silently skip the suite.

**Coverage runs** (Python) use the centralized runner in `scripts/coverage.py`:

```bash
python scripts/coverage.py ci                                     # run + combine + JSON + XML + text
python scripts/coverage.py ci --include-unit-tests                # include unit tests (wraps pytest with coverage run)
python scripts/coverage.py run                                    # pytest under WORCA_COVERAGE=1
python scripts/coverage.py combine                                # merge .coverage.* fragments
python scripts/coverage.py report --format=text                   # terminal (default)
python scripts/coverage.py report --format=json --out=cov.json    # augmented JSON
python scripts/coverage.py report --format=html                   # htmlcov/
python scripts/coverage.py compare --baseline=before.json --current=after.json
```

`ci` is the one-shot used locally and in CI: it erases stale state, runs pytest with `WORCA_COVERAGE=1`, combines fragments, and writes `coverage-out/coverage.json` (augmented schema with `summary`, `modules`, `omitted`, `raw`) plus `coverage-out/coverage.xml` (Cobertura-compatible). The pytest exit code is forwarded so CI fails on real test regressions even when coverage upload succeeds.

`--include-unit-tests` wraps the pytest invocation itself with `coverage run --parallel-mode` and targets `tests/` (instead of `tests/integration/` only), so in-process unit test calls are measured alongside subprocess fragments. Default off — doubles wall time but produces accurate per-module numbers for modules exercised only by unit tests. Pass this flag explicitly when a full-coverage baseline is needed.

`compare` diffs a current `coverage.json` against a saved baseline and prints per-module pp deltas — useful for per-phase tracking without bolting in a `--fail-under` gate. Threshold enforcement stays out of scope until baselines stabilize.

The integration suite uses subprocess-level coverage — each pipeline run is wrapped with `coverage run --parallel-mode` by `tests/integration/conftest.py:_wrap_with_coverage`, producing one fragment per pipeline subprocess. Setting `WORCA_COVERAGE=1` activates this AND auto-disables `pytest-cov` for the run (via the `pytest_load_initial_conftests` hook in `tests/conftest.py`) — without that, pytest-cov's session_finish hook silently consumes the fragments before `coverage combine` can merge them. Without `WORCA_COVERAGE=1`, the standard `pytest --cov=worca` flow stays available for unit-test coverage.

The raw `coverage` CLI still works for ad-hoc use (`coverage combine && coverage report`); the runner is just a thin orchestrator that handles the cleanup-and-combine sequencing and exposes a JSON shape stable enough for downstream tooling.

> Use `/worca-coverage` for the common flows — it wraps `scripts/coverage.py` with the right env vars and surfaces the comparison workflow.

## Governance

- Only the **guardian** agent may run `git commit` (enforced by pre_tool_use hook checking `WORCA_AGENT` env var)
- Source file writes are blocked until `MASTER_PLAN.md` exists (plan_check hook, only active when `WORCA_AGENT` is set)
- The post_tool_use hook has a test gate: 2 consecutive pytest failures block further tool calls
- Tool, skill, and subagent dispatch is governed per agent role via `worca.governance.dispatch`

### Dispatch Governance (`worca.governance.dispatch`)

`tools`, `skills`, and `subagents` each follow a three-tier model:

1. **`always_disallowed`** — hard-deny defaults. Shipped from `_DISPATCH_DEFAULTS` in `tracking.py`; project-editable but rarely should be edited.
2. **`default_denied`** — blocked unless the agent names them in `per_agent_allow`. The `"*"` wildcard does NOT include these.
3. **`per_agent_allow`** — per-agent allow list with `_defaults` fallback. `"*"` means "everything except the deny tiers". `[]` falls through to `_defaults`. `["none"]` is the explicit lockdown sentinel (`LOCKDOWN_SENTINEL`).

MCP tools (`mcp_*`) flow through other channels, not `--tools`. For the full reference — including the shipped denylist contents, mixed-form semantics, the CLI-flag mapping for `tools`, and the resolution algorithm — see [`docs/governance.md`](./docs/governance.md). Dispatch the `worca-dispatch-governance-reviewer` subagent after changes here.

## Events & Webhooks

worca emits ~80 event types across `pipeline.*`, `control.*`, `fleet.*`, and `workspace.*` domains. The full reference lives in [`docs/events.md`](./docs/events.md) — start there before adding a new event type, configuring a webhook subscriber, or writing an integrations adapter. Subscribers can register webhooks (`worca.webhooks` in settings.json, with optional HMAC signing and control-response support) or chat adapters (Telegram, Discord, Slack, generic — configured at `~/.worca/integrations/config.json`).

When adding a new event, use `/worca-event-add` to scaffold the constant, payload builder, test, and (if Tier 1) the chat renderer in one pass. To test a webhook config without running a pipeline, use `/worca-webhook-test`. The `worca-event-payload-reviewer` and `worca-integrations-security-reviewer` subagents audit changes for consistency and security correctness.

## Guide Precedence

When a pipeline run includes a `--guide` file, the guide is injected into the work request under a `## Reference Guide (normative)` header by `attach_guide()` in `work_request.py`. All agents must treat it as the highest-authority source:

**Authority order: guide > plan > description**

- The **guide** is normative — it overrides everything else. It typically carries a migration spec, RFC, or compliance requirement.
- The **plan** is derived from the guide and description. If it diverges from the guide, the guide wins.
- The **description** is task scope. Conflicts with the guide are bugs in the description, not the guide.

Agent behavior when a guide is present:

| Agent | Behavior |
|-------|----------|
| **Planner** | Produces a plan that conforms to the guide. Reports any description-vs-guide conflict rather than silently picking a side. |
| **Reviewer** | Flags any plan instruction that contradicts the guide as a `critical` issue. Surfaces plan-vs-guide divergence explicitly. |
| **Tester** | Flags guide-vs-description conflicts as bug notes in proof artifacts. Does not resolve conflicts — surfaces them. |

See `src/worca/agents/core/planner.md`, `reviewer.md`, and `tester.md` for the per-agent instruction blocks.

## Knowledge Graph (Graphify)

Optional, **off by default**. When `worca.graphify.enabled` is `true` (project-level), the **Preflight** stage builds a per-commit code knowledge graph with the [graphify](https://github.com/safishamsi/graphify) CLI (`graphify update`), content-addressed under `$WORCA_CACHE/ast/<repo-id>/<sha>/graphify/` with a `.complete` marker. Nothing is written into the repo tree.

**Agents query the graph on demand — they are not fed the report.** When a `ready` graph exists, the runner exports `GRAPHIFY_OUT=<snapshot>/graphify` into every agent subprocess (`run_agent(..., graphify_out=…)`), so a bare `graphify query "<question>"` reads the cached `graph.json` (graphify ≥0.8.16 honors `GRAPHIFY_OUT` for reads). Each stage prompt carries only a one-line availability note (`{{#if has_graphify}}` in the `.block.md`); the how-to-use guidance is a static `## Knowledge graph (advisory)` section in each agent's core `.md`. No report content or graph path is ever injected. Authority order: **guide > plan > graph > description** (the graph is advisory orientation).

`GRAPH_REPORT.md` is built and cached for **humans** — the UI Graphify tab surfaces a copy-able `graphify query "<question>" --graph <path>` snippet — not for agents.

**Governance:** the `pre_tool_use` hook blocks mutating graphify subcommands (`update`, `install`, `uninstall`, `add`, `hook`, `merge-driver`, `watch`, `clone`) and allows reads (`query`, `explain`, `path`, `affected`, `diagnose`), gated by `worca.governance.guards.block_graphify_mutation` (default `true`). The pipeline owns all graph builds (preflight + post-guardian cache-warm), run as detached subprocesses that bypass the hook.

**Install (only if enabling):** `uv tool install 'graphifyy>=0.8.16,<1'` — the PyPI package is `graphifyy` (double-y); the CLI it installs is `graphify`. Prefer `uv`/`pipx` over plain `pip` so the CLI lands on PATH. Worca pins `>=0.8.16,<1` (the `update` command + `GRAPHIFY_OUT`-honoring reads).

Spec: [`docs/plans/W-053-graphify-integration.md`](./docs/plans/W-053-graphify-integration.md).

## worca-ui Development

**Badge color language:** all `sl-badge` variants and status colors follow the guide in [`worca-ui/docs/badge-color-language.md`](./worca-ui/docs/badge-color-language.md). Read it before adding or modifying badges — blue means active, orange means caution, green means done.

**Card layout:** all card-style views (run, fleet, workspace, worktree) share the `.run-card` base structure documented in [`worca-ui/docs/card-layout.md`](./worca-ui/docs/card-layout.md). New card types must follow the 4-section pattern (top → meta → stages → actions) and route through `statusIcon`/`statusClass` + a per-domain variant map.

After modifying any source files in `worca-ui/app/`, rebuild the bundle:

```bash
cd worca-ui && npm run build
```

This runs esbuild to produce `app/main.bundle.js`. Without rebuilding, changes won't take effect.

**Before committing any worca-ui changes**, always run lint and tests locally to catch failures before they reach CI:

```bash
cd worca-ui && npm run lint:fix && npx vitest run
```

Run both checks from inside `worca-ui/` so config paths resolve correctly. Do not commit if either fails — fix them first.

**Whenever you add a new file or directory under `worca-ui/server/` or `worca-ui/app/`, verify it ships in the npm package.** The `files` field in `worca-ui/package.json` is an allowlist — anything not matched is silently dropped from the published tarball. The CLI spawns the server with `stdio: 'ignore'`, so a missing-module crash in the published package looks like "started (PID …)" followed by the browser failing to connect — the underlying error is invisible.

Run this before committing any new `server/` or `app/` path:

```bash
cd worca-ui && npm pack --dry-run | grep <new-path>
```

If the new file is absent, extend the `files` glob (e.g. `server/**/*.js` rather than `server/*.js`) and re-check.

> Dispatch `worca-ui-design-reviewer` after non-trivial UI changes — it audits badge color compliance, the lit-html template binding gotcha, and the npm `files` allowlist in one pass.

### Running the UI

```bash
pnpm worca:ui                        # Build + start in global mode (port 3400, default)
pnpm worca:ui:stop                   # Stop the global server
pnpm worca:ui:restart                # Rebuild + restart in global mode
PORT=3401 pnpm worca:ui              # Custom port via env var
pnpm worca:ui -- --port 3401         # Custom port via flag
pnpm worca:ui -- --project /path     # Single-project mode
pnpm worca:ui -- --help              # Show all commands and options
pnpm worca:ui -- --version           # Print version
```

The `--port` flag takes precedence over the `PORT` env var. `HOST` / `--host` works the same way (default `127.0.0.1`).

Global mode (the default) starts the UI without a fixed project root, serving all projects registered in `~/.worca/projects.d/`. Use `--project` to scope to a single project.

**Fleet and workspace grouping requires global mode.** Fleet (`--fleet-id`) and workspace (`--workspace-id`) grouping headers only appear when all member runs are visible across all registered projects. In single-project mode, cross-project siblings are invisible and the UI surfaces an inline notice prompting the user to switch to global mode.

### Worktree cleanup

Each `run_worktree.py` invocation creates a git worktree on disk. Worktrees persist until explicitly removed:

```bash
worca cleanup                    # Interactive: list completed worktrees, prompt to remove
worca cleanup --all              # Remove all completed/failed worktrees without prompting
worca cleanup --run-id <id>      # Remove a specific worktree by run ID
worca cleanup --dry-run          # Preview what would be removed
worca cleanup --older-than 7d   # Remove worktrees started more than 7 days ago
```

Running worktrees are never eligible for cleanup. Use `git worktree list` to see all worktrees.

## Fleet Runs

Fan out a single work-request to N independent projects in parallel via `python .claude/scripts/run_fleet.py --projects <paths> --prompt "..."`. Supports `--guide` (repeatable), `--plan` (shared plan skips child Planner), `--plan-first` (reference-project planning), `--base`/`--head-template` for branch naming, `--max-parallel` (default 5), and a circuit breaker on failure ratio (default 0.30).

Lifecycle actions on an existing fleet_id: `--pause` (paused at next checkpoint), `--stop` (immediate SIGTERM), `--resume` (continues in place or re-dispatches failed children). `--branch` is explicitly rejected — use `--base` + `--head-template`. Worktree cleanup via `worca cleanup --fleet-id <id>`.

Full walkthrough (every flag, halt-vs-pause-vs-stop matrix, circuit breaker semantics, resume behavior): [`docs/fleet-runs.md`](./docs/fleet-runs.md).

## Workspace Runs

Coordinate changes across interdependent projects with dependency-ordered execution via `python .claude/scripts/run_workspace.py <parent-dir> --prompt "..."`. Unlike fleet runs (same prompt to N independent projects), workspace runs decompose one prompt into per-project sub-plans, execute them in DAG tier order, run cross-project integration tests, and create linked PRs with dependency metadata.

A workspace is defined by `workspace.json` in a parent directory listing sibling projects with `depends_on` relationships, an optional `integration_test` command, and an optional `umbrella_repo`. Initialize with `worca workspace init <parent>`. Child pipelines are standard worca runs via `run_worktree.py` — governance, hooks, and stage machinery are unchanged.

Supports `--guide`, `--skip-integration`, `--skip-planning` (each project plans independently), `--workspace-plan PATH` (reuse an existing workspace-plan.json), `--project-plan NAME=PATH` (repeatable, per-repo markdown plans), `--resume`, `--dry-run` (prints the DAG and exits), `--max-parallel` (default 5). Worktree cleanup via `worca cleanup --workspace-id <id>`. See W-056 for planning strategy options — four modes are documented in [`docs/workspace-runs.md` § Planning strategies](./docs/workspace-runs.md#planning-strategies).

Full walkthrough (workspace.json schema, master-planner role, DAG executor + context injection between tiers, integration testing, PR linking with dependency comments, umbrella issue): [`docs/workspace-runs.md`](./docs/workspace-runs.md).

## Migrating

User-facing upgrade and cleanup steps live in [`MIGRATION.md`](./MIGRATION.md).

## Releasing

Two independent packages release by pushing tags — CI handles publishing. **Never use twine or npm publish manually.**

| Package | Version source | Tag format |
|---|---|---|
| `worca-cc` | `pyproject.toml` + `src/worca/__init__.py` (both must match) | `worca-cc-vX.Y.Z` |
| `@worca/ui` | `worca-ui/package.json` | `worca-ui-vX.Y.Z` |

Use `/worca-release` (stable) or `/worca-rc` (RC) — they handle version bump + commit + tag + push. CI validates tag matches version, builds, tests, and publishes (PyPI via trusted publishing, npm via `NPM_TOKEN`). Releases are independent — a UI fix doesn't require a Python release. Dispatch `worca-release-preflight` first to audit version-file parity, master/CI state, and MIGRATION.md coverage.

## Plans & Roadmap

- Feature tracking lives in **GitHub Issues**: https://github.com/SinishaDjukic/worca-cc/issues
- Labels: `area:cc` / `area:ui` for component, `P0`-`P4` for priority
- When a feature is completed, close the GitHub issue
- Bead-run linking uses labels (`run:{run_id}`), not `external_ref`

### GitHub Issue Structure

Issues use this structure so the pipeline can auto-detect plan files when started with `--source gh:issue:N`:

```markdown
## Problem

## Proposal

## Considerations

## Plan

- [docs/plans/W-NNN-slug.md](https://github.com/SinishaDjukic/worca-cc/blob/master/docs/plans/W-NNN-slug.md)
```

**Key rules:**
- Title — features/refactors: `W-NNN: Short Description`. Bugs: plain descriptive title, no prefix.
- Labels — one of `area:cc` / `area:ui` + one of `P0`-`P4`. Bugs add `bug`.
- The `## Plan` link MUST be an absolute blob URL — the pipeline parses this exact format. Missing/relative link means the pipeline runs the Planner.
- Plan file convention: `docs/plans/W-NNN-short-description.md`. Write per [`docs/plans/_TEMPLATE.md`](./docs/plans/_TEMPLATE.md).
- `W-NNN` is for features/refactors only. Bugs do not get an allocation; if a fix is large enough to need a plan, file it as a refactor with `W-NNN` instead.

Use `/worca-plan-new` to file a new W-NNN end-to-end. After drafting, dispatch `worca-plan-template-reviewer` to audit against the template.
