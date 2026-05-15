"""Tests for workspace_planner.md agent template (W-047 §2 task 1).

Validates that the workspace planner agent template:
- Exists and has the expected structure (Role, Context, Process, Output, Rules)
- References the workspace_plan.json schema for structured output
- Mentions workspace.json topology and per-repo CLAUDE.md context
- Enforces the 4KB truncation cap on per-repo CLAUDE.md
- Contains governance markers
- Does not embed block content
- Instructs the agent on dependency graph refinement and skip marking
"""
import pathlib


CORE_DIR = pathlib.Path(__file__).parent.parent / "src" / "worca" / "agents" / "core"


def _read():
    return (CORE_DIR / "workspace_planner.md").read_text()


# ---------------------------------------------------------------------------
# File existence and basic structure
# ---------------------------------------------------------------------------


def test_workspace_planner_file_exists():
    assert (CORE_DIR / "workspace_planner.md").exists()


def test_has_role_section():
    content = _read()
    assert "## Role" in content


def test_has_context_section():
    content = _read()
    assert "## Context" in content


def test_has_process_section():
    content = _read()
    assert "## Process" in content


def test_has_output_section():
    content = _read()
    assert "## Output" in content


def test_has_rules_section():
    content = _read()
    assert "## Rules" in content


# ---------------------------------------------------------------------------
# Schema reference
# ---------------------------------------------------------------------------


def test_references_workspace_plan_schema():
    content = _read()
    assert "workspace_plan.json" in content


# ---------------------------------------------------------------------------
# Workspace topology awareness
# ---------------------------------------------------------------------------


def test_mentions_workspace_json():
    content = _read()
    assert "workspace.json" in content


def test_mentions_repo_topology():
    content = _read()
    lower = content.lower()
    assert "topology" in lower or "dependency" in lower or "depends_on" in lower


def test_mentions_repo_role():
    content = _read()
    assert "role" in content.lower()


# ---------------------------------------------------------------------------
# Per-repo CLAUDE.md context
# ---------------------------------------------------------------------------


def test_mentions_claude_md():
    content = _read()
    assert "CLAUDE.md" in content


def test_mentions_4kb_truncation():
    content = _read()
    assert "4KB" in content or "4096" in content or "4 KB" in content


# ---------------------------------------------------------------------------
# Output structure
# ---------------------------------------------------------------------------


def test_mentions_per_repo_sub_plans():
    content = _read()
    lower = content.lower()
    assert "sub-plan" in lower or "per-repo" in lower


def test_mentions_summary():
    content = _read()
    assert "summary" in content.lower()


def test_mentions_acceptance_criteria():
    content = _read()
    assert "acceptance_criteria" in content or "acceptance criteria" in content.lower()


def test_mentions_integration_expectations():
    content = _read()
    assert "integration_expectations" in content or "integration" in content.lower()


def test_mentions_skip_capability():
    content = _read()
    lower = content.lower()
    assert "skip" in lower


def test_mentions_dependency_refinement():
    content = _read()
    lower = content.lower()
    assert "refine" in lower or "override" in lower or "adjust" in lower


# ---------------------------------------------------------------------------
# Governance
# ---------------------------------------------------------------------------


def test_has_governance_marker():
    content = _read()
    assert "<!-- governance -->" in content


def test_does_not_embed_block_content():
    content = _read()
    assert "{{block:" not in content


def test_no_file_writes_allowed():
    content = _read()
    lower = content.lower()
    assert "do not write" in lower or "do not create" in lower or "not write" in lower


def test_no_code_implementation():
    content = _read()
    lower = content.lower()
    assert "do not write implementation" in lower or "do not implement" in lower or "not write implementation" in lower


# ---------------------------------------------------------------------------
# Agent identity
# ---------------------------------------------------------------------------


def test_identifies_as_workspace_planner():
    content = _read()
    assert "Workspace Planner" in content or "workspace planner" in content.lower()


def test_structured_json_output():
    content = _read()
    lower = content.lower()
    assert "structured" in lower and "json" in lower
