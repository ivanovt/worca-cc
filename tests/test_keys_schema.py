"""Drift tests for src/worca/schemas/keys.json — Python side.

Ensures the Python loader reads the same schema that the JS loader reads,
and that the exported constants match the canonical JSON structure.
"""

import json
from pathlib import Path

import pytest

from worca.utils.settings import (
    GLOBAL_DEFAULTS,
    GLOBAL_ONLY_KEYS,
    NORMALIZE_SKIP_KEYS,
    PROJECT_DEFAULTS,
)

SCHEMA_PATH = Path(__file__).resolve().parent.parent / "src" / "worca" / "schemas" / "keys.json"


@pytest.fixture()
def raw_schema():
    return json.loads(SCHEMA_PATH.read_text())


class TestKeysSchemaLoaded:
    def test_global_only_keys_is_list_of_tuples(self):
        assert isinstance(GLOBAL_ONLY_KEYS, list)
        for entry in GLOBAL_ONLY_KEYS:
            assert isinstance(entry, tuple), f"Expected tuple, got {type(entry)}: {entry}"
            assert len(entry) == 2
            assert all(isinstance(s, str) for s in entry)

    def test_normalize_skip_keys_is_list_of_tuples(self):
        assert isinstance(NORMALIZE_SKIP_KEYS, list)
        for entry in NORMALIZE_SKIP_KEYS:
            assert isinstance(entry, tuple), f"Expected tuple, got {type(entry)}: {entry}"
            assert len(entry) == 2

    def test_global_defaults_is_dict(self):
        assert isinstance(GLOBAL_DEFAULTS, dict)
        assert len(GLOBAL_DEFAULTS) > 0

    def test_project_defaults_is_dict(self):
        assert isinstance(PROJECT_DEFAULTS, dict)
        assert len(PROJECT_DEFAULTS) > 0


class TestDriftDetection:
    """Verify the Python exports match the raw JSON — catches stale imports."""

    def test_global_only_keys_matches_json(self, raw_schema):
        expected = [tuple(k) for k in raw_schema["global_only_keys"]]
        assert GLOBAL_ONLY_KEYS == expected

    def test_normalize_skip_keys_matches_json(self, raw_schema):
        expected = [tuple(k) for k in raw_schema["normalize_skip_keys"]]
        assert NORMALIZE_SKIP_KEYS == expected

    def test_global_defaults_matches_json(self, raw_schema):
        assert GLOBAL_DEFAULTS == raw_schema["defaults"]["global"]

    def test_project_defaults_matches_json(self, raw_schema):
        assert PROJECT_DEFAULTS == raw_schema["defaults"]["project"]

    def test_every_global_only_key_has_a_global_default(self, raw_schema):
        for section, key in GLOBAL_ONLY_KEYS:
            assert section in GLOBAL_DEFAULTS, f"Missing section {section!r} in global defaults"
            assert key in GLOBAL_DEFAULTS[section], (
                f"Missing key {key!r} in global defaults[{section!r}]"
            )

    def test_global_only_keys_count(self, raw_schema):
        assert len(GLOBAL_ONLY_KEYS) == 4

    def test_normalize_skip_keys_count(self, raw_schema):
        assert len(NORMALIZE_SKIP_KEYS) == 1

    def test_no_overlap_between_global_only_and_project_keys(self, raw_schema):
        project_keys = set()
        for section, sub in PROJECT_DEFAULTS.items():
            for key in sub:
                project_keys.add((section, key))
        global_only_set = set(GLOBAL_ONLY_KEYS)
        overlap = global_only_set & project_keys
        assert overlap == set(), f"Keys appear in both global_only and project defaults: {overlap}"


class TestTemplateSettingsMatchSchema:
    """The template settings.json must use the same defaults as keys.json.

    Catches fixtures that still hardcode pre-W-049 values
    (e.g. max_concurrent_pipelines:3, cleanup_policy:'on-success', pr_approval:true).
    """

    TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "src" / "worca" / "settings.json"

    @pytest.fixture()
    def template(self):
        return json.loads(self.TEMPLATE_PATH.read_text())

    def test_template_parallel_matches_project_defaults(self, template):
        t_parallel = template["worca"]["parallel"]
        for key, expected in PROJECT_DEFAULTS.get("parallel", {}).items():
            assert t_parallel.get(key) == expected, (
                f"template parallel.{key}={t_parallel.get(key)!r}, "
                f"keys.json project default={expected!r}"
            )

    def test_template_parallel_matches_global_defaults(self, template):
        t_parallel = template["worca"]["parallel"]
        global_only_set = set(GLOBAL_ONLY_KEYS)
        for key, expected in GLOBAL_DEFAULTS.get("parallel", {}).items():
            if ("parallel", key) in global_only_set:
                continue
            assert t_parallel.get(key) == expected, (
                f"template parallel.{key}={t_parallel.get(key)!r}, "
                f"keys.json global default={expected!r}"
            )

    def test_template_omits_pr_approval(self, template):
        """pr_approval is intentionally absent from the template (§11a).

        The runner reads missing-key as false. Leaving the template default
        would activate the PR gate on every upgraded project."""
        t_ms = template["worca"].get("milestones", {})
        assert "pr_approval" not in t_ms, (
            f"template milestones.pr_approval={t_ms.get('pr_approval')!r} "
            f"— should be absent so the runner's missing-key default (false) takes effect"
        )

    def test_template_has_no_global_only_keys(self, template):
        """Global-only keys should not appear in the project template."""
        w = template.get("worca", {})
        for section, key in GLOBAL_ONLY_KEYS:
            section_data = w.get(section, {})
            assert key not in section_data, (
                f"template contains global-only key worca.{section}.{key} "
                f"— it belongs in ~/.worca/settings.json, not the project template"
            )
