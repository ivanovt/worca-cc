"""Tests for worca.utils.env.filter_model_env."""

import json
from pathlib import Path

from worca.utils.env import filter_model_env, RESERVED_ENV_KEYS, RESERVED_PREFIXES


class TestFilterModelEnv:
    def test_filter_passes_through_anthropic_keys(self):
        safe, dropped = filter_model_env({
            "ANTHROPIC_BASE_URL": "u",
            "API_TIMEOUT_MS": "5000",
        })
        assert safe == {"ANTHROPIC_BASE_URL": "u", "API_TIMEOUT_MS": "5000"}
        assert dropped == []

    def test_filter_strips_path(self):
        safe, dropped = filter_model_env({"PATH": "/tmp"})
        assert safe == {}
        assert dropped == ["PATH"]

    def test_filter_strips_claudecode(self):
        safe, dropped = filter_model_env({"CLAUDECODE": "1"})
        assert safe == {}
        assert dropped == ["CLAUDECODE"]

    def test_filter_strips_worca_prefix(self):
        safe, dropped = filter_model_env({
            "WORCA_FOO": "x",
            "WORCA_RUN_ID": "y",
        })
        assert safe == {}
        assert len(dropped) == 2
        assert "WORCA_FOO" in dropped
        assert "WORCA_RUN_ID" in dropped

    def test_filter_mixed_pass_and_strip(self):
        safe, dropped = filter_model_env({
            "ANTHROPIC_AUTH_TOKEN": "sk",
            "PATH": "/tmp",
            "WORCA_X": "v",
        })
        assert safe == {"ANTHROPIC_AUTH_TOKEN": "sk"}
        assert sorted(dropped) == ["PATH", "WORCA_X"]

    def test_filter_coerces_values_to_str(self):
        safe, dropped = filter_model_env({"ANTHROPIC_BASE_URL": 42})
        assert safe == {"ANTHROPIC_BASE_URL": "42"}
        assert dropped == []

    def test_filter_empty_input(self):
        safe, dropped = filter_model_env({})
        assert safe == {}
        assert dropped == []


class TestReservedConstants:
    def test_reserved_env_keys_contains_path(self):
        assert "PATH" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_claudecode(self):
        assert "CLAUDECODE" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_agent(self):
        assert "WORCA_AGENT" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_project_root(self):
        assert "WORCA_PROJECT_ROOT" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_run_id(self):
        assert "WORCA_RUN_ID" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_run_dir(self):
        assert "WORCA_RUN_DIR" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_plan_file(self):
        assert "WORCA_PLAN_FILE" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_events_path(self):
        assert "WORCA_EVENTS_PATH" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_target_branch(self):
        assert "WORCA_TARGET_BRANCH" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_coverage(self):
        assert "WORCA_COVERAGE" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_skip_beads(self):
        assert "WORCA_SKIP_BEADS" in RESERVED_ENV_KEYS

    def test_reserved_env_keys_contains_worca_claude_bin(self):
        assert "WORCA_CLAUDE_BIN" in RESERVED_ENV_KEYS

    def test_reserved_prefixes_contains_worca(self):
        assert "WORCA_" in RESERVED_PREFIXES

    def test_reserved_env_keys_is_frozenset(self):
        assert isinstance(RESERVED_ENV_KEYS, frozenset)

    def test_reserved_keys_match_shared_json_file(self):
        # Guard against drift: env.py and worca-ui/server/reserved-env-keys.json
        # must list the same denied keys/prefixes. Any divergence is a bug
        # because the JS server enforces from JSON while the Python runtime
        # enforces from the frozenset.
        json_path = Path(__file__).resolve().parent.parent / "worca-ui" / "server" / "reserved-env-keys.json"
        data = json.loads(json_path.read_text())
        json_keys = set(data["keys"])
        only_in_python = RESERVED_ENV_KEYS - json_keys
        only_in_json = json_keys - RESERVED_ENV_KEYS
        assert not only_in_python and not only_in_json, (
            f"reserved-env-keys.json out of sync with RESERVED_ENV_KEYS: "
            f"only in Python={sorted(only_in_python)}, "
            f"only in JSON={sorted(only_in_json)}"
        )
        assert RESERVED_PREFIXES == tuple(data["prefixes"]), (
            f"prefixes out of sync: Python={RESERVED_PREFIXES} "
            f"vs JSON={tuple(data['prefixes'])}"
        )
