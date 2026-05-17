# CLI Reference

## `worca run`

Run a full pipeline from a prompt, spec file, or GitHub issue. By default the run lands in the current working tree; pass `--worktree` to spawn it in an isolated git worktree (parallel-safe; same path the UI's "Run Pipeline" button uses).

```bash
worca run --prompt "Add user authentication"
worca run --spec spec.md --plan plan.md
worca run --source gh:issue:42
worca run --worktree --source gh:issue:42 --template feature
```

### Flags

| Flag | Description |
|------|-------------|
| `--prompt TEXT` | Text prompt describing the work (optional — title auto-generated from spec/plan if omitted) |
| `--spec FILE` | Path to spec/requirements file |
| `--source TEXT` | Source reference (`gh:issue:42`, `bd:bd-abc`, or issue URL) |
| `--plan FILE` | Pre-made plan file (skips Plan stage) |
| `--template ID` | Pipeline template to apply (`feature`, `bugfix`, `quick-fix`, `refactor`, `investigate`, `test-only`, or any project/user template — see `worca templates list`) |
| `--param KEY=VALUE` | Override a template parameter (repeatable) |
| `--resume` | Resume a previous run from status.json |
| `--worktree` | Launch in an isolated git worktree (parallel-safe). Falls back to in-place if `run_worktree.py` is missing in the project runtime |
| `--branch NAME` | Base branch to fork the worktree from (`--worktree` only; default: HEAD) |
| `--guide PATH` | Reference guide injected into the planner prompt (`--worktree` only, repeatable) |
| `--msize [1-10]` | Task size multiplier — scales max_turns per stage |
| `--mloops [1-10]` | Loop multiplier — scales max loop iterations |

`--prompt`, `--spec`, and `--source` are mutually exclusive — provide one.

## `worca templates`

Manage pipeline templates. Templates are resolved across three tiers — user (`~/.worca/templates/`) > project (`.claude/templates/`) > built-in (`.claude/worca/templates/`) — and the highest tier wins on ID collision.

```bash
worca templates list                    # tabular output
worca templates list --json             # machine-readable JSON (id, name, description, tier, tags, builtin, created_at)
worca templates show <id>               # pretty-print template.json (resolved tier marked)
worca templates save <id> [--global]    # snapshot current settings as a project (default) or user template
worca templates delete <id> [--global]  # remove a project or user template (built-ins are protected)
```

`worca templates list --json` is the canonical enumeration used by the `/worca-analyze` skill and any external tooling.

## `worca cleanup`

Remove completed or failed pipeline worktrees from disk and from the `.worca/multi/pipelines.d/` registry. Running worktrees are never eligible.

```bash
worca cleanup                    # interactive: list completed worktrees, prompt to remove
worca cleanup --all              # remove all completed/failed worktrees without prompting
worca cleanup --run-id <id>      # remove a specific worktree by run ID
worca cleanup --dry-run          # preview without removing
worca cleanup --older-than 7d   # remove worktrees started more than 7 days ago
```

Use `git worktree list` to see all worktrees regardless of pipeline state.

## `worca multi`

Run multiple work requests concurrently, each in an isolated git worktree.

```bash
worca multi \
  --requests "Add auth" "Add search" "Add logging" \
  --max-parallel 3

worca multi \
  --sources gh:issue:1 gh:issue:2 \
  --cleanup always
```

### Flags

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

## `worca init`

Scaffold `.claude/` in the current project with pipeline files.

```bash
worca init              # first-time setup
worca init --upgrade    # refresh runtime copy after upgrading worca-cc
worca init .            # developer mode (in the worca-cc repo itself)
```

## `worca-ui`

Start the monitoring dashboard.

```bash
worca-ui                         # monitor all projects (default, port 3400)
worca-ui --project /path         # monitor single project
worca-ui --version               # print version
worca-ui --help                  # show all commands and options
```

### Commands

| Command | Description |
|---------|-------------|
| `start` | Start the server (default) |
| `stop` | Stop the running server |
| `restart` | Restart the server |
| `status` | Show server status |
| `projects list` | List registered projects |
| `projects add <path> [--name]` | Register a project |
| `projects remove <name>` | Unregister a project |
| `migrate --scan <dir>` | Scan directory for projects to register |
| `migrate --add <path>` | Register a single project |
| `migrate --status` | Show registration health |

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port <N>` | `3400` (env: `PORT`) | Server port |
| `--host <addr>` | `127.0.0.1` (env: `HOST`) | Bind address |
| `--global` | *(default)* | Multi-project mode |
| `--project [path]` | | Single-project mode, optionally scoped to path |
| `--open` | | Open browser after start |
| `--dry-run` | | Preview `migrate --scan` without registering |
| `-v`, `--version` | | Print version |
| `-h`, `--help` | | Show help |

### Global dashboard commands

```bash
worca-ui start                   # single instance, port 3400 (default)
worca-ui projects add /path      # register a project
worca-ui projects list           # list registered projects
worca-ui migrate --scan ~/dev    # batch-register all worca-enabled projects
```

Projects are stored in `~/.worca/projects.d/` as individual JSON files. Each project auto-registers when the pipeline runs.
