"""Tests for the learner.md agent file (.claude/agents/core/learner.md)."""
import os

import pytest

import worca
AGENT_PATH = os.path.join(
    os.path.dirname(worca.__file__), "agents", "core", "learner.md",
)


class TestAgentFileExists:
    def test_agent_file_exists(self):
        assert os.path.isfile(AGENT_PATH), f"Agent file not found at {AGENT_PATH}"

    def test_agent_file_not_empty(self):
        with open(AGENT_PATH) as f:
            content = f.read()
        assert len(content.strip()) > 0


class TestAgentStructure:
    @pytest.fixture
    def content(self):
        with open(AGENT_PATH) as f:
            return f.read()

    def test_has_role_heading(self, content):
        assert "## Role" in content

    def test_has_process_heading(self, content):
        assert "## Process" in content

    def test_has_rules_heading(self, content):
        assert "## Rules" in content

    def test_has_output_heading(self, content):
        assert "## Output" in content

    def test_title_is_learner_agent(self, content):
        assert content.startswith("# Learner Agent")


class TestAgentRole:
    @pytest.fixture
    def content(self):
        with open(AGENT_PATH) as f:
            return f.read()

    def test_role_mentions_retrospective(self, content):
        role_section = _extract_section(content, "Role")
        assert "retrospective" in role_section.lower()

    def test_role_mentions_read_only(self, content):
        role_section = _extract_section(content, "Role")
        assert "read-only" in role_section.lower() or "read only" in role_section.lower()


class TestAgentProcessCoversAllCategories:
    """The plan §1.2 requires analysis of these specific categories."""

    @pytest.fixture
    def process(self):
        with open(AGENT_PATH) as f:
            content = f.read()
        return _extract_section(content, "Process")

    def test_analyzes_implement_iterations(self, process):
        assert "implement" in process.lower()

    def test_analyzes_test_fix_loops(self, process):
        assert "test" in process.lower()

    def test_analyzes_review_fix_loops(self, process):
        assert "review" in process.lower()

    def test_evaluates_plan_quality(self, process):
        assert "plan" in process.lower()

    def test_evaluates_configuration(self, process):
        assert "config" in process.lower()

    def test_rates_by_importance(self, process):
        assert "importance" in process.lower()

    def test_formulates_suggestions(self, process):
        assert "suggest" in process.lower()


class TestAgentRules:
    """The plan §1.2 rules: no file modifications, no test runs."""

    @pytest.fixture
    def rules(self):
        with open(AGENT_PATH) as f:
            content = f.read()
        return _extract_section(content, "Rules")

    def test_no_file_modifications(self, rules):
        assert "modify" in rules.lower() or "write" in rules.lower() or "edit" in rules.lower()

    def test_no_test_runs(self, rules):
        assert "test" in rules.lower()

    def test_mentions_learn_json_schema(self):
        with open(AGENT_PATH) as f:
            content = f.read()
        assert "learn.json" in content or "LearnOutput" in content


def _extract_section(content, heading):
    """Extract text between ## heading and the next ## heading."""
    lines = content.split("\n")
    in_section = False
    section_lines = []
    for line in lines:
        if line.strip().startswith(f"## {heading}"):
            in_section = True
            continue
        if in_section and line.strip().startswith("## "):
            break
        if in_section:
            section_lines.append(line)
    return "\n".join(section_lines)
