---
name: worca-install
description: Install the worca autonomous pipeline into a project. Triggers on "install worca", "setup worca", "add worca", "create a pipeline", "set up autonomous development", "use worca-cc", "worca for my project", "let's create a pipeline", "run pipeline on my project", or any request to use worca to automate development on a target project. Requires a target project path (e.g. /worca-install /path/to/project).
---

# Install Worca into a New Project

First-time installation of the worca pipeline into a target project. Delegates core setup (`.claude/worca/` copy, settings.json merge, `.gitignore`, beads init, `.worca/` dir) to `worca init`, then copies skills and registers the project.

**Usage:** `/worca-install <target-project-path>` — the target path is **mandatory**.

## Source Repository

The source is the **worca-cc repo that contains this skill file**. Auto-detect it:

1. **If CWD is inside worca-cc**: `git rev-parse --show-toplevel`
2. **Otherwise**: ask the user for the worca-cc repo path

Store the resolved **absolute path** — it will be saved in the target's `settings.json` for future syncs.

## Procedure

### Step 1: Validate arguments and resolve paths

The user **must** provide the target project path as an argument. If missing, ask for it — do not proceed without it.

```bash
# Resolve the worca-cc source repo root (absolute path)
WORCA_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
# If CWD is not inside worca-cc, ask the user for the path

# Target from mandatory argument
DEST=<target-project-path>
```

Validate:
- `$WORCA_ROOT/src/worca/` exists (confirms it's actually worca-cc)
- `$DEST` exists and is a git repository (including worktrees — use `git -C "$DEST" rev-parse --show-toplevel`, NOT `test -d "$DEST/.git"` which fails for worktrees that have a `.git` file instead of a directory)
- `$DEST/.claude/worca/` does NOT exist (this is install, not sync — if it exists, suggest `/worca-sync` instead)

### Step 2: Run worca init

This single command handles: `.claude/worca/` copy, settings.json merge, `.gitignore` updates, beads init, and `.worca/` runtime directory.

```bash
cd "$DEST" && PYTHONPATH="$WORCA_ROOT/src" python3 -m worca.cli.main init --source "$WORCA_ROOT"
```

If `worca init` fails, stop and report the error.

### Step 3: Copy skills

Copy only the skills that target projects need (skip `worca-install` and `worca-rc` which are source-repo-only):

```bash
mkdir -p "$DEST/.claude/skills"
rsync -av "$WORCA_ROOT/.claude/skills/worca-agent-override/" "$DEST/.claude/skills/worca-agent-override/"
rsync -av "$WORCA_ROOT/.claude/skills/worca-sync/" "$DEST/.claude/skills/worca-sync/"
```

### Step 4: Install Python dev dependencies

```bash
cd "$DEST" && pip install -e ".[dev]"
```

If `pyproject.toml` does not exist in the target project root, skip this step.

### Step 5: Register project in worca-ui

Register the target project so it appears in the worca-ui multi-project selector.

```bash
PREFS_DIR="$HOME/.worca"
PROJ_NAME=$(basename "$DEST")
mkdir -p "$PREFS_DIR/projects.d"

# Slugify: lowercase, replace non-alphanumeric with hyphens, collapse
SLUG=$(echo "$PROJ_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g' | sed 's/--*/-/g' | cut -c1-64)

# Only write if not already registered (don't overwrite existing entry)
if [ ! -f "$PREFS_DIR/projects.d/$SLUG.json" ]; then
  cat > "$PREFS_DIR/projects.d/$SLUG.json" << EOF
{
  "name": "$SLUG",
  "path": "$(cd "$DEST" && pwd)"
}
EOF
fi
```

If the project was registered, note it in the summary. If it already existed, note "already registered".

### Step 6: Report results

Show a summary:

```
Worca installed successfully!

  Source:    /absolute/path/to/worca-cc
  Target:    /absolute/path/to/target-project

  worca init:        done (settings.json, .claude/worca/, .gitignore, beads, .worca/)
  Skills:            done (worca-agent-override, worca-sync)
  pip install:       done / skipped (no pyproject.toml)
  Registered:        ~/.worca/projects.d/<slug>.json (new / already existed)

  Next steps:
    cd <target-project> && claude          # Interactive mode
    worca run --prompt "..."               # Autonomous mode
    /worca-sync                            # Update worca files later
```
