"""Tests for worca.utils.runtime — validate_runtime helper."""
import pytest


def test_validate_runtime_success(tmp_path, monkeypatch):
    """validate_runtime is a no-op when .claude/worca/ exists."""
    (tmp_path / ".claude" / "worca").mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    from worca.utils.runtime import validate_runtime

    validate_runtime()  # must not raise


def test_validate_runtime_missing_raises_systemexit(tmp_path, monkeypatch):
    """validate_runtime raises SystemExit(1) when .claude/worca/ is absent."""
    monkeypatch.chdir(tmp_path)

    from worca.utils.runtime import validate_runtime

    with pytest.raises(SystemExit) as exc_info:
        validate_runtime()
    assert exc_info.value.code == 1


def test_validate_runtime_error_message_on_stderr(tmp_path, monkeypatch, capsys):
    """The error message names the missing path and the fix command."""
    monkeypatch.chdir(tmp_path)

    from worca.utils.runtime import validate_runtime

    with pytest.raises(SystemExit):
        validate_runtime()

    err = capsys.readouterr().err
    assert "worca runtime not found" in err
    assert ".claude/worca" in err
    assert "worca init" in err
