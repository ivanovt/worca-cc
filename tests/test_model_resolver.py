"""Tests for worca.utils.settings.resolve_model and resolve_tier_pinned."""
import pytest

from worca.utils.settings import resolve_model, resolve_tier_pinned, _parse_model_ref


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


class TestParseModelRef:
    def test_bare_alias(self):
        assert _parse_model_ref("opus") == (None, "opus")

    def test_user_qualified(self):
        assert _parse_model_ref("user:opus") == ("user", "opus")

    def test_project_qualified(self):
        assert _parse_model_ref("project:mymodel") == ("project", "mymodel")

    def test_builtin_qualified(self):
        assert _parse_model_ref("builtin:sonnet") == ("builtin", "sonnet")

    def test_malformed_empty_alias(self):
        with pytest.raises(ValueError):
            _parse_model_ref("user:")

    def test_malformed_double_colon(self):
        with pytest.raises(ValueError):
            _parse_model_ref("user:foo:bar")

    def test_malformed_unknown_tier(self):
        with pytest.raises(ValueError):
            _parse_model_ref("global:opus")


class TestResolveTierPinned:
    def _settings_with_stash(self, user_models=None, project_models=None, builtin_models=None):
        from worca.utils.settings import _DEFAULT_MODEL_MAP
        return {
            "worca": {
                "models": {**(user_models or {}), **(project_models or {})}
            },
            "_worca_tier_views": {
                "user": user_models or {},
                "project": project_models or {},
                "builtin": {k: v for k, v in (builtin_models or _DEFAULT_MODEL_MAP).items()},
            }
        }

    def test_ref_none_returns_triple_none(self):
        assert resolve_tier_pinned(None, {}) == (None, {}, None)

    def test_bare_matches_resolve_model(self):
        settings = {"worca": {"models": {"mymodel": "claude-x-1"}}}
        result = resolve_tier_pinned("mymodel", settings)
        assert result == ("claude-x-1", {}, None)

    def test_user_wins_over_project_shadow(self):
        settings = self._settings_with_stash(
            user_models={"fast": "claude-user-fast"},
            project_models={"fast": "claude-project-fast"},
        )
        id_, env, err = resolve_tier_pinned("user:fast", settings)
        assert id_ == "claude-user-fast"
        assert env == {}
        assert err is None

    def test_project_wins_over_user_shadow(self):
        settings = self._settings_with_stash(
            user_models={"fast": "claude-user-fast"},
            project_models={"fast": "claude-project-fast"},
        )
        id_, env, err = resolve_tier_pinned("project:fast", settings)
        assert id_ == "claude-project-fast"
        assert err is None

    def test_builtin_tier_resolves(self):
        settings = self._settings_with_stash()
        id_, env, err = resolve_tier_pinned("builtin:opus", settings)
        assert id_ == "claude-opus-4-7"
        assert err is None

    def test_user_alias_absent_returns_error(self):
        settings = self._settings_with_stash(user_models={"other": "x"})
        id_, env, err = resolve_tier_pinned("user:no-such", settings)
        assert id_ is None
        assert "no-such" in err
        assert "user" in err

    def test_malformed_ref_returns_error(self):
        settings = self._settings_with_stash()
        id_, env, err = resolve_tier_pinned("user:", settings)
        assert id_ is None
        assert err is not None
        assert "malformed" in err.lower()

    def test_pinned_without_stash_falls_back_to_merged(self):
        settings = {"worca": {"models": {"mymodel": "claude-x-1"}}}
        id_, env, err = resolve_tier_pinned("user:mymodel", settings)
        assert id_ == "claude-x-1"
        assert err is None

    def test_builtin_pinned_without_stash_uses_default_model_map(self):
        # When there is no _worca_tier_views stash (plain load_settings), builtin:
        # refs must resolve from _DEFAULT_MODEL_MAP, not from the merged models —
        # so user/project haiku shadowing cannot affect title-gen determinism.
        settings = {"worca": {"models": {"haiku": "shadowed-custom-haiku"}}}
        id_, env, err = resolve_tier_pinned("builtin:haiku", settings)
        assert id_ == "claude-haiku-4-5-20251001"
        assert env == {}
        assert err is None

    def test_pinned_with_object_entry(self):
        settings = self._settings_with_stash(
            project_models={"special": {"id": "claude-special", "env": {"TIMEOUT": "30"}}}
        )
        id_, env, err = resolve_tier_pinned("project:special", settings)
        assert id_ == "claude-special"
        assert env == {"TIMEOUT": "30"}
        assert err is None
