"""Tests for `_copy_claude_config` — runtime-key propagation from parent's
settings.local.json into the worktree's settings.json.

Worktrees deliberately skip settings.local.json (machine-specific). But two
worca-namespace keys ARE runtime-derived from the parent (the loopback
webhook the worca-ui auto-installs, and worca.events.enabled), and must
follow the run into the worktree or pipeline events never reach the UI.

This narrow exception merges those two keys post-copy. Everything else in
settings.local.json (permissions, hooks, mcpServers, etc.) stays parent-only.
"""

import json

from worca.utils.runtime import copy_claude_config


def _read_json(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def test_skips_settings_local_json_top_level(tmp_path):
    """The original guarantee — settings.local.json is never copied verbatim."""
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / ".claude").mkdir(parents=True)
    (src / ".claude" / "settings.json").write_text("{}")
    (src / ".claude" / "settings.local.json").write_text(
        json.dumps({"permissions": {"allow": ["Bash"]}})
    )

    copy_claude_config(str(src / ".claude"), str(dst / ".claude"))

    assert (dst / ".claude" / "settings.json").exists()
    assert not (dst / ".claude" / "settings.local.json").exists()


def test_propagates_worca_webhooks_from_parent_local(tmp_path):
    """The UI's loopback webhook lives in parent settings.local.json. Without
    propagation the worktree pipeline can't deliver events back to the UI."""
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / ".claude").mkdir(parents=True)
    (src / ".claude" / "settings.json").write_text(json.dumps({"worca": {}}))
    (src / ".claude" / "settings.local.json").write_text(
        json.dumps(
            {
                "permissions": {"allow": ["Bash"]},
                "worca": {
                    "webhooks": [
                        {
                            "url": "http://localhost:3400/api/webhooks/inbox",
                            "events": ["pipeline.*"],
                        }
                    ],
                    "events": {"enabled": True},
                },
            }
        )
    )

    copy_claude_config(str(src / ".claude"), str(dst / ".claude"))

    merged = _read_json(str(dst / ".claude" / "settings.json"))
    assert merged["worca"]["webhooks"] == [
        {
            "url": "http://localhost:3400/api/webhooks/inbox",
            "events": ["pipeline.*"],
        }
    ]
    assert merged["worca"]["events"] == {"enabled": True}

    # Permissions must NOT bleed into the worktree (still machine-specific).
    assert "permissions" not in merged
    assert not (dst / ".claude" / "settings.local.json").exists()


def test_local_webhooks_replace_base_webhooks_wholesale(tmp_path):
    """List-typed worca keys follow load_settings semantics: local replaces
    base wholesale (consistent with how the runner reads settings via
    deep_merge in worca.utils.settings)."""
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / ".claude").mkdir(parents=True)
    (src / ".claude" / "settings.json").write_text(
        json.dumps(
            {
                "worca": {
                    "webhooks": [
                        {"url": "https://team.example.com/hook", "events": ["pipeline.run.*"]}
                    ]
                }
            }
        )
    )
    (src / ".claude" / "settings.local.json").write_text(
        json.dumps(
            {
                "worca": {
                    "webhooks": [
                        {
                            "url": "http://localhost:3400/api/webhooks/inbox",
                            "events": ["pipeline.*"],
                        }
                    ]
                }
            }
        )
    )

    copy_claude_config(str(src / ".claude"), str(dst / ".claude"))

    merged = _read_json(str(dst / ".claude" / "settings.json"))
    # Local replaces base wholesale (not concatenation, not dedup).
    assert merged["worca"]["webhooks"] == [
        {
            "url": "http://localhost:3400/api/webhooks/inbox",
            "events": ["pipeline.*"],
        }
    ]


def test_no_op_when_no_parent_local_settings(tmp_path):
    """If the parent has no settings.local.json, the worktree's settings.json
    is just the parent's settings.json verbatim (existing behavior)."""
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / ".claude").mkdir(parents=True)
    base = {"worca": {"agents": {"implementer": {"model": "opus"}}}}
    (src / ".claude" / "settings.json").write_text(json.dumps(base))

    copy_claude_config(str(src / ".claude"), str(dst / ".claude"))

    merged = _read_json(str(dst / ".claude" / "settings.json"))
    assert merged == base


def test_no_op_when_local_has_no_worca_runtime_keys(tmp_path):
    """If parent's settings.local.json has only non-runtime keys (permissions,
    etc.), the worktree's settings.json equals the parent's base verbatim."""
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / ".claude").mkdir(parents=True)
    base = {"worca": {"agents": {"implementer": {"model": "opus"}}}}
    (src / ".claude" / "settings.json").write_text(json.dumps(base))
    (src / ".claude" / "settings.local.json").write_text(
        json.dumps(
            {
                "permissions": {"allow": ["Bash"]},
                "hooks": {"PreToolUse": []},
                "worca": {"agents": {"implementer": {"model": "sonnet"}}},
            }
        )
    )

    copy_claude_config(str(src / ".claude"), str(dst / ".claude"))

    merged = _read_json(str(dst / ".claude" / "settings.json"))
    # Only webhooks/events propagate from local; agents stays as-is from base
    # because it's the project-shared key after the W-049+ split.
    assert merged == base


def test_propagates_only_worca_events_when_webhooks_absent(tmp_path):
    """worca.events.enabled = false in parent local should still cross over
    so the worktree honors the disable flag."""
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / ".claude").mkdir(parents=True)
    (src / ".claude" / "settings.json").write_text(json.dumps({"worca": {}}))
    (src / ".claude" / "settings.local.json").write_text(
        json.dumps({"worca": {"events": {"enabled": False}}})
    )

    copy_claude_config(str(src / ".claude"), str(dst / ".claude"))

    merged = _read_json(str(dst / ".claude" / "settings.json"))
    assert merged["worca"]["events"] == {"enabled": False}
    assert merged["worca"].get("webhooks") in (None, [])


def test_augments_tracked_settings_json_with_runtime_keys(tmp_path):
    """Tracked-files-win still applies to wholesale file copies, but the
    runtime-key propagation is additive (loopback webhook, events.enabled).
    Without it, projects that commit .claude/settings.json would never
    deliver events back to the local UI."""
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / ".claude").mkdir(parents=True)
    (src / ".claude" / "settings.json").write_text(json.dumps({"worca": {}}))
    (src / ".claude" / "settings.local.json").write_text(
        json.dumps(
            {
                "worca": {
                    "webhooks": [
                        {"url": "http://localhost:3400/api/webhooks/inbox"}
                    ]
                }
            }
        )
    )
    (dst / ".claude").mkdir(parents=True)
    tracked = {"worca": {"agents": {"implementer": {"model": "opus"}}}}
    (dst / ".claude" / "settings.json").write_text(json.dumps(tracked))

    copy_claude_config(str(src / ".claude"), str(dst / ".claude"))

    merged = _read_json(str(dst / ".claude" / "settings.json"))
    # The tracked agents config is preserved.
    assert merged["worca"]["agents"] == tracked["worca"]["agents"]
    # The loopback webhook is added on top — additive, not clobbering.
    assert merged["worca"]["webhooks"] == [
        {"url": "http://localhost:3400/api/webhooks/inbox"}
    ]


def test_propagated_settings_json_is_pretty_printed(tmp_path):
    """Worktree settings.json should be human-readable — match the indent
    convention used by the UI's POST /settings handler (2-space + trailing newline)."""
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    (src / ".claude").mkdir(parents=True)
    (src / ".claude" / "settings.json").write_text(json.dumps({"worca": {}}))
    (src / ".claude" / "settings.local.json").write_text(
        json.dumps(
            {
                "worca": {
                    "webhooks": [
                        {"url": "http://localhost:3400/api/webhooks/inbox"}
                    ]
                }
            }
        )
    )

    copy_claude_config(str(src / ".claude"), str(dst / ".claude"))

    content = (dst / ".claude" / "settings.json").read_text()
    assert content.endswith("\n")
    parsed = json.loads(content)
    assert content == json.dumps(parsed, indent=2) + "\n"
