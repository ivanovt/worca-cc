"""Shared CLI tool detection: binary-on-PATH + version parse + semver compat.

Extracted from graphify.py so multiple tool integrations (graphify,
code-review-graph) reuse the same probe logic.
"""

import re
import shutil
import subprocess
from dataclasses import dataclass
from typing import Optional

_VERSION_RE = re.compile(r"(\d+(?:\.\d+)+)")
_SPEC_RE = re.compile(r"(>=|<=|>|<|==|!=)\s*(\d+(?:\.\d+)*)")


def _version_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def check_version_range(version: str, spec_str: str) -> bool:
    """Check whether *version* satisfies a comma-separated specifier string.

    Supports: >=, <=, >, <, ==, != with dotted version numbers.
    """
    ver = _version_tuple(version)
    for clause in spec_str.split(","):
        clause = clause.strip()
        if not clause:
            continue
        m = _SPEC_RE.fullmatch(clause)
        if not m:
            return False
        op, bound_str = m.group(1), m.group(2)
        bound = _version_tuple(bound_str)
        maxlen = max(len(ver), len(bound))
        vp = ver + (0,) * (maxlen - len(ver))
        bp = bound + (0,) * (maxlen - len(bound))
        if op == ">=" and not (vp >= bp):
            return False
        elif op == "<=" and not (vp <= bp):
            return False
        elif op == ">" and not (vp > bp):
            return False
        elif op == "<" and not (vp < bp):
            return False
        elif op == "==" and not (vp == bp):
            return False
        elif op == "!=" and not (vp != bp):
            return False
    return True


@dataclass(frozen=True)
class ToolProbe:
    installed: bool
    version: Optional[str]
    compatible: bool
    error: Optional[str]


def probe_cli(
    binary: str,
    *,
    version_flag: str = "--version",
    version_range: str = "",
    timeout: int = 10,
) -> ToolProbe:
    """Probe a CLI binary: check PATH, run version command, check semver range."""
    if shutil.which(binary) is None:
        return ToolProbe(
            installed=False,
            version=None,
            compatible=False,
            error=f"{binary} not found on PATH",
        )

    try:
        proc = subprocess.run(
            [binary, version_flag],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except Exception as exc:
        return ToolProbe(
            installed=True,
            version=None,
            compatible=False,
            error=str(exc),
        )

    if proc.returncode != 0:
        return ToolProbe(
            installed=True,
            version=None,
            compatible=False,
            error=f"{binary} {version_flag} exited {proc.returncode}: {proc.stderr.strip()}",
        )

    match = _VERSION_RE.search(proc.stdout)
    if not match:
        return ToolProbe(
            installed=True,
            version=None,
            compatible=False,
            error=f"could not parse version from: {proc.stdout.strip()!r}",
        )

    version = match.group(1)
    compatible = check_version_range(version, version_range) if version_range else True

    return ToolProbe(
        installed=True,
        version=version,
        compatible=compatible,
        error=None if compatible else f"version {version} not in {version_range}",
    )
