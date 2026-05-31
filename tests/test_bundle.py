"""Tests for the bundle redaction engine, validator, and fetch hardening."""

import copy
import json
from unittest.mock import MagicMock

import pytest

from worca.orchestrator.bundle import (
    CONFIG_ALLOWLIST,
    ID_RE,
    SECRET_PLACEHOLDER,
    build_export_manifest,
    collect_referenced_model_aliases,
    fetch_bundle,
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
# Layer 2 — value-level secret pattern matching
# ---------------------------------------------------------------------------

class TestSecretPatternMatching:
    """Each SECRET_PATTERNS entry detects its target secret format."""

    def test_redact_strips_sk_prefix(self):
        manifest = _minimal_manifest(
            models={"proxy": {"id": "claude-opus-4-6", "token": "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"}},
        )
        redacted, paths = redact_bundle(manifest)
        assert redacted["models"]["proxy"]["token"] == SECRET_PLACEHOLDER
        assert "models.proxy.token" in paths

    def test_redact_strips_ghp_prefix(self):
        secret = "ghp_" + "a" * 36
        manifest = _minimal_manifest(custom_field=secret)
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == SECRET_PLACEHOLDER
        assert "custom_field" in paths

    def test_redact_strips_github_pat(self):
        secret = "github_pat_" + "A1b2C3d4E5f6G7h8I9j0" + "extra_chars"
        manifest = _minimal_manifest(custom_field=secret)
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == SECRET_PLACEHOLDER

    def test_redact_strips_slack_bot_token(self):
        manifest = _minimal_manifest(custom_field="xoxb-123456789-abcdef")
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == SECRET_PLACEHOLDER

    def test_redact_strips_slack_user_token(self):
        manifest = _minimal_manifest(custom_field="xoxp-999-abc-def")
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == SECRET_PLACEHOLDER

    def test_redact_strips_aws_keys(self):
        manifest = _minimal_manifest(custom_field="AKIAIOSFODNN7EXAMPLE")
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == SECRET_PLACEHOLDER

    def test_redact_does_not_redact_long_hex(self):
        """The hex-≥32 pattern was removed — it false-positived on SHA-1/256
        hashes, UUIDs, and cache keys. Plain hex strings now pass through."""
        sha_like = "a" * 40  # like a git commit SHA
        manifest = _minimal_manifest(custom_field=sha_like)
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == sha_like
        assert paths == []


# ---------------------------------------------------------------------------
# Env-block per-value redaction (replaces the old wholesale strip)
# ---------------------------------------------------------------------------

class TestEnvValueRedaction:
    """Env blocks: keys are always preserved, only secret-matching VALUES are
    replaced with SECRET_PLACEHOLDER. This keeps the env scaffold visible so
    the importer knows which vars to fill in."""

    def test_model_env_keys_preserved_secret_values_replaced(self):
        manifest = _minimal_manifest(
            models={
                "opus": {
                    "id": "claude-opus-4-6",
                    "env": {
                        "ANTHROPIC_BASE_URL": "https://proxy.example.com",
                        "ANTHROPIC_API_KEY": "sk-ant-api03-" + "x" * 30,
                        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "16000",
                    },
                },
                "sonnet": "claude-sonnet-4-6",
            },
        )
        redacted, paths = redact_bundle(manifest)
        env = redacted["models"]["opus"]["env"]
        # All keys preserved
        assert set(env.keys()) == {
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
        }
        # Secret value replaced
        assert env["ANTHROPIC_API_KEY"] == SECRET_PLACEHOLDER
        # Non-secret values preserved verbatim
        assert env["ANTHROPIC_BASE_URL"] == "https://proxy.example.com"
        assert env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] == "16000"
        # Path tracking points to the specific key, not the whole env block
        assert "models.opus.env.ANTHROPIC_API_KEY" in paths
        assert "models.opus.env.ANTHROPIC_BASE_URL" not in paths

    def test_template_agent_env_keys_preserved_secret_values_replaced(self):
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
                                "env": {
                                    "SECRET_KEY": "sk-ant-api03-" + "x" * 30,
                                    "DEBUG": "true",
                                },
                            },
                            "implementer": {"model": "sonnet"},
                        },
                    },
                    "params": {},
                }
            ],
        )
        redacted, paths = redact_bundle(manifest)
        env = redacted["templates"][0]["config"]["agents"]["planner"]["env"]
        # Both keys still present
        assert set(env.keys()) == {"SECRET_KEY", "DEBUG"}
        assert env["SECRET_KEY"] == SECRET_PLACEHOLDER
        assert env["DEBUG"] == "true"
        assert "templates[0].config.agents.planner.env.SECRET_KEY" in paths


# ---------------------------------------------------------------------------
# Config allowlist (the new primary defense)
# ---------------------------------------------------------------------------

class TestConfigAllowlist:
    """templates[*].config.* — only CONFIG_ALLOWLIST keys pass through; the
    rest are stripped wholesale and recorded in `_stripped`."""

    def test_strips_webhooks_integrations_governance(self):
        manifest = _minimal_manifest(
            templates=[
                {
                    "id": "t1",
                    "name": "T1",
                    "description": "",
                    "tags": [],
                    "config": {
                        "stages": {"planner": {"enabled": True}},
                        "agents": {"planner": {"model": "opus"}},
                        "webhooks": [
                            {"url": "https://example.com/", "secret": "supersecret"},
                        ],
                        "integrations": {"slack": {"bot_token": "xoxb-abc-def"}},
                        "governance": {"guards": {}},
                    },
                    "params": {},
                }
            ],
        )
        redacted, _paths = redact_bundle(manifest)
        config = redacted["templates"][0]["config"]
        # Allowlisted survive
        assert "stages" in config
        assert "agents" in config
        # Disallowed are gone
        assert "webhooks" not in config
        assert "integrations" not in config
        assert "governance" not in config
        # _stripped list mirrors them
        stripped = redacted["_stripped"]
        assert "templates[0].config.webhooks" in stripped
        assert "templates[0].config.integrations" in stripped
        assert "templates[0].config.governance" in stripped

    def test_strips_graphify_and_crg(self):
        """graphify and CRG require external packages — auto-importing them
        would silently change behavior once those packages are installed."""
        manifest = _minimal_manifest(
            templates=[
                {
                    "id": "t1",
                    "name": "T1",
                    "description": "",
                    "tags": [],
                    "config": {
                        "graphify": {"enabled": True},
                        "crg": {"engine": "code-review-graph"},
                    },
                    "params": {},
                }
            ],
        )
        redacted, _ = redact_bundle(manifest)
        config = redacted["templates"][0]["config"]
        assert "graphify" not in config
        assert "crg" not in config
        stripped = redacted["_stripped"]
        assert "templates[0].config.graphify" in stripped
        assert "templates[0].config.crg" in stripped

    def test_preserves_all_allowlisted_keys(self):
        """Every key in CONFIG_ALLOWLIST passes through unchanged."""
        config = {
            "stages": {"planner": {}},
            "agents": {"planner": {"model": "opus"}},
            "effort": {"auto_mode": "adaptive"},
            "loops": {"plan_review": {"max": 3}},
            "circuit_breaker": {"halt_threshold": 5},
            "models": {"opus": "claude-opus-4-6"},
        }
        # Sanity: this test must cover the full allowlist
        assert set(config.keys()) == set(CONFIG_ALLOWLIST)

        manifest = _minimal_manifest(
            templates=[{
                "id": "t1", "name": "T1", "description": "", "tags": [],
                "config": config, "params": {},
            }],
        )
        redacted, _ = redact_bundle(manifest)
        # All allowlisted keys still present
        assert set(redacted["templates"][0]["config"].keys()) == set(CONFIG_ALLOWLIST)
        assert "_stripped" not in redacted

    def test_top_level_models_not_affected_by_config_allowlist(self):
        """The allowlist applies to `templates[*].config.*`, not to the
        top-level manifest. Top-level `models` survives independently."""
        manifest = _minimal_manifest(
            models={"opus": {"id": "claude-opus-4-6"}},
        )
        redacted, _ = redact_bundle(manifest)
        assert redacted["models"] == {"opus": {"id": "claude-opus-4-6"}}


# ---------------------------------------------------------------------------
# _redacted / _stripped list correctness
# ---------------------------------------------------------------------------

class TestRedactedListCorrectness:

    def test_redact_populates_redacted_list(self):
        manifest = _minimal_manifest(
            models={
                "proxy": {
                    "id": "claude-opus-4-6",
                    "env": {"K": "sk-ant-api03-" + "x" * 30},
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
                        "agents": {"reviewer": {"env": {"S": "sk-ant-api03-" + "x" * 25}}},
                    },
                    "params": {},
                }
            ],
        )
        redacted, paths = redact_bundle(manifest)
        assert "models.proxy.env.K" in paths
        assert "models.proxy.token" in paths
        assert "templates[0].config.agents.reviewer.env.S" in paths
        assert redacted["_redacted"] == paths

    def test_empty_manifest_no_redactions(self):
        manifest = _minimal_manifest()
        redacted, paths = redact_bundle(manifest)
        assert paths == []
        assert redacted.get("_redacted", []) == []
        assert "_stripped" not in redacted


# ---------------------------------------------------------------------------
# Non-secret preservation
# ---------------------------------------------------------------------------

class TestNonSecretPreservation:

    def test_preserves_non_secret_values(self):
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

    def test_preserves_short_hex_strings(self):
        manifest = _minimal_manifest(custom_field="abcdef12")
        redacted, paths = redact_bundle(manifest)
        assert redacted["custom_field"] == "abcdef12"
        assert paths == []

    def test_preserves_git_sha_like_values(self):
        """40-hex git SHAs and 64-hex SHA-256 values pass through."""
        manifest = _minimal_manifest(
            sha1="0123456789abcdef0123456789abcdef01234567",  # 40 hex
            sha256="0" * 64,
        )
        redacted, paths = redact_bundle(manifest)
        assert redacted["sha1"] == "0123456789abcdef0123456789abcdef01234567"
        assert redacted["sha256"] == "0" * 64
        assert paths == []

    def test_does_not_mutate_input(self):
        manifest = _minimal_manifest(
            models={"m": {"id": "x", "env": {"K": "sk-ant-api03-" + "x" * 30}}},
        )
        original = copy.deepcopy(manifest)
        redact_bundle(manifest)
        assert manifest == original


# ---------------------------------------------------------------------------
# Bundle validation — schema forward-compat
# ---------------------------------------------------------------------------

class TestValidateBundle:

    def test_rejects_unknown_major_version(self):
        manifest = _minimal_manifest(worca_bundle_version=2)
        errors, _ = validate_bundle(manifest)
        assert len(errors) == 1
        assert errors[0]["field"] == "worca_bundle_version"

    def test_rejects_string_major_two(self):
        manifest = _minimal_manifest(worca_bundle_version="2.0")
        errors, _ = validate_bundle(manifest)
        assert any(e["field"] == "worca_bundle_version" for e in errors)

    def test_rejects_garbage_version(self):
        manifest = _minimal_manifest(worca_bundle_version="not-a-version")
        errors, _ = validate_bundle(manifest)
        assert any(e["field"] == "worca_bundle_version" for e in errors)

    def test_accepts_integer_1(self):
        manifest = _minimal_manifest(worca_bundle_version=1)
        errors, warnings = validate_bundle(manifest)
        assert errors == []
        # No warning about version when it's the canonical
        assert not any("worca_bundle_version" in w for w in warnings)

    def test_accepts_string_1_with_no_warning(self):
        manifest = _minimal_manifest(worca_bundle_version="1")
        errors, warnings = validate_bundle(manifest)
        assert errors == []
        assert not any("worca_bundle_version" in w for w in warnings)

    def test_accepts_1_dot_0_no_warning(self):
        manifest = _minimal_manifest(worca_bundle_version="1.0")
        errors, warnings = validate_bundle(manifest)
        assert errors == []
        assert not any("worca_bundle_version" in w for w in warnings)

    def test_accepts_1_dot_N_with_minor_warning(self):
        """Future minor bumps (1.1, 1.5) are forward-compat: warn but proceed."""
        manifest = _minimal_manifest(worca_bundle_version="1.5")
        errors, warnings = validate_bundle(manifest)
        assert errors == []
        assert any("worca_bundle_version" in w and "minor" in w for w in warnings)

    def test_requires_templates_array(self):
        manifest = _minimal_manifest()
        del manifest["templates"]
        errors, _ = validate_bundle(manifest)
        assert any(e["field"] == "templates" for e in errors)

        manifest2 = _minimal_manifest(templates=[])
        errors2, _ = validate_bundle(manifest2)
        assert any(e["field"] == "templates" for e in errors2)

    def test_template_field_rules(self):
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

    def test_accepts_unknown_top_keys(self):
        manifest = _minimal_manifest(future_key="hello", another="world")
        errors, warnings = validate_bundle(manifest)
        assert errors == []
        assert "future_key" in warnings
        assert "another" in warnings


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
        redacted, _ = redact_bundle(manifest)
        errors, _ = validate_bundle(redacted)
        assert errors == []


# ---------------------------------------------------------------------------
# ID_RE is exported and usable by callers
# ---------------------------------------------------------------------------

class TestIdRegex:

    def test_id_re_accepts_valid_ids(self):
        assert ID_RE.match("basic")
        assert ID_RE.match("my-template")
        assert ID_RE.match("t1")
        assert ID_RE.match("a" * 64)

    def test_id_re_rejects_invalid(self):
        assert not ID_RE.match("")
        assert not ID_RE.match("My-Template")  # uppercase
        assert not ID_RE.match("a" * 65)  # too long
        assert not ID_RE.match("foo bar")  # space
        assert not ID_RE.match("../escape")
        assert not ID_RE.match("foo/bar")


# ---------------------------------------------------------------------------
# fetch_bundle
# ---------------------------------------------------------------------------

class TestFetchBundle:

    def test_fetch_from_local_file(self, tmp_path):
        bundle_file = tmp_path / "bundle.json"
        manifest = _minimal_manifest()
        bundle_file.write_text(json.dumps(manifest))

        result = fetch_bundle(str(bundle_file))
        assert result["worca_bundle_version"] == 1
        assert result["templates"][0]["id"] == "basic"

    def test_fetch_from_url_with_size_cap(self, monkeypatch):
        # Pretend host check passes.
        monkeypatch.setattr("worca.orchestrator.bundle._check_public_host", lambda url: None)

        oversized = b"x" * (1024 * 1024 + 1)
        mock_response = MagicMock()
        mock_response.read.return_value = oversized
        mock_response.__enter__ = lambda s: s
        mock_response.__exit__ = MagicMock(return_value=False)

        mock_opener = MagicMock()
        mock_opener.open.return_value = mock_response
        monkeypatch.setattr(
            "worca.orchestrator.bundle.build_opener", lambda *_a, **_kw: mock_opener
        )

        with pytest.raises(ValueError, match="exceeds 1 MiB"):
            fetch_bundle("https://example.com/bundle.json")

    def test_fetch_from_gist(self, monkeypatch):
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


# ---------------------------------------------------------------------------
# HTTPS hardening — host check and redirect block
# ---------------------------------------------------------------------------

class TestHttpsHardening:

    def test_refuses_loopback(self, monkeypatch):
        # Force DNS to return 127.0.0.1
        def fake_getaddrinfo(host, port):
            return [(0, 0, 0, "", ("127.0.0.1", port or 0))]
        monkeypatch.setattr("socket.getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ValueError, match="non-public host"):
            fetch_bundle("https://localhost/bundle.json")

    def test_refuses_private_rfc1918(self, monkeypatch):
        def fake_getaddrinfo(host, port):
            return [(0, 0, 0, "", ("10.0.0.5", port or 0))]
        monkeypatch.setattr("socket.getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ValueError, match="non-public host"):
            fetch_bundle("https://internal.example.com/bundle.json")

    def test_refuses_link_local_aws_metadata(self, monkeypatch):
        """The classic cloud-metadata SSRF target."""
        def fake_getaddrinfo(host, port):
            return [(0, 0, 0, "", ("169.254.169.254", port or 0))]
        monkeypatch.setattr("socket.getaddrinfo", fake_getaddrinfo)

        with pytest.raises(ValueError, match="non-public host"):
            fetch_bundle("https://metadata.example.com/bundle.json")

    def test_redirect_is_blocked(self, monkeypatch):
        from worca.orchestrator.bundle import _NoRedirectHandler
        monkeypatch.setattr("worca.orchestrator.bundle._check_public_host", lambda url: None)

        handler = _NoRedirectHandler()
        req = MagicMock()
        req.full_url = "https://a.example.com/bundle.json"
        with pytest.raises(ValueError, match="refusing redirect"):
            handler.redirect_request(req, None, 302, "Found", {}, "https://b.example.com/")


# ---------------------------------------------------------------------------
# Alias-collection helper — drives the filter that scopes worca.models and
# worca.pricing.models to entries the bundled templates actually reference.
# ---------------------------------------------------------------------------

class TestCollectReferencedModelAliases:
    """`collect_referenced_model_aliases` reads templates[*].config.agents.*.model
    and follows one-hop {id: <alias>} chains in the models map."""

    def test_no_templates_returns_empty(self):
        assert collect_referenced_model_aliases([], {"opus": "claude-opus-4-6"}) == set()

    def test_template_without_agents_returns_empty(self):
        templates = [{"id": "t", "config": {}}]
        assert collect_referenced_model_aliases(templates, {"opus": "x"}) == set()

    def test_direct_reference_included(self):
        templates = [{"id": "t", "config": {"agents": {"planner": {"model": "opus"}}}}]
        models = {"opus": "claude-opus-4-6", "sonnet": "claude-sonnet-4-6"}
        assert collect_referenced_model_aliases(templates, models) == {"opus"}

    def test_id_field_is_not_followed_into_other_aliases(self):
        """`models["glm-ds"] = {"id": "opus", ...}` does NOT pull in
        models["opus"]. `id` is the literal string passed to claude --model
        (resolve_model is non-recursive in worca.utils.settings); pricing in
        worca.utils.token_usage also looks up by alias name directly, never
        by the id field. So `opus` is dead weight in this bundle even though
        glm-ds's id happens to match an existing alias name."""
        templates = [{"id": "t", "config": {"agents": {"planner": {"model": "glm-ds"}}}}]
        models = {
            "opus": "claude-opus-4-6",
            "glm-ds": {"id": "opus", "env": {"ANTHROPIC_BASE_URL": "https://x/"}},
        }
        assert collect_referenced_model_aliases(templates, models) == {"glm-ds"}

    def test_id_field_value_is_irrelevant(self):
        """`id` is never used as a lookup key, so its value (CLI shorthand,
        full model ID, anything else) doesn't matter to the filter."""
        templates = [{"id": "t", "config": {"agents": {"planner": {"model": "alt"}}}}]
        models = {"alt": {"id": "claude-opus-4-6-direct", "env": {}}}
        assert collect_referenced_model_aliases(templates, models) == {"alt"}

    def test_unknown_alias_silently_dropped(self):
        """Typo or stale reference: not in models map, just skipped."""
        templates = [{"id": "t", "config": {"agents": {"planner": {"model": "typo"}}}}]
        assert collect_referenced_model_aliases(templates, {"opus": "x"}) == set()

    def test_multiple_agents_multiple_aliases(self):
        templates = [{
            "id": "t",
            "config": {
                "agents": {
                    "planner": {"model": "opus"},
                    "implementer": {"model": "sonnet"},
                    "tester": {"model": "sonnet"},  # dedup
                },
            },
        }]
        models = {"opus": "x", "sonnet": "y", "haiku": "z"}
        assert collect_referenced_model_aliases(templates, models) == {"opus", "sonnet"}

    def test_multiple_templates_union(self):
        templates = [
            {"id": "a", "config": {"agents": {"planner": {"model": "opus"}}}},
            {"id": "b", "config": {"agents": {"planner": {"model": "sonnet"}}}},
        ]
        models = {"opus": "x", "sonnet": "y", "haiku": "z"}
        assert collect_referenced_model_aliases(templates, models) == {"opus", "sonnet"}

    def test_malformed_inputs_dont_crash(self):
        """Tolerate non-dict templates, non-dict configs, non-dict agents."""
        templates = [
            None,  # type: ignore
            "not a dict",  # type: ignore
            {"id": "ok", "config": None},
            {"id": "ok2", "config": {"agents": "not a dict"}},
            {"id": "ok3", "config": {"agents": {"planner": "not a dict"}}},
            {"id": "ok4", "config": {"agents": {"planner": {"model": 123}}}},  # non-string model
        ]
        assert collect_referenced_model_aliases(templates, {"opus": "x"}) == set()
