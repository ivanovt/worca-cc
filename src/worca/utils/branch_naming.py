"""Utilities for deriving and validating git branch names."""
import re
from datetime import datetime, timezone

_PLACEHOLDER_RE = re.compile(r'\{(project|fleet_id|slug|yyyymmdd|yyyymmddhhmm)\}')


def slugify(title: str) -> str:
    """Convert a title to a filesystem-safe slug (max 30 chars)."""
    name = title.lower().strip()
    name = re.sub(r'[^a-z0-9\-]', '-', name)
    name = re.sub(r'-+', '-', name)
    return name.strip('-')[:30]


def resolve_branch_template(template: str, placeholders: dict, *, now=None) -> str:
    """Resolve a head-branch name template with given placeholder values.

    Supported placeholders: {project}, {fleet_id}, {slug}, {yyyymmdd}, {yyyymmddhhmm}.
    If no recognised placeholder is present the template receives '/{project}' appended
    automatically so every child in a fleet still gets a unique branch name.

    Date placeholders are computed from *now* (UTC) when not in *placeholders*.
    Pass *now* explicitly in tests to avoid real-time variance.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    auto = {
        'yyyymmdd': now.strftime('%Y%m%d'),
        'yyyymmddhhmm': now.strftime('%Y%m%d%H%M'),
    }
    merged = {**auto, **placeholders}

    if not _PLACEHOLDER_RE.search(template):
        template = template + '/{project}'

    return template.format(**merged)


def check_head_branch_collision(branches: list) -> None:
    """Raise ValueError if any two resolved head-branch names are identical.

    Reports the first colliding pair in the error message so callers can
    fail fast before any child pipeline is launched.
    """
    seen = {}
    for i, branch in enumerate(branches):
        if branch in seen:
            raise ValueError(
                f"head branch collision: '{branch}' would be used by both "
                f"target index {seen[branch]} and index {i} — adjust "
                f"--head-template to include a unique placeholder"
            )
        seen[branch] = i
