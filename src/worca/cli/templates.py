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
    build_export_manifest,
    collect_referenced_model_aliases,
    fetch_bundle,
    redact_bundle,
    validate_bundle,
)
from worca.orchestrator.templates import (
    TemplateError,
    TemplateResolver,
)
from worca.utils.env import filter_model_env
from worca.utils.settings import deep_merge


def _resolve_dirs(project_root: str | None = None):
    """Return (builtin_dir, project_dir, user_dir) for TemplateResolver.

    Resolution order for the project root:
      1. explicit `project_root` arg (passed via `--project-root` from
         non-git callers like worca-ui's templates-routes shim)
      2. nearest ancestor of cwd that contains a `.git/` directory
      3. cwd itself (so the CLI is usable outside a git repo, e.g. when
         worca-ui runs against a plain directory)

    builtin_dir: `.claude/worca/templates/` under the resolved root if it
                 exists, else the installed package's `src/worca/templates/`.
    project_dir: `.claude/templates/` under the resolved root.
    user_dir:    `~/.worca/templates/` (honors `$WORCA_HOME` via Path.home).
    """
    if project_root:
        resolved_root = Path(project_root).resolve()
    else:
        cwd = Path.cwd().resolve()
        resolved_root = cwd
        for parent in [cwd, *cwd.parents]:
            if (parent / ".git").exists():
                resolved_root = parent
                break

    candidate_builtin = resolved_root / ".claude" / "worca" / "templates"
    if candidate_builtin.is_dir():
        builtin_dir = candidate_builtin
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

    return templates_parser


def _load_current_worca_config() -> dict:
    """Read worca config from .claude/settings.json if it exists, else return empty dict."""
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


def _atomic_import(templates, settings_patch, target_dir, settings_path):
    """Two-phase import: stage to tmpdir, then commit with full rollback.

    Rollback model:
      1. Stage everything to a tmpdir (no target mutation yet).
      2. For each template that would replace an existing dst, rename the
         existing dst aside to `<dst>.bak-<rand>`. Same for settings.json.
      3. Copy staged templates into place. Then os.replace settings.json.
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
    `settings.json` in the SAME parent directory as the target, not in the
    system tempdir. Template directories can keep staging in the system
    tempdir because `shutil.copytree` is a file-by-file copy (no rename),
    which handles cross-device natively. Same pattern as `state/status.py`
    and `cli/init.py`.
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
    # Settings staging file lives next to the target (see docstring). Tracked
    # separately so the finally block can sweep it on rollback / mid-commit
    # failure without relying on the system-tempdir cleanup.
    staged_settings_local: Path | None = None

    def _bak_name(p: Path) -> Path:
        return p.with_name(p.name + f".bak-{uuid.uuid4().hex[:8]}")

    try:
        # ---- Stage (no target mutation) ----
        for tmpl_id, tmpl_data in templates.items():
            staged_dir = staging / "templates" / tmpl_id
            staged_dir.mkdir(parents=True)
            (staged_dir / "template.json").write_text(
                json.dumps(tmpl_data, indent=2), encoding="utf-8"
            )

        # Serialize the patched settings now (early failure on JSON errors)
        # but defer the file write to the commit phase so it lands in the
        # target's directory — required for same-FS os.replace below.
        new_settings_text: str | None = None
        if settings_patch and settings_path:
            sp = Path(settings_path)
            if sp.exists():
                current = json.loads(sp.read_text(encoding="utf-8"))
            else:
                current = {}
            patched = deep_merge(current, {"worca": settings_patch})
            new_settings_text = json.dumps(patched, indent=2)

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

            if new_settings_text is not None and settings_path:
                sp = Path(settings_path)
                # Ensure the target's parent exists before staging next to it.
                # In normal usage this is always `.claude/`, which the caller
                # guarantees exists, but be defensive.
                sp.parent.mkdir(parents=True, exist_ok=True)
                if sp.exists():
                    bak = _bak_name(sp)
                    shutil.copy2(str(sp), str(bak))
                    backups.append((sp, bak, "file"))
                # Stage in target's directory so os.replace is single-FS on
                # POSIX (no EXDEV) and Windows (no ERROR_NOT_SAME_DEVICE).
                # The hidden prefix keeps the staging file out of casual
                # `ls` and prevents tools watching the directory from
                # confusing it with a real settings.json.
                fd, tmp_name = tempfile.mkstemp(
                    prefix=".settings.json.import-",
                    suffix=".tmp",
                    dir=str(sp.parent),
                )
                staged_settings_local = Path(tmp_name)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(new_settings_text)
                os.replace(str(staged_settings_local), str(sp))
                staged_settings_local = None  # consumed by os.replace
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
        # Sweep any staged-next-to-target settings file that wasn't consumed
        # (write failure, os.replace failure, or pre-replace exception).
        # Required so the rollback-leftover assertion `no .bak-* siblings`
        # also holds for our import-staging file.
        if staged_settings_local is not None:
            try:
                staged_settings_local.unlink()
            except OSError:
                pass
        shutil.rmtree(staging, ignore_errors=True)


def cmd_templates_export(args):
    """worca templates export --to <path|gist> — export templates as a bundle."""
    resolver = _make_resolver(getattr(args, "project_root", None))
    worca_config = _load_current_worca_config()

    if args.templates_filter:
        template_ids = [tid.strip() for tid in args.templates_filter.split(",") if tid.strip()]
    else:
        all_templates = resolver.list()
        template_ids = [t.id for t in all_templates if t.tier != "builtin"]

    templates = []
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
            "config": tmpl.config,
        }
        if tmpl.params:
            entry["params"] = tmpl.params
        templates.append(entry)

    all_models = worca_config.get("models") or {}
    referenced_aliases = collect_referenced_model_aliases(templates, all_models)

    models = None
    if args.include_models:
        models, _ = _filter_models_by_aliases(
            all_models, referenced_aliases, direction="export"
        )

    pricing = None
    if args.include_pricing:
        pricing, _ = _filter_pricing_by_aliases(
            worca_config.get("pricing") or {}, referenced_aliases, direction="export"
        )

    manifest = build_export_manifest(templates, models=models, pricing=pricing)
    redacted, redacted_paths = redact_bundle(manifest)

    if redacted_paths:
        for rp in redacted_paths:
            print(f"info: redacted {rp}", file=sys.stderr)

    dest = args.to
    if dest in ("gist", "gist:public"):
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
    else:
        Path(dest).write_text(json.dumps(redacted, indent=2), encoding="utf-8")
        print(f"exported {len(templates)} template(s) to {dest}")


def cmd_templates_import(args):
    """worca templates import --from <source> — import templates from a bundle."""
    source = args.from_source
    scope = args.scope
    non_interactive = args.non_interactive

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

    resolver = _make_resolver(getattr(args, "project_root", None))
    _, project_dir, user_dir = _resolve_dirs()
    target_dir = user_dir if scope == "user" else project_dir
    if target_dir is None:
        print("error: not in a git repository — cannot determine project template directory", file=sys.stderr)
        raise SystemExit(1)

    to_import = {}
    skipped_ids = []
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
        if has_collision:
            if non_interactive:
                skipped_ids.append(tid)
                continue
            # Re-prompt on unrecognized input — the operation isn't reversible,
            # don't silently fall through to "skip".
            decided = False
            while not decided:
                try:
                    answer = input(
                        f"template '{tid}' already exists in {scope} scope. "
                        f"[r]eplace / [s]kip / [a]bort? "
                    )
                except EOFError:
                    # No stdin available (CI, piped run) — treat as skip and stop.
                    skipped_ids.append(tid)
                    decided = True
                    break
                choice = answer.strip().lower()
                if choice.startswith("a"):
                    print("aborted", file=sys.stderr)
                    raise SystemExit(1)
                if choice.startswith("r"):
                    to_import[tid] = tmpl
                    decided = True
                elif choice.startswith("s"):
                    skipped_ids.append(tid)
                    decided = True
                else:
                    print(
                        f"  unrecognized choice {answer!r} — enter r, s, or a",
                        file=sys.stderr,
                    )
        else:
            to_import[tid] = tmpl

    settings_patch: dict = {}
    settings_path = _find_settings_path(scope)

    # Filter bundle's models/pricing to aliases actually referenced by templates
    # that will land. Anything else is over-inclusion — it would silently
    # inject entries the user didn't ask for and may overwrite their existing
    # aliases. Mirror of the same filter on export.
    if bundle_models or bundle_pricing:
        imported_templates_list = list(to_import.values())
        all_bundle_models = bundle_models or {}
        referenced = collect_referenced_model_aliases(
            imported_templates_list, all_bundle_models
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

    # Detect per-alias collisions against the target's current settings and
    # let the user decide (or default to skip in non-interactive mode). This
    # mirrors the per-template collision UX rather than silently letting the
    # bundle overwrite local model/pricing definitions via deep_merge.
    bundle_models, bundle_pricing = _resolve_settings_alias_collisions(
        bundle_models, bundle_pricing, settings_path, non_interactive
    )

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

    try:
        _atomic_import(to_import, settings_patch, target_dir, settings_path)
    except Exception as e:
        print(f"error: import failed: {e}", file=sys.stderr)
        raise SystemExit(1)

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
    """Restrict `pricing.models` to entries in `referenced`; keep other
    top-level pricing keys (`server_tools`, `currency`, `last_updated`, ...)
    intact — they are project-wide context, not alias-specific.

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
    return result, dropped


def _resolve_settings_alias_collisions(
    bundle_models: dict | None,
    bundle_pricing: dict | None,
    settings_path: str | None,
    non_interactive: bool,
) -> tuple[dict | None, dict | None]:
    """For each alias the bundle would merge into `settings.worca.models` or
    `settings.worca.pricing.models`, compare against the target's current
    value. Surface collisions (different values for the same key) and either
    skip them (non-interactive / EOF) or prompt for replace/skip/abort.

    No prompt is shown when collisions are absent. The reason this exists at
    all is that the underlying `deep_merge` lets bundle values silently
    overwrite local aliases — which is fine for additive merges but a real
    footgun when the bundle ships e.g. `opus: claude-opus-4-6` over a local
    `opus: claude-opus-4-7`.
    """
    current_models: dict = {}
    current_pricing_models: dict = {}
    if settings_path:
        sp = Path(settings_path)
        if sp.exists():
            try:
                current_settings = json.loads(sp.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                current_settings = {}
            worca_cfg = (current_settings.get("worca") or {}) if isinstance(current_settings, dict) else {}
            current_models = worca_cfg.get("models") or {}
            current_pricing_models = (worca_cfg.get("pricing") or {}).get("models") or {}

    model_collisions = sorted(
        k for k, v in (bundle_models or {}).items()
        if k in current_models and current_models[k] != v
    )
    pricing_models_block = (bundle_pricing or {}).get("models") or {}
    pricing_collisions = sorted(
        k for k, v in pricing_models_block.items()
        if k in current_pricing_models and current_pricing_models[k] != v
    )

    if not model_collisions and not pricing_collisions:
        return bundle_models, bundle_pricing

    summary_parts = []
    if model_collisions:
        summary_parts.append(f"models: {', '.join(model_collisions)}")
    if pricing_collisions:
        summary_parts.append(f"pricing.models: {', '.join(pricing_collisions)}")
    print(
        f"warning: bundle would overwrite existing values for {'; '.join(summary_parts)}",
        file=sys.stderr,
    )

    def _drop_collisions(bm, bp):
        if bm is not None:
            bm = {k: v for k, v in bm.items() if k not in model_collisions}
            if not bm:
                bm = None
        if bp is not None and isinstance(bp.get("models"), dict):
            new_pm = {k: v for k, v in bp["models"].items() if k not in pricing_collisions}
            bp = {**bp, "models": new_pm}
        return bm, bp

    if non_interactive:
        print(
            "  non-interactive: kept target's existing values, skipped bundle's overwrites",
            file=sys.stderr,
        )
        return _drop_collisions(bundle_models, bundle_pricing)

    while True:
        try:
            answer = input("[r]eplace all / [s]kip collided / [a]bort? ")
        except EOFError:
            print(
                "  no stdin: kept target's existing values, skipped bundle's overwrites",
                file=sys.stderr,
            )
            return _drop_collisions(bundle_models, bundle_pricing)
        choice = answer.strip().lower()
        if choice.startswith("a"):
            print("aborted", file=sys.stderr)
            raise SystemExit(1)
        if choice.startswith("r"):
            return bundle_models, bundle_pricing
        if choice.startswith("s"):
            return _drop_collisions(bundle_models, bundle_pricing)
        print(
            f"  unrecognized choice {answer!r} — enter r, s, or a",
            file=sys.stderr,
        )


def _collect_placeholder_paths(obj, path: str, out: list[str]) -> None:
    """Walk obj; append every JSON path whose string value equals SECRET_PLACEHOLDER."""
    if isinstance(obj, str):
        if obj == SECRET_PLACEHOLDER:
            out.append(path)
        return
    if isinstance(obj, dict):
        for k, v in obj.items():
            _collect_placeholder_paths(v, f"{path}.{k}" if path else k, out)
        return
    if isinstance(obj, list):
        for i, item in enumerate(obj):
            _collect_placeholder_paths(item, f"{path}[{i}]", out)


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

    # Delegate to the shared validator so the rules stay in one place.
    from worca.orchestrator.templates import validate_merged_config

    issues = validate_merged_config(merged_config)
    print(json.dumps(issues, indent=2))


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


def cmd_templates(args):
    """Dispatch worca templates subcommand."""
    if not args.templates_command:
        print("error: specify a templates subcommand: list, show, save, create, delete, export, import, validate, duplicate", file=sys.stderr)
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
    else:
        print(f"error: unknown templates subcommand {args.templates_command!r}", file=sys.stderr)
        raise SystemExit(1)
