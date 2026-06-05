"""Tests for worca.utils.settings.resolve_model."""
import pytest

from worca.utils.settings import resolve_model


class TestResolveModel:
    def test_resolve_known_string(self):
        result = resolve_model("opus", {"opus": "claude-opus-4-6"})
        assert result == ("claude-opus-4-6", {})

    def test_resolve_known_object(self):
        result = resolve_model("alt", {"alt": {"id": "x", "env": {"A": "1"}}})
        assert result == ("x", {"A": "1"})

    def test_resolve_unknown_passthrough(self):
        result = resolve_model("custom-id", {})
        assert result == ("custom-id", {})

    def test_resolve_falls_back_to_default_map(self):
        result = resolve_model("opus", {})
        assert result == ("claude-opus-4-7", {})

    def test_resolve_none_name(self):
        result = resolve_model(None, {})
        assert result == (None, {})

    def test_resolve_propagates_normalize_errors(self):
        with pytest.raises(ValueError):
            resolve_model("bad", {"bad": {"env": {}}})

    def test_resolve_all_default_models(self):
        assert resolve_model("opus", {}) == ("claude-opus-4-7", {})
        assert resolve_model("sonnet", {}) == ("claude-sonnet-4-6", {})
        assert resolve_model("haiku", {}) == ("claude-haiku-4-5-20251001", {})

    def test_resolve_settings_override_default(self):
        result = resolve_model("opus", {"opus": "claude-opus-4-99-custom"})
        assert result == ("claude-opus-4-99-custom", {})
