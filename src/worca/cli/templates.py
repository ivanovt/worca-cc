"""CLI subcommands for managing pipeline templates.

Subcommands:
  worca templates list              — tabular output of all templates
  worca templates list --json       — machine-readable JSON for tooling
  worca templates show <id>         — pretty-print template.json for a given ID
  worca templates save <id>         — snapshot current settings as template
  worca templates create --from-file <path>  — create template from JSON file
  worca templates delete <id>       — remove a project or user template
  worca templates export --to <path|gist>    — export templates as a bundle
  worca templates import --from <path|url>   — import templates from a bundle
  worca templates rename --src-id <id> --src-scope <scope> --dst-id <id> --dst-scope <scope>
                                    — rename a template, rewriting any default-template pointer
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from worca.orchestrator.bundle import (
    ID_RE,
    SECRET_PLACEHOLDER,
    is_secret_placeholder,
    _OVERLAY_NAME_RE,
    _write_zip,
    build_export_manifest,
    collect_referenced_model_aliases,
    fetch_bundle,
    redact_bundle,
    strip_tier_prefixes,
    validate_bundle,
)
from worca.orchestrator.templates import (
    TemplateError,
    TemplateResolver,
    materialize_config,
)
from worca.utils.env import filter_model_env
from worca.utils.settings import _parse_model_ref, deep_merge


def _resolve_dirs(project_root: str | None = None):
    """Return (builtin_dir, project_dir, user_dir) for TemplateResolver.

    Project-root resolution:
      1. explicit `project_root` arg (from `--project-root`, used by
         worca-ui's templates-routes shim against non-git tmpdirs)
      2. nearest ancestor of cwd that contains `.git/`
      3. cwd itself — so the CLI is usable against plain directories
         (worca-ui supports non-git projects; the CLI must match)

    Once a project root is resolved (explicit OR via `.git` walk):
      - `builtin_dir` = `<root>/.claude/worca/templates/` (the runtime
        copy created by `worca init`; non-existent is fine — scan_tier
        is_dir-checks before iterating).
      - `project_dir` = `<root>/.claude/templates/`.

    When we fall back to plain cwd (no `--project-root`, no `.git`):
      - `builtin_dir` falls back to the installed package's
        `src/worca/templates/`, so `worca templates list` outside any
        project still shows the shipped templates.
      - `project_dir` = `<cwd>/.claude/templates/`, so duplicate /
        create still work and write under cwd.

    `user_dir` is always `~/.worca/templates/`.
    """
    explicit_root = bool(project_root)
    git_root = None
    cwd = Path.cwd().resolve()
    if explicit_root:
        resolved_root = Path(project_root).resolve()
    else:
        resolved_root = cwd
        for parent in [cwd, *cwd.parents]:
            if (parent / ".git").exists():
                git_root = parent
                resolved_root = parent
                break

    if explicit_root or git_root is not None:
        builtin_dir = resolved_root / ".claude" / "worca" / "templates"
    else:
        builtin_dir = Path(__file__).parent.parent / "templates"
    project_dir = resolved_root / ".claude" / "templates"

    user_dir = Path.home() / ".worca" / "templates"
    return builtin_dir, project_dir, user_dir


def _make_resolver(project_root: str | None = None):
    builtin_dir, project_dir, user_dir = _resolve_dirs(project_root)
    return TemplateResolver(builtin_dir, project_dir, user_dir)


def _print_validation_details(details):
    """Print TemplateError.details to stderr in a stable format.

    `details` is either a list of `{field, message}` dicts (returned by
    `TemplateResolver.save` validation) or a single dict of metadata
    (e.g. `{"dst_scope": ...}` from `TemplateResolver.duplicate`). The
    list form gets the bulleted field/message rendering; the dict form
    is printed as `key: value` lines so the underlying problem is still
    visible to the caller.
    """
    if isinstance(details, list):
        for detail in details:
            if isinstance(detail, dict):
                field = detail.get("field", "?")
                message = detail.get("message", "")
                print(f"  - {field}: {message}", file=sys.stderr)
            else:
                print(f"  - {detail}", file=sys.stderr)
    elif isinstance(details, dict):
        for key, value in details.items():
            print(f"  - {key}: {value}", file=sys.stderr)
    else:
        print(f"  - {details}", file=sys.stderr)


def cmd_templates_list(args):
    """worca templates list — tabular output, or JSON when --json is passed."""
    resolver = _make_resolver(getattr(args, "project_root", None))
    templates = resolver.list()

    if getattr(args, "json", False):
        payload = [
            {
                "id": t.id,
                "name": t.name,
                "description": t.description,
                "tier": t.tier,
                "tags": list(t.tags),
                "builtin": t.builtin,
                "created_at": t.created_at,
            }
            for t in templates
        ]
        print(json.dumps(payload, indent=2))
        return

    col_id = max((len(t.id) for t in templates), default=2)
    col_id = max(col_id, len("ID"))
    col_name = max((len(t.name) for t in templates), default=4)
    col_name = max(col_name, len("NAME"))
    col_tier = max((len(t.tier) for t in templates), default=4)
    col_tier = max(col_tier, len("TIER"))

    header = (
        f"{'ID':<{col_id}}  {'NAME':<{col_name}}  {'TIER':<{col_tier}}  TAGS"
    )
    print(header)
    print("-" * (col_id + col_name + col_tier + 10))

    for t in templates:
        tags_str = ", ".join(t.tags) if t.tags else "-"
        print(f"{t.id:<{col_id}}  {t.name:<{col_name}}  {t.tier:<{col_tier}}  {tags_str}")


def cmd_templates_show(args):
    """worca templates show <id> — pretty-print template.json."""
    resolver = _make_resolver(getattr(args, "project_root", None))
    template = resolver.get(args.template_id)
    if template is None:
        print(
            f"error: template '{args.template_id}' not found",
            file=sys.stderr,
        )
        raise SystemExit(1)

    data = json.loads(Path(template.source_dir, "template.json").read_text(encoding="utf-8"))
    data["tier"] = template.tier
    print(json.dumps(data, indent=2))


def register_subcommand(sub):
    """Register `worca templates` with its sub-subcommands into the given subparser group."""
    templates_parser = sub.add_parser("templates", help="Manage pipeline templates")
    templates_parser.add_argument(
        "--project-root",
        dest="project_root",
        default=None,
        help=(
            "Project root directory. Overrides the default `.git`-walk and "
            "cwd-fallback resolution. Used by non-git callers (e.g. worca-ui's "
            "templates-routes shim) to pin the project tier explicitly."
        ),
    )
    templates_sub = templates_parser.add_subparsers(dest="templates_command")

    # list
    list_parser = templates_sub.add_parser("list", help="List all available templates")
    list_parser.add_argument(
        "--json",
        dest="json",
        action="store_true",
        default=False,
        help="Emit JSON array (id, name, description, tier, tags, builtin, created_at) instead of the table",
    )

    # show
    show_parser = templates_sub.add_parser("show", help="Show details of a template")
    show_parser.add_argument("template_id", help="Template ID to show")

    # save
    save_parser = templates_sub.add_parser(
        "save", help="Snapshot current settings as a template"
    )
    save_parser.add_argument("template_id", help="Template ID to create")
    save_parser.add_argument("--description", default="", help="Short description of the template")
    save_parser.add_argument(
        "--global",
        dest="global_",
        action="store_true",
        default=False,
        help="Save to user-global scope (~/.worca/templates/)",
    )

    # create
    create_parser = templates_sub.add_parser(
        "create", help="Create a template from a JSON file"
    )
    create_parser.add_argument(
        "--from-file",
        dest="from_file",
        required=True,
        help="Path to JSON file with template data (use '-' for stdin)",
    )
    create_parser.add_argument(
        "--global",
        dest="global_",
        action="store_true",
        default=False,
        help="Save to user-global scope (~/.worca/templates/)",
    )

    # delete
    delete_parser = templates_sub.add_parser("delete", help="Delete a project or user template")
    delete_parser.add_argument("template_id", help="Template ID to delete")
    delete_parser.add_argument(
        "--global",
        dest="global_",
        action="store_true",
        default=False,
        help="Delete from user-global scope (~/.worca/templates/)",
    )

    # export
    export_parser = templates_sub.add_parser(
        "export", help="Export templates to a bundle file or gist"
    )
    export_parser.add_argument(
        "--to",
        required=True,
        help="Destination: file path, 'gist' (secret), or 'gist:public'",
    )
    export_parser.add_argument(
        "--include-models",
        dest="include_models",
        action="store_true",
        default=False,
        help="Include worca.models from settings.json",
    )
    export_parser.add_argument(
        "--include-pricing",
        dest="include_pricing",
        action="store_true",
        default=False,
        help="Include worca.pricing from settings.json",
    )
    export_parser.add_argument(
        "--templates",
        dest="templates_filter",
        default=None,
        help="Comma-separated template IDs to export (default: all project+user)",
    )
    export_parser.add_argument(
        "--mode",
        choices=["standalone", "delta"],
        default="standalone",
        help=(
            "standalone (default): self-contained bundle — config materialised "
            "over built-in defaults and prompts resolved into a complete set. "
            "delta: sparse template overlay that re-merges over the importer's "
            "defaults at run launch."
        ),
    )

    # import
    import_parser = templates_sub.add_parser(
        "import", help="Import templates from a bundle file, URL, or gist"
    )
    import_parser.add_argument(
        "--from",
        dest="from_source",
        required=True,
        help="Source: file path, HTTPS URL, or GitHub gist ID/URL",
    )
    import_parser.add_argument(
        "--scope",
        choices=["project", "user"],
        default="project",
        help="Target tier: project (.claude/templates/) or user (~/.worca/templates/)",
    )
    import_parser.add_argument(
        "--non-interactive",
        dest="non_interactive",
        action="store_true",
        default=False,
        help="Skip collision prompts; auto-skip all collisions",
    )
    import_parser.add_argument(
        "--on-model-conflict",
        dest="on_model_conflict",
        choices=["abort", "skip", "overwrite", "rename"],
        default="abort",
        help=(
            "Non-interactive policy when an incoming model alias collides with an "
            "existing one in user-global settings. abort: refuse the import; "
            "skip: drop the incoming alias and let the template reference the "
            "existing one; overwrite: replace the existing definition; "
            "rename: append a zero-padded -NN suffix and rewrite template refs."
        ),
    )
    import_parser.add_argument(
        "--on-template-conflict",
        dest="on_template_conflict",
        choices=["abort", "skip", "replace"],
        default="abort",
        help=(
            "Non-interactive policy when an incoming template id already exists "
            "in the target scope. abort: refuse the import; skip: keep the "
            "existing template (drop the incoming one); replace: overwrite the "
            "existing template with the incoming one."
        ),
    )
    import_parser.add_argument(
        "--resolutions",
        dest="resolutions",
        default=None,
        help=(
            "Path to a JSON file describing per-collision resolution actions. "
            "Structured shape: {\"models\": {\"<alias>\": {\"action\": "
            "\"skip|overwrite|rename\", \"new_name\": \"<optional>\"}}, "
            "\"templates\": {\"<tid>\": {\"action\": \"skip|replace\"}}}. "
            "A flat root-level mapping is treated as the models block for "
            "backwards compatibility within this PR. Used by the worca-ui "
            "import flow."
        ),
    )
    import_parser.add_argument(
        "--preview",
        dest="preview",
        action="store_true",
        default=False,
        help=(
            "Print a JSON collision preview to stdout and exit without writing "
            "anything. Used by the worca-ui import flow."
        ),
    )
    import_parser.add_argument(
        "--bundle-label",
        dest="bundle_label",
        default=None,
        help=(
            "Override the human-friendly label stamped on each imported "
            "model entry as `_imported_from`. Defaults to the basename of "
            "--from. Useful for UI imports where the source path is a "
            "temp file but the user-facing filename is known separately."
        ),
    )

    # validate
    validate_parser = templates_sub.add_parser(
        "validate", help="Validate a template config without saving"
    )
    validate_parser.add_argument(
        "--config",
        required=True,
        help="JSON config object to validate",
    )

    # duplicate
    duplicate_parser = templates_sub.add_parser(
        "duplicate", help="Clone a template from any tier to a project or user scope"
    )
    duplicate_parser.add_argument("src_id", help="Source template ID to copy from")
    duplicate_parser.add_argument(
        "--dst", required=True, help="Destination template ID for the copy"
    )
    duplicate_parser.add_argument(
        "--dst-scope",
        choices=["project", "user"],
        default="project",
        help="Destination scope (default: project)",
    )

    # rename
    rename_parser = templates_sub.add_parser(
        "rename",
        help="Rename a template, rewriting any worca.default_template pointer that references it",
    )
    rename_parser.add_argument("--src-id", required=True, dest="src_id", help="Source template ID")
    rename_parser.add_argument(
        "--src-scope",
        required=True,
        dest="src_scope",
        choices=["project", "user"],
        help="Source scope",
    )
    rename_parser.add_argument("--dst-id", required=True, dest="dst_id", help="Destination template ID")
    rename_parser.add_argument(
        "--dst-scope",
        required=True,
        dest="dst_scope",
        choices=["project", "user"],
        help="Destination scope",
    )

    # advise
    advise_parser = templates_sub.add_parser(
        "advise",
        help="Recommend the best-fit template for a given work source",
    )
    advise_parser.add_argument(
        "--source-type",
        required=True,
        dest="advise_source_type",
        help=(
            "Source type — one of: prompt, spec, source (GitHub issue), "
            "pr (GitHub PR), plan (plan file)."
        ),
    )
    advise_parser.add_argument(
        "--source-value",
        default="",
        dest="advise_source_value",
        help=(
            "Source value: raw prompt text, file path, gh:issue:N, "
            "gh:pr:N, or full URL. Read from stdin when set to '-'."
        ),
    )
    advise_parser.add_argument(
        "--model",
        default="sonnet",
        dest="advise_model",
        help="Model alias (resolved via worca.models). Defaults to sonnet.",
    )
    advise_parser.add_argument(
        "--timeout",
        type=int,
        default=60,
        dest="advise_timeout",
        help="Claude CLI timeout in seconds (default: 60).",
    )

    return templates_parser


def _load_current_worca_config() -> dict:
    """Read worca config from .claude/settings.json if it exists, else return empty dict.

    Reads ONLY settings.json. Env blocks for models live in settings.local.json
    after the id/env split and are NOT merged here — they would land in
    template snapshots (gitignored→committed) and leak secrets. Export uses
    `_load_models_with_env()` instead, which redacts on the way out.
    """
    cwd = Path.cwd().resolve()
    for parent in [cwd, *cwd.parents]:
        if (parent / ".git").exists():
            settings_path = parent / ".claude" / "settings.json"
            if settings_path.exists():
                try:
                    data = json.loads(settings_path.read_text(encoding="utf-8"))
                    return data.get("worca", {})
                except (json.JSONDecodeError, OSError):
                    pass
            break
    return {}


def _load_models_with_env() -> dict:
    """Return the project's `worca.models` map with env blocks merged in from
    settings.local.json. Used only on the export path — `redact_bundle` then
    scrubs secret VALUES before the bundle is written.

    Without this merge, exports would drop env routing (e.g. ANTHROPIC_BASE_URL
    for alt-endpoint aliases) because the id/env split keeps env in the
    gitignored local file. See bundle.py's SECRET_PATTERNS for the scrub set.

    Base entries come from `_load_current_worca_config()` so tests that patch
    that loader continue to control what export sees. Entries with no env
    splice are returned in their original shape (string OR object) so callers
    that expected bare-string entries keep matching.
    """
    worca_config = _load_current_worca_config()
    base_models = worca_config.get("models") or {}

    local_models: dict = {}
    cwd = Path.cwd().resolve()
    for parent in [cwd, *cwd.parents]:
        if (parent / ".git").exists():
            local_path = parent / ".claude" / "settings.local.json"
            if local_path.exists():
                try:
                    data = json.loads(local_path.read_text(encoding="utf-8"))
                    local_models = (data.get("worca") or {}).get("models") or {}
                except (json.JSONDecodeError, OSError):
                    pass
            break

    merged: dict = {}
    for alias, entry in base_models.items():
        local_entry = local_models.get(alias)
        env: dict | None = None
        if isinstance(local_entry, dict):
            env_val = local_entry.get("env")
            if isinstance(env_val, dict) and env_val:
                env = dict(env_val)
        if env is None:
            # Pass-through — preserve string-vs-object form.
            merged[alias] = entry
            continue
        # Splicing env requires object form.
        if isinstance(entry, str):
            entry_obj: dict = {"id": entry}
        elif isinstance(entry, dict):
            entry_obj = dict(entry)
        else:
            continue
        entry_obj["env"] = env
        merged[alias] = entry_obj
    return merged


def cmd_templates_save(args):
    """worca templates save <id> — snapshot current settings as template."""
    resolver = _make_resolver(getattr(args, "project_root", None))
    scope = "user" if args.global_ else "project"
    template_id = args.template_id
    description = args.description or ""
    name = template_id.replace("-", " ").title()
    config = _load_current_worca_config()

    template_data = {
        "id": template_id,
        "name": name,
        "description": description,
        "tags": [],
        "config": config,
    }

    from worca.orchestrator.templates import TemplateError
    try:
        template = resolver.save(template_data, scope=scope)
    except TemplateError as e:
        print(f"error: {e}", file=sys.stderr)
        raise SystemExit(1)

    tier_label = "user (~/.worca/templates/)" if scope == "user" else "project (.claude/templates/)"
    print(f"saved template '{template.id}' to {tier_label}")


def cmd_templates_create(args):
    """worca templates create --from-file <path> — create a template from JSON."""
    from worca.orchestrator.templates import TemplateError

    from_file = args.from_file
    try:
        if from_file == "-":
            raw = sys.stdin.read()
        else:
            raw = Path(from_file).read_text(encoding="utf-8")
        template_data = json.loads(raw)
    except (json.JSONDecodeError, OSError) as e:
        print(f"error: failed to read template JSON: {e}", file=sys.stderr)
        raise SystemExit(1)

    resolver = _make_resolver(getattr(args, "project_root", None))
    scope = "user" if args.global_ else "project"

    try:
        template = resolver.save(template_data, scope=scope)
    except TemplateError as e:
        if e.code == "validation_error" and e.details:
            print("error: template validation failed:", file=sys.stderr)
            _print_validation_details(e.details)
        else:
            print(f"error: {e}", file=sys.stderr)
        raise SystemExit(1)

    tier_label = "user (~/.worca/templates/)" if scope == "user" else "project (.claude/templates/)"
    print(f"created template '{template.id}' in {tier_label}")


def _derive_bundle_label(source: str) -> str:
    """Boil a bundle source down to a short human-friendly label for the
    ``_imported_from`` attribution badge on the Models page.

    Examples:
        /path/to/feature-fast-bundle.json -> "feature-fast-bundle.json"
        https://gist.github.com/.../bundle.json -> "bundle.json"
        gist:abcdef -> "gist:abcdef"
        C:\\Users\\sd\\bundle.json -> "bundle.json"  (Windows backslash paths)
    """
    if not source:
        return ""
    # Strip any query/fragment.
    label = source.split("?")[0].split("#")[0]
    # Strip trailing path separators (both flavors) so a trailing slash
    # doesn't reduce the basename to the empty string.
    label = label.rstrip("/\\")
    # Take the last path segment; honor both POSIX and Windows separators
    # so a Windows absolute path doesn't survive whole as the "label".
    sep_idx = max(label.rfind("/"), label.rfind("\\"))
    if sep_idx >= 0:
        return label[sep_idx + 1:] or label[:64]
    return label


def _find_settings_path(scope: str = "project") -> str | None:
    """Locate the settings.json that template-import should write to.

    For ``scope == "user"`` returns the user-global path
    (``~/.worca/settings.json`` by default; honors ``$WORCA_HOME`` and the
    global-disable toggle via ``worca.utils.settings._default_global_path``).
    The file does not need to exist yet — ``_atomic_import`` creates it.

    For ``scope == "project"`` (the default) walks up from cwd to ``.git`` and
    returns ``<git-root>/.claude/settings.json``; returns ``None`` outside a
    git repo so the caller can error out.
    """
    if scope == "user":
        from worca.utils.settings import _default_global_path
        return _default_global_path()
    cwd = Path.cwd().resolve()
    for parent in [cwd, *cwd.parents]:
        if (parent / ".git").exists():
            return str(parent / ".claude" / "settings.json")
    return None


def _local_settings_path_for(settings_path: str) -> str:
    """Derive the `.local.json` sibling path from a `settings.json` path."""
    root, ext = os.path.splitext(settings_path)
    return root + ".local" + ext


def _split_models_patch(settings_patch: dict) -> tuple[dict, dict]:
    """Split a bundle settings_patch into (base_patch, local_patch).

    Enforces the W-053 storage rule: per-model `id` and pricing land in
    `settings.json` (committed), `env` lands in `settings.local.json`
    (gitignored — safe for secrets). Mirrors `writeModelEntry` in the
    worca-ui server so a bundle-import write produces the same on-disk
    shape as a subsequent UI save.

    Returns (base_patch, local_patch). Either may be empty. Both retain
    the `worca` namespace one level up so the caller can deep_merge them
    over existing settings.

    Per-alias decisions:
      - bare string form (id only) → base, untouched
      - object form with env → base gets the non-env fields (`{id, ...}`),
        local gets `{env: {...}}`; if base would be `{id: X}` alone,
        flattens to the bare-string form for cleaner JSON
      - object form without env → base, untouched (will flatten if id-only)
    """
    base: dict = {}
    local: dict = {}

    # Pricing is not secret — keep it in the committed file.
    if settings_patch.get("pricing"):
        base["pricing"] = settings_patch["pricing"]

    models = settings_patch.get("models") or {}
    if not models:
        return base, local

    base_models: dict = {}
    local_models: dict = {}
    for alias, entry in models.items():
        if isinstance(entry, str):
            base_models[alias] = entry
            continue
        if not isinstance(entry, dict):
            # Malformed — preserve in base so it still surfaces somewhere
            # (the loader will warn about its shape).
            base_models[alias] = entry
            continue

        env = entry.get("env") or {}
        base_part = {k: v for k, v in entry.items() if k != "env"}

        if env:
            local_models[alias] = {"env": env}
            if base_part:
                base_models[alias] = base_part
        else:
            # No env in the bundle for this alias — flatten id-only to the
            # canonical bare-string form (matches what writeModelEntry on
            # the UI side emits when env is empty).
            if list(base_part.keys()) == ["id"]:
                base_models[alias] = base_part["id"]
            elif base_part:
                base_models[alias] = base_part

    if base_models:
        base["models"] = base_models
    if local_models:
        local["models"] = local_models
    return base, local


def _atomic_import(
    templates,
    settings_patch,
    target_dir,
    settings_path,
    *,
    local_settings_patch=None,
    local_settings_path=None,
):
    """Two-phase import: stage to tmpdir, then commit with full rollback.

    Writes up to TWO settings files atomically: ``settings_path`` (committed)
    and the optional ``local_settings_path`` (gitignored). The storage split
    enforced by ``_split_models_patch`` puts model env blocks in the local
    file so secrets never land in committed JSON.

    Rollback model:
      1. Stage everything to a tmpdir (no target mutation yet).
      2. For each template that would replace an existing dst, rename the
         existing dst aside to `<dst>.bak-<rand>`. Same for both settings files.
      3. Copy staged templates into place. Then os.replace each settings file.
      4. On any failure during step 3: remove anything newly committed,
         restore every `.bak-*` to its original location, raise.
      5. On success: delete all `.bak-*` backups.

    The backup-aside step uses `shutil.move` (rename within the same parent
    directory — single FS, atomic on POSIX) before any destructive mutation,
    so a write failure in step 3 always has something to roll back to.

    Cross-filesystem safety: `os.replace` requires source and destination on
    the same filesystem (EXDEV on POSIX, ERROR_NOT_SAME_DEVICE on Windows
    cross-drive). The system tempdir is on a different volume from the repo
    in common setups — macOS (`/private/var/folders/...` vs `/Volumes/X`),
    Linux (`/tmp` tmpfs vs ext4 on `/home`), Windows (`C:\\Users\\…\\Temp`
    vs `D:\\repo`). To guarantee single-FS for the atomic replace, we stage
    `settings.json` (and its `.local` sibling) in the SAME parent directory
    as the target, not in the system tempdir. Template directories can keep
    staging in the system tempdir because `shutil.copytree` is a file-by-file
    copy (no rename), which handles cross-device natively. Same pattern as
    `state/status.py` and `cli/init.py`.
    """
    target_real = target_dir.resolve()
    for tmpl_id in templates:
        if not ID_RE.fullmatch(tmpl_id):
            raise ValueError(f"unsafe template id: {tmpl_id!r}")
        dst = (target_dir / tmpl_id).resolve()
        if not str(dst).startswith(str(target_real) + os.sep):
            raise ValueError(f"template id {tmpl_id!r} escapes target directory")

    staging = Path(tempfile.mkdtemp(prefix="worca-import-"))
    # (original_path, backup_path, kind) — kind is "dir" or "file"
    backups: list[tuple[Path, Path, str]] = []
    committed_templates: list[Path] = []
    # Settings staging files live next to their targets (see docstring).
    # Tracked here so the finally block can sweep them on rollback or a
    # mid-commit failure without relying on the system-tempdir cleanup.
    # One slot per managed settings file (base + local) — both are written
    # in the same commit so a failure on either rolls both back.
    staged_paths: list[Path] = []

    def _bak_name(p: Path) -> Path:
        return p.with_name(p.name + f".bak-{uuid.uuid4().hex[:8]}")

    def _prepare_settings_text(patch, path):
        """Read+deep_merge+serialize; return None if nothing to write."""
        if not patch or not path:
            return None
        p = Path(path)
        if p.exists():
            current = json.loads(p.read_text(encoding="utf-8"))
        else:
            current = {}
        patched = deep_merge(current, {"worca": patch})
        return json.dumps(patched, indent=2)

    def _stage_and_replace(new_text, path, prefix):
        """Backup existing, stage next to target, atomic-replace.

        Mutates the `backups` and `staged_paths` lists in-place so the
        rollback / finally blocks see the intermediate state.
        """
        if new_text is None or not path:
            return
        sp = Path(path)
        sp.parent.mkdir(parents=True, exist_ok=True)
        if sp.exists():
            bak = _bak_name(sp)
            shutil.copy2(str(sp), str(bak))
            backups.append((sp, bak, "file"))
        fd, tmp_name = tempfile.mkstemp(
            prefix=prefix, suffix=".tmp", dir=str(sp.parent),
        )
        staged_paths.append(Path(tmp_name))
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(new_text)
        os.replace(tmp_name, str(sp))
        # Consumed — drop from sweep list.
        staged_paths.pop()

    try:
        # ---- Stage (no target mutation) ----
        for tmpl_id, tmpl_data in templates.items():
            staged_dir = staging / "templates" / tmpl_id
            staged_dir.mkdir(parents=True)
            (staged_dir / "template.json").write_text(
                json.dumps(tmpl_data, indent=2), encoding="utf-8"
            )
            overlay_map = tmpl_data.get("_overlays") or {}
            if overlay_map:
                agents_dir = staged_dir / "agents"
                agents_dir.mkdir(parents=True, exist_ok=True)
                for fname, content in overlay_map.items():
                    if not _OVERLAY_NAME_RE.match(fname):
                        raise ValueError(f"invalid overlay filename: {fname!r}")
                    (agents_dir / fname).write_text(content, encoding="utf-8")

        # Serialize the patched settings now (early failure on JSON errors)
        # but defer the file writes to the commit phase so they land in the
        # target directory — required for same-FS os.replace below.
        new_settings_text = _prepare_settings_text(settings_patch, settings_path)
        new_local_text = _prepare_settings_text(
            local_settings_patch, local_settings_path,
        )

        # ---- Commit with backup-first ----
        try:
            for tmpl_id in templates:
                src = staging / "templates" / tmpl_id
                dst = target_dir / tmpl_id
                if dst.exists():
                    bak = _bak_name(dst)
                    shutil.move(str(dst), str(bak))
                    backups.append((dst, bak, "dir"))
                shutil.copytree(str(src), str(dst))
                committed_templates.append(dst)

            _stage_and_replace(
                new_settings_text, settings_path, ".settings.json.import-",
            )
            _stage_and_replace(
                new_local_text,
                local_settings_path,
                ".settings.local.json.import-",
            )
        except Exception:
            # Rollback: tear down what we committed, then restore backups.
            for d in committed_templates:
                shutil.rmtree(d, ignore_errors=True)
            for orig, bak, kind in backups:
                try:
                    if orig.exists():
                        if kind == "dir":
                            shutil.rmtree(orig, ignore_errors=True)
                        else:
                            orig.unlink()
                    shutil.move(str(bak), str(orig))
                except Exception:  # noqa: BLE001 — best-effort restoration
                    pass
            raise
        else:
            # Success — clean up the backups.
            for _, bak, kind in backups:
                if kind == "dir":
                    shutil.rmtree(bak, ignore_errors=True)
                else:
                    try:
                        bak.unlink()
                    except OSError:
                        pass
    finally:
        # Sweep any staged-next-to-target settings files that weren't
        # consumed (write failure, os.replace failure, or pre-replace
        # exception). Required so the rollback-leftover assertion
        # `no .bak-* / .import- siblings` also holds for our staging files.
        for sp in staged_paths:
            try:
                sp.unlink()
            except OSError:
                pass
        shutil.rmtree(staging, ignore_errors=True)


def _read_template_overlays(tmpl) -> dict:
    """Return ``{filename: content}`` for every ``*.md`` in *tmpl.agents_dir*."""
    if not tmpl.agents_dir:
        return {}
    agents_path = Path(tmpl.agents_dir)
    if not agents_path.is_dir():
        return {}
    return {
        f.name: f.read_text(encoding="utf-8")
        for f in sorted(agents_path.glob("*.md"))
    }


def cmd_templates_export(args):
    """worca templates export --to <path|gist> — export templates as a bundle.

    Format auto-selection:
      - Single template with overlays (agents/*.md) → ``.zip``
      - Single template without overlays → ``.json`` (unchanged)
      - Multiple templates → one file per template in the parent dir of ``--to``;
        each file uses ``.zip`` or ``.json`` based on its own overlay presence.
      - ``--to gist`` with any overlay → error (gist only supports JSON bundles).

    Summary of all written paths is printed to stderr for multi-template exports.
    """
    resolver = _make_resolver(getattr(args, "project_root", None))
    worca_config = _load_current_worca_config()

    export_mode = getattr(args, "mode", "standalone")
    standalone = export_mode == "standalone"
    core_dir = resolver._find_core_dir() if standalone else None
    if standalone and core_dir is None:
        print(
            "warning: standalone export requested but core prompt dir not found — "
            "prompts will be carried as raw overlays instead of a self-contained set",
            file=sys.stderr,
        )

    if args.templates_filter:
        template_ids = [tid.strip() for tid in args.templates_filter.split(",") if tid.strip()]
    else:
        all_templates = resolver.list()
        template_ids = [t.id for t in all_templates if t.tier != "builtin"]

    # Resolve Template objects and build entries (including overlays).
    tmpl_objects = []
    template_entries = []
    for tid in template_ids:
        tmpl = resolver.get(tid)
        if tmpl is None:
            print(f"error: template '{tid}' not found", file=sys.stderr)
            raise SystemExit(1)
        entry = {
            "id": tmpl.id,
            "name": tmpl.name,
            "description": tmpl.description,
            "tags": list(tmpl.tags),
            # Standalone: materialise the effective config over the built-in
            # defaults so the bundle is self-describing and version-pinned.
            # Delta: ship the sparse overlay (re-merges on import).
            "config": materialize_config(tmpl.config) if standalone else tmpl.config,
        }
        if tmpl.params:
            entry["params"] = tmpl.params
        if standalone and core_dir is not None:
            # Self-contained prompts: every core role + block composed with this
            # template's overlay (same resolution duplicate uses).
            overlays = resolver.resolve_self_contained_agents(tmpl, core_dir)
        else:
            overlays = _read_template_overlays(tmpl)
        if overlays:
            entry["_overlays"] = overlays
        tmpl_objects.append(tmpl)
        template_entries.append(entry)

    any_overlays = any("_overlays" in e for e in template_entries)

    # Pre-redaction pass: strip user:/project: prefixes from agent model refs so
    # bundles ship bare refs (post-D2 wire format). builtin: and bare refs are
    # preserved verbatim. Malformed refs are left as-is — the validator flagged
    # them earlier; export is not the right place to silently rewrite them.
    template_entries = strip_tier_prefixes(template_entries)

    dest = args.to
    if dest in ("gist", "gist:public"):
        if any_overlays:
            print(
                "error: gist export only supports JSON bundles; "
                "templates with prompt overlays must be shared as a downloaded .zip file",
                file=sys.stderr,
            )
            raise SystemExit(1)

        # Gist path: single merged manifest (existing behaviour).
        # Env blocks are spliced in from settings.local.json by
        # _load_models_with_env so alt-endpoint routing rides through redaction.
        all_models = _load_models_with_env()
        referenced_aliases = collect_referenced_model_aliases(template_entries, all_models)
        models = None
        if args.include_models:
            models, _ = _filter_models_by_aliases(all_models, referenced_aliases, direction="export")
        pricing = None
        if args.include_pricing:
            pricing, _ = _filter_pricing_by_aliases(
                worca_config.get("pricing") or {}, referenced_aliases, direction="export"
            )
        manifest = build_export_manifest(
            template_entries, models=models, pricing=pricing, export_mode=export_mode
        )
        redacted, redacted_paths = redact_bundle(manifest)
        if redacted_paths:
            for rp in redacted_paths:
                print(f"info: redacted {rp}", file=sys.stderr)
        cmd = ["gh", "gist", "create", "--filename", "bundle.json", "-"]
        if dest == "gist:public":
            cmd.append("--public")
        result = subprocess.run(
            cmd,
            input=json.dumps(redacted, indent=2),
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            print(f"error: gh gist create failed: {result.stderr.strip()}", file=sys.stderr)
            raise SystemExit(1)
        print(result.stdout.strip())
        return

    # File output path.
    multi = len(template_entries) > 1
    out_dir = Path(dest).parent if multi else None

    # Env blocks are spliced in from settings.local.json by
    # _load_models_with_env so alt-endpoint routing rides through redaction.
    all_models = _load_models_with_env()
    referenced_aliases = collect_referenced_model_aliases(template_entries, all_models)

    models = None
    if args.include_models:
        models, _ = _filter_models_by_aliases(all_models, referenced_aliases, direction="export")

    pricing = None
    if args.include_pricing:
        pricing, _ = _filter_pricing_by_aliases(
            worca_config.get("pricing") or {}, referenced_aliases, direction="export"
        )

    written_paths = []
    for entry in template_entries:
        has_overlays = bool(entry.get("_overlays"))

        # Always carry models+pricing through the manifest so redaction sees
        # any secret values. The zip layout (v3) ships them in models.json;
        # the json layout keeps them at manifest top level.
        per_manifest = build_export_manifest(
            [entry],
            models=models,
            pricing=pricing,
            export_mode=export_mode,
        )
        redacted_manifest, redacted_paths = redact_bundle(per_manifest)
        if redacted_paths:
            for rp in redacted_paths:
                print(f"info: redacted {rp}", file=sys.stderr)

        redacted_entry = redacted_manifest["templates"][0]
        redacted_models = redacted_manifest.get("models")
        redacted_pricing = redacted_manifest.get("pricing")

        if multi:
            ext = ".zip" if has_overlays else ".json"
            out_path = str(out_dir / f"{entry['id']}-bundle{ext}")
        else:
            out_path = dest

        if has_overlays:
            _write_zip(
                redacted_entry,
                out_path,
                export_mode=export_mode,
                models=redacted_models,
                pricing=redacted_pricing,
            )
        else:
            Path(out_path).write_text(
                json.dumps(redacted_manifest, indent=2), encoding="utf-8"
            )

        written_paths.append(out_path)

    if multi:
        for p in written_paths:
            print(f"  wrote {p}", file=sys.stderr)
    print(f"exported {len(template_entries)} template(s)")


def cmd_templates_import(args):
    """worca templates import --from <source> — import templates from a bundle.

    Templates, model aliases (``worca.models``) and pricing
    (``worca.pricing.models``) in the bundle all land in the tier picked via
    ``--scope`` (project or user). This is the v2 behaviour — earlier
    versions hardcoded models/pricing to user-global; see MIGRATION.md.

    Each imported model entry is stamped with ``_imported_from: <bundle-name>``
    in settings.json so the Models page can surface a small "Imported from X"
    attribution badge. The badge is dropped the first time the user saves
    the entry via the UI (ownership transfer).
    """
    source = args.from_source
    scope = args.scope
    non_interactive = args.non_interactive
    on_model_conflict = getattr(args, "on_model_conflict", "abort")
    on_template_conflict = getattr(args, "on_template_conflict", "abort")
    preview_only = getattr(args, "preview", False)
    resolutions_path = getattr(args, "resolutions", None)

    user_resolutions_raw: dict = {}
    if resolutions_path:
        try:
            user_resolutions_raw = json.loads(Path(resolutions_path).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as e:
            print(f"error: --resolutions: {e}", file=sys.stderr)
            raise SystemExit(1)
        if not isinstance(user_resolutions_raw, dict):
            print("error: --resolutions JSON root must be an object", file=sys.stderr)
            raise SystemExit(1)

    # Two accepted shapes for --resolutions:
    #   structured: {"models": {alias: {...}}, "templates": {tid: {...}}}
    #   legacy:     {alias: {...}}  (treated as the models block)
    if (
        "models" in user_resolutions_raw
        or "templates" in user_resolutions_raw
    ):
        model_resolutions = user_resolutions_raw.get("models") or {}
        template_resolutions = user_resolutions_raw.get("templates") or {}
    else:
        model_resolutions = user_resolutions_raw
        template_resolutions = {}

    try:
        manifest = fetch_bundle(source)
    except Exception as e:
        print(f"error: failed to fetch bundle: {e}", file=sys.stderr)
        raise SystemExit(1)

    errors, warnings = validate_bundle(manifest)
    if errors:
        print("error: bundle validation failed:", file=sys.stderr)
        for err in errors:
            print(f"  - {err['field']}: {err['message']}", file=sys.stderr)
        raise SystemExit(1)
    for w in warnings:
        print(f"warning: unknown top-level key {w!r} (preserved)", file=sys.stderr)

    bundle_templates = manifest.get("templates", [])
    bundle_models = manifest.get("models")
    bundle_pricing = manifest.get("pricing")

    # Standalone bundles carry a fully-materialised config + self-contained
    # prompts; they are written verbatim (applied as-is), so the imported
    # template behaves identically to the source regardless of local defaults.
    if manifest.get("export_mode") == "standalone":
        print(
            "info: standalone bundle — config and prompts applied as-is "
            "(no re-merge over local defaults)",
            file=sys.stderr,
        )

    resolver = _make_resolver(getattr(args, "project_root", None))
    _, project_dir, user_dir = _resolve_dirs()
    target_dir = user_dir if scope == "user" else project_dir
    if target_dir is None:
        print("error: not in a git repository — cannot determine project template directory", file=sys.stderr)
        raise SystemExit(1)

    # First pass: detect template-id collisions in the target scope so they can
    # be surfaced by --preview alongside model collisions before any prompt.
    template_collisions_meta: list[dict] = []
    for tmpl in bundle_templates:
        tid = tmpl["id"]
        existing = resolver.get(tid)
        has_collision = existing is not None and (
            (scope == "project" and existing.tier == "project")
            or (scope == "user" and existing.tier == "user")
        )
        if has_collision:
            template_collisions_meta.append({
                "id": tid,
                "existing_tier": existing.tier,
                "existing_name": existing.name,
                "incoming_name": tmpl.get("name", tid),
            })

    to_import: dict = {}
    skipped_ids: list[str] = []
    for tmpl in bundle_templates:
        tid = tmpl["id"]
        existing = resolver.get(tid)
        has_collision = existing is not None and (
            (scope == "project" and existing.tier == "project")
            or (scope == "user" and existing.tier == "user")
        )
        # A same-id builtin gets shadowed silently by today's resolver — surface
        # it so the user is aware the imported template will mask the builtin.
        if existing is not None and existing.tier == "builtin" and not has_collision:
            print(
                f"info: shadowing builtin template '{tid}' with {scope}-scope import",
                file=sys.stderr,
            )
        if not has_collision:
            to_import[tid] = tmpl
            continue

        # --preview is passive: never prompt, never abort, just record the
        # template as skipped so the loop is consistent and the preview branch
        # below returns the full collision metadata to the caller.
        if preview_only:
            skipped_ids.append(tid)
            continue

        # Collision-resolution precedence:
        #   1. Per-template entry in user_resolutions_raw["templates"]
        #   2. --on-template-conflict policy (in non-interactive mode)
        #   3. Interactive prompt (skip/replace/abort)
        spec = template_resolutions.get(tid) if isinstance(template_resolutions, dict) else None
        action = None
        if isinstance(spec, dict) and isinstance(spec.get("action"), str):
            action = spec["action"]
            if action not in ("skip", "replace"):
                print(f"error: unknown template action {action!r} for {tid!r}", file=sys.stderr)
                raise SystemExit(1)
        elif non_interactive:
            policy = on_template_conflict
            if policy == "abort":
                print(
                    f"error: template '{tid}' already exists in {scope} scope "
                    f"with --on-template-conflict=abort",
                    file=sys.stderr,
                )
                raise SystemExit(1)
            action = policy

        if action is None:
            decided = False
            while not decided:
                try:
                    answer = input(
                        f"template '{tid}' already exists in {scope} scope. "
                        f"[r]eplace / [s]kip / [a]bort? "
                    )
                except EOFError:
                    skipped_ids.append(tid)
                    decided = True
                    break
                choice = answer.strip().lower()
                if choice.startswith("a"):
                    print("aborted", file=sys.stderr)
                    raise SystemExit(1)
                if choice.startswith("r"):
                    action = "replace"
                    decided = True
                elif choice.startswith("s"):
                    action = "skip"
                    decided = True
                else:
                    print(
                        f"  unrecognized choice {answer!r} — enter r, s, or a",
                        file=sys.stderr,
                    )

        if action == "replace":
            to_import[tid] = tmpl
        else:
            skipped_ids.append(tid)

    settings_patch: dict = {}
    template_settings_path = _find_settings_path(scope)
    # Model aliases and pricing land in the SAME scope the templates do, so
    # an "import to Project" applies the whole bundle (templates + models +
    # pricing) to the project. Earlier behaviour hardcoded user-global,
    # which broke the parity between Pipeline Templates' tier model and
    # bundle contents. The Models page's "Import" flow expects this.
    models_settings_path = _find_settings_path(scope)

    # Filter bundle's models/pricing to aliases actually referenced by
    # templates. For preview mode we consider the FULL bundle so the dialog
    # can surface collisions even when the destination already has the
    # template (which non-interactive skips). For commit mode we restrict to
    # `to_import` so we don't carry aliases for skipped templates.
    if bundle_models or bundle_pricing:
        if preview_only:
            referenced_source = list(bundle_templates)
        else:
            referenced_source = list(to_import.values())
        all_bundle_models = bundle_models or {}
        referenced = collect_referenced_model_aliases(
            referenced_source, all_bundle_models
        )
        if bundle_models:
            bundle_models, _ = _filter_models_by_aliases(
                bundle_models, referenced, direction="import"
            )
        if bundle_pricing:
            bundle_pricing, _ = _filter_pricing_by_aliases(
                bundle_pricing, referenced, direction="import"
            )

    # Apply reserved-env-key stripping in place so collision comparison and
    # downstream merge both see the sanitized values.
    if bundle_models:
        cleaned_models: dict = {}
        for model_key, model_entry in bundle_models.items():
            if isinstance(model_entry, dict) and "env" in model_entry:
                safe_env, dropped = filter_model_env(model_entry["env"])
                if dropped:
                    print(
                        f"  stripped reserved keys from models.{model_key}.env: {dropped}",
                        file=sys.stderr,
                    )
                model_entry = {**model_entry, "env": safe_env}
                if not safe_env:
                    del model_entry["env"]
            cleaned_models[model_key] = model_entry
        bundle_models = cleaned_models

    # --preview: print collisions JSON and exit without writing. Used by the
    # worca-ui import flow to drive the collision dialog before commit.
    if preview_only:
        preview = _build_collision_preview(
            bundle_models,
            bundle_pricing,
            models_settings_path,
            bundle_templates=list(bundle_templates),
            landing_tier=scope,
        )
        preview["template_ids"] = [t.get("id") for t in bundle_templates]
        preview["template_collisions"] = template_collisions_meta
        # Models, pricing, and templates all land in the same scope now
        # (previously models were hardcoded to user-global).
        preview["models_scope"] = scope
        preview["template_scope"] = scope
        preview["template_settings_path"] = template_settings_path
        print(json.dumps(preview, indent=2))
        return

    bundle_models, bundle_pricing, rename_map = _resolve_settings_alias_collisions(
        bundle_models,
        bundle_pricing,
        models_settings_path,
        non_interactive,
        on_conflict=on_model_conflict,
        resolutions=model_resolutions,
    )

    # Apply the rename map to templates BEFORE _atomic_import so the on-disk
    # template never references a stale alias name. Also auto-pins all bare
    # refs to the landing tier. Transactional with the rename in the settings patch.
    ref_rewrites = _rewrite_template_model_refs(to_import, rename_map, landing_tier=scope)
    if ref_rewrites:
        print(
            f"info: rewrote {len(ref_rewrites)} template model ref(s) to pin to --scope {scope!r}:",
            file=sys.stderr,
        )
        for tmpl_id, role, old_ref, new_ref, reason in ref_rewrites:
            reason_label = reason.replace("_", " ")
            print(
                f"  - {tmpl_id}.{role}.model: {old_ref} → {new_ref} ({reason_label})",
                file=sys.stderr,
            )

    # Stamp bundle attribution on each imported model entry so the Models
    # page can surface a small "Imported from <X>" badge. Prefer the
    # explicit --bundle-label arg when supplied (the UI passes the user's
    # original filename, since the source path is a server-side temp file
    # named `bundle.zip`); fall back to the source's basename for CLI
    # callers — covers files, gist URLs, and HTTP URLs uniformly. The UI
    # drops the badge on first edit (ownership transfer); the server's
    # writeModelEntry does not preserve _imported_from across UI saves.
    bundle_label = (
        getattr(args, "bundle_label", None) or _derive_bundle_label(source)
    )
    if bundle_models and bundle_label:
        stamped: dict = {}
        for alias, entry in bundle_models.items():
            if isinstance(entry, str):
                # Promote string-form to object-form to carry the metadata.
                stamped[alias] = {"id": entry, "_imported_from": bundle_label}
            elif isinstance(entry, dict):
                stamped[alias] = {**entry, "_imported_from": bundle_label}
            else:
                stamped[alias] = entry
        bundle_models = stamped

    if bundle_models:
        settings_patch["models"] = bundle_models

    if bundle_pricing:
        settings_patch["pricing"] = bundle_pricing

    if not to_import and not settings_patch:
        if skipped_ids:
            print(f"imported 0 templates (skipped: {', '.join(skipped_ids)})")
        else:
            print("nothing to import")
        return

    # Single atomic transaction: templates land in `target_dir` (per --scope),
    # model aliases / pricing land split between settings.json (id +
    # _imported_from + pricing) and settings.local.json (env). The split
    # mirrors writeModelEntry in the worca-ui server so a CLI-import write
    # produces the same on-disk shape as a subsequent UI save — secrets
    # never end up in the committed settings.json. _atomic_import handles
    # cross-FS staging + rollback for both files together.
    base_settings_patch, local_settings_patch = _split_models_patch(
        settings_patch
    )
    models_local_settings_path = (
        _local_settings_path_for(models_settings_path)
        if models_settings_path
        else None
    )
    try:
        _atomic_import(
            to_import,
            base_settings_patch,
            target_dir,
            models_settings_path,
            local_settings_patch=local_settings_patch,
            local_settings_path=models_local_settings_path,
        )
    except Exception as e:
        print(f"error: import failed: {e}", file=sys.stderr)
        raise SystemExit(1)

    if to_import and settings_patch:
        local_note = (
            f" — secrets / env in {models_local_settings_path}"
            if local_settings_patch and models_local_settings_path
            else ""
        )
        print(
            f"info: templates, model aliases, and pricing all landed in "
            f"{scope} scope ({target_dir}, {models_settings_path}){local_note}.",
            file=sys.stderr,
        )

    # Surface any placeholder values that landed — the importer needs to fill
    # them in locally before the pipeline can use them.
    placeholder_paths: list[str] = []
    _collect_placeholder_paths(to_import, "templates", placeholder_paths)
    if settings_patch.get("models"):
        _collect_placeholder_paths(
            settings_patch["models"], "settings.worca.models", placeholder_paths
        )
    if placeholder_paths:
        print(
            f"info: {len(placeholder_paths)} secret placeholder(s) landed — "
            f"replace {SECRET_PLACEHOLDER!r} before running the pipeline:",
            file=sys.stderr,
        )
        for p in placeholder_paths:
            print(f"  - {p}", file=sys.stderr)

    parts = [f"imported {len(to_import)} template(s)"]
    if bundle_models:
        parts.append(f"{len(bundle_models)} model(s)")
    if bundle_pricing:
        parts.append("pricing")
    summary = ", ".join(parts)
    if skipped_ids:
        summary += f" (skipped: {', '.join(skipped_ids)})"
    print(summary)


def _filter_models_by_aliases(
    all_models: dict, referenced: set[str], *, direction: str
) -> tuple[dict | None, list[str]]:
    """Restrict `all_models` to entries in `referenced`.

    Returns (filtered_dict_or_None, dropped_aliases). `None` is returned (not
    `{}`) when no entries survive, so callers can skip emitting the key
    entirely. Drops are logged to stderr with the given `direction` label
    ("export" / "import") so users can tell why the bundle is smaller than
    expected.
    """
    if not all_models:
        return None, []
    filtered = {k: v for k, v in all_models.items() if k in referenced}
    dropped = sorted(set(all_models) - set(filtered))
    if dropped:
        print(
            f"info: dropped {len(dropped)} unreferenced model alias(es) "
            f"from {direction}: {', '.join(dropped)}",
            file=sys.stderr,
        )
    if not filtered:
        if referenced:
            # Bundle/templates referenced aliases we couldn't resolve — surface that.
            print(
                f"info: --include-models had no effect on {direction} — referenced "
                f"alias(es) {sorted(referenced)} not found in models map",
                file=sys.stderr,
            )
        else:
            print(
                f"info: --include-models had no effect on {direction} — no templates "
                "reference any model alias",
                file=sys.stderr,
            )
        return None, dropped
    return filtered, dropped


def _filter_pricing_by_aliases(
    all_pricing: dict, referenced: set[str], *, direction: str
) -> tuple[dict | None, list[str]]:
    """Restrict `pricing.models` to entries in `referenced`. `server_tools`
    (web_fetch / web_search per-request rates) is dropped — those are
    project-wide rates the operator configures locally, not bundle cargo.
    `currency` and `last_updated` ride along as descriptors for the per-model
    rates that ARE shipped.

    Returns (filtered_dict_or_None, dropped_aliases). Returns `None` when
    `all_pricing` is empty.
    """
    if not all_pricing:
        return None, []
    pricing_models = all_pricing.get("models") or {}
    filtered_pm = {k: v for k, v in pricing_models.items() if k in referenced}
    dropped = sorted(set(pricing_models) - set(filtered_pm))
    if dropped:
        print(
            f"info: dropped {len(dropped)} unreferenced pricing entry(ies) "
            f"from {direction}: {', '.join(dropped)}",
            file=sys.stderr,
        )
    result = {**all_pricing}
    if "models" in result:
        result["models"] = filtered_pm
    # Strip project-wide rates that aren't model/template-related.
    result.pop("server_tools", None)
    return result, dropped


def _find_next_alias_name(base: str, taken: set[str], cap: int = 99) -> str | None:
    """Probe ``base-01`` … ``base-{cap:02d}`` and return the first unused name.

    Zero-padded so reimport ordering stays predictable. Returns ``None`` when
    the cap is exhausted; caller treats that as a hard failure.
    """
    for n in range(1, cap + 1):
        candidate = f"{base}-{n:02d}"
        if candidate not in taken:
            return candidate
    return None


def _rewrite_template_model_refs(
    templates: dict, rename_map: dict[str, str], landing_tier: str = "project"
) -> list[tuple]:
    """Rewrite every ``config.agents.*.model`` reference in *templates*.

    Mutates in place; called AFTER collision resolution and BEFORE
    _atomic_import so the on-disk template never references a stale alias or
    bare ref.

    Rules per ref:
    - builtin:alias  → pass through unchanged.
    - user:/project: → wire-format violation (bundles must not carry tier
      prefixes); emit stderr warning, strip the prefix, treat as bare.
    - bare alias     → apply rename_map, then rewrite to
                       ``{landing_tier}:{resolved_alias}``.

    Returns a list of (template_id, role, old_ref, new_ref, reason) tuples
    where reason ∈ {auto_pin, auto_pin_after_rename, wire_format_violation}.
    """
    rewrites: list[tuple] = []
    for tmpl_id, tmpl in templates.items():
        config = tmpl.get("config")
        if not isinstance(config, dict):
            continue
        agents = config.get("agents")
        if not isinstance(agents, dict):
            continue
        for role, agent_cfg in agents.items():
            if not isinstance(agent_cfg, dict):
                continue
            model = agent_cfg.get("model")
            if not isinstance(model, str):
                continue
            old_ref = model
            try:
                tier, alias = _parse_model_ref(model)
            except ValueError:
                # Malformed ref — leave unchanged, no rewrite recorded.
                continue

            if tier == "builtin":
                continue

            reason: str
            if tier in ("user", "project"):
                # Wire-format violation: bundles must export bare aliases only.
                print(
                    f"warning: wire_format_violation: template '{tmpl_id}' agent "
                    f"'{role}' model ref '{model}' carries a tier prefix — "
                    f"stripping and re-pinning to --scope {landing_tier!r}",
                    file=sys.stderr,
                )
                reason = "wire_format_violation"
                # alias is already stripped of the prefix
            else:
                # Bare ref: apply rename map, then pin to landing tier.
                new_alias = rename_map.get(alias, alias)
                if new_alias != alias:
                    reason = "auto_pin_after_rename"
                    alias = new_alias
                else:
                    reason = "auto_pin"

            new_ref = f"{landing_tier}:{alias}"
            agent_cfg["model"] = new_ref
            rewrites.append((tmpl_id, role, old_ref, new_ref, reason))
    return rewrites


def _build_collision_preview(
    bundle_models: dict | None,
    bundle_pricing: dict | None,
    settings_path: str | None,
    *,
    bundle_templates: list | None = None,
    landing_tier: str = "project",
) -> dict:
    """Return a JSON-serializable preview of incoming alias collisions.

    Shape::
        {
          "collisions": [
            {"alias": "glm-ds", "scope": "models",
             "incoming": {...}, "existing": {...},
             "suggested_rename": "glm-ds-01"},
            ...
          ],
          "new_aliases": ["claude-private", ...],
          "ref_rewrites": [
            {"template_id": "t1", "role": "planner",
             "old": "glm-ds", "new": "project:glm-ds", "reason": "auto_pin"},
            ...
          ],
          "settings_path": "/Users/.../.worca/settings.json"
        }

    Used by the worca-ui preview endpoint so the dialog can render
    per-alias resolution rows without re-running the import.
    """
    current_models, _ = _read_current_models_and_pricing(settings_path)
    collisions: list[dict] = []
    new_aliases: list[str] = []
    taken = set(current_models.keys()) | set((bundle_models or {}).keys())
    for alias, incoming in (bundle_models or {}).items():
        if alias in current_models:
            existing = current_models[alias]
            if existing == incoming:
                continue
            suggested = _find_next_alias_name(alias, taken)
            if suggested:
                taken.add(suggested)
            collisions.append({
                "alias": alias,
                "scope": "models",
                "incoming": incoming,
                "existing": existing,
                "suggested_rename": suggested,
            })
        else:
            new_aliases.append(alias)

    # Compute ref rewrites using an empty rename_map (no collision resolution
    # yet in preview mode). The UI can derive the renamed-ref cascade by
    # applying suggested_rename values from collisions to these entries.
    ref_rewrites: list[dict] = []
    if bundle_templates:
        import copy
        preview_templates = {
            t["id"]: copy.deepcopy(t)
            for t in bundle_templates
            if isinstance(t, dict) and "id" in t
        }
        raw_rewrites = _rewrite_template_model_refs(
            preview_templates, {}, landing_tier=landing_tier
        )
        for tmpl_id, role, old_ref, new_ref, reason in raw_rewrites:
            ref_rewrites.append({
                "template_id": tmpl_id,
                "role": role,
                "old": old_ref,
                "new": new_ref,
                "reason": reason,
            })

    return {
        "collisions": collisions,
        "new_aliases": sorted(new_aliases),
        "ref_rewrites": ref_rewrites,
        "settings_path": settings_path,
    }


def _read_current_models_and_pricing(settings_path: str | None) -> tuple[dict, dict]:
    """Read the target settings.json and return its (models, pricing.models)."""
    if not settings_path:
        return {}, {}
    sp = Path(settings_path)
    if not sp.exists():
        return {}, {}
    try:
        current_settings = json.loads(sp.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}, {}
    if not isinstance(current_settings, dict):
        return {}, {}
    worca_cfg = current_settings.get("worca") or {}
    if not isinstance(worca_cfg, dict):
        return {}, {}
    return (
        worca_cfg.get("models") or {},
        (worca_cfg.get("pricing") or {}).get("models") or {},
    )


def _resolve_settings_alias_collisions(
    bundle_models: dict | None,
    bundle_pricing: dict | None,
    settings_path: str | None,
    non_interactive: bool,
    on_conflict: str = "abort",
    resolutions: dict | None = None,
) -> tuple[dict | None, dict | None, dict[str, str]]:
    """Resolve per-alias collisions for incoming model and pricing entries.

    Three resolution actions per colliding alias:
      - ``skip``: drop the incoming entry; existing value retained.
      - ``overwrite``: replace the existing value with the incoming one,
        secrets included. Caller responsibility — the user explicitly chose it.
      - ``rename``: assign a zero-padded ``-NN`` suffix and rewrite every
        template ``config.agents.*.model`` reference to point at the new name.

    Returns ``(bundle_models, bundle_pricing, rename_map)``. The caller MUST
    apply ``rename_map`` to the templates BEFORE they are written via
    ``_rewrite_template_model_refs``.

    Resolution source-of-truth precedence:
      1. ``resolutions`` dict (per-alias UI/CLI overrides) takes precedence.
      2. ``on_conflict`` policy (CLI flag default) covers anything unresolved.
      3. Interactive prompt only when no resolutions AND ``not non_interactive``.
    """
    current_models, current_pricing_models = _read_current_models_and_pricing(settings_path)

    model_collisions = sorted(
        k for k, v in (bundle_models or {}).items()
        if k in current_models and current_models[k] != v
    )
    pricing_models_block = (bundle_pricing or {}).get("models") or {}
    pricing_collisions = sorted(
        k for k, v in pricing_models_block.items()
        if k in current_pricing_models and current_pricing_models[k] != v
    )

    rename_map: dict[str, str] = {}

    if not model_collisions and not pricing_collisions:
        return bundle_models, bundle_pricing, rename_map

    summary_parts = []
    if model_collisions:
        summary_parts.append(f"models: {', '.join(model_collisions)}")
    if pricing_collisions:
        summary_parts.append(f"pricing.models: {', '.join(pricing_collisions)}")
    print(
        f"warning: bundle collides with existing aliases — {'; '.join(summary_parts)}",
        file=sys.stderr,
    )

    resolutions = resolutions or {}
    taken = set(current_models.keys()) | set((bundle_models or {}).keys())

    def _resolve_one(alias: str) -> tuple[str, str | None]:
        """Return (action, new_name). action ∈ {skip, overwrite, rename}."""
        spec = resolutions.get(alias)
        if isinstance(spec, dict) and isinstance(spec.get("action"), str):
            action = spec["action"]
            new_name = spec.get("new_name")
            if action == "rename":
                if not isinstance(new_name, str) or not new_name:
                    new_name = _find_next_alias_name(alias, taken)
                if not new_name:
                    raise SystemExit(
                        f"error: rename for alias {alias!r} exhausted -01..-99 probe"
                    )
                if new_name in taken:
                    raise SystemExit(
                        f"error: rename target {new_name!r} for alias {alias!r} is already taken"
                    )
                taken.add(new_name)
                return "rename", new_name
            if action in ("skip", "overwrite"):
                return action, None
            raise SystemExit(f"error: unknown action {action!r} for alias {alias!r}")

        if non_interactive:
            policy = on_conflict
            if policy == "abort":
                print(
                    f"error: model alias collision on {alias!r} with --on-model-conflict=abort",
                    file=sys.stderr,
                )
                raise SystemExit(1)
            if policy == "rename":
                new_name = _find_next_alias_name(alias, taken)
                if not new_name:
                    raise SystemExit(
                        f"error: rename for alias {alias!r} exhausted -01..-99 probe"
                    )
                taken.add(new_name)
                return "rename", new_name
            return policy, None

        while True:
            try:
                answer = input(
                    f"alias {alias!r} collides — [s]kip / [o]verwrite / [r]ename / [a]bort? "
                )
            except EOFError:
                print(
                    f"  no stdin: defaulting to {on_conflict!r} for alias {alias!r}",
                    file=sys.stderr,
                )
                if on_conflict == "abort":
                    raise SystemExit(1)
                if on_conflict == "rename":
                    new_name = _find_next_alias_name(alias, taken)
                    if not new_name:
                        raise SystemExit(1)
                    taken.add(new_name)
                    return "rename", new_name
                return on_conflict, None
            choice = answer.strip().lower()
            if choice.startswith("a"):
                print("aborted", file=sys.stderr)
                raise SystemExit(1)
            if choice.startswith("s"):
                return "skip", None
            if choice.startswith("o"):
                return "overwrite", None
            if choice.startswith("r"):
                new_name = _find_next_alias_name(alias, taken)
                if not new_name:
                    print(
                        f"  rename for {alias!r} exhausted -01..-99 probe",
                        file=sys.stderr,
                    )
                    continue
                taken.add(new_name)
                return "rename", new_name
            print(
                f"  unrecognized choice {answer!r} — enter s, o, r, or a",
                file=sys.stderr,
            )

    all_collisions = sorted(set(model_collisions) | set(pricing_collisions))
    decisions: dict[str, tuple[str, str | None]] = {}
    for alias in all_collisions:
        decisions[alias] = _resolve_one(alias)

    new_models = dict(bundle_models or {})
    new_pricing_models = dict(pricing_models_block)
    for alias, (action, new_name) in decisions.items():
        if action == "skip":
            new_models.pop(alias, None)
            new_pricing_models.pop(alias, None)
        elif action == "overwrite":
            pass  # entry stays under its original key, will overwrite on merge
        elif action == "rename":
            rename_map[alias] = new_name
            if alias in new_models:
                new_models[new_name] = new_models.pop(alias)
            if alias in new_pricing_models:
                new_pricing_models[new_name] = new_pricing_models.pop(alias)
            print(
                f"  renamed alias {alias!r} -> {new_name!r}",
                file=sys.stderr,
            )

    out_models: dict | None = new_models if new_models else None
    out_pricing = bundle_pricing
    if out_pricing is not None:
        out_pricing = {**out_pricing, "models": new_pricing_models}
    return out_models, out_pricing, rename_map


def _collect_placeholder_paths(obj, path: str, out: list[str]) -> None:
    """Walk obj; append every JSON path whose string value matches any
    entry in SECRET_PLACEHOLDERS.
    """
    if isinstance(obj, str):
        if is_secret_placeholder(obj):
            out.append(path)
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            _collect_placeholder_paths(v, f"{path}.{k}" if path else k, out)
        return
    if isinstance(obj, list):
        for i, item in enumerate(obj):
            _collect_placeholder_paths(item, f"{path}[{i}]", out)


def _write_models_to_user_settings(path: str | None, settings_patch: dict) -> None:
    """Deep-merge ``{worca: settings_patch}`` into the user-global settings.json
    atomically. Creates ``~/.worca/`` if missing. No-op when ``path`` is None.
    """
    if not path or not settings_patch:
        return
    sp = Path(path)
    sp.parent.mkdir(parents=True, exist_ok=True)
    if sp.exists():
        try:
            current = json.loads(sp.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            current = {}
    else:
        current = {}
    patched = deep_merge(current, {"worca": settings_patch})
    _atomic_write_json(str(sp), patched)


def _atomic_write_json(path: str, data: dict) -> None:
    """Atomically write JSON to path via tempfile + os.replace."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp-", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _maybe_rewrite_default_pointer(
    settings_path: str | None,
    old_tier: str,
    old_id: str,
    new_tier: str,
    new_id: str,
) -> bool:
    """Rewrite worca.default_template if it points at (old_tier, old_id).

    No-op when the file is missing, the key is absent, or the pointer
    doesn't match (old_tier, old_id). Returns True if rewritten.
    """
    if not settings_path:
        return False
    sp = Path(settings_path)
    if not sp.exists():
        return False
    try:
        data = json.loads(sp.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return False
    worca = data.get("worca")
    if not isinstance(worca, dict):
        return False
    default_tpl = worca.get("default_template")
    if not isinstance(default_tpl, dict):
        return False
    if default_tpl.get("tier") != old_tier or default_tpl.get("id") != old_id:
        return False
    data["worca"]["default_template"] = {"tier": new_tier, "id": new_id}
    _atomic_write_json(str(sp), data)
    return True


def cmd_templates_delete(args):
    """worca templates delete <id> — remove a project or user template."""
    resolver = _make_resolver(getattr(args, "project_root", None))
    scope = "user" if args.global_ else "project"
    template_id = args.template_id

    from worca.orchestrator.templates import TemplateError
    try:
        resolver.delete(template_id, scope=scope)
    except TemplateError as e:
        print(f"error: {e}", file=sys.stderr)
        raise SystemExit(1)

    tier_label = "user" if scope == "user" else "project"
    print(f"deleted {tier_label} template '{template_id}'")


def cmd_templates_validate(args):
    """worca templates validate --config <json> — validate template config without saving.

    Validates a template config by simulating the merge with current settings and
    running validation rules. Returns a JSON array of validation issues.

    Output format:
    [
      {
        "field": "agents.planner.model",
        "severity": "error" | "warning",
        "message": "error description"
      },
      ...
    ]
    """
    config = args.config
    if config is None:
        print("error: --config is required", file=sys.stderr)
        raise SystemExit(1)

    try:
        merged_config = json.loads(config) if isinstance(config, str) else json.loads(str(config))
    except json.JSONDecodeError as e:
        print(f"error: invalid JSON in --config: {e}", file=sys.stderr)
        raise SystemExit(1) from e

    # worca.models is a cross-template, project-owned key — it is never stored in
    # a template's config but always applies at run launch (the template strip
    # keeps it). Merge the project's resolved models into the config before
    # validating so model aliases defined in project settings (e.g. a custom
    # `glm-ds`) validate the same way they resolve at runtime. Without this every
    # agents.*.model referencing a project alias false-warns "not defined in
    # worca.models". Config-provided models win on key collision.
    if isinstance(merged_config, dict):
        project_models = _resolve_project_models(getattr(args, "project_root", None))
        if project_models:
            existing = merged_config.get("models")
            existing = existing if isinstance(existing, dict) else {}
            merged_config["models"] = {**project_models, **existing}

    # Delegate to the shared validator so the rules stay in one place.
    from worca.orchestrator.templates import validate_merged_config

    issues = validate_merged_config(merged_config)
    print(json.dumps(issues, indent=2))


def _resolve_project_models(project_root: str | None) -> dict:
    """Resolve the project's ``worca.models`` (global ⊕ project ⊕ local merge).

    ``worca.models`` is cross-template (project-owned), so template validation
    must see it or aliases defined in project settings false-warn. Best-effort:
    returns ``{}`` if settings can't be read. Mirrors the runtime resolution via
    ``load_settings_with_global_fallback`` (which also folds in the gitignored
    ``settings.local.json`` where per-model env overrides live).
    """
    from worca.utils.settings import load_settings_with_global_fallback

    base = project_root if project_root else "."
    settings_path = os.path.join(base, ".claude", "settings.json")
    try:
        settings = load_settings_with_global_fallback(settings_path)
    except Exception:
        return {}
    models = settings.get("worca", {}).get("models", {})
    return models if isinstance(models, dict) else {}


def cmd_templates_duplicate(args):
    """worca templates duplicate <src_id> --dst <dst_id> --dst-scope <scope>

    Clone a template from any tier to a project or user scope.

    Args:
        src_id: Template ID to copy from (resolves from any tier: project → user → builtin)
        --dst: Destination template ID
        --dst-scope: Destination scope (project or user)

    Raises:
        TemplateError(builtin_conflict): if dst_id matches a built-in template
        TemplateError(name_collision): if dst_id exists in dst_scope
        TemplateError(not_found): if src_id not found
    """
    src_id = args.src_id
    dst_id = args.dst
    dst_scope = args.dst_scope

    resolver = _make_resolver(getattr(args, "project_root", None))

    try:
        resolver.duplicate(src_id, dst_id, dst_scope)
        tier_label = (
            "user (~/.worca/templates/)"
            if dst_scope == "user"
            else "project (.claude/templates/)"
        )
        print(f"duplicated '{src_id}' -> '{dst_id}' in {tier_label}")
    except TemplateError as e:
        if e.code == "validation_error" and e.details:
            print("error: template validation failed:", file=sys.stderr)
            _print_validation_details(e.details)
        else:
            print(f"error: {e}", file=sys.stderr)
        raise SystemExit(1)


def cmd_templates_rename(args):
    """worca templates rename — move a template to a new id/scope, rewriting any default-template pointer.

    Internally: duplicate → rewrite pointer → delete. If delete fails after
    duplicate succeeds, exits with code 3 and prints a `partial_rename`
    message to stderr so the server can surface the structured error.
    """
    src_id = args.src_id
    src_scope = args.src_scope
    dst_id = args.dst_id
    dst_scope = args.dst_scope
    project_root = getattr(args, "project_root", None)

    resolver = _make_resolver(project_root)

    try:
        resolver.duplicate(src_id, dst_id, dst_scope)
    except TemplateError as e:
        if e.code == "validation_error" and e.details:
            print("error: template validation failed:", file=sys.stderr)
            _print_validation_details(e.details)
        else:
            print(f"error: {e}", file=sys.stderr)
        raise SystemExit(1)

    # Rewrite pointer in both project and user settings so cross-tier renames
    # and either-side placements are handled without knowing which file holds it.
    project_settings = _find_settings_path("project")
    user_settings = _find_settings_path("user")
    for sp in [project_settings, user_settings]:
        _maybe_rewrite_default_pointer(sp, src_scope, src_id, dst_scope, dst_id)

    try:
        resolver.delete(src_id, src_scope)
    except TemplateError as e:
        msg = (
            f"partial_rename: Renamed to '{dst_id}' ({dst_scope}) but failed to remove "
            f"the source '{src_id}' ({src_scope}): {e}"
        )
        print(f"error: {msg}", file=sys.stderr)
        raise SystemExit(3)

    tier_labels = {
        "project": "project (.claude/templates/)",
        "user": "user (~/.worca/templates/)",
    }
    print(
        f"renamed '{src_id}' ({tier_labels.get(src_scope, src_scope)}) -> "
        f"'{dst_id}' ({tier_labels.get(dst_scope, dst_scope)})"
    )


def cmd_templates_advise(args):
    """worca templates advise — recommend the best-fit template for a work source."""
    from worca.template_advisor import TemplateAdvisorError, advise_to_json

    source_type = args.advise_source_type
    source_value = args.advise_source_value
    if source_value == "-":
        source_value = sys.stdin.read()

    project_root = getattr(args, "project_root", None) or os.getcwd()
    try:
        json_text = advise_to_json(
            source_type=source_type,
            source_value=source_value,
            project_root=project_root,
            model_alias=args.advise_model,
            timeout=args.advise_timeout,
        )
    except TemplateAdvisorError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
    print(json_text)


def cmd_templates(args):
    """Dispatch worca templates subcommand."""
    if not args.templates_command:
        print("error: specify a templates subcommand: list, show, save, create, delete, export, import, validate, duplicate, rename, advise", file=sys.stderr)
        raise SystemExit(1)
    if args.templates_command == "list":
        cmd_templates_list(args)
    elif args.templates_command == "show":
        cmd_templates_show(args)
    elif args.templates_command == "save":
        cmd_templates_save(args)
    elif args.templates_command == "create":
        cmd_templates_create(args)
    elif args.templates_command == "delete":
        cmd_templates_delete(args)
    elif args.templates_command == "export":
        cmd_templates_export(args)
    elif args.templates_command == "import":
        cmd_templates_import(args)
    elif args.templates_command == "validate":
        cmd_templates_validate(args)
    elif args.templates_command == "duplicate":
        cmd_templates_duplicate(args)
    elif args.templates_command == "rename":
        cmd_templates_rename(args)
    elif args.templates_command == "advise":
        cmd_templates_advise(args)
    else:
        print(f"error: unknown templates subcommand {args.templates_command!r}", file=sys.stderr)
        raise SystemExit(1)
