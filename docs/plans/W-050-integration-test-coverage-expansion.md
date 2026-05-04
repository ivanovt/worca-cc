# W-050: Integration Test Coverage Expansion

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-05-04
**Depends on:** None

## Problem

Today the integration suite under `tests/integration/` (8 files, ~3,086 lines, ~124 tests) is heavily skewed toward the state-action matrix and preflight/circuit-breaker. Several core subsystems are exercised only at the unit level — or not at all in a live pipeline. Concrete gaps:

- **Agent retry loops never run end-to-end.** No scenario exercises tester fail → re-implement → tester pass, or reviewer revise → re-implement → reviewer approve. The mock-claude scenario format (`tests/mock_claude/mock_claude.py:1`) returns one directive per agent, with no per-iteration variation.
- **Governance hooks never fire in a real pipeline.** `tests/integration/conftest.py:78` sets `WORCA_AGENT=""`, which short-circuits the very hooks `CLAUDE.md` documents as load-bearing: guardian-only `git commit`, `plan_check`, `bd_create_hook`, dispatch tracking, the post-tool-use test gate.
- **Worktree mode has zero integration coverage.** `src/worca/scripts/run_worktree.py:314` is documented as the parallel-safe entry point alongside `run_pipeline.py`, but no test starts a real worktree, asserts branch creation, or tests two-runs-in-parallel isolation. `src/worca/scripts/run_parallel.py:126` and `src/worca/orchestrator/cleanup.py:15` are similarly untested.
- **Beads integration is shut off.** `WORCA_SKIP_BEADS=1` in the fixture (`conftest.py:79`) means no test verifies the beads issue lifecycle, run-id labels, or `--source bd:W-NNN` plan resolution.
- **Learn stage is disabled in the fixture** (`conftest.py:58`). `_run_learn_stage` (`runner.py:722`) and `scripts/run_learn.py` have no live integration test.
- **Resume only re-runs preflight.** `TestResumeRerunsPreflight` covers preflight re-run logic, but there is no test where a real pipeline crashes/SIGTERMs mid-implementer and a follow-up `--resume` continues to completion.
- **UI server boundary against a live run is untested.** `worca-ui/server/*.test.js` runs against mocked file state. No test starts a real worca pipeline and queries `/api/runs` — exactly the gap that lets the "files glob in `package.json` drops a server file" failure mode (called out in `CLAUDE.md`) reach users.

User-facing impact: the parts of the system that have failed in production (dropped npm files, hook regressions, retry-loop bugs, worktree leftovers) are precisely the parts the integration suite cannot catch.

## Proposal

Extend the integration harness with per-iteration scenarios, governance-aware env vars, and stub `bd`/`gh` binaries. Then add ~70 tests across 13 new files, organized into 7 phases. Net result: the suite grows from ~124 → ~195 tests (+57%) while closing the agent-loop, governance-live, worktree, beads, learn, resume, and UI-API blind spots.

## Design

### 1. Fixture extensions (Phase 0 — foundation)

- **Current state:** `tests/integration/conftest.py:73-80` builds a single `_base_env` with `WORCA_AGENT=""` and `WORCA_SKIP_BEADS=1`. `mock_claude.py` returns one directive per agent regardless of iteration.
- **Obstacle:** Tests can't (a) toggle stages on per-test, (b) run as a specific governance agent, (c) make agents return different results across iterations, or (d) exercise beads.
- **Resolution:** Add helpers to `pipeline_env`, extend `mock_claude.py` to support per-iteration directives, and add stub-binary infrastructure under `tests/integration/stubs/`.

```python
# tests/integration/conftest.py — additions to PipelineEnv

def enable_stages(*names: str) -> None:
    """Flip worca.stages.<name>.enabled=True (e.g. 'learn', 'plan_review', 'preflight')."""

def set_governance_agent(name: str) -> None:
    """Set WORCA_AGENT for the next run() invocation so live hooks see a real agent."""

def enable_beads() -> None:
    """Prepend tests/integration/stubs/ to PATH (provides a recording 'bd' shim)
    and clear WORCA_SKIP_BEADS for the next run."""

def make_iteration_scenario(per_agent_per_iter: dict) -> dict:
    """Build a scenario where the same agent returns different directives on
    iter 1, 2, 3. Mock parses iteration from --agent path '...-iter-N.md'."""
```

```python
# tests/mock_claude/mock_claude.py — directive resolution becomes:
#   1. agents[name][iter_N] (exact iteration match)
#   2. agents[name].default
#   3. scenario.default
# Iteration is parsed from the resolved template path
# (_RESOLVED_RE already captures it implicitly via the iter-N suffix).
```

### 2. Per-iteration scenario schema

```json
{
  "agents": {
    "tester": {
      "iter_1": {"action": "fail", "result_text": "1 test failed"},
      "iter_2": {"action": "succeed", "result_text": "All tests passed"}
    },
    "reviewer": {
      "iter_1": {"action": "succeed", "result_text": "REVISE: needs error handling"},
      "iter_2": {"action": "succeed", "result_text": "APPROVE"}
    }
  },
  "default": {"action": "succeed", "delay_s": 0.05}
}
```

Backward compatibility: if `agents[name]` is not a dict-of-iterations, treat the whole value as a single directive (existing scenarios still work).

### 3. Stub binaries

`tests/integration/stubs/bd` and `tests/integration/stubs/gh` are tiny Python shebang scripts that:
- Append their argv + cwd + a timestamp to `$WORCA_STUB_LOG` (a JSONL file the test reads).
- Return canned output configurable per-test via `$WORCA_STUB_<NAME>_RESPONSE_FILE`.

This avoids depending on real `bd`/`gh` binaries in CI.

### 4. Test organization

| Phase | File | Tests | Scope |
|---|---|---|---|
| 1 | `test_implementer_tester_loop.py` | ~7 | tester fail→pass, max-iter exhaustion, test-gate trip, settings respected, token aggregation across iters |
| 1 | `test_reviewer_loop.py` | ~5 | reviewer revise→approve, exhaustion, disabled, feedback reaches next prompt, mloops multiplier |
| 1 | `test_guardian_pr_creation.py` | ~5 | commit message, branch name, gh stub invocation, no-diff skip, failure surfacing |
| 1 | `test_learn_stage.py` | ~4 | runs after success, skipped on failure, run_learn.py CLI parity, output artifacts |
| 1 | `test_full_happy_path.py` | ~4 | all stages on with success scenario, plan_review position, mloops idle, exactly-one completed webhook |
| 2 | `test_governance_hooks_live.py` | ~8 | guardian-only commit, plan_check before/after MASTER_PLAN.md, dispatch tracking, block_files, bd_create_hook validation, post-tool-use 2-pytest-failure gate |
| 3 | `test_run_worktree.py` | ~6 | branch creation, parent untouched, --branch select, --guide injection, parallel isolation, worktree_path in status |
| 3 | `test_run_parallel.py` | ~3 | N tasks complete, one-failure-doesn't-kill-others, aggregated results |
| 3 | `test_worktree_cleanup.py` | ~4 | list/all/dry-run/--older-than |
| 4 | `test_resume_e2e.py` | ~6 | crash mid-implementer resumed, SIGTERM resume no-dup, resume of completed, breaker preservation, token preservation, completed (not interrupted) webhook |
| 5 | `test_beads_integration.py` | ~6 | issue create with run-id label, status updates, blocked on failure, work_request from bd source, --source bd:W-NNN, --source gh:issue:N |
| 6 | `test_ui_server_against_live_run.py` | ~5 | /api/runs lists run, /events matches jsonl, /status matches status.json, websocket transition push, fleet/workspace cross-project listing |
| 7 | `test_misc_edges.py` | ~6 | breaker threshold=1, malformed settings, unwritable plan path, concurrent-start rejection, run-id collision, missing agent_md_ref |

## Implementation Plan

### Phase 0: Fixture extensions
**Files:** `tests/integration/conftest.py`, `tests/integration/helpers.py`, `tests/mock_claude/mock_claude.py`, `tests/mock_claude/test_mock_claude.py`, new `tests/integration/stubs/{bd,gh}`
**Tasks:**
1. Add `enable_stages`, `set_governance_agent`, `enable_beads`, `make_iteration_scenario`, `read_run_dir`, `assert_stage_sequence` to fixture / helpers.
2. Extend `mock_claude.py` directive resolution to per-iteration with backward compat. Add unit test in `tests/mock_claude/test_mock_claude.py`.
3. Add stub binaries + `WORCA_STUB_LOG` recording. Document the format in a docstring.
4. Verify `test_fixture_smoke.py` still passes; add fixture-smoke tests for the new helpers.

### Phase 1: Agent retry loops
**Files:** `test_implementer_tester_loop.py`, `test_reviewer_loop.py`, `test_guardian_pr_creation.py`, `test_learn_stage.py`, `test_full_happy_path.py`
**Tasks:** Use Phase 0's per-iteration scenarios. Each test asserts on `events.jsonl` ordering, iteration artifacts under `runs/<id>/iterations/`, and `status.json` token aggregation.

### Phase 2: Governance hooks live
**Files:** `test_governance_hooks_live.py`
**Tasks:** Use `set_governance_agent("implementer")` etc. Scenarios attempt forbidden tool calls; tests assert hook blocks them via stderr/exit-code/state. Verifies the hook chain `CLAUDE.md` documents.

### Phase 3: Worktree + parallel + cleanup
**Files:** `test_run_worktree.py`, `test_run_parallel.py`, `test_worktree_cleanup.py`
**Tasks:** Drive `python -m worca.scripts.run_worktree` via `subprocess.run`. Assert `git worktree list` output, branch existence, run dir contents, and (for cleanup) idempotent removal.

### Phase 4: Resume e2e
**Files:** `test_resume_e2e.py`
**Tasks:** First run crashes/SIGTERMs mid-iteration; second run with `--resume` continues. Assert no duplicate iteration records and token usage carries forward.

### Phase 5: Beads + work_request
**Files:** `test_beads_integration.py`, possibly fixtures for plan-link issue bodies
**Tasks:** Use the `bd` stub log to assert pipeline-issued `bd create / bd update` invocations. For `--source gh:issue:N`, use a `gh` stub returning a canned issue body with a plan link.

### Phase 6: UI server boundary
**Files:** `test_ui_server_against_live_run.py`
**Tasks:** Start `worca-ui` server in a child process pointing at the integration tmp project; run a real pipeline; query the API; assert response shape and websocket emission. This subsumes the "files glob drops a module" failure mode by running the actually-installed package code.

### Phase 7: Misc edges
**Files:** `test_misc_edges.py`
**Tasks:** Targeted scenarios for each edge case, kept short.

### Files Changed Summary

| File | Change |
|---|---|
| `tests/integration/conftest.py` | Add fixture helpers (Phase 0) |
| `tests/integration/helpers.py` | Add matchers and run-dir reader |
| `tests/mock_claude/mock_claude.py` | Per-iteration directive resolution |
| `tests/mock_claude/test_mock_claude.py` | New unit tests for the per-iter mock behavior |
| `tests/integration/stubs/bd` | New stub binary |
| `tests/integration/stubs/gh` | New stub binary |
| `tests/integration/test_implementer_tester_loop.py` | New |
| `tests/integration/test_reviewer_loop.py` | New |
| `tests/integration/test_guardian_pr_creation.py` | New |
| `tests/integration/test_learn_stage.py` | New |
| `tests/integration/test_full_happy_path.py` | New |
| `tests/integration/test_governance_hooks_live.py` | New |
| `tests/integration/test_run_worktree.py` | New |
| `tests/integration/test_run_parallel.py` | New |
| `tests/integration/test_worktree_cleanup.py` | New |
| `tests/integration/test_resume_e2e.py` | New |
| `tests/integration/test_beads_integration.py` | New |
| `tests/integration/test_ui_server_against_live_run.py` | New |
| `tests/integration/test_misc_edges.py` | New |

## Considerations

- **CI runtime budget.** ~70 new tests at ~2-5s each is +3-6 minutes. Mitigate by keeping `delay_s` ≤ 0.05 in scenarios and turning on `pytest -n auto` once tests are isolated. Worktree tests are the slowest; budget separately.
- **Mock fidelity.** Per-iteration scenarios complicate `mock_claude.py`. The schema must remain backward-compatible so existing scenarios keep working. Add explicit unit tests for the mock itself.
- **Stub binaries vs real tools.** Real `bd` / `gh` are not in CI; stubs are the right call. The tradeoff is tests can drift from real CLI behavior — mitigate by versioning the stubs and pinning the canned responses to current real-world output.
- **Worktree cross-platform.** macOS canonicalizes `/var/...` to `/private/var/...` in worktree paths. Tests must compare via `realpath` or accept either form.
- **UI server test isolation.** Running the UI server in CI means binding to an ephemeral port and shutting down cleanly. Use `port=0` + `lsof`-style discovery, and ensure teardown kills the child even on test failure.
- **Governance live tests must run as a non-empty `WORCA_AGENT`.** Re-using the existing fixture's `_base_env` won't work — ensure `set_governance_agent` clears/replaces, doesn't append.
- **Breaking changes:** None. All additions are new tests + new fixture helpers; existing tests unchanged.
- **Migration:** None.

## Test Plan

This plan *is* a test plan. Done-criteria:

| Layer | Validation |
|---|---|
| `pytest tests/integration/` | All new + existing tests pass |
| `pytest tests/integration/ -k "loop or live or worktree"` | New phases pass in isolation |
| `tests/mock_claude/test_mock_claude.py` | Per-iteration mock behavior unit-verified |
| CI duration | Under +6 minutes added to integration job |

### Existing Tests to Update

- `test_fixture_smoke.py` — extend with smoke tests for the new fixture helpers (no behavioral change).
- No other existing tests should require changes; backward compatibility of the scenario schema is a hard requirement.

## Files to Create/Modify

See the *Files Changed Summary* table above. ~13 new test files, ~5 modified harness/mock files, 2 new stub binaries.

## Out of Scope

- Replacing or rewriting the existing integration tests — this plan is purely additive.
- Adding *unit* tests (those live elsewhere; this plan only addresses the integration tier).
- Cross-OS expansion beyond what the existing suite already supports (Windows is already explicitly skipped for signal tests; nothing changes here).
- Performance benchmarking — separate concern.
- A "real Claude" smoke tier — this plan stays on the mock harness.
