"""Tests for settings migration logic in src/worca/cli/init.py.

Covers:
- governance.dispatch → governance.subagent_dispatch migration (§5.4)
- governance.subagent_dispatch → governance.dispatch.subagents (W-054 §9)
- Global key extraction to ~/.worca/settings.json (§11b step 1)
- Inert milestone key stripping (§11b step 2)
"""

import copy
import json
import os
from pathlib import Path

from worca.cli.init import (
    _deep_merge,
    _migrate_dispatch_governance,
    _migrate_global_keys_to_preferences,
    _migrate_settings_paths,
    _strip_inert_milestone_keys,
)
from worca.hooks.tracking import _DISPATCH_DEFAULTS

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
    """governance.dispatch key is migrated through to governance.dispatch.subagents (W-038 + W-054)."""
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
    assert "subagent_dispatch" not in governance
    assert "subagents" in governance["dispatch"]
    assert any("dispatch" in c for c in changes)


def test_migrate_dispatch_replaces_wrong_values():
    """Old pipeline-agent values are replaced with subagent-type defaults (W-038), then nested (W-054)."""
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
    per_agent = migrated["worca"]["governance"]["dispatch"]["subagents"]["per_agent_allow"]
    for agent, expected in _NEW_DEFAULTS.items():
        assert per_agent[agent] == expected


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


def test_migrate_subagent_dispatch_to_nested():
    """subagent_dispatch is migrated to nested dispatch.subagents (W-054)."""
    existing = {
        "planner": ["Explore"],
        "implementer": ["Explore", "feature-dev:code-reviewer"],
    }
    settings = {
        "worca": {
            "governance": {
                "subagent_dispatch": copy.deepcopy(existing),
            }
        }
    }
    migrated, changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "subagent_dispatch" not in governance
    per_agent = governance["dispatch"]["subagents"]["per_agent_allow"]
    assert per_agent["planner"] == existing["planner"]
    assert per_agent["implementer"] == existing["implementer"]
    assert any("W-054" in c for c in changes)


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


def test_migrate_old_dispatch_legacy_dropped_after_full_migration():
    """W-038 stashes _dispatch_legacy, W-054 drops it."""
    old_values = {
        "planner": [],
        "coordinator": ["implementer"],
        "implementer": [],
        "tester": [],
        "guardian": [],
    }
    settings = {"worca": {"governance": {"dispatch": old_values}}}
    migrated, _changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "_dispatch_legacy" not in governance


def test_migrate_empty_dispatch_gets_nested_shape():
    """Empty old dispatch config → nested W-054 shape with defaults."""
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
    migrated, _changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "_dispatch_legacy" not in governance
    assert "subagent_dispatch" not in governance
    assert "subagents" in governance["dispatch"]


def test_migrate_empty_dict_dispatch_gets_nested_shape():
    """dispatch: {} → nested W-054 shape with defaults."""
    settings = {"worca": {"governance": {"dispatch": {}}}}
    migrated, _changes = _migrate_settings_paths(settings)
    governance = migrated["worca"]["governance"]
    assert "_dispatch_legacy" not in governance
    assert "subagent_dispatch" not in governance
    assert "subagents" in governance["dispatch"]


def test_migrate_normalizes_lowercase_explore_then_nests():
    """Lowercase "explore" is normalized (W-038 casing fix) then nested (W-054)."""
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
    per_agent = migrated["worca"]["governance"]["dispatch"]["subagents"]["per_agent_allow"]
    assert per_agent["planner"] == ["Explore"]
    assert per_agent["implementer"] == ["Explore", "feature-dev:code-reviewer"]
    assert per_agent["coordinator"] == []
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
    """Non-explore entries (plugin subagents, custom names) are left alone through the full migration."""
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
    per_agent = migrated["worca"]["governance"]["dispatch"]["subagents"]["per_agent_allow"]
    assert per_agent["planner"] == [
        "Explore",
        "feature-dev:code-reviewer",
        "custom",
    ]


# ── W-054 §9: _migrate_dispatch_governance ───────────────────────────


class TestMigrateDispatchGovernance:
    """governance.subagent_dispatch → governance.dispatch.subagents (W-054)."""

    def test_legacy_shape_migrated_to_nested_dispatch(self):
        """subagent_dispatch per-agent values land under dispatch.subagents.per_agent_allow."""
        governance_cfg = {
            "subagent_dispatch": {
                "planner": ["Explore"],
                "coordinator": [],
                "implementer": ["Explore", "feature-dev:code-reviewer"],
                "tester": ["Explore"],
                "guardian": ["Explore"],
                "reviewer": ["Explore"],
                "plan_reviewer": ["Explore"],
                "learner": ["Explore"],
            },
            "guards": {"block_rm_rf": True},
        }
        changes = []
        _migrate_dispatch_governance(governance_cfg, changes)

        assert "subagent_dispatch" not in governance_cfg
        per_agent = governance_cfg["dispatch"]["subagents"]["per_agent_allow"]
        assert per_agent["planner"] == ["Explore"]
        assert per_agent["implementer"] == ["Explore", "feature-dev:code-reviewer"]
        assert per_agent["coordinator"] == []
        assert governance_cfg["guards"] == {"block_rm_rf": True}
        assert len(changes) == 1

    def test_defaults_seeded_from_dispatch_defaults(self):
        """_defaults is seeded from _DISPATCH_DEFAULTS — fixes §1.2 workspace_planner defect."""
        governance_cfg = {
            "subagent_dispatch": {
                "planner": ["Explore"],
                "implementer": ["Explore"],
            }
        }
        changes = []
        _migrate_dispatch_governance(governance_cfg, changes)

        per_agent = governance_cfg["dispatch"]["subagents"]["per_agent_allow"]
        assert "_defaults" in per_agent
        assert per_agent["_defaults"] == _DISPATCH_DEFAULTS["subagents"]["per_agent_allow"]["_defaults"]

    def test_existing_defaults_not_overwritten(self):
        """If _defaults already exists (e.g. partially migrated), preserve it."""
        governance_cfg = {
            "subagent_dispatch": {
                "_defaults": ["Explore", "feature-dev:code-reviewer"],
                "planner": ["Explore"],
            }
        }
        changes = []
        _migrate_dispatch_governance(governance_cfg, changes)

        per_agent = governance_cfg["dispatch"]["subagents"]["per_agent_allow"]
        assert per_agent["_defaults"] == ["Explore", "feature-dev:code-reviewer"]

    def test_dispatch_legacy_dropped(self):
        """_dispatch_legacy stash from W-038 migration is cleaned up."""
        governance_cfg = {
            "subagent_dispatch": {"planner": ["Explore"]},
            "_dispatch_legacy": {"coordinator": ["implementer"]},
        }
        changes = []
        _migrate_dispatch_governance(governance_cfg, changes)

        assert "_dispatch_legacy" not in governance_cfg

    def test_tools_section_added_with_defaults(self):
        """tools section is seeded from _DISPATCH_DEFAULTS."""
        governance_cfg = {"subagent_dispatch": {"planner": ["Explore"]}}
        changes = []
        _migrate_dispatch_governance(governance_cfg, changes)

        tools = governance_cfg["dispatch"]["tools"]
        assert tools["always_disallowed"] == _DISPATCH_DEFAULTS["tools"]["always_disallowed"]
        assert tools["default_denied"] == _DISPATCH_DEFAULTS["tools"]["default_denied"]
        assert tools["per_agent_allow"] == _DISPATCH_DEFAULTS["tools"]["per_agent_allow"]

    def test_skills_section_added_with_defaults(self):
        """skills section is seeded from _DISPATCH_DEFAULTS."""
        governance_cfg = {"subagent_dispatch": {"planner": ["Explore"]}}
        changes = []
        _migrate_dispatch_governance(governance_cfg, changes)

        skills = governance_cfg["dispatch"]["skills"]
        assert skills["always_disallowed"] == _DISPATCH_DEFAULTS["skills"]["always_disallowed"]
        assert skills["default_denied"] == _DISPATCH_DEFAULTS["skills"]["default_denied"]
        assert skills["per_agent_allow"] == _DISPATCH_DEFAULTS["skills"]["per_agent_allow"]

    def test_subagents_always_disallowed_and_default_denied_seeded(self):
        """subagents section gets always_disallowed + default_denied from defaults."""
        governance_cfg = {"subagent_dispatch": {"planner": ["Explore"]}}
        changes = []
        _migrate_dispatch_governance(governance_cfg, changes)

        subagents = governance_cfg["dispatch"]["subagents"]
        assert subagents["always_disallowed"] == _DISPATCH_DEFAULTS["subagents"]["always_disallowed"]
        assert subagents["default_denied"] == _DISPATCH_DEFAULTS["subagents"]["default_denied"]

    def test_idempotent_rerun_produces_no_changes(self):
        """Running migration twice doesn't double-apply or generate spurious changes."""
        governance_cfg = {
            "subagent_dispatch": {
                "planner": ["Explore"],
                "implementer": ["Explore", "feature-dev:code-reviewer"],
            }
        }
        changes1 = []
        _migrate_dispatch_governance(governance_cfg, changes1)
        assert len(changes1) == 1

        snapshot = copy.deepcopy(governance_cfg)
        changes2 = []
        _migrate_dispatch_governance(governance_cfg, changes2)
        assert changes2 == []
        assert governance_cfg == snapshot

    def test_noop_when_no_subagent_dispatch(self):
        """Settings without subagent_dispatch pass through unchanged."""
        governance_cfg = {"guards": {"block_rm_rf": True}}
        changes = []
        _migrate_dispatch_governance(governance_cfg, changes)

        assert changes == []
        assert governance_cfg == {"guards": {"block_rm_rf": True}}

    def test_tools_skills_not_overwritten_if_already_present(self):
        """Pre-existing tools/skills sections (partial migration) are preserved."""
        custom_tools = {
            "always_disallowed": ["EnterPlanMode"],
            "default_denied": ["Bash"],
            "per_agent_allow": {"_defaults": ["*"]},
        }
        governance_cfg = {
            "subagent_dispatch": {"planner": ["Explore"]},
            "dispatch": {"tools": copy.deepcopy(custom_tools)},
        }
        changes = []
        _migrate_dispatch_governance(governance_cfg, changes)

        assert governance_cfg["dispatch"]["tools"] == custom_tools

    def test_wired_into_migrate_settings_paths(self):
        """_migrate_settings_paths calls _migrate_dispatch_governance."""
        settings = {
            "worca": {
                "governance": {
                    "subagent_dispatch": {
                        "planner": ["Explore"],
                        "implementer": ["Explore"],
                    }
                }
            }
        }
        migrated, changes = _migrate_settings_paths(settings)
        governance = migrated["worca"]["governance"]
        assert "subagent_dispatch" not in governance
        assert "dispatch" in governance
        assert "subagents" in governance["dispatch"]
        assert any("W-054" in c for c in changes)

    def test_migrate_then_deep_merge_with_template_no_cycle(self):
        """Migration → deep-merge with template → re-migration must not re-add stale keys.

        Regression: if the bundled settings.json template still contains
        subagent_dispatch, _deep_merge re-introduces it after migration removes
        it — causing a destructive cycle on the next --upgrade where
        per_agent.update(old) overwrites user customizations.
        """
        user_settings = {
            "worca": {
                "governance": {
                    "subagent_dispatch": {
                        "planner": ["Explore"],
                        "implementer": ["Explore", "feature-dev:code-reviewer"],
                        "coordinator": [],
                    }
                }
            }
        }
        migrated, _ = _migrate_settings_paths(user_settings)
        assert "subagent_dispatch" not in migrated["worca"]["governance"]
        user_custom = migrated["worca"]["governance"]["dispatch"]["subagents"]["per_agent_allow"]["implementer"]
        assert user_custom == ["Explore", "feature-dev:code-reviewer"]

        template_path = Path(__file__).parent.parent / "src" / "worca" / "settings.json"
        with open(template_path) as f:
            template = json.load(f)

        merged = _deep_merge(migrated, template)
        assert "subagent_dispatch" not in merged["worca"]["governance"], (
            "deep-merge with template must not re-add stale subagent_dispatch key"
        )

        merged2, changes2 = _migrate_settings_paths(merged)
        assert "subagent_dispatch" not in merged2["worca"]["governance"]
        assert not any("W-054" in c for c in changes2), (
            "re-migration should be a no-op — no dispatch changes recorded"
        )
        impl = merged2["worca"]["governance"]["dispatch"]["subagents"]["per_agent_allow"]["implementer"]
        assert impl == ["Explore", "feature-dev:code-reviewer"], (
            "user customization must survive the migrate→merge→re-migrate cycle"
        )


class TestSkillHookRegistration:
    """W-054: hooks.PreToolUse[matcher=Skill] must be auto-wired on upgrade.

    Without explicit injection, _deep_merge treats the existing PreToolUse
    list as a scalar and silently drops the template's Skill matcher —
    leaving skill_use.py dead and governance.dispatch.skills unenforced.
    """

    def _skill_hook_entries(self, settings):
        entries = settings.get("hooks", {}).get("PreToolUse", [])
        return [
            e for e in entries
            if any(
                h.get("command", "").endswith("skill_use.py")
                or h.get("command", "").endswith('skill_use.py"')
                for h in e.get("hooks", [])
            )
        ]

    def test_injected_when_pretooluse_has_other_matchers(self):
        """Existing Bash|Write|Edit matcher must not block Skill injection."""
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash|Write|Edit",
                        "hooks": [{"type": "command", "command": "python3 .../pre_tool_use.py"}],
                    }
                ]
            }
        }
        migrated, changes = _migrate_settings_paths(settings)
        skill_entries = self._skill_hook_entries(migrated)
        assert len(skill_entries) == 1
        assert skill_entries[0]["matcher"] == "Skill"
        assert any("PreToolUse[Skill]" in c for c in changes)

    def test_injected_when_pretooluse_missing(self):
        """Fresh project with no PreToolUse array still gets the Skill hook."""
        settings = {}
        migrated, _changes = _migrate_settings_paths(settings)
        skill_entries = self._skill_hook_entries(migrated)
        assert len(skill_entries) == 1
        assert skill_entries[0]["matcher"] == "Skill"

    def test_idempotent_when_already_present(self):
        """Re-running upgrade must not duplicate the Skill matcher."""
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash|Write|Edit",
                        "hooks": [{"type": "command", "command": "python3 .../pre_tool_use.py"}],
                    }
                ]
            }
        }
        first, first_changes = _migrate_settings_paths(settings)
        second, second_changes = _migrate_settings_paths(first)
        skill_entries = self._skill_hook_entries(second)
        assert len(skill_entries) == 1
        assert any("PreToolUse[Skill]" in c for c in first_changes)
        assert not any("PreToolUse[Skill]" in c for c in second_changes), (
            "second upgrade must be a no-op for Skill hook"
        )

    def test_existing_skill_matcher_preserved(self):
        """User-customized Skill matcher (e.g. different command path) is untouched."""
        custom_command = "python3 /custom/path/to/skill_use.py"
        settings = {
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Skill",
                        "hooks": [{"type": "command", "command": custom_command}],
                    }
                ]
            }
        }
        migrated, changes = _migrate_settings_paths(settings)
        skill_entries = self._skill_hook_entries(migrated)
        assert len(skill_entries) == 1
        assert skill_entries[0]["hooks"][0]["command"] == custom_command
        assert not any("PreToolUse[Skill]" in c for c in changes)


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
