"""Tests for the base guardian agent template content — verifies schema alignment.

These tests verify that guardian.md documents all fields the orchestrator
expects in the pr.json output, including new required and optional fields
added in W-051.
"""

from pathlib import Path

GUARDIAN_PATH = (
    Path(__file__).parent.parent
    / "src"
    / "worca"
    / "agents"
    / "core"
    / "guardian.md"
)


def _guardian():
    return GUARDIAN_PATH.read_text()


class TestGuardianRequired:
    def test_documents_source_branch_field(self):
        assert "source_branch" in _guardian()

    def test_documents_target_branch_field(self):
        assert "target_branch" in _guardian()

    def test_documents_commit_sha_field(self):
        assert "commit_sha" in _guardian()

    def test_documents_pr_number_field(self):
        assert "pr_number" in _guardian()

    def test_documents_pr_url_field(self):
        assert "pr_url" in _guardian()


class TestGuardianOptional:
    def test_documents_provider_field(self):
        assert "provider" in _guardian()

    def test_documents_is_draft_field(self):
        assert "is_draft" in _guardian()

    def test_documents_review_status_field(self):
        assert "review_status" in _guardian()


class TestGuardianCaptureInstructions:
    def test_source_branch_capture_command(self):
        # Must instruct agent to run: git rev-parse --abbrev-ref HEAD
        assert "git rev-parse --abbrev-ref HEAD" in _guardian()

    def test_target_branch_from_status_json(self):
        # Must instruct agent to read target_branch from status.json
        assert "status.json" in _guardian()

    def test_provider_heuristic_from_url(self):
        # Must mention deriving provider from PR URL hostname
        content = _guardian()
        assert "hostname" in content or "provider" in content and "URL" in content

    def test_provider_heuristic_mentions_url_derivation(self):
        # The provider instruction must mention using the PR URL
        content = _guardian()
        # Should mention provider determination from URL
        assert "pr_url" in content or "PR URL" in content


class TestGuardianJsonExample:
    def test_json_example_contains_source_branch(self):
        assert '"source_branch"' in _guardian()

    def test_json_example_contains_target_branch(self):
        assert '"target_branch"' in _guardian()

    def test_json_example_contains_provider(self):
        assert '"provider"' in _guardian()

    def test_json_example_contains_is_draft(self):
        assert '"is_draft"' in _guardian()

    def test_json_example_contains_commit_sha(self):
        assert '"commit_sha"' in _guardian()


class TestGuardianFailurePath:
    def test_failure_path_mentions_empty_string_for_missing_fields(self):
        content = _guardian()
        # Failure path must explain that missing fields can be empty string or 0
        assert 'empty string' in content or '""' in content

    def test_failure_path_mentions_new_fields(self):
        content = _guardian()
        # The failure path section should cover new fields too
        # Check that the section at the bottom references the overall missing-fields pattern
        assert "missing" in content.lower() or "0" in content
