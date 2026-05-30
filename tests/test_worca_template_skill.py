"""Tests that the worca-template skill interview covers mode and governance."""

from pathlib import Path

import pytest

SKILL_PATHS = [
    Path("src/worca/skills/worca-template/SKILL.md"),
    Path(".claude/skills/worca-template/SKILL.md"),
]


@pytest.fixture(params=SKILL_PATHS, ids=lambda p: str(p))
def skill_content(request):
    path = Path(__file__).parent.parent / request.param
    if not path.exists():
        pytest.skip(f"{request.param} not found")
    return path.read_text()


def test_interview_includes_plan_review_mode_question(skill_content):
    assert "review_and_edit" in skill_content
    assert "stages.plan_review.mode" in skill_content


def test_interview_includes_mode_tradeoff_explanation(skill_content):
    lower = skill_content.lower()
    assert "tradeoff" in lower or "trade-off" in lower


def test_interview_includes_governance_override(skill_content):
    assert "governance.plan_review_enforce" in skill_content


def test_interview_mode_question_is_conditional_on_plan_review(skill_content):
    mode_idx = skill_content.find("review_and_edit")
    plan_review_idx = skill_content.find("Plan review")
    assert plan_review_idx < mode_idx, "Mode question should appear after plan review stage toggle"
