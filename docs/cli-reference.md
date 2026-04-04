# CLI Reference

## `worca run`

Run a full pipeline from a prompt, spec file, or GitHub issue.

```bash
worca run --prompt "Add user authentication"
worca run --spec spec.md --plan plan.md
worca run --source gh:issue:42
```

### Flags

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
worca-ui --global            # monitor all projects on port 3400
worca-ui --project /path     # monitor single project
```

### Global dashboard commands

```bash
worca-ui start --global          # single instance, port 3400
worca-ui projects add /path      # register a project
worca-ui projects list           # list registered projects
worca-ui migrate --scan ~/dev    # batch-register all worca-enabled projects
```

Projects are stored in `~/.worca/projects.d/` as individual JSON files. Each project auto-registers when the pipeline runs.
