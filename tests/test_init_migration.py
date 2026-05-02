"""Tests for settings migration logic in src/worca/cli/init.py.

Covers:
- governance.dispatch → governance.subagent_dispatch migration (§5.4)
- Global key extraction to ~/.worca/settings.json (§11b step 1)
- Inert milestone key stripping (§11b step 2)
"""

import json
import os
from pathlib import Path

from worca.cli.init import (
    _migrate_global_keys_to_preferences,
    _migrate_settings_paths,
    _strip_inert_milestone_keys,
)

_FIXTURE_PATH = Path(__file__).parent / "fixtures" / "migration_strip_io.json"


def _load_fixture_cases():
    with open(_FIXTURE_PATH) as f:
        return json.load(f)["cases"]


def _find_case(name):
    for case in _load_fixture_cases():
        if case["name"] == name:
            return case
    raise ValueError(f"fixture case not found: {name}")


_NEW_DEFAULTS = {
    "planner": ["Explore"],
    "coordinator": [],
    "implementer": ["Explore"],
    "tester": ["Explore"],
    "guardian": ["Explore"],
    "reviewer": ["Explore"],
    "plan_reviewer": ["Explore"],
    "learner": ["Explore"],
}


def test_migrate_dispatch_to_subagent_dispatch():
    """governance.dispatch key is renamed to governance.subagent_dispatch."""
    settings = {
        "worca": {
            "governance": {
                "guards": {"block_rm_rf": True},
                "dispatch": {
                    "planner": [],
                    "coordinator": ["implementer"],
                    "implementer": [],
                    "tester": [],
                    "guardian": [],
                },
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "dispatch" not in governance
    assert "subagent_dispatch" in governance
    assert any("dispatch" in c and "subagent_dispatch" in c for c in changes)


def test_migrate_dispatch_replaces_wrong_values():
    """Old pipeline-agent values are replaced with subagent-type defaults."""
    settings = {
        "worca": {
            "governance": {
                "dispatch": {
                    "planner": [],
                    "coordinator": ["implementer"],
                    "implementer": [],
                    "tester": [],
                    "guardian": [],
                },
            }
        }
    }
    migrated, _changes = _migrate_settings_paths(settings)
    subagent_dispatch = migrated["worca"]["governance"]["subagent_dispatch"]
    assert subagent_dispatch == _NEW_DEFAULTS


def test_migrate_preserves_other_governance_keys():
    """guards, test_gate_strikes and other governance keys are untouched."""
    settings = {
        "worca": {
            "governance": {
                "guards": {
                    "block_rm_rf": True,
                    "block_env_write": True,
                },
                "test_gate_strikes": 2,
                "dispatch": {
                    "planner": [],
                },
            }
        }
    }
    migrated, _changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert governance["guards"] == {"block_rm_rf": True, "block_env_write": True}
    assert governance["test_gate_strikes"] == 2


def test_migrate_no_op_when_subagent_dispatch_exists():
    """Already-migrated settings (subagent_dispatch present) are not modified."""
    existing = {
        "planner": ["Explore"],
        "implementer": ["Explore", "feature-dev:code-reviewer"],
    }
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": existing,
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    # subagent_dispatch preserved as-is
    assert governance["subagent_dispatch"] == existing
    # no dispatch-rename change recorded
    assert not any("dispatch" in c and "subagent_dispatch" in c for c in changes)


def test_migrate_no_op_when_no_dispatch_key():
    """Settings without any dispatch key pass through unchanged."""
    settings = {
        "worca": {
            "governance": {
                "guards": {"block_rm_rf": True},
                "test_gate_strikes": 3,
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "dispatch" not in governance
    assert "subagent_dispatch" not in governance
    assert governance["test_gate_strikes"] == 3
    # no dispatch-rename change recorded
    assert not any("dispatch" in c for c in changes)


def test_migrate_preserves_old_dispatch_values_at_legacy():
    """Non-trivial old dispatch config is stashed at _dispatch_legacy for review."""
    old_values = {
        "planner": [],
        "coordinator": ["implementer"],
        "implementer": [],
        "tester": [],
        "guardian": [],
    }
    settings = {"worca": {"governance": {"dispatch": old_values}}}
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert governance["_dispatch_legacy"] == old_values
    # Change message mentions preservation so the user knows what to look for.
    assert any("_dispatch_legacy" in c for c in changes)


def test_migrate_omits_legacy_when_old_dispatch_empty():
    """Empty old dispatch config is not preserved — keeps settings.json tidy."""
    settings = {
        "worca": {
            "governance": {
                "dispatch": {
                    "planner": [],
                    "coordinator": [],
                    "implementer": [],
                }
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "_dispatch_legacy" not in governance
    assert "subagent_dispatch" in governance
    # No mention of preservation in the change message.
    assert not any("_dispatch_legacy" in c for c in changes)


def test_migrate_omits_legacy_when_old_dispatch_is_empty_dict():
    """dispatch: {} is treated the same as all-empty-values — no legacy stash."""
    settings = {"worca": {"governance": {"dispatch": {}}}}
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "_dispatch_legacy" not in governance
    assert "subagent_dispatch" in governance
    assert not any("_dispatch_legacy" in c for c in changes)


def test_migrate_normalizes_lowercase_explore_to_capitalized():
    """Lowercase "explore" from early W-038 installs is renamed to "Explore"."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {
                    "planner": ["explore"],
                    "implementer": ["explore", "feature-dev:code-reviewer"],
                    "coordinator": [],
                }
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    sd = migrated["worca"]["governance"]["subagent_dispatch"]
    assert sd["planner"] == ["Explore"]
    assert sd["implementer"] == ["Explore", "feature-dev:code-reviewer"]
    assert sd["coordinator"] == []
    assert any('"explore" -> "Explore"' in c for c in changes)


def test_migrate_normalization_no_op_when_already_capitalized():
    """Already-correct "Explore" entries do not trigger a change message."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {"planner": ["Explore"]}
            }
        }
    }
    _migrated, changes = _migrate_settings_paths(settings)
    assert not any('"explore" -> "Explore"' in c for c in changes)


def test_migrate_normalization_preserves_other_values():
    """Non-explore entries (plugin subagents, custom names) are left alone."""
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": {
                    "planner": ["explore", "feature-dev:code-reviewer", "custom"],
                }
            }
        }
    }
    migrated, _changes = _migrate_settings_paths(settings)
    assert migrated["worca"]["governance"]["subagent_dispatch"]["planner"] == [
        "Explore",
        "feature-dev:code-reviewer",
        "custom",
    ]


# ── §11b: _migrate_global_keys_to_preferences ──────────────────────


class TestMigrateGlobalKeysToPreferences:
    def test_extracts_global_keys_to_preferences(self, tmp_path):
        case = _find_case("global_keys_extracted_to_preferences")
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps(case["input"]))

        global_dir = tmp_path / "global"
        global_dir.mkdir()
        global_path = str(global_dir / "settings.json")

        extracted = _migrate_global_keys_to_preferences(
            str(project_file), global_path=global_path
        )

        assert extracted == case["expected_global_extracted"]

        with open(project_file) as f:
            project_after = json.load(f)
        assert project_after == case["expected_project"]

        with open(global_path) as f:
            global_after = json.load(f)
        for section, kvs in case["expected_global_extracted"].items():
            for key, val in kvs.items():
                assert global_after["worca"][section][key] == val

    def test_idempotent_on_second_run(self, tmp_path):
        case = _find_case("global_keys_already_stripped")
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps(case["input"]))

        global_path = str(tmp_path / "global" / "settings.json")

        extracted = _migrate_global_keys_to_preferences(
            str(project_file), global_path=global_path
        )

        assert extracted == {}
        with open(project_file) as f:
            assert json.load(f) == case["expected_project"]

    def test_empty_section_cleaned_up(self, tmp_path):
        case = _find_case("empty_section_cleaned_up")
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps(case["input"]))

        global_dir = tmp_path / "global"
        global_dir.mkdir()
        global_path = str(global_dir / "settings.json")

        extracted = _migrate_global_keys_to_preferences(
            str(project_file), global_path=global_path
        )

        assert extracted == case["expected_global_extracted"]
        with open(project_file) as f:
            project_after = json.load(f)
        assert project_after == case["expected_project"]

    def test_merges_into_existing_global_file(self, tmp_path):
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps({
            "worca": {
                "parallel": {"cleanup_policy": "on-success"},
            }
        }))

        global_dir = tmp_path / "global"
        global_dir.mkdir()
        global_path = str(global_dir / "settings.json")
        with open(global_path, "w") as f:
            json.dump({"worca": {"ui": {"theme": "dark"}}}, f)

        _migrate_global_keys_to_preferences(
            str(project_file), global_path=global_path
        )

        with open(global_path) as f:
            global_after = json.load(f)
        assert global_after["worca"]["ui"]["theme"] == "dark"
        assert global_after["worca"]["parallel"]["cleanup_policy"] == "on-success"

    def test_creates_global_dir_if_missing(self, tmp_path):
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps({
            "worca": {
                "ui": {"worktree_disk_warning_bytes": 1000},
            }
        }))

        global_path = str(tmp_path / "nonexistent" / "settings.json")
        extracted = _migrate_global_keys_to_preferences(
            str(project_file), global_path=global_path
        )

        assert extracted == {"ui": {"worktree_disk_warning_bytes": 1000}}
        assert os.path.exists(global_path)

    def test_missing_project_file_returns_empty(self, tmp_path):
        result = _migrate_global_keys_to_preferences(
            str(tmp_path / "nonexistent.json")
        )
        assert result == {}

    def test_reads_global_keys_from_schema(self):
        """GLOBAL_ONLY_KEYS are read from keys.json, not hardcoded."""
        from worca.utils.settings import GLOBAL_ONLY_KEYS
        expected_keys = [
            ("parallel", "cleanup_policy"),
            ("parallel", "max_concurrent_pipelines"),
            ("ui", "worktree_disk_warning_bytes"),
            ("circuit_breaker", "classifier_model"),
        ]
        assert set(GLOBAL_ONLY_KEYS) == set(expected_keys)


# ── §11b: _strip_inert_milestone_keys ──────────────────────────────


class TestStripInertMilestoneKeys:
    def test_strips_true_pr_and_deploy_approval(self, tmp_path):
        case = _find_case("milestone_strip_pr_approval_true")
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps(case["input"]))

        removed = _strip_inert_milestone_keys(str(project_file))

        assert removed == case["expected_removed_keys"]
        with open(project_file) as f:
            assert json.load(f) == case["expected_project_after_milestone_strip"]

    def test_preserves_false_pr_approval(self, tmp_path):
        case = _find_case("milestone_strip_pr_approval_false_kept")
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps(case["input"]))

        removed = _strip_inert_milestone_keys(str(project_file))

        assert removed == case["expected_removed_keys"]
        with open(project_file) as f:
            assert json.load(f) == case["expected_project_after_milestone_strip"]

    def test_cleans_empty_milestones(self, tmp_path):
        case = _find_case("milestone_strip_empty_milestones_cleaned")
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps(case["input"]))

        removed = _strip_inert_milestone_keys(str(project_file))

        assert removed == case["expected_removed_keys"]
        with open(project_file) as f:
            assert json.load(f) == case["expected_project_after_milestone_strip"]

    def test_no_op_when_no_milestones(self, tmp_path):
        case = _find_case("milestone_strip_no_milestones")
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps(case["input"]))

        removed = _strip_inert_milestone_keys(str(project_file))

        assert removed == case["expected_removed_keys"]
        with open(project_file) as f:
            assert json.load(f) == case["expected_project_after_milestone_strip"]

    def test_idempotent_on_second_run(self, tmp_path):
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps({
            "worca": {
                "milestones": {
                    "plan_approval": True,
                    "pr_approval": True,
                }
            }
        }))

        removed1 = _strip_inert_milestone_keys(str(project_file))
        assert removed1 == ["pr_approval"]

        removed2 = _strip_inert_milestone_keys(str(project_file))
        assert removed2 == []

    def test_missing_project_file_returns_empty(self, tmp_path):
        result = _strip_inert_milestone_keys(str(tmp_path / "nonexistent.json"))
        assert result == []

    def test_non_boolean_values_preserved(self, tmp_path):
        project_file = tmp_path / "settings.json"
        project_file.write_text(json.dumps({
            "worca": {
                "milestones": {
                    "plan_approval": True,
                    "pr_approval": "always",
                    "deploy_approval": 1,
                }
            }
        }))

        removed = _strip_inert_milestone_keys(str(project_file))

        assert removed == []
        with open(project_file) as f:
            ms = json.load(f)["worca"]["milestones"]
        assert ms["pr_approval"] == "always"
        assert ms["deploy_approval"] == 1
