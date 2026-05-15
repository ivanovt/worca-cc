# Workspace Runs

Coordinate changes across interdependent repositories with dependency-ordered execution. A workspace decomposes one prompt into repo-specific sub-plans, executes them in DAG tier order, runs cross-repo integration tests, and creates linked PRs with dependency metadata.

**Workspace vs. Fleet:** Fleet runs (W-040) send the same prompt to N independent repos in parallel. Workspace runs (W-047) send different work to each repo, ordered by dependencies. Fleet infrastructure (grouping, dispatch, manifest, circuit breaker, resume, UI grouping) is reused — workspace adds coordination on top.

## Quick start

```bash
# 1. Scaffold workspace.json from sibling git repos
worca workspace init /path/to/parent

# 2. Edit workspace.json to define dependencies and integration test
# 3. Run the workspace pipeline
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Add user authentication across all services"
```

This loads `workspace.json`, runs the master planner to decompose the prompt, dispatches child pipelines tier-by-tier, runs integration tests, and creates linked PRs. Progress appears in the worca-ui dashboard under a workspace group.

## Initializing a workspace

```bash
worca workspace init /path/to/parent         # Scan child dirs, create workspace.json
worca workspace init /path/to/parent --force  # Overwrite existing workspace.json
```

`worca workspace init` scans the parent directory for child directories containing `.git/`, generates a `workspace.json` with all discovered repos (role: `"service"`, `depends_on: []`), and creates a `.worca/` directory. Edit the generated file to define dependency relationships, roles, and an integration test command.

## workspace.json format

The workspace definition lives at `{workspace_root}/workspace.json`:

```json
{
  "name": "my-platform",
  "repos": [
    {
      "name": "shared-lib",
      "path": "shared-lib",
      "role": "library",
      "depends_on": []
    },
    {
      "name": "backend",
      "path": "backend",
      "role": "service",
      "depends_on": ["shared-lib"]
    },
    {
      "name": "frontend",
      "path": "frontend",
      "role": "app",
      "depends_on": ["shared-lib"]
    }
  ],
  "integration_test": {
    "command": "docker compose run integration-tests",
    "working_dir": "."
  },
  "umbrella_repo": "org/my-platform"
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Workspace display name used in UI, PR annotations, and branch templates |
| `repos` | yes | Array of repo entries (at least one) |
| `repos[].name` | yes | Repo identifier referenced in `depends_on` lists |
| `repos[].path` | yes | Relative path from workspace root to the repo directory |
| `repos[].role` | yes | Freeform label (`library`, `service`, `app`, `infra`, etc.) — injected into the master planner prompt for context |
| `repos[].depends_on` | yes | Array of repo names that must complete before this repo starts (empty array `[]` for tier-0 repos) |
| `integration_test` | no | Cross-repo integration test configuration |
| `integration_test.command` | yes (if `integration_test` present) | Shell command to run |
| `integration_test.working_dir` | yes (if `integration_test` present) | Working directory relative to workspace root |
| `umbrella_repo` | no | GitHub `org/repo` for the umbrella issue that links all workspace PRs (falls back to the first tier-0 repo if omitted) |

### Dependency graph and tiers

The `depends_on` lists define a directed acyclic graph (DAG). Repos are grouped into tiers using topological sort (Kahn's algorithm):

- **Tier 0**: repos with no dependencies (`depends_on: []`)
- **Tier 1**: repos whose dependencies are all in tier 0
- **Tier N**: repos whose dependencies are all in tiers 0 through N-1

Repos within the same tier run in parallel. Tiers execute sequentially. Circular dependencies are detected and rejected at load time with a `WorkspaceCycleError`.

**Example DAG:**

```
tier 0: shared-lib
tier 1: backend, frontend  (both depend on shared-lib)
tier 2: e2e-tests          (depends on backend, frontend)
```

## Launching a workspace run

### CLI flags

| Flag | Description |
|------|-------------|
| `WORKSPACE_ROOT` | Positional: path to parent directory containing `workspace.json` |
| `--prompt TEXT` | Work-request prompt (mutually exclusive with `--source`) |
| `--source REF` | Source reference (`gh:issue:42`, `bd:bd-abc`) |
| `--guide PATH` | Normative reference guide (repeatable). Authority order: guide > plan > description |
| `--branch TEMPLATE` | Branch name template with `{workspace}`, `{repo}`, `{slug}` placeholders. Default: `workspace/{slug}/{repo}` |
| `--skip-integration` | Skip the cross-repo integration test phase |
| `--skip-planning` | Skip the master planner; each repo plans independently |
| `--resume WORKSPACE_ID` | Resume a failed/halted workspace run |
| `--max-parallel N` | Max concurrent children within a tier (default: 5) |
| `--dry-run` | Print the DAG and exit without launching children |

### Examples

```bash
# Basic workspace run
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Add user authentication"

# With normative guide
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Migrate to v2 API" \
  --guide ./migration-spec.md \
  --guide ./breaking-changes.md

# Skip planning (each repo plans independently)
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Apply logging standards" \
  --skip-planning

# Custom branch names
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Add auth" \
  --branch "feat/auth/{repo}"

# Dry run — inspect the DAG without launching
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Add auth" --dry-run

# From a GitHub issue
python .claude/scripts/run_workspace.py /path/to/parent \
  --source gh:issue:42
```

## Guide attachment

Attach one or more normative reference guides with `--guide`:

```bash
python .claude/scripts/run_workspace.py /path/to/parent \
  --prompt "Migrate to v2 API" \
  --guide ./migration-spec.md
```

Guide paths are resolved to absolute paths before dispatch. The guide is injected into the master planner's prompt and passed through to each child pipeline.

**Authority order: guide > plan > description.** When all three are present, agents treat the guide as authoritative. Any prompt request that conflicts with the guide is surfaced as a bug, not silently resolved.

## Lifecycle

### Phases

| # | Phase | What happens |
|---|-------|--------------|
| 1 | **Load** | `workspace.json` loaded, validated against schema, DAG computed |
| 2 | **Manifest write** | Workspace ID generated (`ws_<yyyymmddhhmm>_<hex>`), manifest + pointer file written. From here the workspace is observable in the UI. |
| 3 | **Master planner** | Opus agent reads all repos' `CLAUDE.md` (capped at 4 KB per repo), workspace topology, and work request. Produces a structured workspace plan with per-repo sub-plans. Status: `planning` |
| 4 | **Plan validation** | Planner output validated against `workspace_plan.json` schema. Repo names cross-checked against `workspace.json`. Plan files written to run directory. |
| 5 | **DAG execution** | Tiers dispatched sequentially. Within each tier, child pipelines run in parallel via `run_worktree.py`. Between tiers, context artifacts are extracted and injected. Status: `running` |
| 6 | **Integration test** | After all tiers complete, the user-defined integration test runs. Status: `integration_testing`. Failure → `integration_failed` (no PRs created). |
| 7 | **PR linking** | PRs created for each completed child, dependency comments posted, umbrella issue created. Status: `completed` |

### Status values

| Status | Meaning |
|--------|---------|
| `planning` | Master planner is running |
| `running` | Tier execution in progress |
| `integration_testing` | All children done; integration test running |
| `completed` | All children + integration passed; PRs created |
| `failed` | Tier failure — at least one child failed and downstream repos are blocked |
| `integration_failed` | Children done but integration test failed; no PRs created |
| `halted` | User halted or circuit breaker tripped (check `halt_reason` field) |
| `blocked` | Per-child status only — a dependency failed |

## DAG execution

The DAG executor (`src/worca/workspace/dag_executor.py`) runs tiers sequentially:

1. For each tier, partition repos into runnable (all deps completed) and blocked (any dep failed)
2. Dispatch runnable repos in parallel via `ThreadPoolExecutor` (up to `--max-parallel`)
3. Each child runs as a standard worca pipeline (`run_worktree.py`) with `WORCA_DEFER_PR=1` (PR creation is deferred to the workspace orchestrator)
4. Collect results; mark blocked repos
5. Extract context from completed repos for the next tier
6. Check circuit breaker between tiers

### Context injection

Between tiers, the executor extracts each completed repo's `git diff` (unified diff with stat), prioritizes API-surface files (`types/`, `api/`, `schemas/`, `index.*`), and writes a context artifact capped at 8 KB per dependency. These artifacts are injected as `--guide` files into the next tier's children, so downstream repos know exactly what upstream changed.

Context files are written to `{run_dir}/context/{repo}-diff.md`.

### Circuit breaker

When `>=3` children have reached a terminal state AND `failed / terminal >= 30%`, the circuit breaker trips:

- `manifest.status = "halted"`, `halt_reason = "circuit_breaker"`
- Pending tiers are marked halted; no new children are dispatched
- In-flight children finish naturally (never killed)

## Integration testing

After all DAG tiers complete, the workspace runs a cross-repo integration test if configured in `workspace.json`:

```json
{
  "integration_test": {
    "command": "make integration-test",
    "working_dir": "."
  }
}
```

The executor:

1. Creates parallel git worktrees for all completed children in `{workspace_root}/.worca/integration-env/{repo}/`
2. Runs the configured command with `WORCA_INTEGRATION_ENV=1` and `WORCA_WORKSPACE_ROOT` set
3. Captures stdout/stderr to `{run_dir}/integration-test.log`
4. Cleans up integration worktrees (pass or fail)

If the test fails, the workspace status is set to `integration_failed` and no PRs are created. Skip with `--skip-integration` or by omitting `integration_test` from `workspace.json`.

## PR linking

After integration passes (or is skipped), the workspace creates linked PRs:

1. **Per-repo PRs** — each completed child gets a PR titled `[workspace:<ws_short>] <work_title>` with the repo's role in the body
2. **Dependency comments** — each PR gets a comment listing:
   - Dependencies ("Depends on `org/lib#15`" — must merge first)
   - Dependents ("Blocks `org/frontend#43`" — depends on this PR)
   - Workspace run ID
3. **Umbrella issue** — an issue created in `umbrella_repo` (or the first tier-0 repo) listing all PRs as a checklist in tier order (merge order)

Children run with `WORCA_DEFER_PR=1`, so they commit and push their branch but skip PR creation — the workspace orchestrator handles it after integration validation.

## Resume

Failed, halted, and `integration_failed` workspace runs can be resumed:

```bash
python .claude/scripts/run_workspace.py /path/to/parent \
  --resume ws_202601011200_abc12345
```

The resume handler classifies each child:

- **Skip**: completed children are left alone (worktrees retained for context)
- **Re-dispatch**: failed, blocked, and halted children are re-launched fresh

If the workspace was `integration_failed`, resume re-runs the integration test without re-dispatching children (the code changes are already done). Context from completed repos in earlier tiers is regenerated for downstream re-dispatch.

## Cleanup

Workspace worktrees and run directories are cleaned up with:

```bash
worca cleanup --workspace-id <workspace_id>   # Remove all child worktrees + workspace run dir
```

Standard cleanup also picks up workspace child worktrees:

```bash
worca cleanup --all
worca cleanup --older-than 7d
```

Running workspaces are never eligible for cleanup.

## File layout

```
{workspace_root}/
  workspace.json                              # Workspace definition (committed)
  .worca/                                     # Workspace runtime directory (gitignored)
    workspace-runs/{workspace_id}/            # Per-run outputs
      workspace-manifest.json                 # Workspace state + child tracking
      workspace-plan.md                       # Human-readable master plan
      workspace-plan.json                     # Structured master plan (planner output)
      {repo}-plan.md                          # Per-repo sub-plan
      integration-test.log                    # Integration test stdout/stderr
      context/{repo}-diff.md                  # Per-repo context artifacts (tier N → N+1)
    integration-env/{repo}/                   # Temporary worktrees for integration test

~/.worca/workspace-runs/{workspace_id}.json   # Pointer file for global UI discovery
```

## Dashboard grouping

The worca-ui dashboard groups workspace children under a collapsible workspace header showing:

- Workspace status badge (blue = active, green = completed, red = failed, orange = halted by circuit breaker)
- DAG progress by tier
- Links to the workspace detail view

Workspace grouping requires **global mode** (`pnpm worca:ui` without `--project`). In single-project mode, cross-project siblings are invisible.

## Environment variables

Children receive these workspace-specific environment variables:

| Variable | Value |
|----------|-------|
| `WORCA_WORKSPACE_ID` | Workspace ID (`ws_<yyyymmddhhmm>_<hex>`) |
| `WORCA_WORKSPACE_NAME` | Workspace display name from `workspace.json` |
| `WORCA_DEFER_PR=1` | Defers PR creation to workspace orchestrator |

During integration testing, the test command receives:

| Variable | Value |
|----------|-------|
| `WORCA_INTEGRATION_ENV=1` | Indicates integration test context |
| `WORCA_WORKSPACE_ROOT` | Absolute path to workspace root |
