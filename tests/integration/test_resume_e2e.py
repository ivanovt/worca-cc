"""W-050 Phase 4 — end-to-end resume coverage.

Tests the SIGKILL-mid-run → ``--resume`` → completed flow that today's suite
only exercises at the unit level (``TestResumeRerunsPreflight`` checks
``find_resume_point()`` directly, not the full crash-and-recover cycle).

Design note: the W-050 plan suggested "crash/SIGTERM" recovery, but the
runner classifies SIGTERM as a *deliberate* stop — the runner catches the
signal, sets ``pipeline_status="interrupted"``, and ``_TERMINAL_STATUSES``
includes ``interrupted`` so ``_find_active_runs`` excludes it. Tests for
auto-resume therefore use SIGKILL (uncatchable; status stays in a
non-terminal state because the runner never gets to update it). One test
explicitly asserts the SIGTERM-then-resume rejection contract.

Plan rule #12: every multi-run test carries ``timeout(180)``.
Plan rule #13: scenarios keep ``delay_s`` ≤ 0.05.
"""
from __future__ import annotations

import json
import sys

import pytest

from tests.integration.helpers import (
    run_and_act,
    send_sigkill,
    send_sigterm,
)


# Implementer hangs — gives a window to signal mid-stage.
_HANG_AT_IMPLEMENT = {
    "agents": {"implementer": {"action": "hang"}},
    "default": {"action": "succeed", "delay_s": 0.05},
}

# All stages succeed — the resume scenario.
_ALL_SUCCEED = {"default": {"action": "succeed", "delay_s": 0.05}}


def _read_run_status(worca_dir, run_id: str) -> dict:
    """Direct read of a run's status.json by run_id (bypasses
    ``_find_latest_status`` which picks the most recent run regardless of id)."""
    path = worca_dir / "runs" / run_id / "status.json"
    if not path.exists():
        return {}
    return json.loads(path.read_text())


# ---------------------------------------------------------------------------
# Crash mid-stage → resume → completed
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_crash_mid_implementer_then_resume_completes(pipeline_env):
    """SIGKILL during the implementer stage leaves the run mid-flight (status
    persisted before the kill is non-terminal — typically ``running``). The
    ``--resume`` invocation finds the active run via ``_find_active_runs``,
    re-runs PREFLIGHT (per ``find_resume_point``), and continues to completion."""
    first = run_and_act(
        pipeline_env, _HANG_AT_IMPLEMENT, send_sigkill,
        act_after_stage="implement", timeout=20,
    )
    # SIGKILL is uncatchable, so the status field is whatever the runner last
    # persisted. It must NOT be a terminal state — otherwise --resume would
    # reject the run.
    assert first.status.get("pipeline_status") not in ("completed", "failed", "interrupted"), (
        f"first run should be left non-terminal after SIGKILL; "
        f"got {first.status.get('pipeline_status')}"
    )

    resumed = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=60)
    assert resumed.returncode == 0, (
        f"resume should complete cleanly; rc={resumed.returncode}\n"
        f"stderr: {resumed.stderr[:500]}"
    )
    assert resumed.status.get("pipeline_status") == "completed"


# ---------------------------------------------------------------------------
# Resume must not duplicate iteration records
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_resume_does_not_duplicate_iterations(pipeline_env):
    """When the implementer is interrupted mid-iteration, the resumed run
    must continue from ``last_completed + 1`` (per ``get_resume_iteration``)
    rather than re-recording the in_progress iteration as a fresh entry. We
    assert no iteration *number* repeats within any stage's iterations list."""
    run_and_act(
        pipeline_env, _HANG_AT_IMPLEMENT, send_sigkill,
        act_after_stage="implement", timeout=20,
    )

    resumed = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=60)
    assert resumed.returncode == 0
    assert resumed.status.get("pipeline_status") == "completed"

    for stage_name, stage_data in resumed.status.get("stages", {}).items():
        iterations = stage_data.get("iterations") or []
        numbers = [it.get("number") for it in iterations]
        assert len(numbers) == len(set(numbers)), (
            f"stage {stage_name!r} has duplicate iteration numbers after resume: "
            f"{numbers}"
        )


# ---------------------------------------------------------------------------
# Resume of an already-completed run is rejected gracefully
# ---------------------------------------------------------------------------


@pytest.mark.timeout(120)
def test_resume_after_completed_returns_clean_error(pipeline_env):
    """A ``--resume`` call against a run that already finished must reject
    cleanly. ``can_resume`` excludes terminal states, ``_find_active_runs``
    returns no candidates, and the legacy ``.worca/status.json`` fallback
    doesn't exist in the W-048 layout — so the runner exits rc=2 with
    ``error: cannot resume``. Crucially, the original run's terminal status
    must NOT be modified by the failed resume call."""
    first = pipeline_env.run(_ALL_SUCCEED, timeout=30)
    assert first.returncode == 0
    assert first.status.get("pipeline_status") == "completed"

    original_run_id = first.status.get("run_id")
    completed_at_first = first.status.get("completed_at")
    assert original_run_id, "first run must have produced a run_id"

    second = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=30)
    assert second.returncode != 0, (
        f"resume of completed run must reject; got rc={second.returncode}"
    )
    assert "cannot resume" in second.stderr.lower(), (
        f"expected 'cannot resume' diagnostic; stderr: {second.stderr[:400]}"
    )

    # Original run's status.json must be untouched.
    original = _read_run_status(pipeline_env.worca_dir, original_run_id)
    assert original.get("pipeline_status") == "completed"
    assert original.get("completed_at") == completed_at_first


# ---------------------------------------------------------------------------
# SIGTERM → interrupted → --resume rejects (documented contract)
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_sigterm_marks_interrupted_and_resume_rejects(pipeline_env):
    """SIGTERM is *catchable*: the runner traps it, sets
    ``pipeline_status="interrupted"`` + ``stop_reason="signal"``, and emits a
    ``pipeline.run.interrupted`` event. ``_TERMINAL_STATUSES`` includes
    ``interrupted``, so a follow-up ``--resume`` finds no active run and
    rejects — interrupted runs are treated as deliberate stops, not crashes,
    and require explicit human action to resume."""
    first = run_and_act(
        pipeline_env, _HANG_AT_IMPLEMENT, send_sigterm,
        act_after_stage="implement", timeout=20,
    )
    assert first.status.get("pipeline_status") == "interrupted"
    assert any(
        e.get("event_type") == "pipeline.run.interrupted" for e in first.events
    ), "SIGTERM must emit pipeline.run.interrupted before exit"

    second = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=30)
    assert second.returncode != 0, (
        f"--resume on interrupted run must reject; got rc={second.returncode}"
    )
    assert "cannot resume" in second.stderr.lower()


# ---------------------------------------------------------------------------
# Token usage carried forward across resume
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_resume_preserves_token_usage(pipeline_env):
    """Stages completed before the crash record token usage in
    ``status.token_usage``. After resume, the aggregate must be additive —
    not reset to zero — because ``run_pipeline(..., resume=True)`` loads the
    existing status and aggregates new stage runs onto the existing totals."""
    first = run_and_act(
        pipeline_env, _HANG_AT_IMPLEMENT, send_sigkill,
        act_after_stage="implement", timeout=20,
    )

    tokens_first = first.status.get("token_usage") or {}
    if isinstance(tokens_first, dict):
        input_first = tokens_first.get("input_tokens") or 0
        output_first = tokens_first.get("output_tokens") or 0
    else:
        input_first = output_first = 0

    resumed = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=60)
    assert resumed.returncode == 0
    assert resumed.status.get("pipeline_status") == "completed"

    tokens_after = resumed.status.get("token_usage") or {}
    if isinstance(tokens_after, dict):
        input_after = tokens_after.get("input_tokens") or 0
        output_after = tokens_after.get("output_tokens") or 0
    else:
        input_after = output_after = 0

    # The aggregate must not regress — resume is additive. If mock_claude
    # isn't emitting tokens (both 0), this is a non-regression assertion.
    assert input_after >= input_first, (
        f"resume reset input_tokens: {input_first} → {input_after}\n"
        f"first.token_usage: {tokens_first}\nresume.token_usage: {tokens_after}"
    )
    assert output_after >= output_first, (
        f"resume reset output_tokens: {output_first} → {output_after}"
    )


# ---------------------------------------------------------------------------
# Resume terminates with pipeline.run.completed in the run-dir event stream
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_resume_emits_run_completed_in_run_dir_events(pipeline_env):
    """The same run dir's events.jsonl spans both the crashed first run and
    the resumed continuation. After resume completes, the events stream must
    end with ``pipeline.run.completed`` — webhooks that subscribe to terminal
    events must see the run finish, not stay watching a dead crashed run."""
    first = run_and_act(
        pipeline_env, _HANG_AT_IMPLEMENT, send_sigkill,
        act_after_stage="implement", timeout=20,
    )
    assert first.status.get("pipeline_status") not in ("completed", "failed", "interrupted")

    resumed = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=60)
    assert resumed.returncode == 0
    assert resumed.status.get("pipeline_status") == "completed"

    completed_events = [
        e for e in resumed.events
        if e.get("event_type") == "pipeline.run.completed"
    ]
    assert len(completed_events) >= 1, (
        f"resume must emit pipeline.run.completed; "
        f"event_types seen: {sorted({e.get('event_type') for e in resumed.events})}"
    )

    terminal_types = {
        "pipeline.run.completed",
        "pipeline.run.interrupted",
        "pipeline.run.failed",
    }
    terminals = [e for e in resumed.events if e.get("event_type") in terminal_types]
    assert terminals and terminals[-1].get("event_type") == "pipeline.run.completed", (
        f"final terminal event must be pipeline.run.completed; "
        f"got terminals: {[e.get('event_type') for e in terminals]}"
    )


# ---------------------------------------------------------------------------
# Resume preserves the template-pinned model alias for the implementer
# ---------------------------------------------------------------------------


@pytest.mark.timeout(180)
@pytest.mark.skipif(sys.platform == "win32", reason="signal-based tests require Unix")
def test_resume_preserves_template_model_alias(pipeline_env):
    """SIGKILL mid-implementer on a template-pinned run must result in the
    resumed iteration using the *template's* model alias, not the project
    default.

    Reproduction scenario for the original bug: without the fix, resume
    re-resolved the model from project settings (ignoring the persisted
    ``pipeline_template`` in status.json), so the implementer ran with the
    project default model alias instead of the template-pinned one.

    Setup:
    - Write a project-level template (``test-impl-alias``) that pins
      ``agents.implementer.model`` to a custom alias ``"test-impl-alias"``
      mapped to ``claude-sonnet-4-5`` in ``worca.models``.
    - The project settings keep the default implementer model (``"sonnet"``
      resolving to a different ID), so the alias divergence is detectable.
    - Launch with ``--template test-impl-alias``, SIGKILL mid-implementer.
    - Resume WITHOUT ``--template`` — the runner must restore the template
      from ``status.json``'s ``pipeline_template`` field.
    - Assert every implementer iteration recorded after resume carries
      ``model_alias == "test-impl-alias"``.
    """
    # 1. Write the template into the project's .claude/templates/ directory.
    tmpl_dir = pipeline_env.project / ".claude" / "templates" / "test-impl-alias"
    tmpl_dir.mkdir(parents=True, exist_ok=True)
    template_json = {
        "id": "test-impl-alias",
        "name": "Test Impl Alias",
        "description": "Template that pins implementer to a custom model alias.",
        "config": {
            "agents": {
                "implementer": {"model": "test-impl-alias", "max_turns": 5}
            }
        },
    }
    (tmpl_dir / "template.json").write_text(json.dumps(template_json))

    # 2. Add the alias → real model-id mapping in settings so resolution
    #    succeeds (mock_claude ignores the model flag, but the runner must be
    #    able to resolve the alias to avoid an error at start-up).
    settings_path = pipeline_env.project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {}).setdefault("models", {})
    # Map the alias to an actual Claude model ID
    settings["worca"]["models"]["test-impl-alias"] = "claude-sonnet-4-5-20241022"
    settings_path.write_text(json.dumps(settings, indent=2))

    # 3. Crash mid-implementer on first run (template-pinned).
    first = run_and_act(
        pipeline_env,
        _HANG_AT_IMPLEMENT,
        send_sigkill,
        act_after_stage="implement",
        timeout=20,
        extra_args=["--template", "test-impl-alias"],
    )
    assert first.status.get("pipeline_status") not in (
        "completed", "failed", "interrupted"
    ), (
        f"first run should be non-terminal after SIGKILL; "
        f"got {first.status.get('pipeline_status')!r}"
    )
    # Confirm template was recorded in status.json
    assert "test-impl-alias" in (first.status.get("pipeline_template") or ""), (
        f"pipeline_template not recorded; status: {first.status.get('pipeline_template')!r}"
    )

    # 4. Resume without --template — template must be restored from status.json.
    resumed = pipeline_env.run(_ALL_SUCCEED, extra_args=["--resume"], timeout=60)
    assert resumed.returncode == 0, (
        f"resume should complete cleanly; rc={resumed.returncode}\n"
        f"stderr: {resumed.stderr[:500]}"
    )
    assert resumed.status.get("pipeline_status") == "completed"

    # 5. Every implementer iteration written during/after resume must carry
    #    the template-pinned alias — not the project default ("sonnet" / None).
    implement_stage = resumed.status.get("stages", {}).get("implement", {})
    iterations = implement_stage.get("iterations") or []
    assert iterations, "expected at least one implementer iteration after resume"

    bad = [
        it for it in iterations
        if it.get("model_alias") != "test-impl-alias"
    ]
    assert not bad, (
        "resumed implementer iterations have wrong model_alias "
        "(expected 'test-impl-alias' for all):\n"
        + "\n".join(
            f"  iter {it.get('number')}: model_alias={it.get('model_alias')!r}"
            for it in bad
        )
    )
