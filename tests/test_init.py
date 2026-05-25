"""Tests for WORCA_SKIP_BEADS gate in _init_beads / _upgrade_beads."""

from unittest.mock import patch

from worca.cli.init import _init_beads, _upgrade_beads


def test_init_beads_skipped_when_env_set(monkeypatch, tmp_path):
    """_init_beads returns False without invoking bd when WORCA_SKIP_BEADS=1."""
    monkeypatch.setenv("WORCA_SKIP_BEADS", "1")
    with patch("worca.cli.init.subprocess.run") as mock_run:
        result = _init_beads(tmp_path)
    assert result is False
    mock_run.assert_not_called()


def test_upgrade_beads_skipped_when_env_set(monkeypatch, tmp_path):
    """_upgrade_beads returns False without invoking bd when WORCA_SKIP_BEADS=1."""
    monkeypatch.setenv("WORCA_SKIP_BEADS", "1")
    (tmp_path / ".beads").mkdir()
    with patch("worca.cli.init.subprocess.run") as mock_run:
        result = _upgrade_beads(tmp_path)
    assert result is False
    mock_run.assert_not_called()


def test_init_beads_runs_when_env_not_set(monkeypatch, tmp_path):
    """_init_beads still calls bd when WORCA_SKIP_BEADS is not set."""
    monkeypatch.delenv("WORCA_SKIP_BEADS", raising=False)
    with patch("worca.cli.init.subprocess.run") as mock_run:
        result = _init_beads(tmp_path)
    assert result is True
    mock_run.assert_called_once()


def test_upgrade_beads_runs_when_env_not_set(monkeypatch, tmp_path):
    """_upgrade_beads still calls bd when WORCA_SKIP_BEADS is not set."""
    monkeypatch.delenv("WORCA_SKIP_BEADS", raising=False)
    (tmp_path / ".beads").mkdir()
    with patch("worca.cli.init.subprocess.run") as mock_run:
        result = _upgrade_beads(tmp_path)
    assert result is True
    mock_run.assert_called_once()
