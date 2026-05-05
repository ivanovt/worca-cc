"""W-050 Phase 5 — beads + work_request source resolution coverage.

Drives the bd / gh stub binaries (Phase 0 infrastructure) against the real
``orchestrator/work_request.py`` normalize functions and against the full
pipeline subprocess via ``--source bd:...`` and ``--source gh:issue:N``.

Plan rule #16 (binding): stubs are activated per-test via
``monkeypatch.setenv("PATH", ...)`` for in-process tests and via
``pipeline_env.enable_beads()`` (which scopes ``_overrides["PATH"]`` to the
next pipeline subprocess) for full pipeline tests. Global PATH is never
modified — a globally-shadowed ``bd`` would break any concurrent worca run.

Tests 1-4 are in-process: they call ``normalize()`` directly with the stub
on PATH and a canned response file. Tests 5-6 spawn the full pipeline
subprocess and assert on status.json.
"""
from __future__ import annotations

import json
import os

import pytest


def _setup_stub_path(monkeypatch, pipeline_env) -> None:
    """Prepend the stubs/ directory to PATH for the duration of the test only.
    Plan rule #16 — must use monkeypatch (per-test scope), never global PATH."""
    monkeypatch.setenv(
        "PATH", f"{pipeline_env.stubs_dir}{os.pathsep}{os.environ['PATH']}"
    )
    monkeypatch.setenv("WORCA_STUB_LOG", str(pipeline_env.stub_log_path))


# ---------------------------------------------------------------------------
# In-process: normalize_beads_task via bd stub
# ---------------------------------------------------------------------------


def test_normalize_source_resolves_bd_reference(pipeline_env, monkeypatch, tmp_path):
    """``normalize("source", "bd:bd-test-1")`` shells out to ``bd show`` and
    parses the title from the header line. The resulting WorkRequest carries
    ``source_type="beads"`` and the canonical ``source_ref="bd:<id>"``."""
    response_file = tmp_path / "bd_responses.json"
    response_file.write_text(json.dumps({
        "show bd-test-1": {
            "stdout": (
                "○ bd-test-1 · Phase 5 Test Task   [● P2 · OPEN]\n\n"
                "DESCRIPTION\nSome description text.\n"
            ),
            "exit": 0,
        }
    }))
    _setup_stub_path(monkeypatch, pipeline_env)
    monkeypatch.setenv("WORCA_STUB_BD_RESPONSE_FILE", str(response_file))

    from worca.orchestrator.work_request import normalize
    wr = normalize("source", "bd:bd-test-1")

    assert wr.source_type == "beads"
    assert wr.title == "Phase 5 Test Task"
    assert wr.source_ref == "bd:bd-test-1"


# ---------------------------------------------------------------------------
# In-process: normalize_github_issue with plan-link auto-detection
# ---------------------------------------------------------------------------


def test_normalize_source_resolves_gh_issue_with_plan_link(
    pipeline_env, monkeypatch, tmp_path
):
    """``normalize("source", "gh:issue:42")`` calls ``gh issue view --json
    title,body`` and runs the body through ``_extract_plan_path``. A markdown
    link to ``docs/plans/...`` is captured ONLY if the file exists on disk
    (the function ``finditer``s through every match looking for one that
    resolves)."""
    plans_dir = pipeline_env.project / "docs" / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    plan_file = plans_dir / "W-050-test.md"
    plan_file.write_text("# Test plan body\n")

    response_file = tmp_path / "gh_responses.json"
    response_file.write_text(json.dumps({
        "issue view 42 --json title,body": {
            "stdout": json.dumps({
                "title": "Phase 5 GH issue",
                "body": (
                    "## Plan\n\n"
                    "[plan](https://github.com/x/y/blob/main/docs/plans/W-050-test.md)\n"
                ),
            }),
            "exit": 0,
        }
    }))
    _setup_stub_path(monkeypatch, pipeline_env)
    monkeypatch.setenv("WORCA_STUB_GH_RESPONSE_FILE", str(response_file))
    # plan_path resolution is relative to cwd → cd into the project.
    monkeypatch.chdir(pipeline_env.project)

    from worca.orchestrator.work_request import normalize
    wr = normalize("source", "gh:issue:42")

    assert wr.source_type == "github_issue"
    assert wr.title == "Phase 5 GH issue"
    assert wr.source_ref == "gh:42"
    assert wr.plan_path is not None
    assert wr.plan_path.endswith("docs/plans/W-050-test.md")


def test_normalize_source_gh_issue_without_plan_link(
    pipeline_env, monkeypatch, tmp_path
):
    """When the issue body has no ``docs/plans/`` markdown link (or the
    linked file doesn't exist), ``plan_path`` must be None — the pipeline
    runs the PLAN stage instead of skipping it."""
    response_file = tmp_path / "gh_responses.json"
    response_file.write_text(json.dumps({
        "issue view 99 --json title,body": {
            "stdout": json.dumps({
                "title": "Phase 5 issue, no plan",
                "body": "Just a plain description, no plan link to find here.",
            }),
            "exit": 0,
        }
    }))
    _setup_stub_path(monkeypatch, pipeline_env)
    monkeypatch.setenv("WORCA_STUB_GH_RESPONSE_FILE", str(response_file))
    monkeypatch.chdir(pipeline_env.project)

    from worca.orchestrator.work_request import normalize
    wr = normalize("source", "gh:issue:99")

    assert wr.source_type == "github_issue"
    assert wr.source_ref == "gh:99"
    assert wr.plan_path is None


# ---------------------------------------------------------------------------
# Source-format rejection
# ---------------------------------------------------------------------------


def test_normalize_source_invalid_format_raises():
    """A reference that's neither a ``gh:issue:N``/GitHub URL nor a ``bd:``
    prefix must raise ValueError. ``normalize_*_*`` rules are explicit, not
    fall-through-friendly — typos must surface immediately, not produce a
    half-populated WorkRequest."""
    from worca.orchestrator.work_request import normalize
    with pytest.raises(ValueError, match="Unknown source reference format"):
        normalize("source", "invalid-format-without-prefix")


# ---------------------------------------------------------------------------
# Full pipeline: --source bd:<id>
# ---------------------------------------------------------------------------


@pytest.mark.timeout(120)
def test_pipeline_with_source_bd_records_work_request_in_status(
    pipeline_env, tmp_path
):
    """Spawning ``run_pipeline.py --source bd:bd-test-1`` makes the runner
    call ``normalize_beads_task`` (via the bd stub) and persist the
    resulting work_request into status.json. Pipeline runs to completion and
    the recorded source_type / source_ref reflect the BD origin."""
    response_file = tmp_path / "bd_responses.json"
    response_file.write_text(json.dumps({
        "show bd-test-1": {
            "stdout": (
                "○ bd-test-1 · Phase 5 BD Task   [● P2 · OPEN]\n"
            ),
            "exit": 0,
        },
        "default": {"stdout": "", "exit": 0},
    }))
    pipeline_env.enable_beads(response_file=response_file)

    scenario = {"default": {"action": "succeed", "delay_s": 0.05}}
    result = pipeline_env.run(
        scenario,
        extra_args=["--source", "bd:bd-test-1"],
        timeout=60,
    )

    assert result.returncode == 0, (
        f"pipeline should complete; rc={result.returncode}\n"
        f"stderr: {result.stderr[:500]}"
    )
    wr = result.status.get("work_request", {})
    assert wr.get("source_type") == "beads", (
        f"work_request.source_type should be 'beads'; got {wr}"
    )
    assert wr.get("source_ref") == "bd:bd-test-1"
    assert wr.get("title") == "Phase 5 BD Task"


# ---------------------------------------------------------------------------
# Full pipeline: --source gh:issue:N with plan-link skipping the PLAN stage
# ---------------------------------------------------------------------------


@pytest.mark.timeout(120)
def test_pipeline_with_source_gh_issue_uses_extracted_plan_link(
    pipeline_env, monkeypatch, tmp_path
):
    """``--source gh:issue:42`` with a plan-link in the issue body and a
    matching file on disk: the runner extracts plan_path during work-request
    normalization and the status records both the gh source_ref and the
    auto-detected plan file. CLAUDE.md documents this is exactly how the
    pipeline auto-detects pre-written plans without a separate ``--plan``."""
    plans_dir = pipeline_env.project / "docs" / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    plan_file = plans_dir / "W-050-phase5.md"
    plan_file.write_text("# Phase 5 plan\n")

    response_file = tmp_path / "gh_responses.json"
    response_file.write_text(json.dumps({
        "issue view 42 --json title,body": {
            "stdout": json.dumps({
                "title": "Phase 5 GH-sourced run",
                "body": (
                    "## Plan\n\n"
                    "[the plan]"
                    "(https://github.com/x/y/blob/main/docs/plans/W-050-phase5.md)\n"
                ),
            }),
            "exit": 0,
        },
        "default": {"stdout": "", "exit": 0},
    }))

    # enable_beads adds the stubs dir to PATH for the next subprocess; we
    # also need the gh response file env var to reach the subprocess. The
    # fixture's _base_env passes os.environ through, so monkeypatch.setenv
    # is sufficient.
    pipeline_env.enable_beads()
    monkeypatch.setenv("WORCA_STUB_GH_RESPONSE_FILE", str(response_file))

    scenario = {"default": {"action": "succeed", "delay_s": 0.05}}
    result = pipeline_env.run(
        scenario,
        extra_args=["--source", "gh:issue:42"],
        timeout=60,
    )

    assert result.returncode == 0, (
        f"pipeline should complete; rc={result.returncode}\n"
        f"stderr: {result.stderr[:500]}"
    )
    wr = result.status.get("work_request", {})
    assert wr.get("source_type") == "github_issue"
    assert wr.get("source_ref") == "gh:42"

    # The runner promotes the auto-detected plan_path into status.plan_file
    # (top-level) and marks PLAN as skipped — that's the persisted evidence
    # that auto-detection ran. NB: ``plan_path`` is currently dropped from
    # the persisted ``work_request`` dict (runner.py:1417 only copies five
    # fields), so we assert on what actually reaches status.json.
    assert result.status.get("plan_file", "").endswith("W-050-phase5.md"), (
        f"status.plan_file should reflect the auto-detected plan link; "
        f"got plan_file={result.status.get('plan_file')!r}\n"
        f"work_request: {wr}"
    )
    plan_stage = result.status.get("stages", {}).get("plan", {})
    assert plan_stage.get("status") == "completed", (
        f"PLAN stage should be auto-completed (skipped); got {plan_stage}"
    )
    assert plan_stage.get("skipped") is True, (
        f"PLAN stage should carry skipped=True; got {plan_stage}"
    )
