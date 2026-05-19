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

## Configuration

Agent config in `.claude/settings.json` under the `worca` namespace. Key sections:
- `worca.stages` — enable/disable stages, override agents
- `worca.agents` — model and max_turns per agent
- `worca.models` — shorthand→full model ID mapping (supports per-model env vars)
- `worca.loops` — max iterations for test/review/planning retry loops
- `worca.circuit_breaker` — error classification and halt thresholds
- `worca.governance` — hook guards and dispatch rules

### Model Profiles (`worca.models`)

Each entry in `worca.models` is either a plain string (model ID) or an object with `id` and optional `env`:

```jsonc
"worca": {
  "models": {
    "opus":   "claude-opus-4-6",              // string form — no env vars
    "sonnet": "claude-sonnet-4-6",
    "alt-fast": {                             // object form — per-model env vars
      "id": "some-fast-model-id",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.example.com/v1",
        "API_TIMEOUT_MS": "3000000"
      }
    }
  }
}
```

When a stage runs using a model that has an `env` map, those variables are merged into the subprocess environment. This allows routing individual agents through alternative endpoints or tuning per-stage settings like `CLAUDE_CODE_MAX_OUTPUT_TOKENS`.

**Secrets** belong in `settings.local.json` (gitignored, deep-merged over `settings.json` by `load_settings()`). The UI Secrets panel writes exclusively to this file:

```jsonc
// settings.local.json
"worca": {
  "models": {
    "alt-fast": { "env": { "ANTHROPIC_AUTH_TOKEN": "sk-..." } }
  }
}
```

**Reserved keys:** env vars matching `WORCA_*`, `PATH`, or `CLAUDECODE` are silently stripped (with a stderr warning) to prevent misconfiguration from breaking pipeline internals. The denylist is shared between Python (`src/worca/utils/env.py`) and JS (`worca-ui/server/reserved-env-keys.json`).

**Worktree materialization:** when a pipeline runs in a worktree, secrets from the parent's `settings.local.json` are materialized into the worktree's `settings.json` (which is gitignored). This is the same on-disk plaintext exposure model as `~/.aws/credentials`.

**`work_request.py` haiku coupling:** the `extract_work_request` helper resolves its hardcoded `--model haiku` through the same `resolve_model()` path as agent stages. A user who customizes their `haiku` entry also retargets work-request title generation — this is intentional for consistent routing.

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

The guardian agent uses this when creating PRs. Adapt this section for GitLab (`glab`), Bitbucket, or other hosting platforms.

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

## Governance

- Only the **guardian** agent may run `git commit` (enforced by pre_tool_use hook checking `WORCA_AGENT` env var)
- Source file writes are blocked until `MASTER_PLAN.md` exists (plan_check hook, only active when `WORCA_AGENT` is set)
- The post_tool_use hook has a test gate: 2 consecutive pytest failures block further tool calls
- Subagent dispatch is restricted per agent role (tracking hook)

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

## worca-ui Development

**Badge color language:** all `sl-badge` variants and status colors follow the guide in [`worca-ui/docs/badge-color-language.md`](./worca-ui/docs/badge-color-language.md). Read it before adding or modifying badges — blue means active, orange means caution, green means done.

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

Fan out a single work-request to N independent projects in parallel using `run_fleet.py`.

```bash
# Basic fleet: same prompt to 3 projects
python .claude/scripts/run_fleet.py \
  --projects /path/to/repo-a /path/to/repo-b /path/to/repo-c \
  --prompt "Apply authentication migration"

# With a normative guide and shared base branch
python .claude/scripts/run_fleet.py \
  --projects /path/to/repo-a /path/to/repo-b \
  --prompt "Migrate to v2 API" \
  --guide ./migration-spec.md \
  --base main

# Skip per-child planning by supplying a shared plan
python .claude/scripts/run_fleet.py \
  --projects /path/to/repo-a /path/to/repo-b \
  --prompt "Apply logging standards" \
  --plan ./shared-plan.md

# Pause / stop / resume a fleet (lifecycle actions on an existing fleet_id)
python .claude/scripts/run_fleet.py --pause  f_202601011200_abc12345
python .claude/scripts/run_fleet.py --stop   f_202601011200_abc12345
python .claude/scripts/run_fleet.py --resume f_202601011200_abc12345
```

### Key flags

| Flag | Description |
|------|-------------|
| `--projects PATH [PATH ...]` | Target project paths |
| `--projects-file FILE` | File listing project paths (one per line) |
| `--prompt TEXT` | Work-request prompt (mutually exclusive with `--source`) |
| `--source REF` | Source reference (`gh:issue:42`, `bd:bd-abc`) |
| `--guide PATH` | Normative reference guide injected into every child's prompt (repeatable, resolved to absolute paths before dispatch) |
| `--plan PATH` | Shared plan file; every child skips the PLAN stage |
| `--plan-first [PROJECT]` | Run the Planner on a reference project first; remaining children inherit its plan |
| `--base BRANCH` | PR base branch shared across the fleet (each project's default if omitted) |
| `--head-template TMPL` | Per-child head branch name template. Placeholders: `{project}`, `{fleet_id}`, `{slug}`, `{yyyymmdd}`, `{yyyymmddhhmm}` |
| `--max-parallel N` | Maximum concurrent child pipelines (default: 5) |
| `--fleet-failure-threshold RATIO` | Failure ratio that trips the circuit breaker and halts unstarted children (default: 0.30) |
| `--pause FLEET_ID` | Pause a running fleet — write a `pause` control file to every in-flight child (manifest → `paused`) |
| `--stop FLEET_ID` | Stop a running fleet — write a `stop` control file + SIGTERM every in-flight child (manifest → `halted`, `halt_reason=stopped`) |
| `--resume FLEET_ID` | Resume a halted/stopped/paused/failed fleet — continue paused/interrupted children in place, re-dispatch failed/pending children |

`--branch` is explicitly rejected — use `--base` for the PR base branch and `--head-template` for the per-child head branch name. `--pause`, `--stop` and `--resume` are mutually exclusive lifecycle actions.

### Halt vs. Pause vs. Stop

Three ways to wind down an in-flight fleet, differing only in how they treat children already running:

| Action | New children | In-flight children | Manifest state |
|--------|--------------|--------------------|----------------|
| **Halt** (`DELETE /api/fleet-runs/:id`) | not launched | keep running until they finish naturally | `halted` / `halt_reason=user` |
| **Pause** (`--pause`) | not launched | paused at next checkpoint, resumable in place | `paused` |
| **Stop** (`--stop`) | not launched | interrupted immediately (SIGTERM), resumable in place | `halted` / `halt_reason=stopped` |

All three are sticky — only `--resume` (or the UI Resume button) clears them. Resume continues `paused`/`interrupted` children in their existing worktrees and re-dispatches `failed`/`pending` ones fresh.

### Fleet cleanup

Fleet worktrees are cleaned up with the standard `worca cleanup` command extended with a fleet-scoped flag:

```bash
worca cleanup --fleet-id <fleet_id>   # Remove all child worktrees + fleet manifest dir
```

See [`docs/fleet-runs.md`](./docs/fleet-runs.md) for a full walkthrough including guide attachment, plan modes, the circuit breaker, and resume behavior.

## Workspace Runs

Coordinate changes across interdependent projects with dependency-ordered execution using `run_workspace.py`. Unlike fleet runs (same prompt to N independent projects), workspace runs decompose one prompt into project-specific sub-plans, execute them in DAG tier order, run cross-project integration tests, and create linked PRs with dependency metadata.

A workspace is defined by a `workspace.json` in a parent directory whose children are sibling git projects. Child pipelines are standard worca runs dispatched via `run_worktree.py` — all existing governance, hooks, and stage machinery are unchanged.

```bash
# Initialize a workspace from a parent directory containing git projects
worca workspace init /path/to/parent

# Edit workspace.json to define depends_on relationships and integration test
# Then run a coordinated pipeline:
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Add user authentication across all services"

# With a normative guide
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Migrate to v2 API" \
  --guide ./migration-spec.md

# Skip master planner (use per-project independent planning)
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Apply logging standards" \
  --skip-planning

# Dry-run: print the DAG and exit
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Add auth" --dry-run

# Resume a failed/halted workspace run
python .claude/scripts/run_workspace.py /path/to/parent \
  --resume ws_202601011200_abc12345
```

### Key flags

| Flag | Description |
|------|-------------|
| `WORKSPACE_ROOT` | Positional: path to parent directory containing `workspace.json` |
| `--prompt TEXT` | Work-request prompt (mutually exclusive with `--source`) |
| `--source REF` | Source reference (`gh:issue:42`, `bd:bd-abc`) |
| `--guide PATH` | Normative reference guide (repeatable) |
| `--branch TEMPLATE` | Branch name template with `{workspace}`, `{project}`, `{slug}` placeholders (default: `workspace/{slug}/{project}`) |
| `--skip-integration` | Skip the cross-project integration test phase |
| `--skip-planning` | Skip the master planner; each project plans independently |
| `--resume WORKSPACE_ID` | Resume a failed/halted workspace run |
| `--max-parallel N` | Max concurrent children within a tier (default: 5) |
| `--dry-run` | Print the DAG and exit without launching children |

### workspace.json format

```json
{
  "name": "my-platform",
  "projects": [
    { "name": "shared-lib", "path": "shared-lib", "depends_on": [] },
    { "name": "backend",    "path": "backend",    "depends_on": ["shared-lib"] },
    { "name": "frontend",   "path": "frontend",   "depends_on": ["shared-lib"] }
  ],
  "integration_test": {
    "command": "docker compose run integration-tests",
    "working_dir": "."
  },
  "umbrella_repo": "org/my-platform"
}
```

Fields: `name` (workspace display name), `projects` (list with `name`, `path`, `depends_on`), `integration_test` (optional: `command` + `working_dir`), `umbrella_repo` (optional: GitHub `org/repo` for umbrella issue).

### Execution flow

1. **Master planner** reads every project's `CLAUDE.md`, decomposes the prompt into per-project sub-plans (agent + model configurable via `worca.agents.workspace_planner` in settings)
2. **DAG executor** runs tiers sequentially — projects within a tier run in parallel (up to `--max-parallel`)
3. **Context injection** — between tiers, completed projects' diffs (8 KB cap) are injected as `--guide` into the next tier's children
4. **Integration test** — after all tiers, runs the user-defined `integration_test.command`; if it fails, no PRs are created
5. **PR linking** — creates per-project PRs with dependency comments (`Depends on: org/lib#15`, `Blocks: org/frontend#43`) and an umbrella issue listing all PRs in merge order

### Workspace cleanup

```bash
worca cleanup --workspace-id <workspace_id>   # Remove all child worktrees + workspace run dir
```

See [`docs/workspace-runs.md`](./docs/workspace-runs.md) for a full walkthrough including DAG execution, context injection, integration testing, PR linking, and resume behavior.

## Migrating

User-facing upgrade and cleanup steps live in [`MIGRATION.md`](./MIGRATION.md).

## Releasing

Two independent packages — release by pushing tags. **Do not use twine or npm publish manually; CI handles publishing.**

| Package | Version source | Tag format |
|---|---|---|
| `worca-cc` | `pyproject.toml` + `src/worca/__init__.py` (both must match) | `worca-cc-vX.Y.Z` |
| `@worca/ui` | `worca-ui/package.json` | `worca-ui-vX.Y.Z` |

Steps (same for both):

1. Bump version in the version source file(s)
2. Commit and push
3. Tag and push tag:
   ```bash
   git tag worca-cc-v0.6.0rc6    # or worca-ui-v0.1.0-rc.4
   git push origin <tag>
   ```
4. CI validates tag matches version, builds, tests, and publishes (PyPI via trusted publishing, npm via `NPM_TOKEN` secret)

Releases are independent — a UI fix doesn't require a Python release.

Update commands for users:
```bash
pip install --upgrade worca-cc==X.Y.Z
npm install -g @worca/ui@X.Y.Z
```

## Plans & Roadmap

- Feature tracking lives in **GitHub Issues**: https://github.com/SinishaDjukic/worca-cc/issues
- Labels: `area:cc` / `area:ui` for component, `P0`-`P4` for priority
- When a feature is completed, close the GitHub issue
- Bead-run linking uses labels (`run:{run_id}`), not `external_ref`

### GitHub Issue Structure

Issues must follow this structure so the pipeline can auto-detect plan files when started with `--source gh:issue:N`:

```markdown
## Problem

<What's wrong or missing — 2-5 sentences>

## Proposal

<What to build and how — bullet points or short paragraphs>

## Considerations

<Trade-offs, edge cases, dependencies — optional>

## Plan

- [docs/plans/W-NNN-short-description.md](https://github.com/SinishaDjukic/worca-cc/blob/master/docs/plans/W-NNN-short-description.md)
```

**When to use the `W-NNN:` prefix:**
- **Use it** for major features and refactoring — anything that warrants a plan file in `docs/plans/`. The `W-NNN` ties the issue, the plan file, and any branches/PRs together.
- **Do NOT use it for bugs.** Bug issues use a plain descriptive title (e.g. `GH-issue plan auto-detect hardcodes docs/plans/`) and do not get a `W-NNN` allocation. They also typically skip the `## Plan` section unless the fix is large enough to warrant one — in which case it's no longer a bug and should be filed as a `W-NNN` refactor/feature instead.

**Key rules:**
- Title format for features/refactors: `W-NNN: Short Description`
- Title format for bugs: plain descriptive sentence, no prefix
- Labels: one of `area:cc` / `area:ui` + one of `P0`-`P4`. Bugs additionally get the `bug` label.
- The `## Plan` section (when present) must contain a markdown link to `docs/plans/*.md` using an absolute blob URL (e.g. `https://github.com/SinishaDjukic/worca-cc/blob/main/docs/plans/W-NNN.md`) — the pipeline parses this link and skips the PLAN stage when the file exists
- If no plan link is present, the pipeline runs the Planner to generate one
- Plan files use the naming convention `W-NNN-short-description.md` in `docs/plans/`
- When asked to write a new plan, follow the structure and conventions in [`docs/plans/_TEMPLATE.md`](./docs/plans/_TEMPLATE.md)
