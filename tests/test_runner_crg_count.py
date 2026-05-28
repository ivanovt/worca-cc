"""Unit tests for the per-iteration CRG MCP tool-call counter predicate.

The runner counts CRG MCP tool calls (``mcp__code-review-graph__*``) per agent
iteration to drive the run-detail "CRG" badge.  The matching logic lives in
``_is_crg_tool_use``.
"""
import pytest

from worca.orchestrator.runner import _is_crg_tool_use


@pytest.mark.parametrize(
    "tool_name",
    [
        "mcp__code-review-graph__get_minimal_context",
        "mcp__code-review-graph__get_impact_radius",
        "mcp__code-review-graph__get_review_context",
        "mcp__code-review-graph__detect_changes",
        "mcp__code-review-graph__get_file_summary",
    ],
)
def test_matches_crg_mcp_tools(tool_name):
    assert _is_crg_tool_use(tool_name) is True


@pytest.mark.parametrize(
    "tool_name",
    [
        "Bash",
        "Read",
        "Write",
        "Edit",
        "Agent",
        "mcp__other-server__some_tool",
        "",
        "code-review-graph",  # not an MCP tool name
        "mcp__code-review-graphx__query",  # wrong server name
    ],
)
def test_excludes_non_crg_tools(tool_name):
    assert _is_crg_tool_use(tool_name) is False
