"""Integration tests for cross-bead design notes (W-005).

Two scenarios:

  1. Multi-bead run (3 beads): bead 1 emits design_notes; assert bead 2's
     resolved implement prompt contains '## Accumulated design notes (advisory)'
     with bead 1's note and NOT bead 2's own note.

  2. Resume survival: kill after bead 1, resume; assert all_design_notes
     survives via prompt_context.json and is injected into the next bead's prompt.
"""
from __future__ import annotations

import json
import sys
import time

import pytest

from tests.integration.helpers import (
    _find_latest_run_id,
    run_and_act,
    send_sigkill,
)

# Integration tests run the full pipeline as a subprocess; a background
# worca-ui server writing to ~/.worca/worca-ui-global.log during that
# window is falsely attributed to the test by the leak detector.
pytestmark = pytest.mark.allow_worca_writes


# ---------------------------------------------------------------------------
# Local helpers
# ---------------------------------------------------------------------------

def _beads_file(tmp_path, beads):
    """Write a stateful bead pool file and return the path."""
    path = tmp_path / "beads_pool.json"
    path.write_text(json.dumps({"beads": beads}))
    return path


def _read_implement_prompts(worca_dir):
    """Return a dict of {iter_N: prompt_text} from status.json iteration records.

    The design notes section lives in the implement.block.md which is resolved
    into the -p prompt (stored in status iterations), not the agent .md file.
    """
    run_id = _find_latest_run_id(worca_dir)
    status_path = worca_dir / "runs" / run_id / "status.json"
    if not status_path.exists():
        return {}
    status = json.loads(status_path.read_text())
    implement = status.get("stages", {}).get("implement", {})
    prompts = {}
    for it in implement.get("iterations", []):
        num = it.get("number")
        prompt = it.get("prompt", "")
        if num is not None and prompt:
            prompts[f"iter_{num}"] = prompt
    return prompts


def _read_prompt_context(worca_dir) -> dict:
    run_id = _find_latest_run_id(worca_dir)
    ctx_path = worca_dir / "runs" / run_id / "prompt_context.json"
    if not ctx_path.exists():
        return {}
    return json.loads(ctx_path.read_text())


def _wait_for_context_key(worca_dir, key, timeout=30.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            ctx = _read_prompt_context(worca_dir)
            if ctx.get(key):
                return
        except Exception:
            pass
        time.sleep(0.1)
    raise TimeoutError(
        f"prompt_context.json did not contain non-empty {key!r} within {timeout}s"
    )


THREE_BEADS = [
    {"id": "beads-aaa", "title": "Bead A", "priority": "P2", "type": "task"},
    {"id": "beads-bbb", "title": "Bead B", "priority": "P2", "type": "task"},
    {"id": "beads-ccc", "title": "Bead C", "priority": "P2", "type": "task"},
]

_ALL_SUCCEED = {"default": {"action": "succeed", "delay_s": 0.05}}


# ---------------------------------------------------------------------------
# Test 1: multi-bead design notes injection
# ---------------------------------------------------------------------------

@pytest.mark.timeout(180)
def test_multi_bead_design_notes_injected_into_subsequent_beads(
    pipeline_env, tmp_path
):
    """Bead 1 emits design_notes; bead 2 and 3's resolved prompts must contain
    the '## Accumulated design notes (advisory)' section with bead 1's note.
    Bead 2's own note must NOT appear in bead 2's prompt (only siblings)."""
    bf = _beads_file(tmp_path, THREE_BEADS)
    pipeline_env.enable_beads(beads_file=bf)

    scenario = {
        "agents": {
            "coordinator": {
                "action": "succeed",
                "delay_s": 0.05,
                "structured_output": {
                    "beads_ids": ["beads-aaa", "beads-bbb", "beads-ccc"],
                    "dependency_graph": {},
                },
            },
            "tester": {
                "action": "succeed",
                "delay_s": 0.05,
                "structured_output": {"passed": True},
            },
            "implementer": {
                "iter_1": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "files_changed": ["a.py"],
                        "tests_added": [],
                        "bead_id": "beads-aaa",
                        "design_notes": "Use dataclass for Config, not dict.",
                    },
                },
                "iter_2": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "files_changed": ["b.py"],
                        "tests_added": [],
                        "bead_id": "beads-bbb",
                        "design_notes": "Validate inputs at the boundary.",
                    },
                },
                "iter_3": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "files_changed": ["c.py"],
                        "tests_added": [],
                        "bead_id": "beads-ccc",
                    },
                },
                "default": {"action": "succeed", "delay_s": 0.05},
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }

    result = pipeline_env.run(scenario, timeout=90)

    assert result.returncode == 0, (
        f"pipeline should complete; rc={result.returncode}\n"
        f"stderr: {result.stderr[:500]}"
    )

    prompts = _read_implement_prompts(pipeline_env.worca_dir)
    assert "iter_1" in prompts, f"resolved prompt iter_1 not found; got: {sorted(prompts)}"
    assert "iter_2" in prompts, f"resolved prompt iter_2 not found; got: {sorted(prompts)}"
    assert "iter_3" in prompts, f"resolved prompt iter_3 not found; got: {sorted(prompts)}"

    # iter_1 (bead A): no prior notes → section should NOT appear
    assert "## Accumulated design notes (advisory)" not in prompts["iter_1"], (
        "bead 1 should NOT have design notes section (no prior beads)"
    )

    # iter_2 (bead B): should see bead A's note
    assert "## Accumulated design notes (advisory)" in prompts["iter_2"], (
        "bead 2 must have the design notes section with bead 1's note"
    )
    assert "Use dataclass for Config, not dict." in prompts["iter_2"], (
        "bead 2's prompt must contain bead A's design note"
    )
    # bead B's own note must NOT be in its own prompt (only siblings)
    assert "Validate inputs at the boundary." not in prompts["iter_2"], (
        "bead 2's OWN design note must not appear in its own prompt"
    )

    # iter_3 (bead C): should see both bead A and bead B notes
    assert "## Accumulated design notes (advisory)" in prompts["iter_3"], (
        "bead 3 must have the design notes section"
    )
    assert "Use dataclass for Config, not dict." in prompts["iter_3"], (
        "bead 3's prompt must contain bead A's design note"
    )
    assert "Validate inputs at the boundary." in prompts["iter_3"], (
        "bead 3's prompt must contain bead B's design note"
    )


# ---------------------------------------------------------------------------
# Test 2: design notes survive resume via prompt_context.json
# ---------------------------------------------------------------------------

@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_design_notes_survive_resume(pipeline_env, tmp_path):
    """Kill after bead 1 completes; resume and verify all_design_notes
    persisted in prompt_context.json is injected into bead 2's prompt."""
    bf = _beads_file(tmp_path, THREE_BEADS)
    pipeline_env.enable_beads(beads_file=bf)

    scenario = {
        "agents": {
            "coordinator": {
                "action": "succeed",
                "delay_s": 0.05,
                "structured_output": {
                    "beads_ids": ["beads-aaa", "beads-bbb", "beads-ccc"],
                    "dependency_graph": {},
                },
            },
            "tester": {
                "action": "succeed",
                "delay_s": 0.05,
                "structured_output": {"passed": True},
            },
            "implementer": {
                "iter_1": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "files_changed": ["a.py"],
                        "tests_added": [],
                        "bead_id": "beads-aaa",
                        "design_notes": "Error codes use IntEnum, not plain ints.",
                    },
                },
                "iter_2": {"action": "hang"},
                "default": {"action": "succeed", "delay_s": 0.05},
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }

    def _act(proc, env):
        _wait_for_context_key(env.worca_dir, "all_design_notes")
        send_sigkill(proc, env)

    first = run_and_act(pipeline_env, scenario, _act, timeout=40)

    assert first.status.get("pipeline_status") not in (
        "completed", "failed", "interrupted"
    ), (
        f"run must be non-terminal after SIGKILL; "
        f"got {first.status.get('pipeline_status')!r}"
    )

    # Verify all_design_notes persisted in prompt_context.json
    ctx = _read_prompt_context(pipeline_env.worca_dir)
    assert "all_design_notes" in ctx, (
        f"prompt_context.json must contain all_design_notes; "
        f"keys: {sorted(ctx.keys())}"
    )
    notes = ctx["all_design_notes"]
    assert len(notes) >= 1, f"expected at least one design note; got {notes}"
    assert notes[0]["bead_id"] == "beads-aaa"
    assert "IntEnum" in notes[0]["note"]

    # Resume — bead 2 should get the design notes from bead 1
    resume_scenario = {
        "agents": {
            "tester": {
                "action": "succeed",
                "delay_s": 0.05,
                "structured_output": {"passed": True},
            },
            "implementer": {
                "iter_2": {
                    "action": "succeed",
                    "delay_s": 0.05,
                    "structured_output": {
                        "files_changed": ["b.py"],
                        "tests_added": [],
                        "bead_id": "beads-bbb",
                    },
                },
                "default": {"action": "succeed", "delay_s": 0.05},
            },
        },
        "default": {"action": "succeed", "delay_s": 0.05},
    }
    resumed = pipeline_env.run(
        resume_scenario, extra_args=["--resume"], timeout=60
    )
    assert resumed.returncode == 0, (
        f"resume must complete; rc={resumed.returncode}\n"
        f"stderr: {resumed.stderr[:500]}"
    )
    assert resumed.status.get("pipeline_status") == "completed"

    # After resume, check that bead 2's resolved prompt had the design notes
    prompts = _read_implement_prompts(pipeline_env.worca_dir)
    # iter_2 is the first implement call in the resumed run
    bead2_prompt = None
    for key in sorted(prompts):
        content = prompts[key]
        if "beads-bbb" in content or "Bead B" in content:
            bead2_prompt = content
            break

    if bead2_prompt is None:
        # Fall back: any implement prompt after resume should have the notes
        for key in sorted(prompts):
            if "## Accumulated design notes (advisory)" in prompts[key]:
                bead2_prompt = prompts[key]
                break

    assert bead2_prompt is not None, (
        f"could not find bead 2's resolved prompt after resume; "
        f"available: {sorted(prompts.keys())}"
    )
    assert "## Accumulated design notes (advisory)" in bead2_prompt, (
        "bead 2's prompt after resume must contain design notes section"
    )
    assert "IntEnum" in bead2_prompt, (
        "bead 2's prompt after resume must contain bead A's design note"
    )
