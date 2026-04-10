---
name: worca-sync-commit
description: Sync a specific git commit or branch into a target worca-cc repo clone, rebuild worca-ui, upgrade the runtime, and start a project-scoped UI.
---

# Sync Commit/Branch to Target Repo

Checks out a specific commit or branch in a target worca-cc clone, rebuilds the UI, upgrades the Python runtime, and starts a project-scoped worca-ui instance. Designed for worca-cc contributors reviewing pipeline output.

**Usage:**
```
/worca-sync-commit /path/to/target abc1234            # specific commit
/worca-sync-commit /path/to/target master              # latest on master
/worca-sync-commit /path/to/target main                # latest on main
/worca-sync-commit /path/to/target feature/my-thing    # latest on any branch
/worca-sync-commit /path/to/target abc1234 --clean
```

## Params

- **target** (required) — path to the target worca-cc repo clone
- **ref** (required) — commit SHA (7-40 hex characters) or branch name (master, main, feature/foo)
- **--clean** (optional) — discard uncommitted changes in target before checkout

## Procedure

### Step 1: Validate the target path

Confirm the path exists. If not, ask the user to provide a valid path.

### Step 2: Run the sync_commit script

The script handles everything: validation, git state check, commit checkout, worca-ui build, Python runtime sync, and project-scoped UI start.

Resolve the worca-cc source repo (where this skill lives):

```bash
WORCA_ROOT=$(git rev-parse --show-toplevel)
```

Run the script:

```bash
PYTHONPATH="$WORCA_ROOT/src" python3 "$WORCA_ROOT/src/worca/scripts/sync_commit.py" <target> <ref> [--clean]
```

Pass all user-provided arguments through to the script as-is.

### Step 3: Report results

The script prints a summary. Relay it to the user. If any step failed, show the error and suggest fixes (e.g., `--clean` if dirty working tree). Note that the target repo will be in detached HEAD state after checkout.
