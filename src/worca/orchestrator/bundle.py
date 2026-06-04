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
import io
import ipaddress
import json
import re
import shutil
import socket
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
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

# ---------------------------------------------------------------------------
# Zip bundle constants and error types (W-064 Phase 1)
# ---------------------------------------------------------------------------

# Magic bytes for ZIP local file header (empty-archive and spanned variants).
_ZIP_MAGIC = (b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")

_MAX_ZIP_UNCOMPRESSED_TOTAL = 4 * 1024 * 1024  # 4 MiB total uncompressed
_MAX_ZIP_FILE_SIZE = 256 * 1024                 # 256 KiB per file
_MAX_ZIP_ENTRIES = 64                           # max members in archive
_MAX_ZIP_RATIO = 100                            # max expansion ratio (zip bomb guard)

# Allowed overlay filenames: e.g. planner.md, plan.block.md, plan_reviewer.md
_OVERLAY_NAME_RE = re.compile(r"^[a-z0-9._-]{1,64}\.(md|block\.md)$")


class BundleError(ValueError):
    """Base class for bundle processing errors."""


class BundleLayoutError(BundleError):
    """Raised when a zip bundle fails layout or safety validation."""

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.details: dict = details or {}


def _safe_member_path(staging: Path, name: str) -> Path:
    """Return the resolved path of a zip member anchored under *staging*.

    Raises BundleLayoutError for backslashes, drive letters, absolute paths,
    parent-traversal components (`..`), or any path that escapes the staging root.
    """
    if "\\" in name:
        raise BundleLayoutError(
            f"absolute path not allowed: {name}",
            details={"member": name, "rule": "absolute_path"},
        )
    if ":" in name:
        raise BundleLayoutError(
            f"absolute path not allowed: {name}",
            details={"member": name, "rule": "absolute_path"},
        )
    p = PurePosixPath(name)
    if p.is_absolute():
        raise BundleLayoutError(
            f"absolute path not allowed: {name}",
            details={"member": name, "rule": "absolute_path"},
        )
    if any(part == ".." for part in p.parts):
        raise BundleLayoutError(
            f"parent traversal not allowed: {name}",
            details={"member": name, "rule": "parent_traversal"},
        )
    candidate = (staging / p).resolve()
    try:
        candidate.relative_to(staging.resolve())
    except ValueError:
        raise BundleLayoutError(
            f"path traversal: {name}",
            details={"member": name, "rule": "path_traversal"},
        ) from None
    return candidate


def _is_zip(raw: bytes, source: str) -> bool:
    """Return True when *raw* starts with a ZIP magic header or *source* ends in .zip."""
    magic = raw[:4] if len(raw) >= 4 else b""
    return any(magic == m[:4] for m in _ZIP_MAGIC) or source.lower().endswith(".zip")


def _manifest_from_zip(raw_bytes: bytes) -> dict:
    """Parse and harden a zip bundle; return a synthesized v2 manifest dict.

    Validates every member's metadata against the W-064 rule table before
    reading any content. Overlays are extracted into in-memory strings —
    no files are written to disk.
    """
    staging = Path(tempfile.mkdtemp(prefix="worca-zip-import-"))
    try:
        return _parse_zip_bundle(raw_bytes, staging)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _parse_zip_bundle(raw_bytes: bytes, staging: Path) -> dict:
    try:
        zf_handle = zipfile.ZipFile(io.BytesIO(raw_bytes))
    except zipfile.BadZipFile as exc:
        raise BundleLayoutError(
            f"not a valid zip archive: {exc}",
            details={"rule": "bad_zip"},
        ) from exc

    with zf_handle as zf:
        members = zf.infolist()

        if len(members) > _MAX_ZIP_ENTRIES:
            raise BundleLayoutError(
                f"too many entries (max {_MAX_ZIP_ENTRIES})",
                details={"rule": "too_many_entries"},
            )

        seen: set[str] = set()
        template_info: zipfile.ZipInfo | None = None
        overlay_infos: dict[str, zipfile.ZipInfo] = {}
        total_uncompressed = 0

        for info in members:
            # On Windows, ZipFile._RealGetContents normalizes os.sep -> "/"
            # in info.filename, which would silently neuter the backslash
            # defense. orig_filename preserves the raw central-directory
            # value on every platform, so safety checks must use it.
            raw_name = info.orig_filename
            name = info.filename

            if name.endswith("/"):
                continue  # skip directory entries

            if name in seen:
                raise BundleLayoutError(
                    f"duplicate member: {name}",
                    details={"member": name, "rule": "duplicate_member"},
                )
            seen.add(name)

            # Symlink detection: Unix mode bits live in external_attr >> 16
            unix_mode = (info.external_attr >> 16) & 0xFFFF
            if unix_mode and (unix_mode & 0o170000) == 0o120000:
                raise BundleLayoutError(
                    f"symlink not allowed: {name}",
                    details={"member": name, "rule": "symlink"},
                )

            # Path safety: absolute, drive letter, backslash, traversal.
            # Check raw_name so backslashes from Windows-authored zips
            # are caught even when reading on Windows.
            _safe_member_path(staging, raw_name)

            if info.file_size > _MAX_ZIP_FILE_SIZE:
                raise BundleLayoutError(
                    f"file exceeds 256 KiB: {name}",
                    details={"member": name, "rule": "oversized_single"},
                )

            if info.compress_size > 0 and info.file_size > 0:
                if info.file_size / info.compress_size > _MAX_ZIP_RATIO:
                    raise BundleLayoutError(
                        f"suspicious compression ratio: {name}",
                        details={"member": name, "rule": "bomb_ratio"},
                    )

            total_uncompressed += info.file_size

            if name == "template.json":
                template_info = info
            else:
                p = PurePosixPath(name)
                parts = p.parts
                if (
                    len(parts) == 2
                    and parts[0] == "agents"
                    and _OVERLAY_NAME_RE.match(parts[1])
                ):
                    overlay_infos[parts[1]] = info
                else:
                    raise BundleLayoutError(
                        f"unexpected entry: {name}",
                        details={"member": name, "rule": "unexpected_entry"},
                    )

        if total_uncompressed > _MAX_ZIP_UNCOMPRESSED_TOTAL:
            raise BundleLayoutError(
                "bundle exceeds 4 MiB uncompressed",
                details={"rule": "oversized_total"},
            )

        if template_info is None:
            raise BundleLayoutError(
                "missing template.json",
                details={"rule": "missing_template_json"},
            )

        with zf.open(template_info) as fh:
            tmpl_data: dict = json.loads(fh.read(_MAX_ZIP_FILE_SIZE + 1))

        overlays: dict[str, str] = {}
        for fname, ov_info in overlay_infos.items():
            with zf.open(ov_info) as fh:
                raw = fh.read(_MAX_ZIP_FILE_SIZE + 1)
                if len(raw) > _MAX_ZIP_FILE_SIZE:
                    raise BundleLayoutError(
                        f"file exceeds 256 KiB: {fname}",
                        details={"member": fname, "rule": "oversized_single"},
                    )
                overlays[fname] = raw.decode("utf-8")

        if overlays:
            tmpl_data["_overlays"] = overlays

        return {
            "worca_bundle_version": 2,
            "exported_at": datetime.now(timezone.utc).isoformat(),
            "templates": [tmpl_data],
        }


def _write_zip(tmpl_entry: dict, dest: str) -> None:
    """Write a single-template zip bundle to *dest*.

    *tmpl_entry* is a (redacted) template dict that may carry
    ``_overlays: {filename: content}``.  The zip layout is::

        template.json        — template data (without _overlays key)
        agents/<fname>       — one file per entry in _overlays

    This mirrors the layout expected by ``_parse_zip_bundle`` so a zip
    produced here can be round-tripped through ``fetch_bundle``.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        json_entry = {k: v for k, v in tmpl_entry.items() if k != "_overlays"}
        zf.writestr("template.json", json.dumps(json_entry, indent=2))
        for fname, content in (tmpl_entry.get("_overlays") or {}).items():
            zf.writestr(f"agents/{fname}", content)
    Path(dest).write_bytes(buf.getvalue())


_GIST_RE = re.compile(r"^[a-f0-9]{20,}$")
_GIST_URL_RE = re.compile(r"^https://gist\.github\.com/[^/]+/([a-f0-9]{20,})$")


def fetch_bundle(source: str) -> dict:
    """Load a bundle from a local file, HTTPS URL, or GitHub gist ID/URL.

    The payload is sniffed after fetch:
    - ZIP magic bytes or a ``.zip`` extension route to the hardened zip
      extraction path (validates layout, path safety, compression ratios).
    - Everything else is parsed as JSON (original behaviour, unchanged).

    Gist sources are always JSON — zip is not supported for gist targets.

    HTTPS sources are hardened against SSRF, redirect following, and a 1 MiB
    size cap (unchanged from the JSON-only path).
    """
    gist_match = _GIST_URL_RE.match(source)
    if gist_match:
        return _fetch_gist(gist_match.group(1))

    if _GIST_RE.match(source):
        return _fetch_gist(source)

    if source.startswith("https://"):
        raw = _fetch_url_bytes(source)
    else:
        raw = Path(source).read_bytes()

    if _is_zip(raw, source):
        return _manifest_from_zip(raw)
    return json.loads(raw.decode("utf-8"))


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


def _fetch_url_bytes(url: str) -> bytes:
    """Fetch *url* over HTTPS; return raw bytes capped at 1 MiB."""
    _check_public_host(url)
    opener = build_opener(_NoRedirectHandler(), HTTPSHandler())
    req = Request(url)  # noqa: S310 — vetted by _check_public_host above
    with opener.open(req) as resp:  # noqa: S310
        data = resp.read(_MAX_BUNDLE_BYTES + 1)
        if len(data) > _MAX_BUNDLE_BYTES:
            raise ValueError(f"bundle at {url} exceeds 1 MiB size limit")
        return data


def _fetch_url(url: str) -> dict:
    return json.loads(_fetch_url_bytes(url))


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

# Expected top-level keys for each entry in `templates[]`. `_overlays` sits
# here (not under `config`) so it bypasses CONFIG_ALLOWLIST but still goes
# through `_walk_and_redact` for value-level secret scanning.
_TEMPLATE_TOPLEVEL_KEYS = frozenset({
    "id",
    "name",
    "description",
    "tags",
    "config",
    "params",
    "_overlays",
})


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


# Major versions this code understands.
# v1 = JSON-only bundles; v2 = zip-sourced bundles with optional _overlays.
SUPPORTED_BUNDLE_MAJOR = 2
_SUPPORTED_BUNDLE_MAJORS = frozenset({1, 2})


def validate_bundle(manifest: dict) -> tuple[list[dict], list[str]]:
    """Validate a bundle manifest against the v1/v2 schema.

    Returns (errors, warnings). errors is a list of
    {"field": ..., "message": ...} dicts; warnings is a list of strings.

    Forward-compat: accepts any minor revision of a supported major
    (1.0, 1.1, 2.0, 2.1, ...) with a warning when the minor differs from
    the major's canonical (.0); rejects unrecognised majors.
    """
    errors: list[dict] = []
    warnings: list[str] = []

    version_raw = manifest.get("worca_bundle_version")
    parsed = _parse_bundle_version(version_raw)
    if parsed is None or parsed[0] not in _SUPPORTED_BUNDLE_MAJORS:
        errors.append({
            "field": "worca_bundle_version",
            "message": (
                f"unsupported bundle version {version_raw!r}, "
                f"expected major version in {sorted(_SUPPORTED_BUNDLE_MAJORS)}"
            ),
        })
        return errors, warnings
    if parsed[1] != 0:
        warnings.append(
            f"worca_bundle_version is {version_raw!r} (minor {parsed[1]}); "
            f"this importer understands {sorted(_SUPPORTED_BUNDLE_MAJORS)} — proceeding with "
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
