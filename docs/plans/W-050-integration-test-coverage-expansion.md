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

## Baseline Coverage (2026-05-04)

Measured with `pytest-cov` + `coverage` (branch mode, subprocess-aware). Captured before any phase of W-050 lands so we can quantify each phase's contribution.

**Run:** 114 passed / 45 skipped / 0 failed, 6:27 wall time (vs ~3:30 without coverage — ~85% overhead).
**Total: 32.0% line, 13% branch (BrPart 338).** 6,783 statements / 2,586 branches across `src/worca/`.

### Best-covered modules (state-machine core works)

| Module | Cover |
|---|---|
| `orchestrator/stages.py` | 94.5% |
| `utils/env.py` | 87.1% |
| `orchestrator/overlay.py` | 79.6% |
| `utils/settings.py` | 68.8% |
| `orchestrator/control.py` | 68.1% |
| `orchestrator/error_classifier.py` | 66.4% |
| `events/types.py` | 61.0% |
| `events/emitter.py` | 59.5% |
| `scripts/run_pipeline.py` | 57.9% |
| `utils/claude_cli.py` | 56.2% |
| `orchestrator/runner.py` | **50.6%** (1,582 stmts — the big one) |

### Zero-coverage modules — exact targets of W-050

**Hook layer (Phase 2):** every file in `claude_hooks/` (post/pre tool use, session_*, subagent_*, user_prompt_submit, stop, pre_compact) and `hooks/` (guard, plan_check, tracking, session, prompt) at **0.0%**. Plus `events/hook_emitter.py` and `events/dispatch_external.py` at 0%. Caused by `WORCA_AGENT=""` in the fixture short-circuiting governance hooks.

**Worktree / parallel / sync (Phase 3):**
- `scripts/run_worktree.py` (167 lines), `scripts/run_parallel.py` (111 lines), `scripts/sync_commit.py` (118 lines), `scripts/sync_pr.py` (83 lines), `scripts/worca_lifecycle.py` (152 lines) — all **0.0%**
- `orchestrator/cleanup.py`, `cli/cleanup.py` — **0.0%**

**Disabled stages (Phase 1):** `scripts/preflight_checks.py` and `scripts/run_learn.py` at 0% — preflight + learn disabled in fixture.

**CLI surface:** `cli/init.py` (446 lines) and the rest of `cli/*` at 0%. Note: `worca init` *is* invoked once per test, but as a non-coverage-wrapped subprocess. This is a measurement artifact; easy to fix by wrapping the init step too.

### Partial-coverage modules — high-value lift targets

| Module | Cover | Phase |
|---|---|---|
| `orchestrator/registry.py` | 11.3% | (incidental) |
| `utils/git.py` | 17.3% | Phase 3 |
| `orchestrator/work_request.py` | 19.0% | Phase 5 |
| `utils/gh_issues.py` | 21.6% | Phase 5 |
| `orchestrator/resume.py` | 22.6% | Phase 4 |
| `utils/beads.py` | 32.4% | Phase 5 |
| `orchestrator/templates.py` | 40.1% | Phase 1 (overlay reuse) |
| `orchestrator/prompt_builder.py` | 43.7% | Phase 1 |
| `state/status.py` | 46.6% | Phase 1/4 |
| `events/webhook.py` | 47.0% | Phase 6 |
| `utils/token_usage.py` | 51.1% | Phase 1 |
| `orchestrator/runner.py` | 50.6% | Phase 1 (biggest single move) |

### Branch coverage detail

`runner.py` carries **726 branches with 169 partial** — the BrPart column. Many of those partials are the "if condition X happens during retry" cases that line coverage counts as "covered." This is exactly the case branch coverage was designed for, and where Phase 1 (agent retry loops) will move the most.

### Expected post-W-050

Rough estimate: **32% → 60-65% line coverage**, with branch coverage moving proportionally more in `runner.py`, `prompt_builder.py`, and `resume.py`. Each phase commit should include the post-phase coverage delta in its description so we can attribute movement.

### How to reproduce locally

```bash
pip install -e ".[dev]"                   # installs pytest-cov + coverage[toml]
WORCA_COVERAGE=1 pytest tests/integration/ --timeout=120
coverage combine
coverage report                            # terminal
coverage html                              # htmlcov/index.html
```

Setting `WORCA_COVERAGE=1` activates `_wrap_with_coverage()` in `tests/integration/conftest.py` — pipeline subprocesses get wrapped with `coverage run --parallel-mode`. Without the env var, the suite runs at normal speed.

## Pipeline Run Notes

This plan is intended to be executed by the worca autonomous pipeline. The notes below address failure modes specific to autonomous execution that a human implementer would handle by judgment. **All notes here are binding constraints on the planner / coordinator / implementer / tester / reviewer / guardian agents.**

### Sequencing & PR strategy

1. **One PR per phase, phases land in order.** Phase 0 must merge before any other phase opens a PR. Phases 1-7 do not depend on each other and can run in any order *after* Phase 0 is merged. Each phase PR description must reference Phase 0's commit SHA so reviewers can verify ordering.
2. **Do not bundle phases.** A single mega-PR is rejected on review. If the pipeline is tempted to combine phases, it must split first.

### Done-criteria per phase

3. **Each phase PR description must include a "Coverage delta" section** with before/after numbers on the modules that phase targets:
   ```
   WORCA_COVERAGE=1 pytest tests/integration/ --timeout=120
   coverage combine && coverage report
   ```
   Phase fails review if delta on its named target modules is < +10 percentage points (line coverage).
4. **All ~124 existing integration tests must continue to pass** under the modified fixture / mock. The tester agent must run the full integration suite (not only new tests) and report total pass count in the PR description.

### Mock & fixture backward compatibility

5. **`mock_claude.py` per-iteration directives must be backward compatible.** Phase 0 must include a regression test in `tests/mock_claude/test_mock_claude.py` that loads at least three pre-existing scenario JSONs (from current integration tests) and asserts identical mock behavior. If existing scenarios silently fall through to defaults, all 124 tests pass while testing nothing — the regression test catches this.
6. **Do not change the existing `_RESOLVED_RE` regex** in `mock_claude.py` (line 17). Iteration parsing reuses it; widening it can mis-extract agent names from resolved template paths.

### Scope lock (binding)

7. **Out of scope for every W-050 phase:**
   - Refactoring any code under `src/worca/` (this plan adds *tests*, not source changes)
   - Fixing pre-existing failing tests (CLAUDE.md: "Pre-existing failures in unrelated tests should be ignored")
   - Modifying CLI flags or argparse definitions
   - Modifying `.github/workflows/*.yml` to make coverage the default test job (see #11 below)
   - Adding `--fail-under` thresholds (see #10)
8. **Files this plan may touch:** `tests/integration/**`, `tests/mock_claude/**`, `.coveragerc`, the new `tests/integration/stubs/` directory, and `pyproject.toml` (only if a new dev dep is genuinely required). Touching anything outside this list requires explicit justification in the PR description.

### Governance hook safety (Phase 2)

9. **The pipeline itself runs under the very hooks Phase 2 tests.** A buggy hook change can lock the pipeline out of further commits. Phase 2 implementer must:
   - Run hook unit tests before each commit: `pytest tests/test_pre_tool_use.py tests/test_post_tool_use.py tests/test_plan_check.py tests/test_guard.py tests/test_tracking.py tests/test_session.py`
   - Abort the iteration if any unit test fails
   - Never modify any file under `src/worca/claude_hooks/` or `src/worca/hooks/` — Phase 2 only adds *tests* that drive existing hook code

### Coverage gating

10. **Do not add `--fail-under` to `.coveragerc`, CI, shell scripts, or any tool config during W-050.** Coverage remains a measurement tool, not a gate, until all phases land. A separate post-merge phase 8 (out of scope here) will set per-module thresholds once data is available.
11. **CI coverage runs as an opt-in side job, never the default.** Pipeline may add a new `python-coverage` job in `.github/workflows/test.yml` with `continue-on-error: true` and a 15-minute timeout. The existing `python-tests` job must remain unchanged. Do not swap `pytest tests/` for `WORCA_COVERAGE=1 pytest tests/` in any existing job.

### Test runtime & timeouts

12. **Coverage adds ~85% overhead.** New tests in Phases 1, 4, 6 that exercise multi-iteration runs must set `@pytest.mark.timeout(180)` explicitly. Do not change the global `timeout = 30` default in `pyproject.toml`.
13. **Keep `delay_s` ≤ 0.05 in scenarios.** Each iteration of a per-iteration scenario adds wall time; high `delay_s` values inflate suite runtime quickly when combined with coverage overhead.

### Phase-specific safeguards

14. **Phase 1 — sanity-check the mock.** Each new test file (`test_implementer_tester_loop.py`, `test_reviewer_loop.py`, etc.) must include at least one assertion that the per-iteration mock *actually changes behavior between iterations* — e.g. verify iteration 1 returns different output than iteration 2 from the agent log. If the mock silently always returns the default, the entire phase tests nothing while passing.
15. **Phase 3 — worktree-inside-worktree.** If the W-050 pipeline run itself uses `run_worktree.py`, Phase 3 tests will create worktrees inside an already-worktreed run. Tests must:
    - Use unique worktree paths (`tmp_path / f"wt-{uuid4().hex}"`)
    - Not assume the parent repo's branch is `master`
    - Use `realpath` when comparing worktree paths (macOS canonicalizes `/var/...` to `/private/var/...`)
    - Clean up via `git worktree remove --force` in a pytest fixture finalizer, *even on test failure*
16. **Phase 5 — stub binaries must never modify global PATH.** The pipeline uses real `bd` for issue tracking; a globally-shadowed `bd` breaks the pipeline mid-run. Stubs must be activated per-test via `monkeypatch.setenv("PATH", ...)`. Same rule for the `gh` stub. Do not write to `~/.bashrc`, `~/.zshrc`, or any persistent PATH location.
17. **Phase 6 — UI server lifecycle.** Tests must bind to port 0 (ephemeral) and discover the assigned port from `server.address`. The child process must be killed in a fixture finalizer (`finally: proc.kill(); proc.wait(timeout=5)`) so a hung server doesn't leak across tests.

### `cli/init.py` measurement artifact (do not "fix")

18. **The 0% line coverage on `src/worca/cli/init.py` is intentional.** `worca init` runs as a non-coverage-wrapped subprocess in the fixture's project setup (conftest.py:46) — by design, because wrapping the init step would multiply runtime by N (one init per test). Pipeline must not modify the init invocation in conftest.py to wrap with coverage.

### Recommended pipeline invocation

```bash
# From the worca-cc repo, on a clean master:
python -m worca.scripts.run_worktree \
    --source gh:issue:123 \
    --branch master \
    --prompt "Implement Phase 0 of W-050: fixture extensions"
```

Run one phase per pipeline invocation. After phase 0 merges, repeat with `--prompt "Implement Phase 1 of W-050: agent retry loops"`, and so on. Using `run_worktree.py` (not in-place `run_pipeline.py`) is mandatory because Phase 3's worktree tests would otherwise clobber the active run's `.worca/runs/` directory.

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
