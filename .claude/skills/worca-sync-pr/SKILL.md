---
name: worca-sync-pr
description: Sync a GitHub PR into a target worca-cc repo clone, rebuild worca-ui, upgrade the runtime, and start a project-scoped UI.
---

# Sync PR to Target Repo

Checks out a GitHub PR in a target worca-cc clone, rebuilds the UI, upgrades the Python runtime, and starts a project-scoped worca-ui instance. Designed for worca-cc contributors reviewing pipeline output.

**Usage:**
```
/worca-sync-pr /path/to/target 43
/worca-sync-pr /path/to/target gh:pr:43
/worca-sync-pr /path/to/target https://github.com/owner/repo/pull/43
/worca-sync-pr /path/to/target gh:pr:43 --clean
```

## Params

- **target** (required) — path to the target worca-cc repo clone
- **pr** (required) — PR number (`43`, `#43`, `gh:pr:43`) or full GitHub PR URL
- **--clean** (optional) — discard uncommitted changes in target before checkout

## Procedure

### Step 1: Validate the target path

Confirm the path exists. If not, ask the user to provide a valid path.

### Step 2: Run the sync_pr script

The script handles everything: validation, git state check, PR checkout, worca-ui build, Python runtime sync, and project-scoped UI start.

Resolve the worca-cc source repo (where this skill lives):

```bash
WORCA_ROOT=$(git rev-parse --show-toplevel)
```

Run the script:

```bash
PYTHONPATH="$WORCA_ROOT/src" python3 "$WORCA_ROOT/src/worca/scripts/sync_pr.py" <target> <pr> [--clean]
```

Pass all user-provided arguments through to the script as-is.

### Step 3: Report results

The script prints a summary. Relay it to the user. If any step failed, show the error and suggest fixes (e.g., `--clean` if dirty working tree).
