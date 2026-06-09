"""CLI subcommand: worca models add <alias> <id> [--tier {user,project}] [--env K=V ...]"""

import json
import os
import sys
from pathlib import Path


def _find_project_root() -> Path | None:
    """Walk upward from cwd looking for a .git directory."""
    cwd = Path(os.getcwd()).resolve()
    for parent in [cwd, *cwd.parents]:
        if (parent / ".git").exists():
            return parent
    return None


def _project_settings_path() -> Path | None:
    root = _find_project_root()
    if root is None:
        return None
    return root / ".claude" / "settings.json"


def _global_settings_path() -> str:
    from worca.utils.settings import _default_global_path
    return _default_global_path()


def _read_json(path: str) -> dict:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def _local_path_for(settings_path: str) -> str:
    root, ext = os.path.splitext(settings_path)
    return root + ".local" + ext


def _is_reserved(key: str) -> bool:
    from worca.utils.env import RESERVED_ENV_KEYS, RESERVED_PREFIXES
    return key in RESERVED_ENV_KEYS or any(key.startswith(p) for p in RESERVED_PREFIXES)


def register_subcommand(sub) -> None:
    models_parser = sub.add_parser("models", help="Manage worca model aliases")
    models_sub = models_parser.add_subparsers(dest="models_command")

    add_parser = models_sub.add_parser("add", help="Add or update a model alias")
    add_parser.add_argument("alias", help="Alias name (no colons)")
    add_parser.add_argument("id", help="Model ID (e.g. claude-sonnet-4-6)")
    add_parser.add_argument(
        "--tier",
        choices=["user", "project", "builtin"],
        default=None,
        help="Settings tier to write to (default: project if in a git repo, else user)",
    )
    add_parser.add_argument(
        "--env",
        action="append",
        metavar="KEY=VAL",
        default=None,
        help="Environment variable for this model (repeatable); goes to settings.local.json",
    )


def cmd_models(args) -> None:
    if not getattr(args, "models_command", None):
        print("error: specify a subcommand, e.g. 'worca models add <alias> <id>'", file=sys.stderr)
        raise SystemExit(1)

    if args.models_command == "add":
        _cmd_models_add(args)
    else:
        print(f"error: unknown models subcommand {args.models_command!r}", file=sys.stderr)
        raise SystemExit(1)


def _cmd_models_add(args) -> None:
    alias = args.alias
    model_id = args.id
    tier = args.tier
    env_pairs = args.env or []

    # --- Reject builtin tier ---
    if tier == "builtin":
        print("error: built-in models are not user-writable", file=sys.stderr)
        raise SystemExit(1)

    # --- Reject colon in alias ---
    if ":" in alias:
        print(
            f"error: alias name cannot contain colon: '{alias}'. "
            "Use 'tier:alias' only in agent model references, not as a models key.",
            file=sys.stderr,
        )
        raise SystemExit(1)

    # --- Parse --env pairs ---
    env: dict[str, str] = {}
    for pair in env_pairs:
        if "=" not in pair:
            print(f"error: --env value must be KEY=VAL, got {pair!r}", file=sys.stderr)
            raise SystemExit(1)
        k, v = pair.split("=", 1)
        if _is_reserved(k):
            print(
                f"error: env key '{k}' is reserved and cannot be set via --env",
                file=sys.stderr,
            )
            raise SystemExit(1)
        env[k] = v

    # --- Resolve tier ---
    if tier is None:
        tier = "project" if _find_project_root() is not None else "user"

    # --- Resolve settings paths ---
    if tier == "project":
        project_path = _project_settings_path()
        if project_path is None:
            print(
                "error: could not find a .git-rooted project directory; "
                "use --tier user or run from a git repository",
                file=sys.stderr,
            )
            raise SystemExit(1)
        settings_path = str(project_path)
    else:
        settings_path = _global_settings_path()

    # --- Write settings.json (id side) ---
    base = _read_json(settings_path)
    base.setdefault("worca", {}).setdefault("models", {})
    base["worca"]["models"][alias] = {"id": model_id} if env else model_id
    _write_json(settings_path, base)

    # --- Write settings.local.json (env side) ---
    local_path = _local_path_for(settings_path)
    local = _read_json(local_path)
    local.setdefault("worca", {}).setdefault("models", {})
    if env:
        local["worca"]["models"][alias] = {"env": env}
        _write_json(local_path, local)
    else:
        # Remove any stale env entry if overwriting with no-env
        if alias in local.get("worca", {}).get("models", {}):
            del local["worca"]["models"][alias]
            _write_json(local_path, local)

    print(f"ok: wrote '{alias}' to {tier} settings ({settings_path})")
