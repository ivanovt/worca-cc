"""Tests for reviewer.md Output section documenting observations array (W-065 bead worca-cc-sxa)."""
import pathlib

REVIEWER_MD = pathlib.Path(__file__).parent.parent / "src/worca/agents/core/reviewer.md"


def _content():
    return REVIEWER_MD.read_text()


def test_output_documents_observations_array():
    assert "observations" in _content(), "Output section must document the observations array"


def test_observations_routing_outside_diff():
    content = _content()
    assert "outside" in content or "pre-existing" in content, (
        "observations must be described as findings outside the diff / pre-existing code"
    )


def test_observations_never_triggers_loopback():
    content = _content()
    assert "loop" in content.lower() or "loopback" in content.lower() or "loop-back" in content.lower(), (
        "Output section must state observations never trigger loop-back"
    )


def test_observations_user_facing_only():
    content = _content()
    assert "user-facing" in content or "user facing" in content, (
        "Output section must state observations are user-facing only"
    )


def test_issues_routing_within_diff():
    content = _content()
    assert "within" in content or "git diff" in content, (
        "issues must be described as findings within the diff"
    )


def test_scope_gate_rule_present():
    content = _content()
    assert "Scope gate" in content, "Rules section must contain a Scope gate rule"


def test_scope_gate_references_review_base():
    content = _content()
    assert "Scope gate" in content
    # The scope gate rule must reference the review_base template variable
    scope_gate_idx = content.index("Scope gate")
    snippet = content[scope_gate_idx : scope_gate_idx + 300]
    assert "{{review_base}}" in snippet, "Scope gate rule must reference {{review_base}}"


def test_scope_gate_observations_never_cause_implement_cycle():
    content = _content()
    assert "Scope gate" in content
    scope_gate_idx = content.index("Scope gate")
    snippet = content[scope_gate_idx : scope_gate_idx + 400]
    assert "implement cycle" in snippet or "never cause" in snippet, (
        "Scope gate must state observations never cause an implement cycle"
    )
