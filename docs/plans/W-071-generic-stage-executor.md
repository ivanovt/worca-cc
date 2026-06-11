# W-071: Generic Stage Executor and User-Defined Stages

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-06-10
**Depends on:** W-070

## Problem

Even with a declarative flow (W-070), users cannot *add* a stage or agent —
every stage's execution logic is bespoke code inline in the runner's main loop
(`src/worca/orchestrator/runner.py:3040-4700`, ~1,000+ lines of per-stage
handling: bead decomposition for coordinate, test-failure parsing, review
outcome routing, guardian PR metadata, milestone gates). The bindings that
would let a new stage exist are closed maps:

- stage → agent: `STAGE_AGENT_MAP` (`src/worca/orchestrator/stages.py:43-53`)
- stage → schema: `STAGE_SCHEMA_MAP` (`stages.py:66-76`)
- stage → prompt block: `_STAGE_BLOCK_MAP` (`runner.py:115-124`)
- agent template resolution falls back only to the shipped core dir
  (`_agent_path`, `runner.py:610-620`); schemas only to the shipped schema dir
  (`_schema_path`, `runner.py:623-625`).

Users can *override* an existing agent's prompt via the three-tier overlay
(`src/worca/orchestrator/overlay.py:113-142`) but a new agent name has nothing
to dispatch it. The architecture review explicitly deferred this decomposition
as "W-NNN-scale" (PR #320, "Explicitly not done"). This plan is that W-NNN.

## Proposal

Extract the common dispatch path every stage already shares — render prompt →
dispatch agent (`run_stage`, `runner.py:1574`) → validate structured output →
persist iteration → emit `STAGE_*` events → map output to an outcome trigger —
into a `StageExecutor`. Builtin stages keep their bespoke logic as registered
`StageHandler` classes (pure code motion, no behavior change). A stage named in
the flow with no registered handler gets the generic executor, with its agent
`.md`, block `.md`, and schema `.json` resolved from user-supplied locations.
Result: users add stages/agents by dropping three files and one flow entry.

## Design

### 1. Stage handler protocol and registry

- **Current state:** the loop body is one `if current_stage == Stage.X:` ladder
  (`runner.py:3040+`); per-stage logic and the shared dispatch scaffolding are
  interleaved.
- **Obstacle:** the bespoke blocks read and mutate loop-local state
  (`loop_counters`, `_next_trigger`, `status`, `prompt_builder`, `ctx`), so a
  naive extraction breaks pause/abort gating and resume.
- **Resolution:** a narrow protocol whose contract is exactly the loop-local
  state the blocks already touch, passed as one object:

```python
class StageRunContext:               # src/worca/orchestrator/executor.py
    flow_stage: FlowStage            # from W-070
    status: dict
    prompt_builder: PromptBuilder
    loop_counters: dict[str, int]
    emit: EventEmitter               # wraps ctx + the _emit_*_and_gate helpers
    settings_path: str

class StageHandler(Protocol):
    def pre_dispatch(self, rc: StageRunContext) -> None: ...
    def dispatch(self, rc: StageRunContext) -> StageResult: ...   # default: generic
    def post_dispatch(self, rc: StageRunContext, result: StageResult) -> str | None:
        """Return outcome trigger for flow.next_index(), or None to advance."""

HANDLER_REGISTRY: dict[str, type[StageHandler]] = {
    "preflight": PreflightHandler, "plan": PlanHandler,
    "plan_review": PlanReviewHandler, "coordinate": CoordinateHandler,
    "implement": ImplementHandler, "test": TestHandler,
    "review": ReviewHandler, "pr": PrHandler, "learn": LearnHandler,
}

def handler_for(stage: FlowStage) -> StageHandler:
    return HANDLER_REGISTRY.get(stage.name, GenericHandler)()
```

The main loop body collapses to: resolve handler → `pre_dispatch` →
`dispatch` → `post_dispatch` → `flow.next_index(stage, trigger)`. Control-gate
polling and circuit-breaker accounting stay in the loop (they are
stage-agnostic today and remain so).

### 2. `GenericHandler` — the path user stages take

- **Current state:** `run_stage` (`runner.py:1574`) already implements
  render → dispatch → schema-validate → iteration record for arbitrary
  stage/agent/schema arguments; what's missing is anyone calling it with
  non-builtin names.
- **Resolution:** `GenericHandler.dispatch` calls `run_stage` with the
  `FlowStage`'s agent/schema/block; `post_dispatch` maps the structured
  output's `outcome` field (if present) directly to a trigger name, so a custom
  stage's schema can drive `on:` transitions declared in the flow:

```python
class GenericHandler:
    def post_dispatch(self, rc, result) -> str | None:
        outcome = result.output.get("outcome")
        if outcome and outcome in rc.flow_stage.on:
            return outcome          # e.g. "needs_rework" -> goto per flow spec
        if outcome == "reject":
            raise StageFailedError(rc.flow_stage.name, result)
        return None                 # advance
```

Convention over configuration: `success`/missing → advance; `reject` → stage
failure (existing failure path); any other outcome must be declared in the
flow's `on:` map or flow validation (W-070 §2) rejects it at launch.

### 3. User-supplied agents, blocks, and schemas

- **Current state:** `_agent_path` falls back to
  `.claude/worca/agents/core/{name}.md` (`runner.py:610`); `_schema_path` is
  hard-pinned to `.claude/worca/schemas/` (`runner.py:623`); the overlay
  resolver already reads project files from `.claude/agents/`
  (`overlay.py:137`).
- **Obstacle:** today a project file in `.claude/agents/planner.md` is an
  *overlay* on the core planner; for a new name there is no core base, so
  resolution must treat the project file as the base itself.
- **Resolution:** extend resolution order (first hit wins), reusing the
  existing overlay machinery — a project file with no core counterpart simply
  resolves with an empty base, which `OverlayResolver.resolve` already handles:

| Artifact | Search order |
|---|---|
| agent `.md` | run_dir rendered → `.claude/agents/` → `.claude/worca/agents/core/` |
| block `.block.md` | unchanged three-tier chain (`overlay.py:144-195`) — project tier already supports new names |
| schema `.json` | `.claude/schemas/` (new dir) → `.claude/worca/schemas/` |

Custom schemas must declare `outcome` as a string enum if the stage has `on:`
transitions; flow validation cross-checks enum values against declared
triggers.

### 4. Governance for custom agents

- **Current state:** dispatch governance is keyed by agent name with a
  `_defaults` fallback and `["none"]` lockdown sentinel
  (`worca.governance.dispatch`, `docs/governance.md`); the commit guard checks
  `WORCA_AGENT` against `guardian` literally.
- **Obstacle:** a custom agent inherits `_defaults` silently — too permissive
  for an unknown role, and a custom "shipper" stage must not gain commit
  rights.
- **Resolution:** (a) custom agents not named in `per_agent_allow` resolve to
  the lockdown sentinel `["none"]` rather than `_defaults` — explicit grant
  required, with a launch-time warning naming the missing entry; (b) the
  guardian-only `git commit` guard is unchanged — custom agents can never
  commit; PR/commit duties stay on the builtin `pr` stage. Dispatch
  `worca-dispatch-governance-reviewer` on the implementing PR.

### 5. Obstacle catalog

| # | Obstacle | Severity | Resolution |
|---|---|---|---|
| 1 | Bead loop spans coordinate+implement with a runtime-derived cap (`runner.py:4238-4243`) | High | `CoordinateHandler`/`ImplementHandler` keep it verbatim; the `next_bead` self-loop is already expressible in the W-070 flow |
| 2 | Control gates (pause/abort) interleave every emit (`_emit_*_and_gate`, dedup'd on this branch) | High | Gates live in `StageRunContext.emit`; handlers call the same helpers — code motion only |
| 3 | Milestone gates (plan approval, PR approval) have asymmetric defaults (`runner.py:4484+`) | Medium | Stay inside `PlanHandler`/`PrHandler`; not generalized |
| 4 | Resume can land mid-stage with `_next_trigger` state | High | Trigger persistence is untouched; handler selection is deterministic from stage name |
| 5 | Cost/effort accounting per agent (`worca.agents.<name>`) | Low | Already name-keyed (`stages.py:114-193`) — arbitrary names work today |
| 6 | Windows lifecycle degradations (`docs/platform-support.md`) | Low | Executor sits above process control; no new process semantics |
| 7 | `Stage` enum comparisons sprinkled through helpers (`Stage.PR` PR-deferral at `runner.py:1623`) | Medium | Each remaining comparison moves into its builtin handler; grep-gate in CI (`rg "== Stage\." src/worca/orchestrator/runner.py` must hit only the registry) |

## Implementation Plan

### Phase 1: Extract `StageRunContext` + registry, move one simple stage
**Files:** `src/worca/orchestrator/executor.py` (new), `runner.py`,
`tests/test_executor.py`
**Tasks:**
1. Introduce the protocol/registry; move `TestHandler` (smallest bespoke block,
   `runner.py:4335-4360`) first; integration suite green = parity proven.

### Phase 2: Move remaining builtin stages, one per commit
**Files:** `executor.py`, `runner.py`
**Tasks:**
1. Order: plan → plan_review → review → pr → coordinate/implement (bead loop
   last, moved together) → learn/preflight.
2. After the last move, delete the `if current_stage ==` ladder; add the
   grep-gate from obstacle #7.

### Phase 3: GenericHandler + user file resolution + governance
**Files:** `executor.py`, `runner.py` (`_agent_path`/`_schema_path`),
`src/worca/hooks` + `src/worca/claude_hooks/` (lockdown default),
`tests/integration/test_custom_stage.py` (new)
**Tasks:**
1. Implement §2 and §3; flow-validation cross-checks (with W-070's loader).
2. Governance default-deny for unknown agents (§4) + warning.
3. End-to-end integration test: a `docs_audit` custom stage (agent .md +
   schema + block in `.claude/`) inserted between review and pr, with a
   `needs_rework → implement` transition, runs under mock claude.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/executor.py` | New: protocol, registry, builtin handlers, GenericHandler |
| `src/worca/orchestrator/runner.py` | Loop body delegates to handlers; resolution order in `_agent_path`/`_schema_path`; ladder deleted |
| `src/worca/orchestrator/flow.py` | Validation: custom outcomes vs schema enums (extends W-070) |
| `src/worca/claude_hooks/` + `src/worca/hooks/guard.py` | Unknown-agent lockdown default |
| `tests/test_executor.py` | New: handler unit tests |
| `tests/integration/test_custom_stage.py` | New: e2e custom stage |
| `docs/flow.md`, `docs/governance.md`, `CLAUDE.md` | Custom-stage authoring guide; governance note |

## Considerations

- **Breaking changes:** none for default runs — Phases 1–2 are code motion
  gated by the integration suite per commit. For *projects already naming
  unknown agents* in `per_agent_allow`: none (entry exists). The new
  lockdown-not-`_defaults` rule only affects agents that were never
  dispatchable before.
- **Migration:** none. Custom stages are additive opt-in.
- **Risk concentration:** Phase 2's coordinate/implement move (bead loop).
  Mitigation: moved last, together, behind the full integration suite plus the
  W-070 parity tests; revert is one commit.
- **Stage keys:** custom stage names enter `status.json` `stages.*`; the UI
  renders from data shape (design principle) — icon/label fallback for unknown
  names is a UI nicety, not a blocker. Dispatch `worca-stage-key-reviewer` on
  every Phase 2 PR.
- **Events:** `STAGE_STARTED/COMPLETED/FAILED` payloads already carry the stage
  name string (`runner.py:74-109`) — custom names flow through; no new event
  types (no `/worca-event-add` needed).

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_handler_registry_covers_builtin_flow` | Every default-flow stage has a registered handler |
| Python | `test_generic_handler_outcome_to_trigger` | §2 mapping incl. reject/undeclared-outcome |
| Python | `test_agent_path_project_tier_new_name` | `.claude/agents/foo.md` resolves with empty core base |
| Python | `test_schema_path_project_tier` | `.claude/schemas/` precedence |
| Python | `test_unknown_agent_locked_down` | §4 lockdown + warning |
| Python | `test_flow_rejects_undeclared_custom_outcome` | Schema-enum vs `on:` cross-check |

### Integration / E2E Tests
- Full `tests/integration/` suite after **every** stage-move commit (Phases 1–2)
  — done-criterion: zero diffs in produced `status.json` shapes vs. parent
  commit for the canonical mock run.
- `test_custom_stage.py`: custom stage end-to-end incl. loopback transition and
  resume-mid-custom-stage.

### Existing Tests to Update
- Tests asserting on runner internals moved into handlers (grep for
  `runner._handle`, none expected — the bespoke blocks are currently
  unaddressable, which is the point). `tests/test_resolve_agent_integration.py`
  gains a new-name case.

## Out of Scope

- Declared context inputs/outputs for custom stages (they get the ambient
  context dict as-is) — W-072.
- Custom *handlers* (user Python code) — only declarative custom stages;
  arbitrary code execution per stage is a governance decision deferred.
- Parallel stage execution / DAG semantics inside a single run (workspace runs
  already cover cross-project DAGs).
- UI authoring/editing of custom stages.
- Granting commit/PR ability to any non-guardian agent.
