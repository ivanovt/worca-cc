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
from pathlib import Path

from worca.orchestrator.bundle import (
    build_export_manifest,
    fetch_bundle,
    redact_bundle,
    validate_bundle,
)
from worca.orchestrator.templates import TemplateResolver
from worca.utils.env import filter_model_env
from worca.utils.settings import deep_merge


def _resolve_dirs():
    """Return (builtin_dir, project_dir, user_dir) for TemplateResolver.

    builtin_dir: .claude/worca/templates/ (runtime copy) when inside a project,
                 or src/worca/templates/ from the installed package outside a project
    project_dir: .claude/templates/ relative to git root (or None if not in a repo)
    user_dir:    ~/.worca/templates/
    """
    # Walk up to find git root
    git_root = None
    cwd = Path.cwd().resolve()
    for parent in [cwd, *cwd.parents]:
        if (parent / ".git").exists():
            git_root = parent
            break

    if git_root is not None:
        builtin_dir = git_root / ".claude" / "worca" / "templates"
        project_dir = git_root / ".claude" / "templates"
    else:
        builtin_dir = Path(__file__).parent.parent / "templates"
        project_dir = None

    user_dir = Path.home() / ".worca" / "templates"
    return builtin_dir, project_dir, user_dir


def _make_resolver():
    builtin_dir, project_dir, user_dir = _resolve_dirs()
    return TemplateResolver(builtin_dir, project_dir, user_dir)


def cmd_templates_list(args):
    """worca templates list — tabular output, or JSON when --json is passed."""
    resolver = _make_resolver()
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
    resolver = _make_resolver()
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
    resolver = _make_resolver()
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

    resolver = _make_resolver()
    scope = "user" if args.global_ else "project"

    try:
        template = resolver.save(template_data, scope=scope)
    except TemplateError as e:
        if e.code == "validation_error" and e.details:
            print("error: template validation failed:", file=sys.stderr)
            for detail in e.details:
                print(f"  - {detail['field']}: {detail['message']}", file=sys.stderr)
        else:
            print(f"error: {e}", file=sys.stderr)
        raise SystemExit(1)

    tier_label = "user (~/.worca/templates/)" if scope == "user" else "project (.claude/templates/)"
    print(f"created template '{template.id}' in {tier_label}")


def _find_settings_path() -> str | None:
    """Locate .claude/settings.json from git root, returning its path or None."""
    cwd = Path.cwd().resolve()
    for parent in [cwd, *cwd.parents]:
        if (parent / ".git").exists():
            return str(parent / ".claude" / "settings.json")
    return None


_SAFE_ID_RE = __import__("re").compile(r"^[a-z0-9\-]{1,64}$")


def _atomic_import(templates, settings_patch, target_dir, settings_path):
    """Two-phase import: stage to tmpdir, then commit atomically with rollback."""
    target_real = target_dir.resolve()
    for tmpl_id in templates:
        if not _SAFE_ID_RE.fullmatch(tmpl_id):
            raise ValueError(f"unsafe template id: {tmpl_id!r}")
        dst = (target_dir / tmpl_id).resolve()
        if not str(dst).startswith(str(target_real) + os.sep):
            raise ValueError(f"template id {tmpl_id!r} escapes target directory")

    staging = Path(tempfile.mkdtemp(prefix="worca-import-"))
    try:
        for tmpl_id, tmpl_data in templates.items():
            staged_dir = staging / "templates" / tmpl_id
            staged_dir.mkdir(parents=True)
            (staged_dir / "template.json").write_text(
                json.dumps(tmpl_data, indent=2), encoding="utf-8"
            )

        if settings_patch and settings_path:
            sp = Path(settings_path)
            if sp.exists():
                current = json.loads(sp.read_text(encoding="utf-8"))
            else:
                current = {}
            patched = deep_merge(current, {"worca": settings_patch})
            (staging / "settings.json").write_text(
                json.dumps(patched, indent=2), encoding="utf-8"
            )

        committed: list[Path] = []
        try:
            for tmpl_id in templates:
                src = staging / "templates" / tmpl_id
                dst = target_dir / tmpl_id
                if dst.exists():
                    shutil.rmtree(dst)
                shutil.copytree(str(src), str(dst))
                committed.append(dst)

            if (staging / "settings.json").exists() and settings_path:
                os.replace(str(staging / "settings.json"), settings_path)
        except Exception:
            for d in committed:
                shutil.rmtree(d, ignore_errors=True)
            raise
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def cmd_templates_export(args):
    """worca templates export --to <path|gist> — export templates as a bundle."""
    resolver = _make_resolver()
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

    models = worca_config.get("models") if args.include_models else None
    pricing = worca_config.get("pricing") if args.include_pricing else None

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

    if scope == "user" and (bundle_models or bundle_pricing):
        skipped_parts = []
        if bundle_models:
            skipped_parts.append("models")
        if bundle_pricing:
            skipped_parts.append("pricing")
        print(
            f"skipped: {', '.join(skipped_parts)} (user-scope import — no user-level settings.json)",
            file=sys.stderr,
        )
        bundle_models = None
        bundle_pricing = None

    resolver = _make_resolver()
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
        if has_collision:
            if non_interactive:
                skipped_ids.append(tid)
                continue
            try:
                answer = input(
                    f"template '{tid}' already exists in {scope} scope. "
                    f"[r]eplace / [s]kip / [a]bort? "
                )
            except EOFError:
                answer = "s"
            choice = answer.strip().lower()
            if choice.startswith("a"):
                print("aborted", file=sys.stderr)
                raise SystemExit(1)
            elif choice.startswith("r"):
                to_import[tid] = tmpl
            else:
                skipped_ids.append(tid)
        else:
            to_import[tid] = tmpl

    settings_patch: dict = {}
    settings_path = _find_settings_path()

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
        settings_patch["models"] = cleaned_models

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

    parts = [f"imported {len(to_import)} template(s)"]
    if bundle_models:
        parts.append(f"{len(bundle_models)} model(s)")
    if bundle_pricing:
        parts.append("pricing")
    summary = ", ".join(parts)
    if skipped_ids:
        summary += f" (skipped: {', '.join(skipped_ids)})"
    print(summary)


def cmd_templates_delete(args):
    """worca templates delete <id> — remove a project or user template."""
    resolver = _make_resolver()
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


def cmd_templates(args):
    """Dispatch worca templates subcommand."""
    if not args.templates_command:
        print("error: specify a templates subcommand: list, show, save, create, delete, export, import", file=sys.stderr)
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
    else:
        print(f"error: unknown templates subcommand {args.templates_command!r}", file=sys.stderr)
        raise SystemExit(1)
