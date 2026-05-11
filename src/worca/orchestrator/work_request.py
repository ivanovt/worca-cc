"""Input normalization - converts various input sources into a WorkRequest dataclass."""
import json
import os
import re
import subprocess
from dataclasses import dataclass
from typing import Optional

from worca.utils.env import get_env, filter_model_env
from worca.utils.settings import load_settings, resolve_model

_DEFAULT_PLAN_PATH_TEMPLATE = "docs/plans/{timestamp}-{title_slug}.md"
# Matches GitHub issue URLs: https://github.com/owner/repo/issues/42
_GH_ISSUE_URL_RE = re.compile(r"https?://github\.com/[^/]+/[^/]+/issues/(\d+)$")


def _plan_prefix_from_template(template: Optional[str]) -> str:
    """Derive the directory prefix from a plan_path_template.

    Strips at the first `{` placeholder. For literal templates with no
    placeholder, falls back to the dirname. Empty/None templates use the
    default `docs/plans/` prefix to avoid an empty prefix that would match
    every markdown link.
    """
    if not template:
        template = _DEFAULT_PLAN_PATH_TEMPLATE
    if template.startswith("./"):
        template = template[2:]
    brace = template.find("{")
    prefix = template[:brace] if brace >= 0 else os.path.dirname(template) + "/"
    if not prefix or prefix == "/":
        prefix = _plan_prefix_from_template(_DEFAULT_PLAN_PATH_TEMPLATE)
    return prefix


def _build_plan_link_re(template: Optional[str]) -> "re.Pattern[str]":
    """Build a regex matching markdown links to plan files under the prefix
    derived from `template`. Supports both relative paths and absolute
    GitHub blob URLs, mirroring the original hardcoded behavior.
    """
    prefix = _plan_prefix_from_template(template)
    return re.compile(
        rf"\[.*?\]\([^)]*?({re.escape(prefix)}[^\)]+\.md)\)"
    )


_PROMPT_TITLE_THRESHOLD = 60

_SMART_TITLE_PROMPT = (
    "Extract a concise 5-8 word title summarizing this content. "
    "Return ONLY the title, no quotes, no punctuation at the end, no explanation."
)


def generate_smart_title(content: str, source_hint: str = "") -> str:
    """Use LLM to extract a short title from content.

    Calls claude with haiku model, 30s timeout. Returns empty string on any
    failure. Sanity checks: non-empty, <100 chars, no newlines.
    """
    if not content or not content.strip():
        return ""

    truncated = content[:10_000]
    prompt = _SMART_TITLE_PROMPT
    if source_hint:
        prompt += f"\n\nSource: {source_hint}"
    prompt += f"\n\nContent:\n{truncated}"

    settings = load_settings(".claude/settings.json")
    models_cfg = settings.get("worca", {}).get("models", {})
    model_id, model_env = resolve_model("haiku", models_cfg)
    safe_env, _ = filter_model_env(model_env)

    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "text", "--model", model_id],
            capture_output=True,
            text=True,
            timeout=30,
            env=get_env(**safe_env),
        )
    except (subprocess.TimeoutExpired, OSError):
        return ""

    if result.returncode != 0:
        return ""

    title = result.stdout.strip()

    # Sanity checks
    if not title or len(title) > 100 or "\n" in title:
        return ""

    return title


@dataclass
class WorkRequest:
    """Normalized work request from any input source."""
    source_type: str  # "github_issue", "beads", "prompt", "spec_file"
    title: str
    description: str = ""
    source_ref: Optional[str] = None
    priority: int = 2
    plan_path: Optional[str] = None


def normalize_plan_file(path: str, content: str = None) -> WorkRequest:
    """Create a WorkRequest from a plan file.

    Reads file if content not provided. Title priority:
    generate_smart_title() → first # heading fallback → filename fallback.
    """
    if content is None:
        with open(path, "r") as f:
            content = f.read()

    # Title priority: smart title → heading → filename
    title = generate_smart_title(content, source_hint=f"plan file: {os.path.basename(path)}")

    if not title:
        for line in content.splitlines():
            if line.startswith("#"):
                title = line.lstrip("#").strip()
                break

    if not title:
        title = os.path.basename(path)

    return WorkRequest(
        source_type="plan_file",
        title=title,
        description=content,
        source_ref=path,
        plan_path=path,
    )


def normalize_prompt(text: str) -> WorkRequest:
    """Create a WorkRequest from a plain text prompt.

    Short prompts (<=60 chars) are used as-is. Long prompts call
    generate_smart_title(); falls back to first 60 chars + ellipsis.
    """
    if len(text) <= _PROMPT_TITLE_THRESHOLD:
        title = text
    else:
        title = generate_smart_title(text, source_hint="prompt") or text[:_PROMPT_TITLE_THRESHOLD] + "…"
    return WorkRequest(source_type="prompt", title=title, description=text)


def normalize_spec_file(path: str) -> WorkRequest:
    """Create a WorkRequest from a spec file.

    Title priority: generate_smart_title() → first # heading fallback → filename fallback.
    """
    with open(path, "r") as f:
        content = f.read()

    # Title priority: smart title → heading → filename
    title = generate_smart_title(content, source_hint=f"spec file: {os.path.basename(path)}")

    if not title:
        for line in content.splitlines():
            if line.startswith("#"):
                title = line.lstrip("#").strip()
                break

    if not title:
        title = os.path.basename(path)

    return WorkRequest(
        source_type="spec_file",
        title=title,
        description=content,
        source_ref=path,
    )


def _extract_plan_path(
    body: str, plan_path_template: Optional[str] = None
) -> Optional[str]:
    """Extract a plan file path from a GitHub issue body.

    Looks for markdown links to plan files under the directory derived from
    `plan_path_template` (default `docs/plans/`). Returns the first path
    that exists on disk; None when no link or no link's target exists.

    Iterates all matches so a leading link whose target is missing (e.g. a
    substring match against a longer URL) does not shadow a later, valid
    link to a real plan file.
    """
    pattern = _build_plan_link_re(plan_path_template)
    for match in pattern.finditer(body or ""):
        path = match.group(1)
        if os.path.isfile(path):
            return path
    return None


def normalize_github_issue(
    ref: str, plan_path_template: Optional[str] = None
) -> WorkRequest:
    """Create a WorkRequest from a GitHub issue reference like 'gh:issue:42'.

    `plan_path_template` is the configured `worca.plan_path_template`; when
    provided, it determines the directory prefix used to detect plan-file
    links in the issue body.
    """
    parts = ref.split(":")
    issue_num = parts[-1]
    result = subprocess.run(
        ["gh", "issue", "view", issue_num, "--json", "title,body"],
        capture_output=True,
        text=True,
        env=get_env(),
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to fetch issue {issue_num}: {result.stderr}")
    data = json.loads(result.stdout)
    body = data.get("body", "")
    return WorkRequest(
        source_type="github_issue",
        title=data["title"],
        description=body,
        source_ref=f"gh:{issue_num}",
        plan_path=_extract_plan_path(body, plan_path_template=plan_path_template),
    )


def normalize_beads_task(ref: str) -> WorkRequest:
    """Create a WorkRequest from a beads task reference like 'bd:bd-a1b2'."""
    parts = ref.split(":", 1)
    task_id = parts[-1]
    result = subprocess.run(
        ["bd", "show", task_id],
        capture_output=True,
        text=True,
        env=get_env(),
    )
    if result.returncode != 0:
        raise RuntimeError(f"Failed to fetch beads task {task_id}: {result.stderr}")
    # Parse title from output (first line with the title)
    title = ""
    for line in result.stdout.splitlines():
        line = line.strip()
        if "\u00b7" in line and task_id in line:
            # Format: "\u25cb bd-a1b2 \u00b7 Task Title   [\u25cf P1 \u00b7 OPEN]"
            parts = line.split("\u00b7")
            if len(parts) >= 2:
                title = parts[1].strip().split("[")[0].strip()
                break
    if not title:
        title = task_id
    return WorkRequest(
        source_type="beads",
        title=title,
        source_ref=f"bd:{task_id}",
    )


def normalize(source_type: str, source_value: str, **kwargs) -> WorkRequest:
    """Dispatch to the appropriate normalize_* function.

    source_type can be "prompt", "spec", "plan", or "source" (auto-detect from value).
    For "source", the value is sniffed: gh:issue:N → GitHub, bd:ID → Beads.
    Extra kwargs are forwarded to the dispatch function (e.g. content for plan,
    plan_path_template for github_issue).
    """
    plan_path_template = kwargs.pop("plan_path_template", None)
    if source_type == "prompt":
        return normalize_prompt(source_value)
    elif source_type == "plan":
        return normalize_plan_file(source_value, **kwargs)
    elif source_type == "spec":
        return normalize_spec_file(source_value)
    elif source_type == "source" or source_value.startswith(("gh:", "bd:")):
        # Convert GitHub URLs to gh:issue:N format
        gh_url_match = _GH_ISSUE_URL_RE.match(source_value)
        if gh_url_match:
            source_value = f"gh:issue:{gh_url_match.group(1)}"
        if source_value.startswith("gh:issue:"):
            return normalize_github_issue(
                source_value, plan_path_template=plan_path_template
            )
        elif source_value.startswith("bd:"):
            return normalize_beads_task(source_value)
        else:
            raise ValueError(f"Unknown source reference format: {source_value}")
    else:
        raise ValueError(f"Unknown source type: {source_type}={source_value}")
