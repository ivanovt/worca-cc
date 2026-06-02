"""Template resolver and utility functions for pipeline templates."""

from __future__ import annotations

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
# worca.governance.guards, worca.graphify, worca.code_review_graph, etc.)
# stay cross-template — they're project-machine concerns (creds, infra,
# integrations) that should be the same for every template the project runs.
TEMPLATE_OWNED_KEYS: list[tuple[str, ...]] = [
    ("agents",),
    ("stages",),
    ("loops",),
    ("circuit_breaker",),
    ("effort",),
    ("governance", "dispatch"),
    # Approval gates (plan_approval / pr_approval / deploy_approval). Every
    # existing built-in already declares these per its intent; promoting the
    # block to template-owned closes the "teammate's Settings silently flips
    # my gates" gap and makes the template's gate posture explicit.
    ("milestones",),
]

# Nested paths that sit under a template-owned block but are themselves
# cross-template: stripped along with the parent, then restored from the
# project's Settings before the template's config applies. The template can
# still deep-merge over them (so a template that explicitly sets
# stages.preflight.enabled=false still wins), but project Settings values
# survive when the template doesn't touch them.
#
# stages.preflight: the preflight check list is a project-machine concern
# (what does THIS project need to pass before launching?) — not a template
# choice. Every template should respect the project's preflight setup unless
# it explicitly opts out.
CROSS_TEMPLATE_CARVEOUTS: list[tuple[str, ...]] = [
    ("stages", "preflight"),
]


def _get_at_path(d: dict, path: tuple[str, ...]):
    """Walk path; return the leaf value or None if any segment is missing."""
    node = d
    for segment in path:
        if not isinstance(node, dict) or segment not in node:
            return None
        node = node[segment]
    return node


def _set_at_path(d: dict, path: tuple[str, ...], value) -> None:
    """Set value at path, creating intermediate dicts as needed."""
    node = d
    for segment in path[:-1]:
        node = node.setdefault(segment, {})
    node[path[-1]] = value


def _delete_at_path(d: dict, path: tuple[str, ...]) -> None:
    """Delete the leaf at path; no-op if any segment is missing."""
    node = d
    for segment in path[:-1]:
        if not isinstance(node, dict) or segment not in node:
            return
        node = node[segment]
    if isinstance(node, dict) and path[-1] in node:
        del node[path[-1]]


def strip_template_owned(worca_settings: dict) -> dict:
    """Return a deep-copy of worca_settings with every TEMPLATE_OWNED_KEYS path
    removed, then restore CROSS_TEMPLATE_CARVEOUTS from the original.

    Called by run launch before a template's config is deep-merged in, so
    project Settings can't leak template-driven keys into the merge base.
    Cross-template carve-outs (e.g. stages.preflight) are preserved so they
    still flow through to the merged config — the template can still override
    them via deep-merge if it explicitly sets a value.

    Missing intermediate paths are skipped silently — a clean project that
    never customized any of these keys is a no-op.
    """
    # Snapshot carve-outs from the original settings BEFORE stripping.
    saved_carveouts: list[tuple[tuple[str, ...], object]] = []
    for path in CROSS_TEMPLATE_CARVEOUTS:
        value = _get_at_path(worca_settings, path)
        if value is not None:
            saved_carveouts.append((path, copy.deepcopy(value)))

    # Strip the template-owned paths.
    result = copy.deepcopy(worca_settings)
    for path in TEMPLATE_OWNED_KEYS:
        _delete_at_path(result, path)

    # Restore carve-outs so they survive into the template-merge base.
    for path, value in saved_carveouts:
        _set_at_path(result, path, value)

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


VALID_EFFORT_LEVELS = frozenset({"low", "medium", "high", "xhigh", "max"})


def validate_merged_config(merged: dict) -> list[dict]:
    """Run validation rules against an already-merged worca config.

    Single source of truth for the validation ruleset. Used by both
    `TemplateResolver.validate` (template + base settings → merge → check)
    and the CLI's `worca templates validate --config <json>` (caller has
    pre-merged config in hand).

    Returns a list of issues:
        {"field": <dot.path>, "severity": "error" | "warning", "message": <str>}

    "error" means a run with this config would break; "warning" is suspicious
    but legal (e.g. model alias falls back via `_DEFAULT_MODEL_MAP`).
    """
    from worca.orchestrator.stages import ALL_AGENTS
    from worca.utils.settings import _DEFAULT_MODEL_MAP

    issues: list[dict] = []
    if not isinstance(merged, dict):
        issues.append({
            "field": "",
            "severity": "error",
            "message": "config must be a JSON object",
        })
        return issues

    known_agents = {v for v in ALL_AGENTS if v is not None}
    agents_config = merged.get("agents", {}) if isinstance(merged.get("agents"), dict) else {}
    models_config = merged.get("models", {}) if isinstance(merged.get("models"), dict) else {}

    for agent_key in agents_config:
        if agent_key not in known_agents:
            issues.append({
                "field": f"agents.{agent_key}",
                "severity": "error",
                "message": (
                    f"Unknown agent '{agent_key}'. "
                    f"Must be one of: {sorted(known_agents)}"
                ),
            })

    for agent_name in known_agents:
        agent_data = agents_config.get(agent_name, {})
        if not isinstance(agent_data, dict):
            continue

        model = agent_data.get("model")
        if (
            model
            and isinstance(model, str)
            and model not in models_config
            and model not in ("opa", "oha")
            and model not in _DEFAULT_MODEL_MAP
        ):
            issues.append({
                "field": f"agents.{agent_name}.model",
                "severity": "warning",
                "message": (
                    f"Model alias '{model}' is not defined in worca.models "
                    "and not in default map (may be treated as a raw model ID)"
                ),
            })

        agent_effort = agent_data.get("effort")
        if agent_effort and agent_effort not in VALID_EFFORT_LEVELS:
            issues.append({
                "field": f"agents.{agent_name}.effort",
                "severity": "error",
                "message": (
                    f"Invalid effort level for {agent_name}: '{agent_effort}'. "
                    f"Must be one of: {sorted(VALID_EFFORT_LEVELS)}"
                ),
            })

    effort_config = merged.get("effort", {})
    if isinstance(effort_config, dict):
        auto_cap = effort_config.get("auto_cap")
        if auto_cap and auto_cap not in VALID_EFFORT_LEVELS:
            issues.append({
                "field": "effort.auto_cap",
                "severity": "error",
                "message": (
                    f"Invalid effort level for auto_cap: '{auto_cap}'. "
                    f"Must be one of: {sorted(VALID_EFFORT_LEVELS)}"
                ),
            })

        for agent_name, agent_effort in effort_config.items():
            if agent_name == "auto_cap" or not isinstance(agent_effort, dict):
                continue
            effort_level = agent_effort.get("effort")
            if effort_level and effort_level not in VALID_EFFORT_LEVELS:
                issues.append({
                    "field": f"effort.{agent_name}.effort",
                    "severity": "error",
                    "message": (
                        f"Invalid effort level for {agent_name}: '{effort_level}'. "
                        f"Must be one of: {sorted(VALID_EFFORT_LEVELS)}"
                    ),
                })

    return issues


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

    def validate(
        self, template_id: str, base_settings: dict, params: dict | None = None
    ) -> list[dict]:
        """Simulate apply() over base_settings (or {}); return a list of validation issues.

        Renders params, deep-merges the template config with base settings,
        then runs `validate_merged_config` on the merged result. Use
        `validate_merged_config` directly when the caller already has a
        merged config in hand (e.g. the CLI's interactive `--config` mode).

        Issue schema:
            {"field": <dot.path>, "severity": "error" | "warning", "message": <str>}
        """
        template = self.get(template_id)
        if template is None:
            raise TemplateError(
                f"Template '{template_id}' not found.",
                code="not_found",
                details={"template_id": template_id},
            )

        rendered_config = _render_params_in_dict(template.config, params or {}, template.params)
        merged = deep_merge_config(base_settings or {}, rendered_config)
        return validate_merged_config(merged)

    def duplicate(self, src_id: str, dst_id: str, dst_scope: str = "project") -> "Template":
        """Resolve src_id from any tier, write a copy to dst_scope as dst_id.

        Duplicating a built-in to project/user scope with the SAME id is
        the canonical "shadow a built-in to edit it" UX path — that is
        explicitly supported. `dst_scope` is already restricted to
        'project' or 'user', so there is no path by which `duplicate`
        can overwrite a built-in on disk.

        Args:
            src_id: Template id to copy from (resolves from any tier: project → user → builtin)
            dst_id: Id to assign to the copy in the destination scope
            dst_scope: "project" or "user" (builtin is not a valid destination)

        Returns:
            Template instance representing the copied template

        Raises:
            TemplateError(name_collision): if dst_id already exists in dst_scope
            TemplateError(not_found): if src_id not found
            TemplateError(validation_error): if dst_scope is invalid or unavailable
        """
        # Validate destination scope
        if dst_scope not in ("project", "user"):
            raise TemplateError(
                f"dst_scope must be 'project' or 'user', got {dst_scope!r}",
                code="validation_error",
                details={"dst_scope": dst_scope},
            )

        # Determine destination directory
        scope_dir = self._user_dir if dst_scope == "user" else self._project_dir
        if scope_dir is None:
            raise TemplateError(
                f"Destination scope '{dst_scope}' is not available.",
                code="validation_error",
                details={"dst_scope": dst_scope},
            )

        scope_path = Path(scope_dir)
        tmpl_dir = scope_path / dst_id

        # Check for name collision in target scope
        if tmpl_dir.is_dir():
            raise TemplateError(
                f"Template ID '{dst_id}' already exists in {dst_scope} scope.",
                code="name_collision",
                details={"template_id": dst_id, "scope": dst_scope},
            )

        # Load source template using existing get() method (resolves by priority)
        src_template = self.get(src_id)
        if src_template is None:
            raise TemplateError(
                f"Template '{src_id}' not found.",
                code="not_found",
                details={"template_id": src_id},
            )

        # Create destination directory
        scope_path.mkdir(parents=True, exist_ok=True)
        tmpl_dir.mkdir(parents=True, exist_ok=True)

        # Prepare destination template data - preserve all fields from source
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        dst_data = {
            "id": dst_id,
            "name": src_template.name,
            "description": src_template.description,
            "builtin": False,  # Duplicates are never built-in
            "created_at": now,
            "tags": list(src_template.tags),  # Copy tags
            "params": copy.deepcopy(src_template.params),  # Deep copy params
            "config": copy.deepcopy(src_template.config),  # Deep copy config
        }

        # Read the source template.json to preserve any custom fields
        source_manifest = Path(src_template.source_dir) / "template.json"
        if source_manifest.is_file():
            source_data = json.loads(source_manifest.read_text(encoding="utf-8"))
            # Preserve any additional fields not in our base set
            for key, value in source_data.items():
                if key not in ["id", "name", "description", "builtin", "created_at", "tags", "params", "config"]:
                    dst_data[key] = value

        # Write template.json
        (tmpl_dir / "template.json").write_text(json.dumps(dst_data, indent=2), encoding="utf-8")

        # Copy agents directory if present
        if src_template.agents_dir and Path(src_template.agents_dir).is_dir():
            src_agents_dir = Path(src_template.agents_dir)
            dest_agents_dir = tmpl_dir / "agents"
            if dest_agents_dir.is_dir():
                shutil.rmtree(dest_agents_dir)
            shutil.copytree(src_agents_dir, dest_agents_dir)

        # Return new Template instance
        tier = "user" if dst_scope == "user" else "project"
        agents_path = tmpl_dir / "agents"
        return Template(
            id=dst_id,
            name=dst_data["name"],
            description=dst_data["description"],
            builtin=False,
            created_at=now,
            tags=dst_data["tags"],
            params=dst_data["params"],
            config=dst_data["config"],
            agents_dir=str(agents_path) if agents_path.is_dir() else None,
            source_dir=str(tmpl_dir),
            tier=tier,
        )


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
