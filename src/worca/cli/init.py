"""worca init — scaffold or upgrade .claude/worca/ in a project.

worca init [--upgrade] [--force] [--check] [--source PATH]

Source resolution order:
  1. --source flag (explicit, highest priority)
  2. worca.source_repo in .claude/settings.local.json
  3. Installed pip package (default)
"""

import copy
import importlib.resources
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_schema = json.loads(
    importlib.resources.files("worca.schemas").joinpath("keys.json").read_text()
)
_GLOBAL_ONLY_KEYS = [tuple(k) for k in _schema["global_only_keys"]]


def _find_git_root() -> Path:
    """Walk up from cwd to find the git root directory."""
    cwd = Path.cwd().resolve()
    for parent in [cwd, *cwd.parents]:
        if (parent / ".git").exists():
            return parent
    print("error: not inside a git repository", file=sys.stderr)
    raise SystemExit(1)


def _get_worca_source(source_flag: str | None, git_root: Path) -> Path:
    """Resolve the worca source directory using the resolution chain."""
    # 1. Explicit --source flag
    if source_flag:
        src = Path(source_flag).expanduser() / "src" / "worca"
        if not src.is_dir():
            print(f"error: source not found: {src}", file=sys.stderr)
            raise SystemExit(1)
        return src

    # 2. settings.local.json source_repo
    local_settings = git_root / ".claude" / "settings.local.json"
    if local_settings.exists():
        try:
            with open(local_settings) as f:
                settings = json.load(f)
            source_repo = settings.get("worca", {}).get("source_repo")
            if source_repo:
                src = Path(source_repo).expanduser() / "src" / "worca"
                if src.is_dir():
                    return src
        except (json.JSONDecodeError, OSError):
            pass

    # 3. Installed pip package
    try:
        import worca as _worca_pkg
        return Path(_worca_pkg.__file__).parent
    except ImportError:
        print(
            "error: worca-cc package not installed and no --source provided",
            file=sys.stderr,
        )
        raise SystemExit(1)


def _atomic_write_json(path: str, data: dict) -> None:
    """Atomically write JSON to path via tempfile + os.replace.

    Mirrors the JS atomicWriteSync helper so concurrent readers (the UI
    server) never observe a half-written ~/.worca/settings.json during
    `worca init --upgrade`.
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _deep_merge(base: dict, overlay: dict) -> dict:
    """Non-destructive deep-merge: base wins for scalars; nested dicts merge recursively.

    Overlay only contributes keys absent from base. This is the upgrade
    semantic — user values in `base` are always preserved, and the template
    `overlay` only fills in keys the user does not yet have. To get the
    opposite (overlay wins for scalars), use `_deep_merge_overwrite`.
    """
    result = base.copy()
    for key, value in overlay.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge(result[key], value)
        else:
            # Only add missing keys, don't overwrite existing
            if key not in result:
                result[key] = value
    return result


def _deep_merge_overwrite(base: dict, overlay: dict) -> dict:
    """Deep-merge overlay into base. Overlay values always win."""
    result = base.copy()
    for key, value in overlay.items():
        if key in result and isinstance(result[key], dict) and isinstance(value, dict):
            result[key] = _deep_merge_overwrite(result[key], value)
        else:
            result[key] = value
    return result


# Legacy files to remove during upgrade from pre-packaging installs
_LEGACY_HOOK_FILES = [
    "__init__.py", "post_tool_use.py", "pre_compact.py", "pre_tool_use.py",
    "session_end.py", "session_start.py", "stop.py",
    "subagent_start.py", "subagent_stop.py", "user_prompt_submit.py",
]

_LEGACY_SCRIPT_FILES = [
    "__init__.py", "preflight_checks.py", "run_batch.py", "run_learn.py",
    "run_multi.py", "run_parallel.py", "run_pipeline.py",
    "worca.py",  # renamed to worca_lifecycle.py in new structure
]

_LEGACY_AGENT_FILES = [
    "coordinator.md", "guardian.md", "implementer.md", "learner.md",
    "plan_reviewer.md", "planner.md", "tester.md",
]

# Path migrations for --upgrade from pre-packaging installs
_PATH_MIGRATIONS = [
    # (settings key path, old substring, new substring)
    (".claude/hooks/pre_tool_use.py", ".claude/hooks/pre_tool_use.py",
     ".claude/worca/claude_hooks/pre_tool_use.py"),
    (".claude/hooks/post_tool_use.py", ".claude/hooks/post_tool_use.py",
     ".claude/worca/claude_hooks/post_tool_use.py"),
    (".claude/hooks/user_prompt_submit.py", ".claude/hooks/user_prompt_submit.py",
     ".claude/worca/claude_hooks/user_prompt_submit.py"),
    (".claude/scripts/preflight_checks.py", ".claude/scripts/preflight_checks.py",
     ".claude/worca/scripts/preflight_checks.py"),
]


def _migrate_dispatch_governance(governance_cfg: dict, changes: list[str]) -> None:
    """Migrate flat subagent_dispatch -> nested dispatch.subagents (W-054)."""
    from worca.hooks.tracking import _DISPATCH_DEFAULTS

    if "subagent_dispatch" not in governance_cfg:
        return
    old = governance_cfg.pop("subagent_dispatch")
    dispatch = governance_cfg.setdefault("dispatch", {})
    subagents = dispatch.setdefault("subagents", {})
    per_agent = subagents.setdefault("per_agent_allow", {})
    per_agent.update(old)
    per_agent.setdefault(
        "_defaults",
        list(_DISPATCH_DEFAULTS["subagents"]["per_agent_allow"]["_defaults"]),
    )
    subagents.setdefault(
        "always_disallowed",
        list(_DISPATCH_DEFAULTS["subagents"]["always_disallowed"]),
    )
    subagents.setdefault(
        "default_denied",
        list(_DISPATCH_DEFAULTS["subagents"]["default_denied"]),
    )
    dispatch.setdefault("tools", copy.deepcopy(_DISPATCH_DEFAULTS["tools"]))
    dispatch.setdefault("skills", copy.deepcopy(_DISPATCH_DEFAULTS["skills"]))
    governance_cfg.pop("_dispatch_legacy", None)
    changes.append(
        "  governance.subagent_dispatch -> governance.dispatch.subagents "
        "(W-054 — tools and skills sections added with defaults)"
    )


def _migrate_settings_paths(settings: dict) -> tuple[dict, list[str]]:
    """Apply path migrations to settings dict. Returns (migrated_settings, list_of_changes)."""
    changes = []
    raw = json.dumps(settings)

    for _desc, old, new in _PATH_MIGRATIONS:
        if old in raw:
            raw = raw.replace(old, new)
            changes.append(f"  {old} -> {new}")

    # Migrate agent_overrides_dir
    migrated = json.loads(raw)
    worca_cfg = migrated.get("worca", {})
    if worca_cfg.get("agent_overrides_dir") == ".claude/agents/overrides":
        worca_cfg["agent_overrides_dir"] = ".claude/agents"
        changes.append("  agent_overrides_dir: .claude/agents/overrides -> .claude/agents")
        migrated["worca"] = worca_cfg

    # Migrate review stage agent: guardian -> reviewer (W-037)
    stages_cfg = worca_cfg.get("stages", {})
    review_cfg = stages_cfg.get("review", {})
    if review_cfg.get("agent") == "guardian":
        review_cfg["agent"] = "reviewer"
        stages_cfg["review"] = review_cfg
        worca_cfg["stages"] = stages_cfg
        migrated["worca"] = worca_cfg
        changes.append("  stages.review.agent: guardian -> reviewer")

    # Migrate governance.dispatch -> governance.subagent_dispatch (W-038).
    # The two keys use incompatible namespaces: the old `dispatch` maps
    # pipeline-agent parents to lists of pipeline-agent children; the new
    # `subagent_dispatch` maps parents to lists of subagent types
    # (explore, feature-dev:code-reviewer, ...). Old values cannot be
    # automatically translated, so we stash them under `_dispatch_legacy`
    # for the user to review and re-enter under the new schema.
    governance_cfg = worca_cfg.get("governance", {})
    dispatch_val = governance_cfg.get("dispatch", {})
    _is_new_dispatch_shape = isinstance(dispatch_val, dict) and bool(
        {"tools", "skills", "subagents"} & dispatch_val.keys()
    )
    if "dispatch" in governance_cfg and "subagent_dispatch" not in governance_cfg and not _is_new_dispatch_shape:
        _SUBAGENT_DISPATCH_DEFAULTS = {
            "planner": ["Explore"],
            "coordinator": [],
            "implementer": ["Explore"],
            "tester": ["Explore"],
            "guardian": ["Explore"],
            "reviewer": ["Explore"],
            "plan_reviewer": ["Explore"],
            "learner": ["Explore"],
        }
        old_values = governance_cfg.pop("dispatch")
        governance_cfg["subagent_dispatch"] = _SUBAGENT_DISPATCH_DEFAULTS
        # Preserve the old config only if it was non-trivial — skip empty or
        # all-defaults-equivalent shells to keep settings.json tidy.
        if old_values and any(v for v in old_values.values()):
            governance_cfg["_dispatch_legacy"] = old_values
            changes.append(
                "  governance.dispatch -> governance.subagent_dispatch "
                "(new defaults applied; old config preserved at "
                "governance._dispatch_legacy — review and delete when no longer needed)"
            )
        else:
            changes.append(
                "  governance.dispatch -> governance.subagent_dispatch "
                "(old key was empty; new defaults applied)"
            )
        worca_cfg["governance"] = governance_cfg
        migrated["worca"] = worca_cfg

    # Casing normalization: the initial W-038 landing shipped with lowercase
    # `"explore"` in subagent_dispatch defaults. Claude Code's actual
    # subagent_type for the built-in Explore subagent is capitalized
    # (`"Explore"`), so lowercase entries are silently broken — the hook
    # compares strings directly and blocks the dispatch. Normalize them in
    # place so upgrading users self-heal without manual edits.
    subagent_dispatch_cfg = worca_cfg.get("governance", {}).get(
        "subagent_dispatch"
    )
    if isinstance(subagent_dispatch_cfg, dict):
        normalized = False
        for agent, allowed in list(subagent_dispatch_cfg.items()):
            if not isinstance(allowed, list):
                continue
            if "explore" in allowed:
                subagent_dispatch_cfg[agent] = [
                    "Explore" if v == "explore" else v for v in allowed
                ]
                normalized = True
        if normalized:
            migrated["worca"] = worca_cfg
            changes.append(
                '  governance.subagent_dispatch: normalized "explore" -> "Explore" '
                "(canonical Claude Code subagent name is capitalized)"
            )

    # Migrate subagent_dispatch → dispatch.subagents + add tools/skills (W-054).
    governance_cfg = worca_cfg.get("governance", {})
    _migrate_dispatch_governance(governance_cfg, changes)
    if governance_cfg:
        worca_cfg["governance"] = governance_cfg
        migrated["worca"] = worca_cfg

    # Ensure SubagentStart + SubagentStop hooks are registered. The hook
    # scripts have existed since the initial W-038 landing but were never
    # wired into settings.json — making dispatch tracking dead code.
    hooks = migrated.setdefault("hooks", {})
    _hook_cmd_tpl = (
        'python3 "$(cd "$(git rev-parse --git-common-dir)/.." && pwd)'
        '/.claude/worca/claude_hooks/{script}"'
    )
    for hook_type, script in [
        ("SubagentStart", "subagent_start.py"),
        ("SubagentStop", "subagent_stop.py"),
    ]:
        if hook_type not in hooks:
            hooks[hook_type] = [
                {"hooks": [{"type": "command", "command": _hook_cmd_tpl.format(script=script)}]}
            ]
            changes.append(f"  hooks.{hook_type}: registered {script}")

    return migrated, changes


def _migrate_agent_overrides(git_root: Path) -> list[str]:
    """Move .claude/agents/overrides/*.md to .claude/agents/*.md."""
    changes = []
    old_dir = git_root / ".claude" / "agents" / "overrides"
    new_dir = git_root / ".claude" / "agents"

    if not old_dir.is_dir():
        return changes

    for md_file in old_dir.glob("*.md"):
        target = new_dir / md_file.name
        if target.exists():
            changes.append(f"  WARNING: {target} already exists, skipping {md_file.name}")
        else:
            shutil.move(str(md_file), str(target))
            changes.append(f"  Moved {md_file.name} to .claude/agents/")

    # Remove empty overrides directory
    try:
        # Remove .DS_Store if present
        ds_store = old_dir / ".DS_Store"
        if ds_store.exists():
            ds_store.unlink()
        old_dir.rmdir()
        changes.append("  Removed empty .claude/agents/overrides/")
    except OSError:
        pass  # Directory not empty, leave it

    return changes


def _migrate_global_keys_to_preferences(
    project_settings_path: str,
    global_path: str | None = None,
) -> dict:
    """One-shot: extract to-be-global keys from .claude/settings.json,
    write them into ~/.worca/settings.json, then strip from the project file.
    Idempotent: returns {} on second run."""
    if not os.path.exists(project_settings_path):
        return {}
    with open(project_settings_path) as f:
        project = json.load(f)

    extracted: dict = {}
    worca = project.get("worca", {})
    for section, key in _GLOBAL_ONLY_KEYS:
        val = worca.get(section, {}).get(key)
        if val is not None:
            extracted.setdefault(section, {})[key] = val
            del worca[section][key]
            if not worca[section]:
                del worca[section]

    if not extracted:
        return {}

    if global_path is None:
        global_path = os.path.expanduser("~/.worca/settings.json")
    try:
        with open(global_path) as f:
            global_blob = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        global_blob = {}
    global_blob.setdefault("worca", {})
    for section, kvs in extracted.items():
        global_blob["worca"].setdefault(section, {}).update(kvs)
    _atomic_write_json(global_path, global_blob)

    _atomic_write_json(project_settings_path, project)

    return extracted


def _strip_inert_milestone_keys(project_settings_path: str) -> list[str]:
    """One-shot: remove pr_approval and deploy_approval from .claude/settings.json
    if they were template-default values (true).

    Only strips when value is exactly True. False, strings, ints etc. are
    treated as intentional user overrides and left alone.

    Returns the list of removed keys. Idempotent: returns [] on second run."""
    if not os.path.exists(project_settings_path):
        return []
    with open(project_settings_path) as f:
        project = json.load(f)

    milestones = project.get("worca", {}).get("milestones", {})
    removed = []
    for key in ("pr_approval", "deploy_approval"):
        if milestones.get(key) is True:
            del milestones[key]
            removed.append(key)

    if not removed:
        return []

    if "worca" in project and "milestones" in project["worca"] and not project["worca"]["milestones"]:
        del project["worca"]["milestones"]

    _atomic_write_json(project_settings_path, project)

    return removed


def _remove_files_from_dir(directory: Path, filenames: list[str], changes: list[str]) -> None:
    """Remove specific files from a directory, then clean up __pycache__/.DS_Store and empty dir."""
    if not directory.is_dir():
        return

    for name in filenames:
        f = directory / name
        if f.exists():
            f.unlink()
            changes.append(f"  Removed {f.relative_to(directory.parent.parent)}")

    # Remove __pycache__/ if present
    pycache = directory / "__pycache__"
    if pycache.is_dir():
        shutil.rmtree(pycache)
        changes.append(f"  Removed {pycache.relative_to(directory.parent.parent)}")

    # Remove .DS_Store if present
    ds_store = directory / ".DS_Store"
    if ds_store.exists():
        ds_store.unlink()

    # Remove directory if now empty
    try:
        directory.rmdir()
        changes.append(f"  Removed empty {directory.relative_to(directory.parent.parent)}/")
    except OSError:
        pass  # Directory not empty (user files remain)


def _cleanup_legacy_files(git_root: Path) -> list[str]:
    """Remove known worca-owned files from pre-packaging install locations.

    Only runs if .claude/worca/ has no version (pre-packaging install).
    Returns list of change descriptions.
    """
    changes: list[str] = []
    claude_dir = git_root / ".claude"
    worca_dir = claude_dir / "worca"

    # If worca dir already has a version, this is a packaged install — skip cleanup
    if read_version(worca_dir) is not None:
        return changes

    # Remove known files from .claude/hooks/
    _remove_files_from_dir(claude_dir / "hooks", _LEGACY_HOOK_FILES, changes)

    # Remove known files from .claude/scripts/
    _remove_files_from_dir(claude_dir / "scripts", _LEGACY_SCRIPT_FILES, changes)

    # Remove .claude/agents/core/ (agent templates)
    _remove_files_from_dir(claude_dir / "agents" / "core", _LEGACY_AGENT_FILES, changes)

    # Remove .claude/agents/domain/ if only contains .gitkeep and/or .DS_Store
    domain_dir = claude_dir / "agents" / "domain"
    if domain_dir.is_dir():
        contents = set(f.name for f in domain_dir.iterdir())
        if contents <= {".gitkeep", ".DS_Store"}:
            shutil.rmtree(domain_dir)
            changes.append("  Removed .claude/agents/domain/")

    # Remove .claude/worca-ui/ (fully worca-owned embedded UI)
    worca_ui_dir = claude_dir / "worca-ui"
    if worca_ui_dir.is_dir():
        shutil.rmtree(worca_ui_dir)
        changes.append("  Removed .claude/worca-ui/")

    return changes


def _copy_worca_source(source: Path, target: Path) -> None:
    """Copy worca source to target, excluding cli/, skills/, and __pycache__/.

    skills/ ships in the wheel as package data but is installed separately
    into the project's top-level .claude/skills/ (not under .claude/worca/),
    since Claude Code only auto-discovers skills at .claude/skills/.
    """
    if target.exists():
        shutil.rmtree(target)

    def ignore_patterns(directory, contents):
        ignored = set()
        rel = os.path.relpath(directory, source)
        # Skip cli/ and skills/ at the top level
        if rel == ".":
            if "cli" in contents:
                ignored.add("cli")
            if "skills" in contents:
                ignored.add("skills")
        # Skip __pycache__ everywhere
        if "__pycache__" in contents:
            ignored.add("__pycache__")
        # Skip .DS_Store
        if ".DS_Store" in contents:
            ignored.add(".DS_Store")
        return ignored

    shutil.copytree(str(source), str(target), ignore=ignore_patterns)


def _install_skills(source: Path, git_root: Path) -> list[str]:
    """Install worca-owned skills into <project>/.claude/skills/.

    Each subdirectory of source/skills/ contains a SKILL.md. We mirror that
    layout into git_root/.claude/skills/<name>/SKILL.md, overwriting any
    existing copy (the package version is the source of truth). Unrelated
    user-authored skills under .claude/skills/ are left untouched.

    Returns a list of human-readable change descriptions.
    """
    changes: list[str] = []
    skills_src = source / "skills"
    if not skills_src.is_dir():
        return changes

    skills_dst = git_root / ".claude" / "skills"
    skills_dst.mkdir(parents=True, exist_ok=True)

    for skill_dir in sorted(skills_src.iterdir()):
        if not skill_dir.is_dir():
            continue
        skill_md = skill_dir / "SKILL.md"
        if not skill_md.is_file():
            continue
        dst_dir = skills_dst / skill_dir.name
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst_md = dst_dir / "SKILL.md"
        shutil.copy2(str(skill_md), str(dst_md))
        changes.append(f"  Installed .claude/skills/{skill_dir.name}/SKILL.md")

    return changes


def _ensure_gitignore(git_root: Path) -> list[str]:
    """Add recommended .gitignore entries if missing."""
    gitignore = git_root / ".gitignore"
    entries_needed = [".worca/", "logs/", ".claude/settings.local.json"]
    changes = []

    existing = ""
    if gitignore.exists():
        existing = gitignore.read_text()

    lines_to_add = []
    for entry in entries_needed:
        if entry not in existing:
            lines_to_add.append(entry)
            changes.append(f"  Added {entry} to .gitignore")

    if lines_to_add:
        with open(gitignore, "a") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write("\n# worca runtime\n")
            for line in lines_to_add:
                f.write(f"{line}\n")

    return changes


def _init_beads(git_root: Path) -> bool:
    """Run bd init if .beads/ doesn't exist. Returns True if initialized."""
    if (git_root / ".beads").is_dir():
        return False
    try:
        subprocess.run(
            ["bd", "init"],
            cwd=str(git_root),
            capture_output=True,
            timeout=30,
        )
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _upgrade_beads(git_root: Path) -> bool:
    """Update beads repo fingerprint if .beads/ exists. Idempotent."""
    if not (git_root / ".beads").is_dir():
        return False
    try:
        subprocess.run(
            ["bd", "migrate", "--update-repo-id"],
            cwd=str(git_root),
            input=b"y\n",
            capture_output=True,
            timeout=30,
        )
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def _show_check(source: Path, git_root: Path) -> None:
    """Show what would change without making changes."""
    target = git_root / ".claude" / "worca"
    settings_path = git_root / ".claude" / "settings.json"

    # Version comparison
    source_version = read_version(source)
    project_version = read_version(target) if target.exists() else None

    print(f"Source version:  {source_version or 'unknown'}")
    print(f"Project version: {project_version or 'not installed'}")

    if source_version and project_version and source_version != project_version:
        print(f"  -> Would upgrade {project_version} -> {source_version}")
    elif source_version == project_version:
        print("  -> Versions match")

    # Settings diff
    if settings_path.exists():
        with open(settings_path) as f:
            current = json.load(f)

        source_settings_path = source / "settings.json"
        if source_settings_path.exists():
            with open(source_settings_path) as f:
                template = json.load(f)

            # Check what keys would be added
            merged = _deep_merge(current, template)
            new_raw = json.dumps(merged, indent=2, sort_keys=True)
            old_raw = json.dumps(current, indent=2, sort_keys=True)
            if new_raw != old_raw:
                print("\nSettings changes (new keys that would be added):")
                # Simple diff: show keys present in merged but not in current
                _show_key_diff(current, merged, prefix="  ")
            else:
                print("\nSettings: no changes needed")

        # Check path migrations
        _, migration_changes = _migrate_settings_paths(current)
        if migration_changes:
            print("\nPath migrations that would be applied:")
            for change in migration_changes:
                print(change)

    # Legacy file cleanup check
    claude_dir = git_root / ".claude"
    worca_dir = claude_dir / "worca"
    if read_version(worca_dir) is None:
        legacy_files = []
        for name in _LEGACY_HOOK_FILES:
            f = claude_dir / "hooks" / name
            if f.exists():
                legacy_files.append(f"  .claude/hooks/{name}")
        for name in _LEGACY_SCRIPT_FILES:
            f = claude_dir / "scripts" / name
            if f.exists():
                legacy_files.append(f"  .claude/scripts/{name}")
        for name in _LEGACY_AGENT_FILES:
            f = claude_dir / "agents" / "core" / name
            if f.exists():
                legacy_files.append(f"  .claude/agents/core/{name}")
        domain_dir = claude_dir / "agents" / "domain"
        if domain_dir.is_dir():
            contents = set(f.name for f in domain_dir.iterdir())
            if contents <= {".gitkeep", ".DS_Store"}:
                legacy_files.append("  .claude/agents/domain/")
        worca_ui_dir = claude_dir / "worca-ui"
        if worca_ui_dir.is_dir():
            legacy_files.append("  .claude/worca-ui/")
        if legacy_files:
            print("\nLegacy files that would be removed:")
            for lf in legacy_files:
                print(lf)

    # Agent override migration
    old_overrides = git_root / ".claude" / "agents" / "overrides"
    if old_overrides.is_dir() and list(old_overrides.glob("*.md")):
        print("\nAgent overrides that would be moved:")
        for md in old_overrides.glob("*.md"):
            print(f"  {md.name} -> .claude/agents/{md.name}")


def _show_key_diff(current: dict, merged: dict, prefix: str = "") -> None:
    """Show keys that exist in merged but not in current."""
    for key in sorted(merged.keys()):
        if key not in current:
            print(f"{prefix}+ {key}")
        elif isinstance(merged[key], dict) and isinstance(current.get(key), dict):
            _show_key_diff(current[key], merged[key], prefix=f"{prefix}  {key}.")


def read_version(worca_dir: Path) -> str | None:
    """Read __version__ from a worca __init__.py."""
    init_file = worca_dir / "__init__.py"
    if not init_file.exists():
        return None
    content = init_file.read_text()
    for line in content.splitlines():
        if line.startswith("__version__"):
            # Extract version string
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def run_init(
    upgrade: bool = False,
    force: bool = False,
    check: bool = False,
    source: str | None = None,
) -> None:
    """Main init logic."""
    git_root = _find_git_root()
    worca_source = _get_worca_source(source, git_root)

    print(f"Source: {worca_source}")
    print(f"Target: {git_root / '.claude' / 'worca'}")

    # --check: dry-run mode
    if check:
        _show_check(worca_source, git_root)
        return

    target = git_root / ".claude" / "worca"
    settings_path = git_root / ".claude" / "settings.json"
    source_settings = worca_source / "settings.json"

    # Ensure .claude/ exists
    (git_root / ".claude").mkdir(exist_ok=True)

    if not upgrade and not force and target.exists():
        print(
            ".claude/worca/ already exists. Use --upgrade to update or --force to overwrite.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    # --- Path migrations (before merge, only on --upgrade) ---
    migration_changes = []
    if upgrade and settings_path.exists():
        with open(settings_path) as f:
            current_settings = json.load(f)
        migrated, migration_changes = _migrate_settings_paths(current_settings)
        if migration_changes:
            with open(settings_path, "w") as f:
                json.dump(migrated, f, indent=2)
                f.write("\n")
            print("Path migrations applied:")
            for change in migration_changes:
                print(change)

    # --- Legacy file cleanup (only on --upgrade, before source copy) ---
    if upgrade:
        legacy_changes = _cleanup_legacy_files(git_root)
        if legacy_changes:
            print("Legacy file cleanup:")
            for change in legacy_changes:
                print(change)

    # --- Agent override migration (only on --upgrade) ---
    if upgrade:
        override_changes = _migrate_agent_overrides(git_root)
        if override_changes:
            print("Agent override migration:")
            for change in override_changes:
                print(change)

    # --- Copy worca source ---
    _copy_worca_source(worca_source, target)
    print("Copied worca to .claude/worca/")

    # --- Install worca-owned skills into .claude/skills/ ---
    skill_changes = _install_skills(worca_source, git_root)
    if skill_changes:
        print("Skills:")
        for change in skill_changes:
            print(change)

    # --- Create .claude/templates/ for project templates ---
    project_templates_dir = git_root / ".claude" / "templates"
    if not project_templates_dir.exists():
        project_templates_dir.mkdir(parents=True, exist_ok=True)
        print("Created .claude/templates/ (project templates go here)")

    # --- Settings merge ---
    if force:
        # Full overwrite from template
        if source_settings.exists():
            shutil.copy2(str(source_settings), str(settings_path))
            print("Settings: replaced with template (--force)")
    elif settings_path.exists():
        # Non-destructive deep-merge: add new template keys, preserve user values
        # (permissions.allow, worca.agents.*.model, worca.loops.*, webhooks, etc.).
        # Forward-incompatible changes must go through _migrate_settings_paths so they
        # apply deterministically and are visible under `worca init --check`. Use --force
        # to replace the file with the template wholesale.
        with open(settings_path) as f:
            current = json.load(f)
        if source_settings.exists():
            with open(source_settings) as f:
                template = json.load(f)
            merged = _deep_merge(current, template)
            with open(settings_path, "w") as f:
                json.dump(merged, f, indent=2)
                f.write("\n")
            print("Settings: added new template keys (user values preserved)")
    else:
        # Create from template
        if source_settings.exists():
            shutil.copy2(str(source_settings), str(settings_path))
            print("Settings: created from template")

    # --- Global key migration (only on --upgrade, after settings merge) ---
    if upgrade and settings_path.exists():
        extracted = _migrate_global_keys_to_preferences(str(settings_path))
        if extracted:
            n = sum(len(v) for v in extracted.values())
            print(f"Migrated {n} key(s) to ~/.worca/settings.json")

        stripped = _strip_inert_milestone_keys(str(settings_path))
        if stripped:
            keys_str = ", ".join(stripped)
            print(
                f"Reset {len(stripped)} template-default milestone key(s) "
                f"({keys_str}) — gate now opt-in via Pipeline tab"
            )

    # --- .gitignore ---
    gitignore_changes = _ensure_gitignore(git_root)
    if gitignore_changes:
        print(".gitignore updates:")
        for change in gitignore_changes:
            print(change)

    # --- Beads init / upgrade ---
    if _init_beads(git_root):
        print("Initialized beads (.beads/)")
    elif upgrade and _upgrade_beads(git_root):
        print("Beads: updated repo fingerprint")

    version = read_version(target)
    print(f"\nworca {version or 'unknown'} initialized successfully.")
