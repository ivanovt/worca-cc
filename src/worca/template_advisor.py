"""Template advisor — recommends a pipeline template for a given work request.

Given any source the launcher supports (prompt, spec file, GitHub issue, GitHub
PR, plan file, beads task), normalises it via ``WorkRequest.normalize`` and asks
Claude to pick the best-fit template from the project's catalog. The advisor
returns a structured recommendation conforming to
``schemas/template_advisor.json``.

Agent and user prompts are external Markdown files so project operators can
override them:

- System prompt: ``src/worca/agents/core/template-advisor.md``
  (project overlay: ``.claude/agents/template-advisor.md``)
- User prompt:   ``src/worca/agents/core/template-advise.block.md``
  (project overlay: ``.claude/agents/template-advise.block.md``)

The advisor is one-shot and short-lived; it does not participate in the
pipeline state machine. It is callable from ``worca templates advise`` and
from the worca-ui ``POST /api/projects/:projectId/templates/advise`` endpoint.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from worca.orchestrator.overlay import OverlayResolver, resolve_agent
from worca.orchestrator.templates import TemplateResolver, TemplateSummary
from worca.orchestrator.work_request import WorkRequest, normalize
from worca.utils.env import filter_model_env, get_env
from worca.utils.gh_pr import current_repo_nwo
from worca.utils.pr_url import parse_pr_url
from worca.utils.settings import load_settings, resolve_model

_CORE_DIR = Path(__file__).parent / "agents" / "core"
_SYSTEM_PROMPT_NAME = "template-advisor"
_USER_PROMPT_BLOCK = "template-advise"
_DEFAULT_MODEL_ALIAS = "sonnet"
_DEFAULT_TIMEOUT_SECONDS = 60
_REVIEW_COMMENT_CAP = 20  # at most N rendered in the prompt
_URL_PREFIX_RE = ("http://", "https://")


def _source_repo_nwo(source_value: str) -> Optional[str]:
    """Extract owner/repo from a full GitHub PR or issue URL.

    Returns ``None`` for bare refs (``gh:pr:N``, ``gh:issue:N``), non-URL
    inputs, or URLs that don't carry a parseable owner/repo. The check
    only matters for explicit URL inputs — without a URL we have no
    independent statement of what repo the user intended.
    """
    if not source_value or not source_value.startswith(_URL_PREFIX_RE):
        return None
    parsed = parse_pr_url(source_value)
    if parsed.get("provider") == "github" and parsed.get("repo_path"):
        return parsed["repo_path"]
    # Issue URLs aren't PR URLs — try a one-shot match on the path.
    import re

    m = re.match(
        r"https?://[^/]+/([^/]+/[^/]+)/(?:issues|pull)/\d+", source_value
    )
    return m.group(1) if m else None


def _guard_cross_project_source(
    source_value: str, project_root: Path
) -> None:
    """Refuse to advise when the source URL points to a different repo.

    No-ops when:
    - The source isn't a URL (we have nothing to compare against).
    - The project repo can't be resolved (not a GitHub repo, gh not
      configured, etc.) — we'd rather suggest a template than block on
      an ambient infra issue.
    """
    source_nwo = _source_repo_nwo(source_value)
    if not source_nwo:
        return
    project_nwo = current_repo_nwo(cwd=str(project_root))
    if not project_nwo:
        return  # can't compare — let the request proceed
    if source_nwo.lower() == project_nwo.lower():
        return
    raise TemplateAdvisorError(
        f"This source belongs to {source_nwo}, but this project's "
        f"repository is {project_nwo}. Open the matching project's "
        f"launcher, or paste a source from {project_nwo}."
    )


@dataclass
class TemplateAdvice:
    """Structured advisor output."""

    template_id: str
    rationale: str
    confidence: str = "high"  # "high" | "medium" | "low"
    alternatives: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "template_id": self.template_id,
            "rationale": self.rationale,
            "confidence": self.confidence,
            "alternatives": list(self.alternatives),
        }


class TemplateAdvisorError(Exception):
    """Raised when the advisor cannot produce a valid recommendation."""


def _load_system_prompt(project_root: Path) -> str:
    """Load the advisor system prompt with project-overlay support."""
    core_path = _CORE_DIR / f"{_SYSTEM_PROMPT_NAME}.md"
    if not core_path.exists():
        raise TemplateAdvisorError(
            f"advisor system prompt missing: {core_path}"
        )
    rendered = core_path.read_text(encoding="utf-8")
    resolver = OverlayResolver(
        overrides_dir=str(project_root / ".claude" / "agents")
    )
    return resolver.resolve(_SYSTEM_PROMPT_NAME, rendered)


def _load_user_prompt(project_root: Path, context: dict) -> str:
    """Load and render the advisor user-prompt block."""
    resolver = OverlayResolver(
        overrides_dir=str(project_root / ".claude" / "agents")
    )
    block = resolver.resolve_block(_USER_PROMPT_BLOCK, str(_CORE_DIR))
    if block is None:
        raise TemplateAdvisorError(
            f"advisor user-prompt block missing: {_USER_PROMPT_BLOCK}.block.md"
        )
    return resolve_agent(block, context, resolver, str(_CORE_DIR))


def _render_catalog(templates: list[TemplateSummary]) -> str:
    """Render the template catalog as a compact Markdown list for the LLM.

    Includes id, tier, name, and description only — tags are intentionally
    omitted (the advisor matches on name + description; tags would just be
    a second axis the model has to weigh against the same signal).
    """
    if not templates:
        return "(no templates available)"
    lines = []
    for t in templates:
        desc = (t.description or "").strip().replace("\n", " ")
        lines.append(f"- **{t.id}** ({t.tier}): {t.name}\n  {desc}")
    return "\n".join(lines)


def _render_review_comments(comments: list[dict]) -> str:
    """Render review comments compactly for the user prompt."""
    if not comments:
        return ""
    rendered = []
    for c in comments[:_REVIEW_COMMENT_CAP]:
        path = c.get("path", "")
        line = c.get("line")
        author = c.get("author", "")
        body = (c.get("body") or "").strip().splitlines()
        body_first = body[0] if body else ""
        loc = f"{path}:{line}" if path and line is not None else (path or "PR-level")
        rendered.append(f"- [{loc}] @{author}: {body_first}")
    remaining = max(0, len(comments) - _REVIEW_COMMENT_CAP)
    if remaining:
        rendered.append(f"- … and {remaining} more comment(s) omitted.")
    return "\n".join(rendered)


def _build_user_context(work: WorkRequest) -> dict:
    """Build the substitution context for the user-prompt block."""
    description = (work.description or "").strip()
    return {
        "source_type": work.source_type,
        "source_ref": work.source_ref or "",
        "title": work.title or "",
        "description": description,
        "has_plan_link": bool(work.plan_path),
        "plan_path": work.plan_path or "",
        "review_comments": _render_review_comments(work.review_comments or []),
        "has_review_comments": bool(work.review_comments),
    }


def _truncate_for_llm(text: str, max_chars: int = 12_000) -> str:
    """Soft cap on description size to keep the prompt small and fast."""
    if not text or len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "\n\n…[truncated]"


def _list_templates(project_root: Path) -> list[TemplateSummary]:
    """Enumerate templates the project can pick from.

    Mirrors the CLI's resolution: when ``.claude/worca/templates`` exists
    (post ``worca init``), use it; otherwise fall back to the installed
    package's bundled templates so the advisor still works in fresh repos.
    """
    builtin_runtime = project_root / ".claude" / "worca" / "templates"
    builtin_pkg = Path(__file__).parent / "templates"
    builtin_dir = builtin_runtime if builtin_runtime.is_dir() else builtin_pkg
    project_dir = project_root / ".claude" / "templates"
    user_dir = Path.home() / ".worca" / "templates"
    return TemplateResolver(builtin_dir, project_dir, user_dir).list()


def _extract_json_object(text: str) -> Optional[dict]:
    """Pull the outermost JSON object out of a model response.

    The advisor prompt instructs the model to emit raw JSON, but some
    responses still slip a fenced block or a leading sentence in. Extract
    the substring between the first ``{`` and the matching outermost ``}``
    and parse it. Returns ``None`` when no valid object is found.
    """
    if not text:
        return None
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            continue
        if in_str:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                snippet = text[start : i + 1]
                try:
                    parsed = json.loads(snippet)
                except json.JSONDecodeError:
                    return None
                return parsed if isinstance(parsed, dict) else None
    return None


def _call_claude(
    *,
    system_prompt: str,
    user_prompt: str,
    model_id: str,
    model_env: dict,
    timeout: int,
) -> str:
    """Invoke the Claude CLI one-shot and return its stdout text."""
    safe_env, _ = filter_model_env(model_env)
    args = [
        "claude",
        "-p",
        user_prompt,
        "--model",
        model_id,
        "--append-system-prompt",
        system_prompt,
        "--output-format",
        "text",
    ]
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=get_env(**safe_env),
    )
    if result.returncode != 0:
        raise TemplateAdvisorError(
            f"claude CLI exited {result.returncode}: "
            f"{result.stderr.strip() or '(no stderr)'}"
        )
    return result.stdout or ""


def _coerce_advice(
    payload: dict, catalog_ids: set[str]
) -> TemplateAdvice:
    """Validate the LLM payload and coerce it into a TemplateAdvice."""
    template_id = (payload.get("template_id") or "").strip()
    if not template_id:
        raise TemplateAdvisorError("model response missing template_id")
    if template_id not in catalog_ids:
        raise TemplateAdvisorError(
            f"model recommended unknown template '{template_id}'"
        )
    rationale = (payload.get("rationale") or "").strip()
    if not rationale:
        rationale = "Best fit based on the work content."
    confidence = (payload.get("confidence") or "high").strip().lower()
    if confidence not in {"high", "medium", "low"}:
        confidence = "high"
    alternatives_raw = payload.get("alternatives") or []
    alternatives: list[dict] = []
    if isinstance(alternatives_raw, list):
        for alt in alternatives_raw:
            if not isinstance(alt, dict):
                continue
            alt_id = (alt.get("template_id") or "").strip()
            alt_rationale = (alt.get("rationale") or "").strip()
            if alt_id and alt_id in catalog_ids and alt_id != template_id:
                alternatives.append(
                    {
                        "template_id": alt_id,
                        "rationale": alt_rationale
                        or "Plausible alternative.",
                    }
                )
    return TemplateAdvice(
        template_id=template_id,
        rationale=rationale,
        confidence=confidence,
        alternatives=alternatives,
    )


def advise(
    *,
    source_type: str,
    source_value: str = "",
    project_root: str | os.PathLike[str] | None = None,
    settings_path: str | os.PathLike[str] | None = None,
    model_alias: str = _DEFAULT_MODEL_ALIAS,
    timeout: int = _DEFAULT_TIMEOUT_SECONDS,
    plan_path_template: Optional[str] = None,
    work_request: Optional[WorkRequest] = None,
) -> TemplateAdvice:
    """Return a template recommendation for the given source.

    Args:
        source_type: One of the launcher source types — ``prompt``,
            ``spec``, ``source`` (GitHub issue auto-detect),
            ``pr`` (GitHub PR), ``plan`` (plan file), or a backend
            type (``github_issue``, ``github_pr``, ``spec_file``,
            ``plan_file``, ``beads``) when calling with a pre-built
            ``work_request``.
        source_value: The raw value the operator entered (prompt text,
            file path, ``gh:issue:N``, URL, etc.). Ignored when
            ``work_request`` is supplied.
        project_root: Project root used for template discovery and
            overlay resolution. Defaults to the current working
            directory.
        settings_path: Override the settings path (mainly for tests).
        model_alias: Model alias (resolved through ``worca.models``)
            to drive the advisor. Defaults to ``sonnet``.
        timeout: Claude CLI timeout in seconds.
        plan_path_template: Optional ``worca.plan_path_template`` for
            GitHub issue plan-link detection.
        work_request: Pre-built work request. When provided,
            ``source_type``/``source_value`` are ignored and the call
            skips normalisation (useful for tests).

    Raises:
        TemplateAdvisorError: When normalisation fails, no templates
            are available, the model errors out, or the response can
            not be coerced into a valid recommendation.
    """
    root = Path(project_root or os.getcwd()).resolve()

    work = work_request
    if work is None:
        # Refuse cross-project URL sources BEFORE shelling out to gh /
        # claude — otherwise the user pays the round-trip + LLM cost for a
        # recommendation that wouldn't apply to this project's launch
        # anyway. Bare refs (gh:pr:N) skip this since we have no second
        # source of truth for the intended repo.
        _guard_cross_project_source(source_value, root)
        try:
            work = normalize(
                source_type,
                source_value,
                plan_path_template=plan_path_template,
            )
        except (ValueError, RuntimeError, OSError) as exc:
            # The inner exception is already specific
            # ("Failed to fetch PR #313 in foo/bar: …", "[Errno 2] No such
            # file or directory: …", "Unknown source reference format: …").
            # Surface it verbatim — the extra "could not normalise work
            # source:" wrapper just adds noise without information.
            raise TemplateAdvisorError(str(exc)) from exc

    work.description = _truncate_for_llm(work.description)

    templates = _list_templates(root)
    if not templates:
        raise TemplateAdvisorError(
            "no templates available — run `worca init` or define one first"
        )
    catalog_ids = {t.id for t in templates}

    settings = load_settings(
        str(settings_path) if settings_path else str(
            root / ".claude" / "settings.json"
        )
    )
    models_cfg = settings.get("worca", {}).get("models", {})
    model_id, model_env = resolve_model(model_alias, models_cfg)

    catalog_md = _render_catalog(templates)
    user_ctx = _build_user_context(work)
    user_ctx["catalog"] = catalog_md

    system_prompt = _load_system_prompt(root)
    user_prompt = _load_user_prompt(root, user_ctx)

    raw = _call_claude(
        system_prompt=system_prompt,
        user_prompt=user_prompt,
        model_id=model_id,
        model_env=model_env,
        timeout=timeout,
    )
    payload = _extract_json_object(raw)
    if payload is None:
        # one retry with an explicit corrective instruction
        retry_user = (
            user_prompt
            + "\n\nReturn ONLY a JSON object matching the schema. "
            "No prose, no Markdown fence."
        )
        raw = _call_claude(
            system_prompt=system_prompt,
            user_prompt=retry_user,
            model_id=model_id,
            model_env=model_env,
            timeout=timeout,
        )
        payload = _extract_json_object(raw)
    if payload is None:
        raise TemplateAdvisorError(
            "model did not return a parseable JSON object"
        )

    return _coerce_advice(payload, catalog_ids)


def advise_to_json(**kwargs: Any) -> str:
    """Convenience wrapper used by the CLI: return JSON text for stdout."""
    advice = advise(**kwargs)
    return json.dumps(advice.to_dict(), indent=2)
