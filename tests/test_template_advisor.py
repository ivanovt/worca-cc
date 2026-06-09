"""Tests for worca.template_advisor — the UI/CLI "Suggest template" feature."""
import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from worca.orchestrator.work_request import WorkRequest
from worca.template_advisor import (
    TemplateAdvisorError,
    _build_user_context,
    _coerce_advice,
    _extract_json_object,
    _render_catalog,
    _render_review_comments,
    advise,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _seed_project(root: Path, *, template_ids=("bugfix", "feature")) -> None:
    """Create a minimal project layout with built-in templates for resolver."""
    (root / ".claude").mkdir(parents=True, exist_ok=True)
    (root / ".claude" / "settings.json").write_text(
        json.dumps({"worca": {"models": {}}}), encoding="utf-8"
    )
    templates_dir = root / ".claude" / "worca" / "templates"
    templates_dir.mkdir(parents=True, exist_ok=True)
    descriptions = {
        "bugfix": "Fast bug fix pipeline. Investigates root cause, focused fix.",
        "feature": "Full feature pipeline with plan review and learn stages.",
        "investigate": "Analysis-only pipeline. No implementation changes.",
        "quick-fix": "Minimal pipeline for trivial single-line fixes.",
    }
    for tid in template_ids:
        d = templates_dir / tid
        d.mkdir(parents=True, exist_ok=True)
        (d / "template.json").write_text(
            json.dumps(
                {
                    "id": tid,
                    "name": tid.replace("-", " ").title(),
                    "description": descriptions.get(tid, f"{tid} template"),
                    "builtin": True,
                    "created_at": "2026-03-10T00:00:00Z",
                    "tags": [],
                    "config": {},
                }
            ),
            encoding="utf-8",
        )


def _claude_returns(payload: dict) -> MagicMock:
    """Build a MagicMock subprocess.run return that emits the JSON payload."""
    return MagicMock(returncode=0, stdout=json.dumps(payload), stderr="")


# ---------------------------------------------------------------------------
# Pure-function helpers
# ---------------------------------------------------------------------------


class TestExtractJsonObject:
    def test_raw_json(self):
        assert _extract_json_object('{"a": 1}') == {"a": 1}

    def test_json_inside_prose(self):
        text = 'Here you go:\n{"template_id": "bugfix"}\nThat\'s my pick.'
        assert _extract_json_object(text) == {"template_id": "bugfix"}

    def test_json_inside_fence(self):
        text = '```json\n{"template_id": "bugfix"}\n```'
        assert _extract_json_object(text) == {"template_id": "bugfix"}

    def test_braces_inside_strings_do_not_close_early(self):
        text = '{"rationale": "uses { and } characters", "x": 1}'
        out = _extract_json_object(text)
        assert out == {"rationale": "uses { and } characters", "x": 1}

    def test_returns_none_when_no_object(self):
        assert _extract_json_object("no json here") is None

    def test_returns_none_for_array_root(self):
        assert _extract_json_object("[1, 2, 3]") is None


class TestRenderCatalog:
    def test_includes_id_tier_name_and_description(self):
        from worca.orchestrator.templates import TemplateSummary

        templates = [
            TemplateSummary(
                id="bugfix",
                name="Bugfix",
                description="Fix a thing",
                builtin=True,
                tags=("fast",),
                created_at="2026-03-10T00:00:00Z",
                tier="builtin",
            ),
        ]
        rendered = _render_catalog(templates)
        assert "**bugfix**" in rendered
        assert "(builtin)" in rendered
        assert "Bugfix" in rendered
        assert "Fix a thing" in rendered
        assert "fast" in rendered

    def test_empty_catalog(self):
        assert _render_catalog([]) == "(no templates available)"


class TestRenderReviewComments:
    def test_empty(self):
        assert _render_review_comments([]) == ""

    def test_formats_path_and_author(self):
        out = _render_review_comments(
            [{"path": "a.py", "line": 12, "author": "u", "body": "nit"}]
        )
        assert "a.py:12" in out
        assert "@u" in out
        assert "nit" in out

    def test_caps_long_lists(self):
        comments = [
            {"path": f"f{i}.py", "line": 1, "author": "u", "body": "x"}
            for i in range(25)
        ]
        out = _render_review_comments(comments)
        # 20 rendered + 1 trailing "omitted" line
        assert out.count("\n") == 20
        assert "5 more" in out


class TestBuildUserContext:
    def test_prompt_source(self):
        work = WorkRequest(source_type="prompt", title="Add X", description="Add X")
        ctx = _build_user_context(work)
        assert ctx["source_type"] == "prompt"
        assert ctx["has_plan_link"] is False
        assert ctx["has_review_comments"] is False

    def test_github_issue_with_plan_link(self):
        work = WorkRequest(
            source_type="github_issue",
            title="W-099: Foo",
            description="Body",
            source_ref="gh:99",
            plan_path="docs/plans/W-099-foo.md",
        )
        ctx = _build_user_context(work)
        assert ctx["has_plan_link"] is True
        assert ctx["plan_path"] == "docs/plans/W-099-foo.md"

    def test_github_pr_with_review_comments(self):
        work = WorkRequest(
            source_type="github_pr",
            title="PR title",
            description="body",
            review_comments=[
                {"path": "x.py", "line": 1, "author": "u", "body": "fix this"}
            ],
        )
        ctx = _build_user_context(work)
        assert ctx["has_review_comments"] is True
        assert "@u" in ctx["review_comments"]


# ---------------------------------------------------------------------------
# Coerce / validation
# ---------------------------------------------------------------------------


class TestCoerceAdvice:
    def test_minimal_valid_payload(self):
        advice = _coerce_advice(
            {"template_id": "bugfix", "rationale": "fits"},
            {"bugfix", "feature"},
        )
        assert advice.template_id == "bugfix"
        assert advice.confidence == "high"
        assert advice.alternatives == []

    def test_unknown_template_id_raises(self):
        with pytest.raises(TemplateAdvisorError):
            _coerce_advice(
                {"template_id": "nope", "rationale": "x"}, {"bugfix"}
            )

    def test_missing_template_id_raises(self):
        with pytest.raises(TemplateAdvisorError):
            _coerce_advice({"rationale": "x"}, {"bugfix"})

    def test_drops_unknown_alternatives(self):
        advice = _coerce_advice(
            {
                "template_id": "bugfix",
                "rationale": "fits",
                "alternatives": [
                    {"template_id": "feature", "rationale": "or feature"},
                    {"template_id": "ghost", "rationale": "ignore"},
                    {"template_id": "bugfix", "rationale": "dup"},
                ],
            },
            {"bugfix", "feature"},
        )
        assert len(advice.alternatives) == 1
        assert advice.alternatives[0]["template_id"] == "feature"

    def test_normalises_bad_confidence(self):
        advice = _coerce_advice(
            {"template_id": "bugfix", "rationale": "x", "confidence": "MEGA"},
            {"bugfix"},
        )
        assert advice.confidence == "high"

    def test_accepts_low_confidence(self):
        advice = _coerce_advice(
            {"template_id": "bugfix", "rationale": "x", "confidence": "low"},
            {"bugfix"},
        )
        assert advice.confidence == "low"


# ---------------------------------------------------------------------------
# advise() — end-to-end with mocked subprocess
# ---------------------------------------------------------------------------


class TestAdviseEndToEnd:
    def test_prompt_source_happy_path(self, tmp_path):
        _seed_project(tmp_path)
        with patch("worca.template_advisor.subprocess.run") as mock_run:
            mock_run.return_value = _claude_returns(
                {
                    "template_id": "bugfix",
                    "rationale": "bug language and small scope",
                    "confidence": "high",
                }
            )
            advice = advise(
                source_type="prompt",
                source_value="Fix the regression in the login flow",
                project_root=tmp_path,
            )
        assert advice.template_id == "bugfix"
        assert advice.rationale.startswith("bug language")
        assert mock_run.call_count == 1
        cmd = mock_run.call_args[0][0]
        assert cmd[0] == "claude"
        assert "--model" in cmd

    def test_spec_source_normalises_via_work_request(self, tmp_path):
        _seed_project(tmp_path)
        spec = tmp_path / "spec.md"
        spec.write_text("# Refactor X\n\nBody body body", encoding="utf-8")
        with patch("worca.template_advisor.subprocess.run") as mock_run:
            mock_run.return_value = _claude_returns(
                {"template_id": "feature", "rationale": "spec-driven"}
            )
            # smart-title also goes through subprocess.run via work_request;
            # so the first call is the title generator, the second is advise.
            # We accept either, just check the call count is at least 1.
            advice = advise(
                source_type="spec",
                source_value=str(spec),
                project_root=tmp_path,
            )
        assert advice.template_id == "feature"

    def test_retries_once_when_response_is_not_json(self, tmp_path):
        _seed_project(tmp_path)
        with patch("worca.template_advisor.subprocess.run") as mock_run:
            mock_run.side_effect = [
                MagicMock(returncode=0, stdout="No JSON here at all", stderr=""),
                _claude_returns({"template_id": "bugfix", "rationale": "retry"}),
            ]
            advice = advise(
                source_type="prompt",
                source_value="Fix bug",
                project_root=tmp_path,
                work_request=WorkRequest(
                    source_type="prompt",
                    title="Fix bug",
                    description="Fix bug",
                ),
            )
        assert advice.template_id == "bugfix"
        assert mock_run.call_count == 2

    def test_raises_when_no_templates_available(self, tmp_path):
        # No templates directory at all.
        (tmp_path / ".claude").mkdir()
        (tmp_path / ".claude" / "settings.json").write_text(
            "{}", encoding="utf-8"
        )
        # Make the fallback (package builtin) also empty by pointing project_root
        # to tmp_path; the resolver scans `<root>/.claude/worca/templates`. With
        # nothing there it falls through to the package builtin which DOES exist
        # for the worca repo — so just assert the advise() flow handles the
        # package fallback by mocking the resolver.
        with patch("worca.template_advisor._list_templates", return_value=[]):
            with pytest.raises(TemplateAdvisorError, match="no templates"):
                advise(
                    source_type="prompt",
                    source_value="anything",
                    project_root=tmp_path,
                    work_request=WorkRequest(
                        source_type="prompt", title="x", description="x"
                    ),
                )

    def test_raises_when_claude_exits_nonzero(self, tmp_path):
        _seed_project(tmp_path)
        with patch("worca.template_advisor.subprocess.run") as mock_run:
            mock_run.return_value = MagicMock(
                returncode=1, stdout="", stderr="boom"
            )
            with pytest.raises(TemplateAdvisorError, match="claude CLI"):
                advise(
                    source_type="prompt",
                    source_value="x",
                    project_root=tmp_path,
                    work_request=WorkRequest(
                        source_type="prompt", title="x", description="x"
                    ),
                )

    def test_raises_when_template_id_unknown(self, tmp_path):
        _seed_project(tmp_path)
        with patch("worca.template_advisor.subprocess.run") as mock_run:
            mock_run.return_value = _claude_returns(
                {"template_id": "ghost-template", "rationale": "made up"}
            )
            with pytest.raises(TemplateAdvisorError, match="unknown template"):
                advise(
                    source_type="prompt",
                    source_value="x",
                    project_root=tmp_path,
                    work_request=WorkRequest(
                        source_type="prompt", title="x", description="x"
                    ),
                )

    def test_normalisation_failure_surfaces_inner_message(self, tmp_path):
        _seed_project(tmp_path)
        with pytest.raises(
            TemplateAdvisorError, match="Unknown source reference format"
        ):
            advise(
                source_type="source",  # auto-detect
                source_value="not-a-real-ref",
                project_root=tmp_path,
            )


class TestCrossProjectGuard:
    """Refuse to advise when a URL source points to a different repo."""

    def test_refuses_when_pr_url_belongs_to_different_repo(self, tmp_path):
        _seed_project(tmp_path)
        with patch(
            "worca.template_advisor.current_repo_nwo",
            return_value="owner-a/repo-a",
        ):
            with patch("worca.template_advisor.subprocess.run") as mock_run:
                with pytest.raises(
                    TemplateAdvisorError,
                    match=r"owner-b/repo-b.*owner-a/repo-a",
                ):
                    advise(
                        source_type="pr",
                        source_value="https://github.com/owner-b/repo-b/pull/313",
                        project_root=tmp_path,
                    )
                # MUST short-circuit before any subprocess call (gh, claude).
                mock_run.assert_not_called()

    def test_refuses_when_issue_url_belongs_to_different_repo(self, tmp_path):
        _seed_project(tmp_path)
        with patch(
            "worca.template_advisor.current_repo_nwo",
            return_value="owner-a/repo-a",
        ):
            with patch("worca.template_advisor.subprocess.run") as mock_run:
                with pytest.raises(
                    TemplateAdvisorError,
                    match=r"owner-b/repo-b.*owner-a/repo-a",
                ):
                    advise(
                        source_type="source",
                        source_value="https://github.com/owner-b/repo-b/issues/42",
                        project_root=tmp_path,
                    )
                mock_run.assert_not_called()

    def test_allows_when_pr_url_matches_project_repo(self, tmp_path):
        _seed_project(tmp_path)
        with patch(
            "worca.template_advisor.current_repo_nwo",
            return_value="owner-a/repo-a",
        ):
            with patch("worca.template_advisor.subprocess.run") as mock_run:
                mock_run.return_value = _claude_returns(
                    {
                        "template_id": "bugfix",
                        "rationale": "matched",
                        "confidence": "high",
                    }
                )
                # Pre-built work_request short-circuits normalize, so we
                # only exercise the guard's URL parse here. The guard
                # accepts because the URL nwo matches project nwo
                # (case-insensitive).
                from worca.orchestrator.work_request import WorkRequest

                advise(
                    source_type="pr",
                    source_value="https://github.com/Owner-A/Repo-A/pull/99",
                    project_root=tmp_path,
                    work_request=WorkRequest(
                        source_type="github_pr",
                        title="x",
                        description="x",
                    ),
                )
                assert mock_run.called

    def test_allows_when_project_nwo_cannot_be_resolved(self, tmp_path):
        _seed_project(tmp_path)
        # Project repo unresolvable (gh not configured, non-GitHub remote).
        # Don't block — let normalize/gh produce a more specific error.
        from worca.orchestrator.work_request import WorkRequest

        with patch(
            "worca.template_advisor.current_repo_nwo",
            return_value="",
        ):
            with patch("worca.template_advisor.subprocess.run") as mock_run:
                mock_run.return_value = _claude_returns(
                    {
                        "template_id": "bugfix",
                        "rationale": "no repo to compare",
                        "confidence": "low",
                    }
                )
                advise(
                    source_type="pr",
                    source_value="https://github.com/owner-b/repo-b/pull/1",
                    project_root=tmp_path,
                    work_request=WorkRequest(
                        source_type="github_pr",
                        title="x",
                        description="x",
                    ),
                )
                assert mock_run.called

    def test_skips_guard_for_bare_gh_pr_ref(self, tmp_path):
        """`gh:pr:N` has no URL nwo — guard must not block."""
        _seed_project(tmp_path)
        from worca.orchestrator.work_request import WorkRequest

        with patch(
            "worca.template_advisor.current_repo_nwo",
            return_value="owner-a/repo-a",
        ):
            with patch("worca.template_advisor.subprocess.run") as mock_run:
                mock_run.return_value = _claude_returns(
                    {
                        "template_id": "bugfix",
                        "rationale": "x",
                        "confidence": "high",
                    }
                )
                advise(
                    source_type="pr",
                    source_value="gh:pr:55",
                    project_root=tmp_path,
                    work_request=WorkRequest(
                        source_type="github_pr",
                        title="x",
                        description="x",
                    ),
                )
                assert mock_run.called

    def test_skips_guard_for_prompt_source(self, tmp_path):
        _seed_project(tmp_path)
        from worca.orchestrator.work_request import WorkRequest

        with patch(
            "worca.template_advisor.current_repo_nwo",
            return_value="owner-a/repo-a",
        ):
            with patch("worca.template_advisor.subprocess.run") as mock_run:
                mock_run.return_value = _claude_returns(
                    {
                        "template_id": "bugfix",
                        "rationale": "x",
                        "confidence": "high",
                    }
                )
                advise(
                    source_type="prompt",
                    source_value="fix the bug",
                    project_root=tmp_path,
                    work_request=WorkRequest(
                        source_type="prompt",
                        title="x",
                        description="x",
                    ),
                )
                assert mock_run.called

    def test_passes_review_comments_into_user_prompt(self, tmp_path):
        _seed_project(tmp_path)
        wr = WorkRequest(
            source_type="github_pr",
            title="PR title",
            description="body",
            review_comments=[
                {
                    "path": "a.py",
                    "line": 1,
                    "author": "alice",
                    "body": "address this",
                }
            ],
        )
        with patch("worca.template_advisor.subprocess.run") as mock_run:
            mock_run.return_value = _claude_returns(
                {"template_id": "bugfix", "rationale": "PR review"}
            )
            advise(
                source_type="pr",
                source_value="gh:pr:99",
                project_root=tmp_path,
                work_request=wr,
            )
        # The user prompt is positional arg [0][2] — claude -p <prompt>
        user_prompt = mock_run.call_args[0][0][2]
        assert "address this" in user_prompt
        assert "alice" in user_prompt
