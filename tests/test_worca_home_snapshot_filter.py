"""Tests for _snapshot_worca_home ignore filter."""
import os
import tempfile

import pytest


def test_snapshot_worca_home_ignores_ephemeral_files(monkeypatch):
    """_snapshot_worca_home should exclude *.log, *.pid, .DS_Store, and cache/**
    while including durable state files (projects.d/, fleet-runs/, settings.json).
    """
    from tests.conftest import _snapshot_worca_home

    with tempfile.TemporaryDirectory(prefix="worca-home-test-") as tmp:
        monkeypatch.setattr("tests.conftest._REAL_WORCA_HOME", tmp)

        # --- Ignored files (should NOT appear in snapshot) ---
        # *.log
        _touch(tmp, "worca-ui-global.log")
        # *.pid
        _touch(tmp, "worca-ui-global.pid")
        # .DS_Store
        _touch(tmp, ".DS_Store")
        # cache/** (graphify AST cache)
        _touch(tmp, "cache/ast/foo/graph.json")
        _touch(tmp, "cache/ast/bar/baz/data.json")

        # --- Watched files (SHOULD appear in snapshot) ---
        _touch(tmp, "projects.d/myproject.json")
        _touch(tmp, "fleet-runs/abc/status.json")
        _touch(tmp, "settings.json")

        snap = _snapshot_worca_home()

    keys = set(snap.keys())
    normalized = {k.replace(os.sep, "/") for k in keys}

    # Watched files must be present
    assert "projects.d/myproject.json" in normalized
    assert "fleet-runs/abc/status.json" in normalized
    assert "settings.json" in normalized

    # Ignored files must be absent
    assert "worca-ui-global.log" not in normalized
    assert "worca-ui-global.pid" not in normalized
    assert ".DS_Store" not in normalized
    assert "cache/ast/foo/graph.json" not in normalized
    assert "cache/ast/bar/baz/data.json" not in normalized


@pytest.mark.parametrize("test_file", [
    "tests/test_runner_effort.py",
    "tests/test_runner_effort_backfill.py",
    "tests/integration/test_effort_integration.py",
])
def test_effort_files_have_no_allow_worca_writes_marker(test_file):
    """The allow_worca_writes workaround is no longer needed now that
    _snapshot_worca_home filters ephemeral files."""
    import pathlib
    repo_root = pathlib.Path(__file__).resolve().parent.parent
    content = (repo_root / test_file).read_text(encoding="utf-8")
    assert "allow_worca_writes" not in content


def _touch(base: str, relpath: str) -> None:
    """Create an empty file at base/relpath, making parent dirs as needed."""
    full = os.path.join(base, relpath)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write("x")
