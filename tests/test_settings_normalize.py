"""Tests for worca.utils.settings.normalize_model_entry."""
import pytest

from worca.utils.settings import normalize_model_entry


class TestNormalizeModelEntry:
    def test_normalize_string_form(self):
        result = normalize_model_entry("claude-opus-4-6")
        assert result == {"id": "claude-opus-4-6", "env": {}}

    def test_normalize_full_object(self):
        original_env = {"K": "v"}
        result = normalize_model_entry({"id": "x", "env": original_env})
        assert result == {"id": "x", "env": {"K": "v"}}
        assert result["env"] is not original_env

    def test_normalize_object_no_env(self):
        result = normalize_model_entry({"id": "x"})
        assert result == {"id": "x", "env": {}}

    def test_normalize_extra_keys_ignored(self):
        result = normalize_model_entry({"id": "x", "env": {}, "future_field": 42})
        assert result == {"id": "x", "env": {}}

    def test_normalize_missing_id_raises(self):
        with pytest.raises(ValueError, match="string ID"):
            normalize_model_entry({"env": {}})

    def test_normalize_id_not_string_raises(self):
        with pytest.raises(ValueError, match="string ID"):
            normalize_model_entry({"id": 42})

    def test_normalize_env_not_dict_raises(self):
        with pytest.raises(ValueError, match="dict"):
            normalize_model_entry({"id": "x", "env": "not-a-dict"})

    def test_normalize_unknown_type_raises(self):
        with pytest.raises(ValueError, match="string ID"):
            normalize_model_entry(42)
