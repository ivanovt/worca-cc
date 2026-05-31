"""Template resolver and utility functions for pipeline templates."""

import copy
import json
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

# Keys under `worca.*` that are owned by the selected template at run launch.
# When a template is in play (explicit at launch or resolved from
# worca.default_template), these are stripped from the project-settings merge
# base BEFORE the template's config applies. Result: a shared template behaves
# identically across machines until explicitly edited.
#
# Keys NOT in this list (worca.models, worca.webhooks, worca.pricing,
# worca.governance.guards, worca.graphify, worca.code_review_graph,
# stages.preflight.checks, etc.) stay cross-template — they're project-machine
# concerns (creds, infra, integrations) that should be the same for every
# template the project runs.
TEMPLATE_OWNED_KEYS: list[tuple[str, ...]] = [
    ("agents",),
    ("stages",),
    ("loops",),
    ("circuit_breaker",),
    ("effort",),
    ("governance", "dispatch"),
]


def strip_template_owned(worca_settings: dict) -> dict:
    """Return a deep-copy of worca_settings with every TEMPLATE_OWNED_KEYS path removed.

    Called by run launch before a template's config is deep-merged in, so
    project Settings can't leak template-driven keys into the merge base.
    Missing intermediate paths are skipped silently — a clean project that
    never customized any of these keys is a no-op.
    """
    result = copy.deepcopy(worca_settings)
    for path in TEMPLATE_OWNED_KEYS:
        node = result
        for segment in path[:-1]:
            if not isinstance(node, dict) or segment not in node:
                node = None
                break
            node = node[segment]
        if isinstance(node, dict) and path[-1] in node:
            del node[path[-1]]
    return result


@dataclass
class TemplateSummary:
    id: str
    name: str
    description: str
    builtin: bool
    tags: list
    created_at: str
    tier: str  # "builtin" | "project" | "user"


@dataclass
class Template:
    id: str
    name: str
    description: str
    builtin: bool
    created_at: str
    tags: list
    params: dict
    config: dict
    agents_dir: str | None
    source_dir: str
    tier: str  # "builtin" | "project" | "user"


class TemplateError(Exception):
    def __init__(self, message, code, details=None):
        super().__init__(message)
        self.code = code
        self.details = details


def deep_merge_config(base: dict, overlay: dict) -> dict:
    """Deep-merge overlay into base. Overlay values win for scalars.

    Dicts are merged recursively unless overlay has '__replace__': True,
    in which case the overlay replaces the base key wholesale.
    """
    result = base.copy()
    for key, value in overlay.items():
        if key == "__replace__":
            continue
        if isinstance(value, dict) and not value.get("__replace__"):
            if key in result and isinstance(result[key], dict):
                result[key] = deep_merge_config(result[key], value)
            else:
                clean = {k: v for k, v in value.items() if k != "__replace__"}
                result[key] = clean
        else:
            if isinstance(value, dict):
                result[key] = {k: v for k, v in value.items() if k != "__replace__"}
            else:
                result[key] = value
    return result


class TemplateResolver:
    def __init__(self, builtin_dir, project_dir, user_dir):
        """
        builtin_dir: src/worca/templates/ (from installed package)
        project_dir: .claude/templates/ (project-local)
        user_dir:    ~/.worca/templates/ (user-global)
        All arguments may be None or non-existent paths.
        """
        self._builtin_dir = Path(builtin_dir) if builtin_dir else None
        self._project_dir = Path(project_dir) if project_dir else None
        self._user_dir = Path(user_dir) if user_dir else None

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _scan_tier(self, tier_dir: Path | None, tier: str) -> list[TemplateSummary]:
        """Scan a tier directory and return TemplateSummary objects for valid templates."""
        if tier_dir is None or not tier_dir.is_dir():
            return []
        summaries = []
        for subdir in sorted(tier_dir.iterdir()):
            if not subdir.is_dir():
                continue
            manifest = subdir / "template.json"
            if not manifest.is_file():
                continue
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            try:
                summaries.append(TemplateSummary(
                    id=data["id"],
                    name=data.get("name", data["id"]),
                    description=data.get("description", ""),
                    builtin=data.get("builtin", tier == "builtin"),
                    tags=data.get("tags", []),
                    created_at=data.get("created_at", ""),
                    tier=tier,
                ))
            except (KeyError, TypeError):
                continue
        return summaries

    def _load_template(self, tmpl_dir: Path, tier: str) -> Template | None:
        """Load a Template object from a template directory."""
        manifest = tmpl_dir / "template.json"
        if not manifest.is_file():
            return None
        try:
            data = json.loads(manifest.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        try:
            agents_path = tmpl_dir / "agents"
            agents_dir = str(agents_path) if agents_path.is_dir() else None
            return Template(
                id=data["id"],
                name=data.get("name", data["id"]),
                description=data.get("description", ""),
                builtin=data.get("builtin", tier == "builtin"),
                created_at=data.get("created_at", ""),
                tags=data.get("tags", []),
                params=data.get("params", {}),
                config=data.get("config", {}),
                agents_dir=agents_dir,
                source_dir=str(tmpl_dir),
                tier=tier,
            )
        except (KeyError, TypeError):
            return None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def list(self) -> list[TemplateSummary]:
        """Return all templates across all tiers, deduplicated by ID.

        Priority: project > user > builtin (highest wins on collision).
        Sort order: builtins alpha, project alpha, user newest-first.
        """
        builtins = self._scan_tier(self._builtin_dir, "builtin")
        projects = self._scan_tier(self._project_dir, "project")
        users = self._scan_tier(self._user_dir, "user")

        # Collect seen IDs in priority order (highest priority first)
        seen: dict[str, TemplateSummary] = {}

        # Project templates sorted alphabetically
        for t in sorted(projects, key=lambda t: t.id):
            seen.setdefault(t.id, t)

        # User templates sorted newest-first
        users_sorted = sorted(users, key=lambda t: t.created_at, reverse=True)
        for t in users_sorted:
            seen.setdefault(t.id, t)

        # Builtin templates sorted alphabetically
        for t in sorted(builtins, key=lambda t: t.id):
            seen.setdefault(t.id, t)

        # Output order: builtins alpha, then project alpha, then user newest-first
        result_builtins = sorted(
            [t for t in seen.values() if t.tier == "builtin"], key=lambda t: t.id
        )
        result_projects = sorted(
            [t for t in seen.values() if t.tier == "project"], key=lambda t: t.id
        )
        result_users = sorted(
            [t for t in seen.values() if t.tier == "user"],
            key=lambda t: t.created_at,
            reverse=True,
        )
        return result_builtins + result_projects + result_users

    def get(self, template_id: str) -> "Template | None":
        """Fetch a template by ID. Searches project > user > builtin."""
        for tier, tier_dir in [
            ("project", self._project_dir),
            ("user", self._user_dir),
            ("builtin", self._builtin_dir),
        ]:
            if tier_dir is None or not tier_dir.is_dir():
                continue
            tmpl_dir = tier_dir / template_id
            if tmpl_dir.is_dir():
                result = self._load_template(tmpl_dir, tier)
                if result is not None:
                    return result
        return None

    def snapshot_to_run(self, template_id: str, run_dir: str, params: dict | None = None) -> None:
        """Copy entire template directory to {run_dir}/template/ for traceability.
        Also writes a resolved-params.json with the param values used.
        """
        template = self.get(template_id)
        if template is None:
            raise TemplateError(
                f"Template '{template_id}' not found.",
                code="not_found",
                details={"template_id": template_id},
            )
        dest = Path(run_dir) / "template"
        shutil.copytree(template.source_dir, str(dest))
        resolved_params = {
            "template_id": template.id,
            "template_tier": template.tier,
            "params": params or {},
            "snapshot_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        (dest / "resolved-params.json").write_text(json.dumps(resolved_params, indent=2), encoding="utf-8")

    def save(self, template_data: dict, scope: str = "project") -> "Template":
        """Save a new template. scope is 'project' or 'user'.

        Validates all fields. Raises TemplateError(validation_error) with a
        details list if any field is invalid. Raises TemplateError(builtin_conflict)
        if the id matches a built-in template. Creates {scope_dir}/{id}/ and writes
        template.json with builtin=false and created_at set to now.
        """
        scope_dir = self._user_dir if scope == "user" else self._project_dir

        errors = []

        template_id = template_data.get("id", "")
        if not isinstance(template_id, str) or not re.match(r"^[a-z0-9\-]{1,64}$", template_id):
            errors.append({"field": "id", "message": f"id must match [a-z0-9-]{{1,64}}, got {template_id!r}"})

        name = template_data.get("name", "")
        if not isinstance(name, str) or not name or len(name) > 80:
            errors.append({"field": "name", "message": "name must be a non-empty string of max 80 chars"})

        tags = template_data.get("tags", [])
        if not isinstance(tags, list):
            errors.append({"field": "tags", "message": "tags must be a list"})
        elif len(tags) > 5:
            errors.append({"field": "tags", "message": f"max 5 tags allowed, got {len(tags)}"})
        else:
            for tag in tags:
                if not isinstance(tag, str) or not re.match(r"^[a-z0-9\-]{1,20}$", tag):
                    errors.append({"field": "tags", "message": f"tag {tag!r} must match [a-z0-9-]{{1,20}}"})

        config = template_data.get("config", {})
        if not isinstance(config, dict):
            errors.append({"field": "config", "message": "config must be a dict"})

        if errors:
            raise TemplateError(
                "Template validation failed.",
                code="validation_error",
                details=errors,
            )

        # Check for builtin ID conflict
        if self._builtin_dir is not None and (self._builtin_dir / template_id).is_dir():
            raise TemplateError(
                f"Cannot save template with built-in ID '{template_id}'.",
                code="builtin_conflict",
                details={"template_id": template_id},
            )

        scope_path = Path(scope_dir)
        scope_path.mkdir(parents=True, exist_ok=True)
        tmpl_dir = scope_path / template_id
        tmpl_dir.mkdir(parents=True, exist_ok=True)

        tier = "user" if scope == "user" else "project"
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        data = {
            "id": template_id,
            "name": name,
            "description": template_data.get("description", ""),
            "builtin": False,
            "created_at": now,
            "tags": tags,
            "params": template_data.get("params", {}),
            "config": config,
        }
        (tmpl_dir / "template.json").write_text(json.dumps(data, indent=2), encoding="utf-8")

        agents_path = tmpl_dir / "agents"
        return Template(
            id=template_id,
            name=name,
            description=data["description"],
            builtin=False,
            created_at=now,
            tags=tags,
            params=data["params"],
            config=config,
            agents_dir=str(agents_path) if agents_path.is_dir() else None,
            source_dir=str(tmpl_dir),
            tier=tier,
        )

    def delete(self, template_id: str, scope: str = "project") -> bool:
        """Delete a template directory. Cannot delete built-ins.

        Raises TemplateError(builtin) if template_id matches a built-in.
        Raises TemplateError(not_found) if not found in the given scope.
        """
        if self._builtin_dir is not None and (self._builtin_dir / template_id).is_dir():
            raise TemplateError(
                f"Cannot delete built-in template '{template_id}'.",
                code="builtin",
                details={"template_id": template_id},
            )

        scope_dir = self._user_dir if scope == "user" else self._project_dir
        if scope_dir is None:
            raise TemplateError(
                f"Template '{template_id}' not found.",
                code="not_found",
                details={"template_id": template_id},
            )

        tmpl_dir = Path(scope_dir) / template_id
        if not tmpl_dir.is_dir():
            raise TemplateError(
                f"Template '{template_id}' not found.",
                code="not_found",
                details={"template_id": template_id},
            )

        shutil.rmtree(tmpl_dir)
        return True

    def apply(self, template_id: str, current_worca: dict, params: dict | None = None) -> dict:
        """Deep-merge template config into current worca settings.

        Loads template via get(), renders {{param}} placeholders in config string
        values, then deep-merges into a copy of current_worca. Does not mutate
        either input.
        """
        template = self.get(template_id)
        if template is None:
            raise TemplateError(
                f"Template '{template_id}' not found.",
                code="not_found",
                details={"template_id": template_id},
            )
        rendered_config = _render_params_in_dict(template.config, params or {}, template.params)
        return deep_merge_config(current_worca, rendered_config)


def _render_params_in_dict(obj, params: dict, param_defs: dict):
    """Recursively render {{param}} placeholders in all string values of a dict."""
    if isinstance(obj, dict):
        return {k: _render_params_in_dict(v, params, param_defs) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_render_params_in_dict(item, params, param_defs) for item in obj]
    if isinstance(obj, str) and re.search(r"\{\{\w+\}\}", obj):
        return render_params(obj, params, param_defs)
    return obj


def render_params(content: str, params: dict, param_defs: dict) -> str:
    """Replace {{param_name}} placeholders in content with resolved values.

    Uses param_defs for defaults; params dict overrides defaults.
    Raises TemplateError if a required param without a default is missing,
    or if a placeholder has no corresponding entry in param_defs.
    """
    placeholders = re.findall(r"\{\{(\w+)\}\}", content)

    resolved = {}
    for name in set(placeholders):
        if name in params:
            resolved[name] = str(params[name])
        elif name in param_defs:
            defn = param_defs[name]
            if "default" in defn:
                resolved[name] = str(defn["default"])
            else:
                raise TemplateError(
                    f"Required template parameter '{name}' has no value and no default.",
                    code="validation_error",
                    details={"param": name},
                )
        else:
            raise TemplateError(
                f"Template parameter '{name}' is not defined in param_defs.",
                code="validation_error",
                details={"param": name},
            )

    result = content
    for name, value in resolved.items():
        result = result.replace("{{" + name + "}}", value)
    return result
