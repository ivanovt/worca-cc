# Migrating worca-cc

## TL;DR

| Step | Command | Notes |
|------|---------|-------|
| 1. Upgrade package | `pip install --upgrade worca-cc==X.Y.Z` | Updates the Python package |
| 2. Refresh runtime | `cd <project> && worca init --upgrade` | Migrates settings, copies new runtime |
| 3. Manual cleanup | See [What you must delete manually](#what-you-must-delete-manually) | Only needed for projects that pre-date v0.6.0 packaging |

## How upgrades work

1. **`pip install --upgrade worca-cc==X.Y.Z`** updates the Python package globally (or in your venv). This does not touch any project files.

2. **`worca init --upgrade`** (run inside each project) refreshes the `.claude/worca/` runtime copy and migrates settings. Run this in every project that uses worca.

3. **Manual cleanup** may be required for projects that were initially set up before the v0.6.0 packaging migration (i.e., when worca files lived directly in `.claude/hooks/`, `.claude/scripts/`, etc.).

### Why manual cleanup is sometimes needed

`worca init --upgrade` includes a one-shot legacy cleanup function (`_cleanup_legacy_files` in `src/worca/cli/init.py`). However, this cleanup **only runs when `.claude/worca/__init__.py` has no `__version__` string** — meaning the project was set up via the old copy-paste method, not from a pip package.

Once a project has been upgraded to a versioned (packaged) install, the version check gate (`read_version(worca_dir) is not None`) causes the cleanup to be skipped on all subsequent upgrades. Legacy directories left behind by a previous pre-packaging install will persist silently.

## What `worca init --upgrade` handles automatically

### Settings path migrations

These old paths in `settings.json` are rewritten to their new locations:

| Old path | New path |
|----------|----------|
| `.claude/hooks/pre_tool_use.py` | `.claude/worca/claude_hooks/pre_tool_use.py` |
| `.claude/hooks/post_tool_use.py` | `.claude/worca/claude_hooks/post_tool_use.py` |
| `.claude/hooks/user_prompt_submit.py` | `.claude/worca/claude_hooks/user_prompt_submit.py` |
| `.claude/scripts/preflight_checks.py` | `.claude/worca/scripts/preflight_checks.py` |

Source: `_PATH_MIGRATIONS` in `src/worca/cli/init.py:108-118`.

### Settings key migrations

| Setting | Old value | New value | Context |
|---------|-----------|-----------|---------|
| `worca.stages.review.agent` | `guardian` | `reviewer` | W-037 agent rename |
| `worca.agent_overrides_dir` | `.claude/agents/overrides` | `.claude/agents` | Override dir flattening |

### Agent override directory migration

Override files are moved from `.claude/agents/overrides/*.md` to `.claude/agents/*.md` (flat). The empty `overrides/` directory is removed if no user files remain.

### Runtime copy

The entire `.claude/worca/` directory is replaced with a fresh copy from the installed package (excluding `cli/` and `__pycache__/`).

### Settings deep-merge

New default keys from the package's `src/worca/settings.json` are merged into the project's `.claude/settings.json`. Existing user settings are overwritten by the template defaults (use `.claude/settings.local.json` for project-specific customizations that should survive upgrades).

### .gitignore entries

These entries are added if missing: `.worca/`, `logs/`, `.claude/settings.local.json`.

### Beads

- `.beads/` is initialized if it doesn't exist.
- The beads repo fingerprint is updated on upgrade (`bd migrate --update-repo-id`).

### One-shot legacy cleanup (pre-packaging installs only)

On the **first** upgrade from a pre-packaging install (no version in `.claude/worca/__init__.py`), these are automatically removed:

- `.claude/hooks/` — files: `__init__.py`, `post_tool_use.py`, `pre_compact.py`, `pre_tool_use.py`, `session_end.py`, `session_start.py`, `stop.py`, `subagent_start.py`, `subagent_stop.py`, `user_prompt_submit.py`
- `.claude/scripts/` — files: `__init__.py`, `preflight_checks.py`, `run_batch.py`, `run_learn.py`, `run_multi.py`, `run_parallel.py`, `run_pipeline.py`, `worca.py`
- `.claude/agents/core/` — files: `coordinator.md`, `guardian.md`, `implementer.md`, `learner.md`, `plan_reviewer.md`, `planner.md`, `tester.md`
- `.claude/agents/domain/` — removed if it only contains `.gitkeep` and/or `.DS_Store`
- `.claude/worca-ui/` — entire directory

## What you must delete manually

If your project was set up before v0.6.0 and has since been upgraded past the version gate, the following directories and files may still exist. **None of them are read by any current code path** — they are safe to delete.

Run `worca init --check` first as a dry-run to see what the upgrade tool would do, then use the table below to identify leftover files.

### Obsolete files inventory

| Path | Replaced by | Still read by any code? | Safe to delete |
|------|-------------|------------------------|----------------|
| `.claude/hooks/` | `.claude/worca/claude_hooks/` | No — `settings.json` points to `.claude/worca/claude_hooks/` | Yes |
| `.claude/scripts/` | `.claude/worca/scripts/` | No — `settings.json` and CLI entry points use the packaged paths | Yes |
| `.claude/worca-ui/` | `@worca/ui` npm package (install globally) or the `worca-ui/` directory in the source repo | No — the embedded UI was fully removed | Yes |
| `.claude/agents/core/*.md` | `.claude/worca/agents/core/` (runtime copy from package) | No — see explanation below | Yes |
| `.claude/agents/domain/` | Nothing (empty scaffolding leftover) | No | Yes |
| `.claude/agents/overrides/` | `.claude/agents/` (flat, no subdirectory) | No — `agent_overrides_dir` defaults to `.claude/agents` | Yes |
| `__pycache__/` dirs inside any of the above | N/A | No | Yes |

### Why `.claude/agents/core/*.md` files are dead

This is the most confusing leftover. Three different `agents/core/` paths exist:

1. **`src/worca/agents/core/`** — the canonical templates in the pip package source tree.
2. **`.claude/worca/agents/core/`** — the runtime copy created by `worca init`. This is what the pipeline reads at runtime (`runner.py:257`).
3. **`.claude/agents/core/`** — the **old** pre-packaging location. **Nothing reads from here.**

The runtime (`runner.py`) resolves agent templates from `.claude/worca/agents/core/` only. Agent overrides live flat in `.claude/agents/<agent>.md` (no `core/` subdirectory). Claude Code's subagent discovery scans `.claude/agents/` flat — it does not recurse into `core/`.

Files in `.claude/agents/core/` are neither templates nor overrides. They are inert.

### Consolidated cleanup command

After verifying with `worca init --check`, run this from your project root:

```bash
cd .claude
rm -rf hooks/ scripts/ worca-ui/ agents/domain/ agents/overrides/
rm -f agents/core/coordinator.md agents/core/guardian.md agents/core/implementer.md \
     agents/core/learner.md agents/core/plan_reviewer.md agents/core/planner.md \
     agents/core/tester.md agents/core/reviewer.md
rmdir agents/core 2>/dev/null || true
find . -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true
```

If `.claude/agents/core/` contains files you do not recognize (not in the list above), investigate before deleting — they may be custom files you created.

## Where overrides go now

| Type | Location | Example |
|------|----------|---------|
| Per-project agent override | `.claude/agents/<agent>.md` | `.claude/agents/implementer.md` |
| Per-project block override | `.claude/agents/<block>.block.md` | `.claude/agents/implement.block.md` |

Override modes:

- **Replace** (default): the override file replaces the base prompt entirely. No tag needed, or use `<!-- replace -->` explicitly.
- **Append** (`<!-- append -->`): sections are merged into the base using section-level merge. Use `## Override: <Section Name>` headings to target specific sections.
- **Governance protection**: sections marked `<!-- governance -->` in the base cannot be replaced by overrides (demoted to append with a warning).

For details, see the `/worca-agent-override` skill or `src/worca/orchestrator/overlay.py`.

## Verifying the upgrade

After upgrading and cleaning up, run these checks:

```bash
# 1. Dry-run check for drift
worca init --check

# 2. Verify .claude/ directory structure
ls .claude/
# Expected: agents/  settings.json  skills/  templates/  worca/
# Optional: settings.local.json  worktrees/

# 3. Confirm runtime version matches installed package
grep __version__ .claude/worca/__init__.py
python -c "import worca; print(worca.__version__)"
# Both should print the same version

# 4. Check settings.json has no stale paths
grep -c '.claude/hooks/' .claude/settings.json    # should be 0
grep -c '.claude/scripts/' .claude/settings.json  # should be 0 (except .claude/worca/scripts/ which is correct)
```

## Version-specific notes

### 0.5.0 → 0.6.0

The packaging migration. This is the release that moved pipeline code from `.claude/` into the `src/worca/` pip package.

- Agent templates moved from `.claude/agents/core/` to `src/worca/agents/core/` (runtime copy at `.claude/worca/agents/core/`)
- Hook scripts moved from `.claude/hooks/` to `src/worca/claude_hooks/`
- Agent overrides directory simplified from `.claude/agents/overrides/` to `.claude/agents/` (flat)
- `release.yml` merged into `release-pypi.yml`
- **Manual cleanup required** for projects that pre-date this release — see [What you must delete manually](#what-you-must-delete-manually)

### 0.6.x → 0.7.0

- Usage object logging added with model-specific pricing
- `DEFAULT_PRICING` removed from UI; pricing now sourced from `settings.json`
- Beads fingerprint upgrade added to `worca init`

### 0.7.0 → 0.8.0

- Pipeline templates system added (W-016)
- No path or settings migrations required

### 0.8.0 → 0.9.0

- Template agent prompt overrides wired through overlay resolver
- `milestones.plan_approval=false` now correctly auto-approves plans
- `pipeline.pid` moved to per-run directories for concurrent pipeline support

### 0.9.0 → 0.10.0+

- W-037: Agent prompts extracted into composable block files
- `stages.review.agent` renamed from `guardian` to `reviewer` (auto-migrated by `worca init --upgrade`)

## Getting help

- Issues: https://github.com/SinishaDjukic/worca-cc/issues
- The `/worca-install` and `/worca-sync` skills handle most install/upgrade flows

---

*Follow-up: add a pointer to this file from the project README: `> **Upgrading?** See [MIGRATION.md](./MIGRATION.md).`*
