"""Bundle manifest build, redaction, validation, and fetch for template import/export.

Trust boundary (READ THIS BEFORE TOUCHING fetch_bundle):
    Imported bundles are config-as-data, not code-as-data. They are merged into
    settings.json and used to drive subsequent pipeline runs. **Only import
    bundles from sources you trust.** `fetch_bundle` hardens HTTPS fetches
    against obvious SSRF (private/loopback/link-local hosts, redirect chains)
    and caps response size, but cannot defend against a malicious bundle
    crafted by a trusted upstream. Treat bundle URLs the same way you'd treat
    a `curl | sh` URL: verify the author.
"""

from __future__ import annotations

import copy
import ipaddress
import json
import re
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import (
    HTTPRedirectHandler,
    HTTPSHandler,
    Request,
    build_opener,
)

# Placeholder used when redacting secret VALUES. Keys are always preserved so
# users importing the bundle can see what env vars are expected and fill in
# the correct secret locally.
SECRET_PLACEHOLDER = "<YOUR-SECRET-HERE>"

# Back-compat alias — old name kept for any external callers.
REDACTED_PLACEHOLDER = SECRET_PLACEHOLDER

SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"^sk-[a-zA-Z0-9_-]{20,}$"), "Anthropic/OpenAI API key"),
    (re.compile(r"^ghp_[a-zA-Z0-9]{36,}$"), "GitHub PAT (classic)"),
    (re.compile(r"^github_pat_[a-zA-Z0-9_]{20,}$"), "GitHub PAT (fine-grained)"),
    (re.compile(r"^xoxb-[a-zA-Z0-9-]+$"), "Slack bot token"),
    (re.compile(r"^xoxp-[a-zA-Z0-9-]+$"), "Slack user token"),
    (re.compile(r"^AKIA[A-Z0-9]{16}$"), "AWS access key"),
]
# NOTE: removed the hex-≥32 catch-all. It false-positived on SHA-1/256 hashes,
# UUIDs-without-dashes, and content-addressed cache keys (worca's $WORCA_CACHE
# layout literally uses 40-hex commit SHAs). Prefer false-negatives in favor of
# structural allowlisting + env-value redaction below.

# Identifier regex shared by validate_bundle and cli/templates (path-traversal guard).
ID_RE = re.compile(r"^[a-z0-9\-]{1,64}$")
_TAG_RE = re.compile(r"^[a-z0-9\-]{1,20}$")

# Allowlist of top-level keys permitted under `templates[*].config`. Everything
# else is stripped wholesale on export — even if it doesn't match a SECRET_PATTERN.
# This is the primary defense; SECRET_PATTERNS is a backstop.
#
# Rationale per key:
#   stages, agents, effort, loops, circuit_breaker — pipeline behavior, no secrets
#   models                                          — alias→id refs (top-level `models`
#                                                     map handles the alias→{id,env}
#                                                     definition separately)
#
# Deliberately EXCLUDED (and what they would carry):
#   webhooks       — HMAC signing keys, integration URLs with embedded tokens
#   integrations   — chat-platform bot tokens (Telegram/Discord/Slack)
#   governance     — may carry hook-side tokens or path secrets
#   graphify, crg  — require external packages to be installed on importer's
#                    machine; importing blind would silently change behavior
#                    once those packages are installed. Surface via a follow-up
#                    if/when we add a "requires" manifest.
CONFIG_ALLOWLIST: frozenset[str] = frozenset({
    "stages",
    "agents",
    "effort",
    "loops",
    "circuit_breaker",
    "models",
})


def collect_referenced_model_aliases(
    templates: list[dict], all_models: dict
) -> set[str]:
    """Set of `worca.models` aliases the given templates actually reference.

    Walks each template's `config.agents.*.model` value and returns the
    aliases that appear in `all_models`. Aliases not present in `all_models`
    are dropped silently (caller may surface them separately as typos).

    Why no recursion through the `id` field: `resolve_model()` in
    `worca.utils.settings` is a single non-recursive lookup that returns
    `entry["id"]` verbatim as the string passed to `claude --model …`.
    The `id` is a claude-CLI shorthand (`"opus"` / `"sonnet"` / `"haiku"`)
    or a full model ID — it is NOT another worca alias to be resolved.
    Similarly, pricing in `worca.utils.token_usage` uses the alias name
    directly as the lookup key, with no fallback to whatever the `id` points
    at. So `models["glm-ds"] = {"id": "opus", ...}` does not imply that
    `models["opus"]` is needed for glm-ds to function.

    Used by export to drop unreferenced entries from `worca.models` and
    `worca.pricing.models`, and by import to apply the symmetric filter
    against the bundle's contents.
    """
    referenced: set[str] = set()

    for tmpl in templates:
        if not isinstance(tmpl, dict):
            continue
        config = tmpl.get("config")
        if not isinstance(config, dict):
            continue
        agents = config.get("agents")
        if not isinstance(agents, dict):
            continue
        for agent_cfg in agents.values():
            if isinstance(agent_cfg, dict):
                model = agent_cfg.get("model")
                if isinstance(model, str) and model in all_models:
                    referenced.add(model)

    return referenced


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
    """Walk obj recursively; replace any string value matching SECRET_PATTERNS
    with SECRET_PLACEHOLDER. Dict KEYS are always preserved — only values
    are transformed. This keeps env-block scaffolds intact for the importer.
    """
    if isinstance(obj, str):
        if _is_secret(obj):
            redacted_paths.append(path)
            return SECRET_PLACEHOLDER
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


def _apply_config_allowlist(manifest: dict) -> list[str]:
    """For each template in `templates`, drop any key under `config` that isn't
    in CONFIG_ALLOWLIST. Returns the list of stripped JSON paths.

    This is structural — it doesn't inspect values. The allowlist is the
    safety net; SECRET_PATTERNS is the backstop for values that slip through.
    """
    stripped: list[str] = []
    templates = manifest.get("templates")
    if not isinstance(templates, list):
        return stripped

    for i, tmpl in enumerate(templates):
        config = tmpl.get("config")
        if not isinstance(config, dict):
            continue
        for key in list(config.keys()):
            if key not in CONFIG_ALLOWLIST:
                del config[key]
                stripped.append(f"templates[{i}].config.{key}")
    return stripped


def redact_bundle(manifest: dict) -> tuple[dict, list[str]]:
    """Redact secrets from a bundle manifest.

    Two-layer strategy:
      1. Structural allowlist on `templates[*].config.*` — only known-safe
         subtrees pass through; everything else (webhooks, integrations,
         governance, etc.) is removed wholesale. Tracked in `_stripped`.
      2. Value-level regex scan against SECRET_PATTERNS, applied to every
         string value remaining in the manifest. Matching values become
         SECRET_PLACEHOLDER; the corresponding env/config KEYS are preserved
         so the importer sees the scaffold. Tracked in `_redacted`.

    Returns (redacted_manifest_copy, list_of_redacted_json_paths).
    The input manifest is never mutated.
    """
    result = copy.deepcopy(manifest)

    stripped_paths = _apply_config_allowlist(result)

    redacted_paths: list[str] = []
    result = _walk_and_redact(result, "", redacted_paths)

    if redacted_paths:
        result["_redacted"] = redacted_paths
    if stripped_paths:
        result["_stripped"] = stripped_paths

    return result, redacted_paths


_MAX_BUNDLE_BYTES = 1024 * 1024  # 1 MiB

_GIST_RE = re.compile(r"^[a-f0-9]{20,}$")
_GIST_URL_RE = re.compile(r"^https://gist\.github\.com/[^/]+/([a-f0-9]{20,})$")


def fetch_bundle(source: str) -> dict:
    """Load a bundle JSON from a local file, HTTPS URL, or GitHub gist ID/URL.

    HTTPS sources are hardened against the obvious SSRF cases:
      * non-public hosts (private/loopback/link-local/reserved) are refused
        before connect, based on DNS resolution
      * HTTP redirects are blocked (the bundle URL you paste IS the bundle)
      * response is capped at 1 MiB

    These mitigations close common cases but cannot defend against a
    malicious upstream — see the module docstring's trust-boundary note.
    """
    gist_match = _GIST_URL_RE.match(source)
    if gist_match:
        return _fetch_gist(gist_match.group(1))

    if source.startswith("https://"):
        return _fetch_url(source)

    if _GIST_RE.match(source):
        return _fetch_gist(source)

    return json.loads(Path(source).read_text(encoding="utf-8"))


class _NoRedirectHandler(HTTPRedirectHandler):
    """Block all HTTP redirects on bundle fetches. The user typed the URL
    they want; following a 30x silently substitutes a different bundle."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError(
            f"refusing redirect from {req.full_url!r} to {newurl!r} "
            "(bundle URLs must resolve directly)"
        )


def _check_public_host(url: str) -> None:
    """Resolve `url`'s host and refuse private/loopback/link-local/reserved IPs.

    There's a TOCTOU here — urlopen does its own DNS resolution and a hostile
    resolver could return different answers. This blocks the obvious cases
    (`http://169.254.169.254/`, `https://localhost/`, `https://10.x.y.z/`)
    not the determined attacker.
    """
    parsed = urlparse(url)
    host = parsed.hostname
    if not host:
        raise ValueError(f"invalid URL: missing host in {url!r}")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise ValueError(f"could not resolve host {host!r}: {e}") from e
    for info in infos:
        ip_str = info[4][0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise ValueError(
                f"refusing to fetch from non-public host {host!r} "
                f"(resolved to {ip_str})"
            )


def _fetch_url(url: str) -> dict:
    _check_public_host(url)
    opener = build_opener(_NoRedirectHandler(), HTTPSHandler())
    req = Request(url)  # noqa: S310 — vetted by _check_public_host above
    with opener.open(req) as resp:  # noqa: S310
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
    "_stripped",
}


def _parse_bundle_version(v: object) -> tuple[int, int] | None:
    """Parse a worca_bundle_version into (major, minor) or return None if
    it isn't a recognizable shape. Accepts int 1, string '1', '1.0', '1.N'.
    """
    if isinstance(v, bool):
        return None  # bool is a subclass of int — guard explicitly
    if isinstance(v, int):
        return (v, 0)
    if isinstance(v, str):
        try:
            if "." in v:
                major_s, minor_s = v.split(".", 1)
                return (int(major_s), int(minor_s))
            return (int(v), 0)
        except ValueError:
            return None
    return None


# Major version this code understands. Future major bumps require a code change
# to the redactor/validator and explicit handling here.
SUPPORTED_BUNDLE_MAJOR = 1


def validate_bundle(manifest: dict) -> tuple[list[dict], list[str]]:
    """Validate a bundle manifest against the v1 schema.

    Returns (errors, warnings). errors is a list of
    {"field": ..., "message": ...} dicts; warnings is a list of strings.

    Forward-compat: accepts any minor revision of the supported major
    (1.0, 1.1, ...) with a warning when the minor differs from the major's
    canonical (.0); rejects other majors.
    """
    errors: list[dict] = []
    warnings: list[str] = []

    version_raw = manifest.get("worca_bundle_version")
    parsed = _parse_bundle_version(version_raw)
    if parsed is None or parsed[0] != SUPPORTED_BUNDLE_MAJOR:
        errors.append({
            "field": "worca_bundle_version",
            "message": (
                f"unsupported bundle version {version_raw!r}, "
                f"expected major version {SUPPORTED_BUNDLE_MAJOR}"
            ),
        })
        return errors, warnings
    if parsed[1] != 0:
        warnings.append(
            f"worca_bundle_version is {version_raw!r} (minor {parsed[1]}); "
            f"this importer is {SUPPORTED_BUNDLE_MAJOR}.0 — proceeding with "
            "forward-compat (unknown additive fields preserved)"
        )

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
            if not isinstance(tid, str) or not ID_RE.match(tid):
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
