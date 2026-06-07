"""Cross-tier whole-entry replace for `worca.models.*` and `worca.pricing.models.*`.

The Models page treats each alias as resolving from exactly one tier
(Project shadows User shadows Built-in, in entirety). Within a single tier
the `settings.json` / `settings.local.json` id/env split still composes —
that's a storage detail, not a separate tier.

These tests pin the semantics on `load_settings_with_global_fallback` and the
underlying `_replace_atomic_subkeys` helper so a future refactor that
accidentally re-enables field-level deep-merge across tiers gets caught.
"""

import json

from worca.utils.settings import (
    _ATOMIC_LEAF_PATHS,
    _replace_atomic_subkeys,
    deep_merge,
    load_settings_with_global_fallback,
)


class TestReplaceAtomicSubkeys:
    """The post-deep-merge fixup that swaps whole entries for atomic-leaf paths."""

    def test_replaces_overlapping_alias_entirely(self):
        merged = {
            "worca": {
                "models": {
                    "opus": {"id": "X", "env": {"A": "1"}},
                }
            }
        }
        project = {
            "worca": {
                "models": {
                    "opus": {"id": "Y"},
                }
            }
        }
        _replace_atomic_subkeys(merged, project, ("worca", "models"))
        # Whole-entry replace — env block is gone.
        assert merged["worca"]["models"]["opus"] == {"id": "Y"}

    def test_leaves_global_only_alias_untouched(self):
        merged = {
            "worca": {
                "models": {
                    "glmds": {"id": "Z", "env": {"B": "2"}},
                    "opus": {"id": "Y"},
                }
            }
        }
        project = {"worca": {"models": {"opus": {"id": "Y"}}}}
        _replace_atomic_subkeys(merged, project, ("worca", "models"))
        assert merged["worca"]["models"]["glmds"] == {"id": "Z", "env": {"B": "2"}}
        assert merged["worca"]["models"]["opus"] == {"id": "Y"}

    def test_path_partial_no_op(self):
        """If either side doesn't reach the full path, silently no-op."""
        merged = {"worca": {}}
        project = {"worca": {"models": {"opus": {"id": "Y"}}}}
        _replace_atomic_subkeys(merged, project, ("worca", "models"))
        # merged was missing the leaf — left alone.
        assert merged == {"worca": {}}

    def test_pricing_models_path_also_atomic(self):
        merged = {
            "worca": {
                "pricing": {
                    "models": {
                        "opus": {"input_per_mtok": 1.0, "output_per_mtok": 2.0},
                    }
                }
            }
        }
        project = {
            "worca": {"pricing": {"models": {"opus": {"input_per_mtok": 3.0}}}}
        }
        _replace_atomic_subkeys(merged, project, ("worca", "pricing", "models"))
        # output_per_mtok from global is dropped — project wins entirely.
        assert merged["worca"]["pricing"]["models"]["opus"] == {"input_per_mtok": 3.0}

    def test_atomic_leaf_paths_constant_intent(self):
        """The shipped atomic paths cover both model aliases and per-model pricing."""
        assert ("worca", "models") in _ATOMIC_LEAF_PATHS
        assert ("worca", "pricing", "models") in _ATOMIC_LEAF_PATHS


class TestLoadSettingsWithGlobalFallbackModelsAtomic:
    """Integration: the public loader applies atomic replace after deep_merge."""

    def test_project_alias_shadows_user_alias_entirely(self, tmp_path):
        global_file = tmp_path / "global" / "settings.json"
        global_file.parent.mkdir()
        global_file.write_text(
            json.dumps(
                {
                    "worca": {
                        "models": {
                            "opus": {
                                "id": "claude-opus-4-7",
                                "env": {"ANTHROPIC_BASE_URL": "https://my-proxy/"},
                            },
                        }
                    }
                }
            )
        )
        project_file = tmp_path / "project" / "settings.json"
        project_file.parent.mkdir()
        project_file.write_text(
            json.dumps({"worca": {"models": {"opus": {"id": "claude-opus-4-8"}}}})
        )

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        # Project's id wins AND user's env is dropped — whole-entry replace.
        assert result["worca"]["models"]["opus"] == {"id": "claude-opus-4-8"}

    def test_user_only_alias_survives_unchanged(self, tmp_path):
        global_file = tmp_path / "global" / "settings.json"
        global_file.parent.mkdir()
        global_file.write_text(
            json.dumps(
                {
                    "worca": {
                        "models": {
                            "glmds": {
                                "id": "zai-glm-4",
                                "env": {"ANTHROPIC_BASE_URL": "https://glm/"},
                            }
                        }
                    }
                }
            )
        )
        project_file = tmp_path / "project" / "settings.json"
        project_file.parent.mkdir()
        project_file.write_text(json.dumps({"worca": {}}))

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        # Project doesn't define glmds — user-tier entry resolves verbatim.
        assert result["worca"]["models"]["glmds"] == {
            "id": "zai-glm-4",
            "env": {"ANTHROPIC_BASE_URL": "https://glm/"},
        }

    def test_non_model_paths_still_deep_merge(self, tmp_path):
        """The atomic-replace rule only applies to the listed paths.

        Cross-tier composition of `pricing.server_tools`, `stages.*`, etc.
        must still deep-merge — that's the cross-template config that the
        worca runtime expects to compose normally.
        """
        global_file = tmp_path / "global" / "settings.json"
        global_file.parent.mkdir()
        global_file.write_text(
            json.dumps(
                {
                    "worca": {
                        "pricing": {
                            "currency": "USD",
                            "server_tools": {"web_search_per_request": 0.01},
                        }
                    }
                }
            )
        )
        project_file = tmp_path / "project" / "settings.json"
        project_file.parent.mkdir()
        project_file.write_text(
            json.dumps(
                {
                    "worca": {
                        "pricing": {
                            "server_tools": {"web_fetch_per_request": 0.02},
                        }
                    }
                }
            )
        )

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        # currency from global survives, both server_tools rates merged.
        assert result["worca"]["pricing"]["currency"] == "USD"
        assert result["worca"]["pricing"]["server_tools"] == {
            "web_search_per_request": 0.01,
            "web_fetch_per_request": 0.02,
        }

    def test_pricing_models_alias_replaced_entirely(self, tmp_path):
        global_file = tmp_path / "global" / "settings.json"
        global_file.parent.mkdir()
        global_file.write_text(
            json.dumps(
                {
                    "worca": {
                        "pricing": {
                            "models": {
                                "opus": {
                                    "input_per_mtok": 10.0,
                                    "output_per_mtok": 50.0,
                                    "cache_read_per_mtok": 1.5,
                                }
                            }
                        }
                    }
                }
            )
        )
        project_file = tmp_path / "project" / "settings.json"
        project_file.parent.mkdir()
        project_file.write_text(
            json.dumps(
                {
                    "worca": {
                        "pricing": {"models": {"opus": {"input_per_mtok": 7.5}}}
                    }
                }
            )
        )

        result = load_settings_with_global_fallback(
            str(project_file), global_path=str(global_file)
        )

        # output_per_mtok and cache_read_per_mtok from global are dropped.
        assert result["worca"]["pricing"]["models"]["opus"] == {"input_per_mtok": 7.5}


class TestDeepMergeUnchanged:
    """Sanity check: `deep_merge` itself was not touched by the atomic-replace work."""

    def test_deep_merge_still_recursive(self):
        a = {"x": {"y": 1, "z": 2}}
        b = {"x": {"z": 99, "w": 3}}
        result = deep_merge(a, b)
        assert result == {"x": {"y": 1, "z": 99, "w": 3}}
        # input dicts untouched
        assert a == {"x": {"y": 1, "z": 2}}
        assert b == {"x": {"z": 99, "w": 3}}
