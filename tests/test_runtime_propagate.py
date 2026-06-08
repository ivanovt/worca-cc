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


def test_propagate_split_storage_id_in_base_env_in_local(tmp_path):
    """The split-storage case: id lives in parent's settings.json, env lives
    in parent's settings.local.json, and the worktree's settings.json (from a
    stale HEAD) lacks the alias entirely. Propagation must reconstruct the
    full {id, env} pair so normalize_model_entry() doesn't reject it.

    Regression: pre-fix the worktree got `{env: ...}` with no id and the
    pipeline crashed at the first resolve_model() call with
    "model entry must be a string ID or {id, env} object".
    """
    src = tmp_path / "src"
    src.mkdir()
    (src / "settings.json").write_text(
        json.dumps({"worca": {"models": {"glm-ds": {"id": "opus"}}}})
    )
    (src / "settings.local.json").write_text(
        json.dumps(
            {"worca": {"models": {"glm-ds": {"env": {"ANTHROPIC_BASE_URL": "https://api.x"}}}}}
        )
    )

    dst = tmp_path / "dst"
    dst.mkdir()
    # Worktree's settings.json from stale HEAD — no glm-ds at all.
    (dst / "settings.json").write_text(
        json.dumps({"worca": {"models": {"opus": "claude-opus-4-6"}}})
    )

    propagate_runtime_local_keys(str(src), str(dst))
    merged = json.loads((dst / "settings.json").read_text())
    glm = merged["worca"]["models"]["glm-ds"]
    assert glm["id"] == "opus"
    assert glm["env"] == {"ANTHROPIC_BASE_URL": "https://api.x"}
    # Pre-existing worktree entries from HEAD survive.
    assert merged["worca"]["models"]["opus"] == "claude-opus-4-6"


def test_propagate_no_parent_files(tmp_path):
    """When neither parent file exists, propagation is a no-op (no crash)."""
    src = tmp_path / "src"
    src.mkdir()
    dst = tmp_path / "dst"
    dst.mkdir()
    (dst / "settings.json").write_text(json.dumps({"worca": {"models": {"a": "x"}}}))

    propagate_runtime_local_keys(str(src), str(dst))
    merged = json.loads((dst / "settings.json").read_text())
    assert merged == {"worca": {"models": {"a": "x"}}}


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
