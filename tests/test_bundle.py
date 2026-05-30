"""Tests for the bundle redaction engine (SECRET_PATTERNS + redact_bundle)."""

import copy

import pytest

from worca.orchestrator.bundle import (
    build_export_manifest,
    redact_bundle,
    validate_bundle,
)



# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _minimal_manifest(**overrides):
    base = {
        "worca_bundle_version": 1,
        "exported_at": "2026-05-30T07:31:07Z",
        "templates": [
            {
                "id": "basic",
                "name": "Basic",
                "description": "A basic template",
                "tags": ["fast"],
                "config": {},
                "params": {},
            }
        ],
    }
    base.update(overrides)
    return base


# ---------------------------------------------------------------------------
# Layer 2 — SECRET_PATTERNS value-level regex
# ---------------------------------------------------------------------------

class TestSecretPatternMatching:
    """Each SECRET_PATTERNS entry detects its target secret format."""

    def test_redact_strips_sk_prefix(self):
        manifest = _minimal_manifest(
            models={"proxy": {"id": "claude-opus-4-6", "token": "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"}},
        )
        redacted, paths = redact_bundle(manifest)
        assert redacted["models"]["proxy"]["token"] == "<REDACTED>"
        assert "models.proxy.token" in paths

    def test_redact_strips_ghp_prefix(self):
        secret = "ghp_" + "a" * 36
        manifest = _minimal_manifest(custom_field=secret)
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == "<REDACTED>"
        assert "custom_field" in paths

    def test_redact_strips_github_pat(self):
        secret = "github_pat_" + "A1b2C3d4E5f6G7h8I9j0" + "extra_chars"
        manifest = _minimal_manifest(custom_field=secret)
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == "<REDACTED>"
        assert "custom_field" in paths

    def test_redact_strips_slack_bot_token(self):
        manifest = _minimal_manifest(custom_field="xoxb-123456789-abcdef")
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == "<REDACTED>"
        assert "custom_field" in paths

    def test_redact_strips_slack_user_token(self):
        manifest = _minimal_manifest(custom_field="xoxp-999-abc-def")
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == "<REDACTED>"
        assert "custom_field" in paths

    def test_redact_strips_aws_keys(self):
        manifest = _minimal_manifest(custom_field="AKIAIOSFODNN7EXAMPLE")
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == "<REDACTED>"
        assert "custom_field" in paths

    def test_redact_strips_long_hex(self):
        secret = "a" * 32  # 32-char hex string
        manifest = _minimal_manifest(custom_field=secret)
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == "<REDACTED>"
        assert "custom_field" in paths


# ---------------------------------------------------------------------------
# Layer 1 — Structural env-block stripping
# ---------------------------------------------------------------------------

class TestEnvBlockStripping:
    """Env blocks are removed wholesale from models and template agent configs."""

    def test_redact_strips_model_env_blocks(self):
        manifest = _minimal_manifest(
            models={
                "opus": {
                    "id": "claude-opus-4-6",
                    "env": {"ANTHROPIC_BASE_URL": "https://proxy.example.com", "NPM_TOKEN": "secret"},
                },
                "sonnet": "claude-sonnet-4-6",  # plain string, no env
            },
        )
        redacted, paths = redact_bundle(manifest)
        assert "env" not in redacted["models"]["opus"]
        assert redacted["models"]["opus"]["id"] == "claude-opus-4-6"
        assert redacted["models"]["sonnet"] == "claude-sonnet-4-6"
        assert "models.opus.env" in paths

    def test_redact_strips_template_agent_env(self):
        manifest = _minimal_manifest(
            templates=[
                {
                    "id": "t1",
                    "name": "T1",
                    "description": "test",
                    "tags": [],
                    "config": {
                        "agents": {
                            "planner": {
                                "model": "opus",
                                "env": {"SECRET_KEY": "should-be-stripped"},
                            },
                            "implementer": {"model": "sonnet"},
                        },
                    },
                    "params": {},
                }
            ],
        )
        redacted, paths = redact_bundle(manifest)
        agents = redacted["templates"][0]["config"]["agents"]
        assert "env" not in agents["planner"]
        assert agents["planner"]["model"] == "opus"
        assert agents["implementer"]["model"] == "sonnet"
        assert "templates[0].config.agents.planner.env" in paths


# ---------------------------------------------------------------------------
# _redacted list correctness
# ---------------------------------------------------------------------------

class TestRedactedListCorrectness:
    """The _redacted list accurately reflects every stripped path."""

    def test_redact_populates_redacted_list(self):
        manifest = _minimal_manifest(
            models={
                "proxy": {
                    "id": "claude-opus-4-6",
                    "env": {"KEY": "val"},
                    "token": "sk-ant-api03-" + "x" * 20,
                },
            },
            templates=[
                {
                    "id": "t1",
                    "name": "T1",
                    "description": "d",
                    "tags": [],
                    "config": {
                        "agents": {
                            "reviewer": {"env": {"S": "v"}},
                        },
                    },
                    "params": {},
                }
            ],
        )
        redacted, paths = redact_bundle(manifest)
        assert "models.proxy.env" in paths
        assert "models.proxy.token" in paths
        assert "templates[0].config.agents.reviewer.env" in paths
        assert redacted["_redacted"] == paths

    def test_empty_manifest_no_redactions(self):
        manifest = _minimal_manifest()
        redacted, paths = redact_bundle(manifest)
        assert paths == []
        assert redacted.get("_redacted", []) == []


# ---------------------------------------------------------------------------
# Non-secret preservation
# ---------------------------------------------------------------------------

class TestNonSecretPreservation:
    """Normal, non-secret values are left untouched."""

    def test_redact_preserves_non_secret_values(self):
        manifest = _minimal_manifest(
            models={
                "opus": {"id": "claude-opus-4-6"},
                "sonnet": "claude-sonnet-4-6",
            },
            pricing={"models": {"opus": {"input_per_mtok": 5}}, "currency": "USD"},
        )
        original = copy.deepcopy(manifest)
        redacted, paths = redact_bundle(manifest)
        assert paths == []
        assert redacted["models"] == original["models"]
        assert redacted["pricing"] == original["pricing"]
        assert redacted["templates"] == original["templates"]
        assert redacted["worca_bundle_version"] == 1

    def test_redact_preserves_short_hex_strings(self):
        manifest = _minimal_manifest(custom_field="abcdef12")  # 8 chars, under 32
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == "abcdef12"
        assert paths == []

    def test_redact_does_not_mutate_input(self):
        manifest = _minimal_manifest(
            models={"m": {"id": "x", "env": {"K": "V"}}},
        )
        original = copy.deepcopy(manifest)
        redact_bundle(manifest)
        assert manifest == original


# ---------------------------------------------------------------------------
# Bundle validation
# ---------------------------------------------------------------------------

class TestValidateBundle:
    """validate_bundle() checks schema conformance and returns error dicts."""

    def test_validate_rejects_unknown_version(self):
        manifest = _minimal_manifest(worca_bundle_version=2)
        errors, _warnings = validate_bundle(manifest)
        assert len(errors) == 1
        assert errors[0]["field"] == "worca_bundle_version"
        assert "2" in errors[0]["message"]

    def test_validate_requires_templates_array(self):
        manifest = _minimal_manifest()
        del manifest["templates"]
        errors, _ = validate_bundle(manifest)
        assert any(e["field"] == "templates" for e in errors)

        manifest2 = _minimal_manifest(templates=[])
        errors2, _ = validate_bundle(manifest2)
        assert any(e["field"] == "templates" for e in errors2)

    def test_validate_template_field_rules(self):
        manifest = _minimal_manifest(
            templates=[
                {
                    "id": "INVALID ID!",
                    "name": "x" * 81,
                    "tags": ["a", "b", "c", "d", "e", "f"],
                    "config": "not-a-dict",
                }
            ],
        )
        errors, _ = validate_bundle(manifest)
        fields = [e["field"] for e in errors]
        assert "templates[0].id" in fields
        assert "templates[0].name" in fields
        assert "templates[0].tags" in fields
        assert "templates[0].config" in fields

# ---------------------------------------------------------------------------
# build_export_manifest
# ---------------------------------------------------------------------------

class TestBuildExportManifest:

    def test_correct_structure(self):
        templates = [{"id": "t1", "name": "T1", "description": "d", "tags": [], "config": {}, "params": {}}]
        manifest = build_export_manifest(templates)
        assert manifest["worca_bundle_version"] == 1
        assert "exported_at" in manifest
        assert manifest["templates"] == templates
        assert "models" not in manifest
        assert "pricing" not in manifest

    def test_models_excluded_when_none(self):
        templates = [{"id": "t1", "name": "T1", "description": "d", "tags": [], "config": {}, "params": {}}]
        with_models = build_export_manifest(templates, models={"opus": "claude-opus-4-6"})
        without_models = build_export_manifest(templates)
        assert with_models["models"] == {"opus": "claude-opus-4-6"}
        assert "models" not in without_models

    def test_round_trip_build_redact_validate(self):
        templates = [{"id": "my-tmpl", "name": "My Template", "description": "x", "tags": ["fast"], "config": {}, "params": {}}]
        manifest = build_export_manifest(templates, models={"opus": {"id": "claude-opus-4-6"}}, pricing={"currency": "USD"})
        redacted, _paths = redact_bundle(manifest)
        errors, _warnings = validate_bundle(redacted)
        assert errors == []


    def test_validate_accepts_unknown_top_keys(self):
        manifest = _minimal_manifest(future_key="hello", another="world")
        errors, warnings = validate_bundle(manifest)
        assert len(errors) == 0
        assert "future_key" in warnings
        assert "another" in warnings


# ---------------------------------------------------------------------------
# fetch_bundle
# ---------------------------------------------------------------------------

class TestFetchBundle:
    """fetch_bundle loads bundle JSON from file, URL, or GitHub gist."""

    def test_fetch_from_local_file(self, tmp_path):
        import json
        from worca.orchestrator.bundle import fetch_bundle

        bundle_file = tmp_path / "bundle.json"
        manifest = _minimal_manifest()
        bundle_file.write_text(json.dumps(manifest))

        result = fetch_bundle(str(bundle_file))
        assert result["worca_bundle_version"] == 1
        assert result["templates"][0]["id"] == "basic"

    def test_fetch_from_url_with_size_cap(self, monkeypatch):
        from unittest.mock import MagicMock
        from worca.orchestrator.bundle import fetch_bundle

        oversized = b"x" * (1024 * 1024 + 1)
        mock_response = MagicMock()
        mock_response.read.return_value = oversized
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)

        mock_urlopen = MagicMock(return_value=mock_response)
        monkeypatch.setattr("worca.orchestrator.bundle.urlopen", mock_urlopen)

        with pytest.raises(ValueError, match="exceeds 1 MiB"):
            fetch_bundle("https://example.com/bundle.json")

    def test_fetch_from_gist(self, monkeypatch):
        import json
        from unittest.mock import MagicMock
        from worca.orchestrator.bundle import fetch_bundle

        manifest = _minimal_manifest()
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = json.dumps(manifest)

        mock_run = MagicMock(return_value=mock_result)
        monkeypatch.setattr("subprocess.run", mock_run)

        gist_id = "a1b2c3d4e5f6a1b2c3d4"
        result = fetch_bundle(gist_id)
        assert result["worca_bundle_version"] == 1
        mock_run.assert_called_once()
        args = mock_run.call_args[0][0]
        assert "gh" in args
        assert gist_id in args
