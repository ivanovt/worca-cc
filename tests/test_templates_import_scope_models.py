"""End-to-end coverage for the v2 scope-honest bundle import.

Pins the post-0.52.0 semantics:
1. Templates, model aliases, and pricing land in the SAME tier picked via
   ``--scope`` (project or user). Earlier versions hardcoded models/pricing
   to user-global regardless of ``--scope``; see MIGRATION.md.
2. Each imported model entry is stamped with ``_imported_from: <bundle-name>``
   in settings.json so the Models page can surface an attribution badge.
3. ``_derive_bundle_label`` boils the source down to a short human label
   that matches paths, gist sources, and HTTP URLs.
"""

import json
from argparse import Namespace
from pathlib import Path

import pytest

from worca.cli.templates import (
    _derive_bundle_label,
    cmd_templates_import,
)


class TestDeriveBundleLabel:
    """The label shown on the imported-from badge — short, human-readable."""

    def test_local_file_basename(self):
        assert _derive_bundle_label("/tmp/feature-fast-bundle.json") == "feature-fast-bundle.json"

    def test_relative_path_basename(self):
        assert _derive_bundle_label("./bundles/quick-fix.json") == "quick-fix.json"

    def test_http_url_basename(self):
        assert _derive_bundle_label("https://example.com/path/feature.json") == "feature.json"

    def test_http_url_with_query_string(self):
        assert _derive_bundle_label("https://example.com/feature.json?v=2") == "feature.json"

    def test_http_url_with_fragment(self):
        assert _derive_bundle_label("https://example.com/feature.json#section") == "feature.json"

    def test_gist_id(self):
        # Gist source has no path slashes — full source preserved.
        assert _derive_bundle_label("gist:abcdef123456") == "gist:abcdef123456"

    def test_empty_source(self):
        assert _derive_bundle_label("") == ""

    def test_trailing_slash_stripped(self):
        assert _derive_bundle_label("https://example.com/dir/") == "dir"


def _write_bundle(path: Path, *, with_models: bool = True, with_pricing: bool = True) -> None:
    """Write a minimal v1-shape JSON bundle suitable for cmd_templates_import."""
    manifest = {
        "worca_bundle_version": 1,
        "templates": [
            {
                "id": "imported-tpl",
                "name": "Imported Template",
                "description": "from a bundle",
                "tags": [],
                "params": {},
                "config": {
                    "agents": {
                        "planner": {"model": "custom-alias"},
                    },
                },
            }
        ],
    }
    if with_models:
        manifest["models"] = {
            "custom-alias": {
                "id": "claude-opus-4-7",
                "env": {"ANTHROPIC_BASE_URL": "https://example.com/"},
            }
        }
    if with_pricing:
        manifest["pricing"] = {
            "models": {
                "custom-alias": {
                    "input_per_mtok": 1.5,
                    "output_per_mtok": 7.5,
                }
            }
        }
    path.write_text(json.dumps(manifest), encoding="utf-8")


@pytest.fixture
def project_dir(tmp_path, monkeypatch):
    """A fake project root with .git/ plus a tmp HOME so user-tier writes
    land in `tmp/.worca/` instead of the real `~/.worca/`. WORCA_HOME alone
    isn't enough — the templates resolver uses Path.home() directly, while
    settings.py honors WORCA_HOME. Patching $HOME and exporting WORCA_HOME
    to the same root keeps both paths redirected.
    """
    project = tmp_path / "project"
    project.mkdir()
    (project / ".git").mkdir()  # _find_settings_path walks up to find this
    (project / ".claude").mkdir()
    (project / ".claude" / "templates").mkdir()

    fake_home = tmp_path / "fake-home"
    fake_home.mkdir()
    worca_home = fake_home / ".worca"
    worca_home.mkdir()
    (worca_home / "templates").mkdir()
    monkeypatch.setenv("HOME", str(fake_home))
    monkeypatch.setenv("WORCA_HOME", str(worca_home))

    # cmd_templates_import resolves project settings against cwd → .git walk.
    monkeypatch.chdir(project)
    return project, worca_home


def _make_import_args(*, source: str, scope: str = "project") -> Namespace:
    return Namespace(
        from_source=source,
        scope=scope,
        non_interactive=True,
        on_model_conflict="abort",
        on_template_conflict="abort",
        preview=False,
        resolutions=None,
        project_root=None,
        ext_preview=None,
    )


class TestImportScopeHonesty:
    """`--scope project` lands models in the project's settings.json, not user-global."""

    def test_scope_project_writes_models_to_project_settings(self, project_dir, capsys):
        project, worca_home = project_dir
        bundle = project / "bundle.json"
        _write_bundle(bundle)

        cmd_templates_import(_make_import_args(source=str(bundle), scope="project"))

        project_settings = project / ".claude" / "settings.json"
        assert project_settings.exists()
        data = json.loads(project_settings.read_text())
        assert "custom-alias" in data.get("worca", {}).get("models", {})

        # User-global must remain empty.
        user_settings = worca_home / "settings.json"
        if user_settings.exists():
            user = json.loads(user_settings.read_text())
            assert "custom-alias" not in user.get("worca", {}).get("models", {})

    def test_scope_user_writes_models_to_user_global(self, project_dir, capsys):
        project, worca_home = project_dir
        bundle = project / "bundle.json"
        _write_bundle(bundle)

        cmd_templates_import(_make_import_args(source=str(bundle), scope="user"))

        user_settings = worca_home / "settings.json"
        assert user_settings.exists()
        data = json.loads(user_settings.read_text())
        assert "custom-alias" in data.get("worca", {}).get("models", {})

        # Project's own settings.json must NOT carry the alias.
        project_settings = project / ".claude" / "settings.json"
        if project_settings.exists():
            project_data = json.loads(project_settings.read_text())
            assert "custom-alias" not in project_data.get("worca", {}).get("models", {})


class TestImportProvenanceStamping:
    """Each imported model entry gets ``_imported_from: <bundle-name>``."""

    def test_imported_models_get_imported_from_field(self, project_dir, capsys):
        project, _worca_home = project_dir
        bundle = project / "shareable-bundle.json"
        _write_bundle(bundle)

        cmd_templates_import(_make_import_args(source=str(bundle), scope="project"))

        data = json.loads((project / ".claude" / "settings.json").read_text())
        entry = data["worca"]["models"]["custom-alias"]
        # Object-form preserved; bundle metadata added alongside id.
        assert entry.get("_imported_from") == "shareable-bundle.json"
        assert entry.get("id") == "claude-opus-4-7"

    def test_string_form_alias_is_promoted_to_object_form(self, project_dir, capsys):
        """If the bundle ships an alias as a bare string, the stamp upgrades
        it to the object form `{id, _imported_from}` so the metadata survives.
        """
        project, _ = project_dir
        bundle = project / "bare.json"
        bundle.write_text(
            json.dumps(
                {
                    "worca_bundle_version": 1,
                    "templates": [
                        {
                            "id": "imported-tpl",
                            "name": "T",
                            "description": "",
                            "tags": [],
                            "params": {},
                            "config": {"agents": {"planner": {"model": "bare"}}},
                        }
                    ],
                    "models": {"bare": "claude-opus-4-7"},
                }
            ),
            encoding="utf-8",
        )

        cmd_templates_import(_make_import_args(source=str(bundle), scope="project"))

        data = json.loads((project / ".claude" / "settings.json").read_text())
        entry = data["worca"]["models"]["bare"]
        assert isinstance(entry, dict)
        assert entry["id"] == "claude-opus-4-7"
        assert entry["_imported_from"] == "bare.json"

    def test_pricing_entries_land_in_same_tier_as_models(self, project_dir, capsys):
        project, worca_home = project_dir
        bundle = project / "with-pricing.json"
        _write_bundle(bundle, with_pricing=True)

        cmd_templates_import(_make_import_args(source=str(bundle), scope="project"))

        data = json.loads((project / ".claude" / "settings.json").read_text())
        pricing = data.get("worca", {}).get("pricing", {}).get("models", {})
        assert "custom-alias" in pricing
        assert pricing["custom-alias"]["input_per_mtok"] == 1.5
        assert pricing["custom-alias"]["output_per_mtok"] == 7.5
