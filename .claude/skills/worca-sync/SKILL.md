---
name: worca-sync
description: Sync worca pipeline files from the worca-cc source repo to a target project. Use when updating a project with the latest worca pipeline files, or when the user says "sync worca", "update worca", or "copy worca files". Accepts an optional path argument to specify the worca-cc repo location.
---

# Sync Worca to Project

Sync the worca pipeline files from the worca-cc source repository to a target project. Delegates core sync (`.claude/worca/` copy, settings.json merge) to `worca init --upgrade`, then syncs skills and ensures project registration.

## Source Repository Resolution (priority order)

1. **Explicit argument** — if the user passes a path (e.g. `/worca-sync /path/to/worca-cc`), use that
2. **Stored path** — read `worca.source_repo` from the target's `.claude/settings.json` (set during `/worca-install`)
3. **Auto-detect** — if CWD is inside worca-cc, use `git rev-parse --show-toplevel`
4. **Ask the user** — if none of the above work

After resolving, validate that `$WORCA_ROOT/src/worca/` exists to confirm it's actually a worca-cc repo.

**If a new source path is used (explicit or auto-detected), update `worca.source_repo` in the target's `settings.json`** so future syncs find it automatically.

## Procedure

### Step 1: Resolve source path

```bash
# Priority 1: explicit argument
WORCA_ROOT=<user-provided-path>

# Priority 2: read from target settings.json
WORCA_ROOT=$(python3 -c "import json; print(json.load(open('.claude/settings.json')).get('worca',{}).get('source_repo',''))" 2>/dev/null)

# Priority 3: auto-detect if CWD is inside worca-cc
WORCA_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

# Validate
test -d "$WORCA_ROOT/src/worca" || echo "ERROR: not a worca-cc repo"
```

### Step 2: Determine target project directory

If not specified, use the current working directory. Confirm the target has a `.claude/` directory. Create it if missing.

### Step 3: Run worca init --upgrade

This single command handles: `.claude/worca/` sync, settings.json deep-merge (preserving existing values), `.gitignore` updates, and `.worca/` runtime directory.

```bash
cd "$DEST" && PYTHONPATH="$WORCA_ROOT/src" python3 -m worca.cli.main init --upgrade --source "$WORCA_ROOT"
```

If a new source path was used, `init --upgrade` updates `worca.source_repo` in settings.json automatically.

### Step 4: Sync skills

Copy only the skills that target projects need (additive — preserves project-specific skills):

```bash
rsync -av "$WORCA_ROOT/skills/worca-agent-override/" "$DEST/.claude/skills/worca-agent-override/"
rsync -av "$WORCA_ROOT/skills/worca-sync/" "$DEST/.claude/skills/worca-sync/"
```

### Step 5: Ensure project is registered

Register the target project in the worca-ui multi-project selector (covers projects installed before multi-project support was added).

```bash
PREFS_DIR="$HOME/.worca"
PROJ_NAME=$(basename "<target-project>")
mkdir -p "$PREFS_DIR/projects.d"

# Slugify: lowercase, replace non-alphanumeric with hyphens, collapse
SLUG=$(echo "$PROJ_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g' | sed 's/--*/-/g' | cut -c1-64)

# Only write if not already registered (don't overwrite existing entry)
if [ ! -f "$PREFS_DIR/projects.d/$SLUG.json" ]; then
  cat > "$PREFS_DIR/projects.d/$SLUG.json" << EOF
{
  "name": "$SLUG",
  "path": "$(cd "<target-project>" && pwd)"
}
EOF
fi
```

If the project was registered, note it in the summary. If it already existed, note "already registered".

### Step 6: Skip these files

- `settings.local.json` — machine-specific, never copy or merge
- `.worca/` — runtime state directory, project-specific
- `worktrees/` — git worktree state, project-specific

### Step 7: Report results

Show a summary of what was synced, the source path used, and project registration status.
