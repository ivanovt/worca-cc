"""Tests for worca.utils.runtime — propagate_runtime_local_keys."""
import json

from worca.utils.runtime import propagate_runtime_local_keys


def test_propagate_models_into_worktree(tmp_path):
    """Parent settings.local.json model secrets merge into worktree settings.json."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "settings.local.json").write_text(
        json.dumps({"worca": {"models": {"alt": {"env": {"SECRET": "s"}}}}})
    )

    dst = tmp_path / "dst"
    dst.mkdir()
    (dst / "settings.json").write_text(
        json.dumps(
            {"worca": {"models": {"alt": {"id": "x", "env": {"PUBLIC": "p"}}}}}
        )
    )

    propagate_runtime_local_keys(str(src), str(dst))
    merged = json.loads((dst / "settings.json").read_text())
    assert merged["worca"]["models"]["alt"]["env"] == {"PUBLIC": "p", "SECRET": "s"}
    assert merged["worca"]["models"]["alt"]["id"] == "x"


def test_propagate_models_no_clobber_existing_keys(tmp_path):
    """Propagation deep-merges — existing worktree model keys are not lost."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "settings.local.json").write_text(
        json.dumps({"worca": {"models": {"alt": {"env": {"TOKEN": "t"}}}}})
    )

    dst = tmp_path / "dst"
    dst.mkdir()
    (dst / "settings.json").write_text(
        json.dumps(
            {
                "worca": {
                    "models": {"alt": {"id": "original-id", "env": {"BASE": "b"}}},
                    "agents": {"planner": {"model": "alt"}},
                }
            }
        )
    )

    propagate_runtime_local_keys(str(src), str(dst))
    merged = json.loads((dst / "settings.json").read_text())
    assert merged["worca"]["models"]["alt"]["id"] == "original-id"
    assert merged["worca"]["models"]["alt"]["env"]["BASE"] == "b"
    assert merged["worca"]["models"]["alt"]["env"]["TOKEN"] == "t"
    assert merged["worca"]["agents"] == {"planner": {"model": "alt"}}


def test_propagate_webhooks_still_works(tmp_path):
    """Adding models to the allowlist doesn't break existing webhook propagation."""
    src = tmp_path / "src"
    src.mkdir()
    (src / "settings.local.json").write_text(
        json.dumps({"worca": {"webhooks": {"url": "http://localhost:3400"}}})
    )

    dst = tmp_path / "dst"
    dst.mkdir()
    (dst / "settings.json").write_text(json.dumps({"worca": {}}))

    propagate_runtime_local_keys(str(src), str(dst))
    merged = json.loads((dst / "settings.json").read_text())
    assert merged["worca"]["webhooks"] == {"url": "http://localhost:3400"}
