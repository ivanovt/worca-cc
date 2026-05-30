"""Bundle manifest build, redaction, validation, and fetch for template import/export."""

from __future__ import annotations

import copy
import json
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen

REDACTED_PLACEHOLDER = "<REDACTED>"

SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^sk-[a-zA-Z0-9_-]{20,}$"), "Anthropic/OpenAI API key"),
    (re.compile(r"^ghp_[a-zA-Z0-9]{36,}$"), "GitHub PAT (classic)"),
    (re.compile(r"^github_pat_[a-zA-Z0-9_]{20,}$"), "GitHub PAT (fine-grained)"),
    (re.compile(r"^xoxb-[a-zA-Z0-9-]+$"), "Slack bot token"),
    (re.compile(r"^xoxp-[a-zA-Z0-9-]+$"), "Slack user token"),
    (re.compile(r"^AKIA[A-Z0-9]{16}$"), "AWS access key"),
    (re.compile(r"^[a-fA-F0-9]{32,}$"), "hex secret (≥32 chars)"),
]


def build_export_manifest(
    templates: list[dict],
    models: dict | None = None,
    pricing: dict | None = None,
) -> dict:
    manifest: dict = {
        "worca_bundle_version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "templates": templates,
    }
    if models is not None:
        manifest["models"] = models
    if pricing is not None:
        manifest["pricing"] = pricing
    return manifest


def _is_secret(value: str) -> bool:
    return any(pat.search(value) for pat, _ in SECRET_PATTERNS)


def _walk_and_redact(
    obj: object, path: str, redacted_paths: list[str]
) -> object:
    if isinstance(obj, str):
        if _is_secret(obj):
            redacted_paths.append(path)
            return REDACTED_PLACEHOLDER
        return obj
    if isinstance(obj, dict):
        return {
            k: _walk_and_redact(v, f"{path}.{k}" if path else k, redacted_paths)
            for k, v in obj.items()
        }
    if isinstance(obj, list):
        return [
            _walk_and_redact(item, f"{path}[{i}]", redacted_paths)
            for i, item in enumerate(obj)
        ]
    return obj


def _strip_env_blocks(manifest: dict) -> list[str]:
    """Layer 1: structurally strip env keys from models and template agent configs.

    Returns the list of stripped JSON paths.
    """
    stripped: list[str] = []

    models = manifest.get("models")
    if isinstance(models, dict):
        for key, entry in models.items():
            if isinstance(entry, dict) and "env" in entry:
                del entry["env"]
                stripped.append(f"models.{key}.env")

    templates = manifest.get("templates")
    if isinstance(templates, list):
        for i, tmpl in enumerate(templates):
            agents = (tmpl.get("config") or {}).get("agents")
            if isinstance(agents, dict):
                for agent_name, agent_cfg in agents.items():
                    if isinstance(agent_cfg, dict) and "env" in agent_cfg:
                        del agent_cfg["env"]
                        stripped.append(
                            f"templates[{i}].config.agents.{agent_name}.env"
                        )

    return stripped


def redact_bundle(manifest: dict) -> tuple[dict, list[str]]:
    """Redact secrets from a bundle manifest.

    Two-layer strategy:
    1. Structural stripping of all env keys from models and template config agents.
    2. Value-level regex scan against SECRET_PATTERNS.

    Returns (redacted_manifest_copy, list_of_redacted_json_paths).
    The input manifest is never mutated.
    """
    result = copy.deepcopy(manifest)
    redacted_paths: list[str] = []

    redacted_paths.extend(_strip_env_blocks(result))

    result = _walk_and_redact(result, "", redacted_paths)

    if redacted_paths:
        result["_redacted"] = redacted_paths

    return result, redacted_paths


_MAX_BUNDLE_BYTES = 1024 * 1024  # 1 MiB

_GIST_RE = re.compile(r"^[a-f0-9]{20,}$")
_GIST_URL_RE = re.compile(r"^https://gist\.github\.com/[^/]+/([a-f0-9]{20,})$")


def fetch_bundle(source: str) -> dict:
    """Load a bundle JSON from a local file, HTTPS URL, or GitHub gist ID/URL."""
    gist_match = _GIST_URL_RE.match(source)
    if gist_match:
        return _fetch_gist(gist_match.group(1))

    if source.startswith("https://"):
        return _fetch_url(source)

    if _GIST_RE.match(source):
        return _fetch_gist(source)

    return json.loads(Path(source).read_text(encoding="utf-8"))


def _fetch_url(url: str) -> dict:
    req = Request(url)  # noqa: S310 — URL is user-provided source
    with urlopen(req) as resp:  # noqa: S310
        data = resp.read(_MAX_BUNDLE_BYTES + 1)
        if len(data) > _MAX_BUNDLE_BYTES:
            raise ValueError(f"bundle at {url} exceeds 1 MiB size limit")
        return json.loads(data)


def _fetch_gist(gist_id: str) -> dict:
    result = subprocess.run(
        ["gh", "gist", "view", gist_id, "--filename", "bundle.json", "--raw"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"gh gist view failed: {result.stderr.strip()}")
    return json.loads(result.stdout)


_KNOWN_TOP_KEYS = {
    "worca_bundle_version",
    "exported_at",
    "templates",
    "models",
    "pricing",
    "_redacted",
}

_ID_RE = re.compile(r"^[a-z0-9\-]{1,64}$")
_TAG_RE = re.compile(r"^[a-z0-9\-]{1,20}$")


def validate_bundle(manifest: dict) -> tuple[list[dict], list[str]]:
    """Validate a bundle manifest against the v1 schema.

    Returns (errors, warnings) where errors is a list of
    {"field": ..., "message": ...} dicts and warnings is a list of
    unknown top-level key names (preserved for additive-compat).
    """
    errors: list[dict] = []
    warnings: list[str] = []

    version = manifest.get("worca_bundle_version")
    if version != 1:
        errors.append({
            "field": "worca_bundle_version",
            "message": f"unsupported bundle version {version!r}, expected 1",
        })
        return errors, warnings

    templates = manifest.get("templates")
    if not isinstance(templates, list) or len(templates) == 0:
        errors.append({
            "field": "templates",
            "message": "templates must be a non-empty array",
        })
    else:
        for i, tmpl in enumerate(templates):
            prefix = f"templates[{i}]"

            tid = tmpl.get("id", "")
            if not isinstance(tid, str) or not _ID_RE.match(tid):
                errors.append({
                    "field": f"{prefix}.id",
                    "message": f"id must match [a-z0-9-]{{1,64}}, got {tid!r}",
                })

            name = tmpl.get("name", "")
            if not isinstance(name, str) or not name or len(name) > 80:
                errors.append({
                    "field": f"{prefix}.name",
                    "message": "name must be a non-empty string of max 80 chars",
                })

            tags = tmpl.get("tags", [])
            if not isinstance(tags, list):
                errors.append({
                    "field": f"{prefix}.tags",
                    "message": "tags must be a list",
                })
            elif len(tags) > 5:
                errors.append({
                    "field": f"{prefix}.tags",
                    "message": f"max 5 tags allowed, got {len(tags)}",
                })
            else:
                for tag in tags:
                    if not isinstance(tag, str) or not _TAG_RE.match(tag):
                        errors.append({
                            "field": f"{prefix}.tags",
                            "message": f"tag {tag!r} must match [a-z0-9-]{{1,20}}",
                        })

            config = tmpl.get("config", {})
            if not isinstance(config, dict):
                errors.append({
                    "field": f"{prefix}.config",
                    "message": "config must be a dict",
                })

    for key in manifest:
        if key not in _KNOWN_TOP_KEYS:
            warnings.append(key)

    return errors, warnings
