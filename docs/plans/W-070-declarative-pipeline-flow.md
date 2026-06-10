# W-070: Declarative Pipeline Flow Specification

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-06-10
**Depends on:** None

## Problem

The pipeline's flow — stage order and loop topology — is hardcoded Python control
flow, contradicting the stated design principle ("Generic stage system — stages are
data-driven, not hardcoded, so the pipeline is reconfigurable",
`docs/design-principles.md`). Concretely:

- The canonical sequence is a Python list of enum members: `STAGE_ORDER`
  (`src/worca/orchestrator/stages.py:91`), consumed by an index-walking loop
  `while stage_idx < len(stage_order)` (`src/worca/orchestrator/runner.py:3040`).
- All five loopback/jump targets are literal `stage_idx = stage_order.index(...)`
  reassignments inside the loop body:
  - plan_review → PLAN (`runner.py:4061`, trigger `plan_review_revise`)
  - bead loop → IMPLEMENT (`runner.py:4243`, trigger `next_bead`)
  - test → IMPLEMENT (`runner.py:4343`, trigger `test_failure`, loop `implement_test`)
  - review → IMPLEMENT (`runner.py:4444`, trigger `review_changes`, loop `pr_changes`)
  - review → PLAN (`runner.py:4479`, trigger `restart_planning`)
- Config can only toggle stages on/off and swap the agent per stage
  (`stages.py:114` `get_stage_config`, `stages.py:222` `get_enabled_stages`). Loop
  *limits* are config (`worca.loops`, names pinned in
  `src/worca/orchestrator/templates.py:197-202`), but loop *topology* is not.

Users cannot reorder stages, insert a stage, or redirect where a loop goes without
editing `runner.py`. This blocks the pluggable-pipeline roadmap (W-071 custom
stages, W-072 context contract) and forces every flow change through a risky edit
of a 4,700-line module.

## Proposal

Introduce a declarative **flow spec**: a JSON document describing the ordered
stage list and outcome-driven transitions (including loops with counters and
limits). Ship the current 9-stage behavior as the builtin default flow, compiled
from the same data. The runner walks the compiled `FlowSpec` instead of doing
`stage_idx` arithmetic; the five jump sites become declarative `on:` transitions.
Zero behavior change by default; `worca.flow` (template-ownable) lets projects and
templates override the topology.

## Design

### 1. Flow spec schema (`worca.flow`)

- **Current state:** no flow document exists; topology lives in
  `stages.py:91` + five jump sites in `runner.py`.
- **Obstacle:** the spec must express everything the hardcoded flow does today:
  linear advance, conditional stages, outcome-driven jumps, loop counters with
  limits, and the post-pipeline `learn` stage (outside `STAGE_ORDER`, dispatched
  separately at `runner.py:1232`).
- **Resolution:** a `flow` object under the `worca` namespace (settings or
  template `config`), validated against a new packaged schema
  `src/worca/schemas/flow.json`:

```json
{
  "flow": {
    "version": 1,
    "stages": [
      { "name": "preflight" },
      { "name": "plan", "agent": "planner", "schema": "plan.json",
        "prompt_block": "plan" },
      { "name": "plan_review", "agent": "plan_reviewer",
        "enabled": false,
        "on": { "plan_review_revise": { "goto": "plan", "loop": "plan_review" } } },
      { "name": "coordinate", "agent": "coordinator" },
      { "name": "implement", "agent": "implementer",
        "on": { "next_bead": { "goto": "implement", "loop": "bead_iteration" } } },
      { "name": "test", "agent": "tester",
        "on": { "test_failure": { "goto": "implement", "loop": "implement_test" } } },
      { "name": "review", "agent": "reviewer",
        "on": { "review_changes": { "goto": "implement", "loop": "pr_changes" },
                 "restart_planning": { "goto": "plan", "loop": "restart_planning" } } },
      { "name": "pr", "agent": "guardian" },
      { "name": "learn", "agent": "learner", "enabled": false, "post": true }
    ]
  }
}
```

Field semantics:

| Field | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | — | Stage key. Becomes the `status.json` `stages.*` key verbatim. |
| `agent` | no | `STAGE_AGENT_MAP` lookup, else `name` | Agent template name. |
| `schema` | no | `{name}.json` (existing convention, `stages.py:192`) | Structured-output schema file. |
| `prompt_block` | no | `_STAGE_BLOCK_MAP` lookup, else `name` | Stage block `.block.md` name (`runner.py:115-124`). |
| `enabled` | no | per-stage default (`stages.py:114-193`) | Same semantics as `worca.stages.<name>.enabled`. |
| `on` | no | `{}` | Map of outcome trigger → transition. Absence of a matching trigger means "advance to next stage in list". |
| `on.<t>.goto` | yes (in `on`) | — | Target stage `name`. |
| `on.<t>.loop` | no | — | Loop counter key; limit from `worca.loops.<key>` (default 5, `templates.py:203`). Exhaustion follows current per-loop semantics (finish vs. `LoopExhaustedError`). |
| `post` | no | `false` | Runs after the terminal transition (today: `learn`). |

### 2. `FlowSpec` loader and validation

- **Current state:** `get_enabled_stages()` (`stages.py:222`) filters the enum
  list; no validation layer exists because nothing is user-supplied.
- **Obstacle:** a malformed flow must fail at launch, not mid-run — same
  fail-loud posture this branch gave `prompt_builder.load_context`
  (`src/worca/orchestrator/prompt_builder.py:142`).
- **Resolution:** new module `src/worca/orchestrator/flow.py`:

```python
@dataclass(frozen=True)
class FlowStage:
    name: str
    agent: str | None
    schema: str
    prompt_block: str
    enabled: bool
    post: bool
    on: dict[str, Transition]   # Transition(goto: str, loop: str | None)

class FlowSpec:
    stages: list[FlowStage]                 # enabled, non-post, in order
    post_stages: list[FlowStage]
    def next_index(self, current: str, trigger: str | None) -> int | None: ...
    def index_of(self, name: str) -> int: ...

def load_flow(settings_path: str) -> FlowSpec:
    """worca.flow if present, else compile_default_flow(). Raises FlowError on:
    duplicate stage names; goto targets that don't exist or are disabled;
    backward goto without a loop key (unbounded cycle); loop keys colliding
    with reserved counters; missing agent template or schema file at the
    resolved paths (_agent_path / _schema_path, runner.py:610/623)."""
```

`compile_default_flow()` produces the JSON in §1 from `STAGE_ORDER`,
`STAGE_AGENT_MAP` (`stages.py:43`), `STAGE_SCHEMA_MAP` (`stages.py:66`), and
`_STAGE_BLOCK_MAP` — keeping the enum as the single source for the builtin set.
`worca.stages.<name>.enabled` / `.agent` overrides are merged into the compiled
flow so existing config keeps working unchanged.

### 3. Runner integration

- **Current state:** index arithmetic plus five literal jump sites
  (`runner.py:3040, 4061, 4243, 4343, 4444, 4479`); resume re-derives the index
  via `stage_order.index(resume_stage)` (`runner.py:3006`).
- **Obstacle:** each jump site is interleaved with side effects that must keep
  their exact order: `_emit_loop_triggered_and_gate(...)`, `_next_trigger[...]`
  assignment, `prompt_builder.save_context(...)`, `save_status(...)`.
- **Resolution:** mechanical replacement only — the side effects stay where they
  are; the index assignment is delegated:

```python
# before (runner.py:4343)
_next_trigger[Stage.IMPLEMENT.value] = "test_failure"
stage_idx = stage_order.index(Stage.IMPLEMENT)
continue

# after
_next_trigger[target.name] = "test_failure"
stage_idx = flow.next_index(current_stage.name, "test_failure")
continue
```

The other four jump sites (`runner.py:4061, 4243, 4444, 4479`) follow the
identical shape — the review stage simply has two `on:` entries
(`review_changes`, `restart_planning`), each converted independently.
`stage_order` becomes `flow.stages`; `current_stage` becomes a `FlowStage` whose
`.name` replaces `Stage.X.value` comparisons. The `Stage` enum is retained for
builtin-stage identity checks (bead loop, PR gating) in this plan — W-071 removes
those checks; this plan deliberately does not.

### 4. State, resume, and run identity

- **Current state:** `status.json` `stages.*` keys come from `Stage.value`
  strings (`src/worca/state/status.py:281`); loop counters live in
  `status.loop_counters`.
- **Obstacle:** if a project edits `worca.flow` while a run is paused, resume
  could walk a different topology than the one that produced `status.json` —
  the same class of bug as the stage-key gotcha (`worca-stage-key-reviewer`).
- **Resolution:** persist a `flow_fingerprint` (sha256 of the canonicalized
  compiled flow) in `status.json` at launch. On resume, recompute and compare;
  mismatch fails loudly with the same posture as corrupt `prompt_context.json`
  (`prompt_builder.py:142`) — message names the changed stages and tells the
  user to restore the flow or start a new run. Default-flow runs are unaffected
  (fingerprint stable across versions unless the default itself changes, which
  is release-noted).

### 5. Configuration precedence and template ownership

- **Current state:** `worca.stages` and `worca.loops` are template-driven keys
  (CLAUDE.md, `docs/configuration-precedence.md`) — stripped from the project
  merge base when a template is in play.
- **Resolution:** `worca.flow` joins the template-driven set (added to the strip
  list in `templates.py` alongside `stages`/`loops`). Precedence: per-run
  override (future flag, out of scope) → template `config.flow` → project
  `worca.flow` → builtin default. `worca.stages.*` remains supported as
  shorthand that merges *into* whichever flow is selected (documented in
  `docs/configuration-precedence.md`).

## Implementation Plan

### Phase 1: FlowSpec module + default-flow parity (no runner changes)
**Files:** `src/worca/orchestrator/flow.py`, `src/worca/schemas/flow.json`,
`tests/test_flow.py`
**Tasks:**
1. Implement `FlowStage`/`Transition`/`FlowSpec`/`load_flow`/`compile_default_flow`.
2. Parity test: compiled default flow reproduces `STAGE_ORDER`,
   `STAGE_AGENT_MAP`, `STAGE_SCHEMA_MAP`, `_STAGE_BLOCK_MAP`, and the five
   transitions exactly (table-driven against the literals in `runner.py`).
3. Validation tests: every `FlowError` branch in §2.

### Phase 2: Runner consumes FlowSpec
**Files:** `src/worca/orchestrator/runner.py`, `src/worca/orchestrator/stages.py`
**Tasks:**
1. Replace `get_enabled_stages()` call sites with `load_flow().stages`;
   keep `get_enabled_stages` as a thin wrapper (other callers + tests).
2. Convert the five jump sites to `flow.next_index(...)` (§3, one commit per
   site; integration suite must stay green after each).
3. Route `learn` dispatch (`runner.py:1232`) through `flow.post_stages`.
4. Persist + verify `flow_fingerprint` (§4).

### Phase 3: Config surface + docs
**Files:** `src/worca/orchestrator/templates.py`, `docs/configuration-precedence.md`,
`docs/flow.md` (new), `CLAUDE.md`
**Tasks:**
1. Add `flow` to the template-driven key strip list.
2. Document the schema, defaults table, and fingerprint semantics.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/flow.py` | New: FlowSpec model, loader, validator, default-flow compiler |
| `src/worca/schemas/flow.json` | New: JSON schema for `worca.flow` |
| `src/worca/orchestrator/runner.py` | Walk FlowSpec; five jump sites → `next_index`; fingerprint check |
| `src/worca/orchestrator/stages.py` | `get_enabled_stages` delegates to flow module |
| `src/worca/orchestrator/templates.py` | `flow` becomes template-driven key |
| `src/worca/state/status.py` | Store `flow_fingerprint` |
| `tests/test_flow.py` | New: parity + validation suites |
| `tests/test_stages.py` | Update: pins assert *default-flow* order via compiler, not raw enum |
| `docs/flow.md`, `docs/configuration-precedence.md`, `CLAUDE.md` | Docs |

## Considerations

- **Breaking changes:** none by default. The compiled default flow is
  asserted byte-equivalent to current behavior in CI (parity test).
  Custom flows are opt-in.
- **Migration:** none for users. `worca.stages.*` keeps working (merged into the
  selected flow). Release notes flag `flow_fingerprint` (old in-flight runs
  resumed under the new version get a fingerprint backfilled, not rejected).
- **Governance:** the flow spec cannot widen agent capability — dispatch
  governance (`worca.governance.dispatch`) is keyed by agent name and applies
  to whatever the flow names; custom *agents* are W-071 scope.
- **Stage-key gotcha:** flow `name` values ARE the stage keys; the plan keeps
  builtin names identical, so existing `stages.*` consumers (UI, hooks,
  state-action matrix) see no change. Consult `/state-action-matrix` before
  Phase 2 — transitions move but the state set must not.
- **Known unknown:** the bead loop counter (`bead_iteration`, safety cap at
  `runner.py:4238`) is dynamic (cap depends on created bead count), unlike the
  four config loops. Modeled as a loop key whose limit is provided at runtime,
  not from `worca.loops`.

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_default_flow_matches_legacy_order` | Compiled default == `STAGE_ORDER` + maps |
| Python | `test_default_flow_transitions_match_jump_sites` | The five `on:` entries match runner literals |
| Python | `test_next_index_linear_advance` | No trigger → next enabled stage |
| Python | `test_next_index_loop_target` | Trigger → declared `goto` index |
| Python | `test_flow_rejects_unknown_goto` / `_duplicate_names` / `_unbounded_backward_goto` / `_missing_schema_file` | Each `FlowError` branch |
| Python | `test_fingerprint_mismatch_fails_resume` | §4 fail-loud resume |
| Python | `test_loop_limit_runtime_provided` | `bead_iteration` cap supplied at runtime, not from `worca.loops` |
| Python | `test_template_owns_flow_key` | Strip-list behavior |

### Integration / E2E Tests
- Full `tests/integration/` suite green after each Phase 2 commit (mock claude) —
  this is the done-criterion for "zero behavior change".
- New integration test: custom flow with a reordered optional stage and a
  redirected loop target completes; `status.json` stage keys match flow names.

### Existing Tests to Update
- `tests/test_stages.py:88-99` — `STAGE_ORDER` pins re-expressed against the
  compiled default flow (the enum stays, so most pins survive unchanged).

## Out of Scope

- User-defined stages/agents and removal of builtin-stage identity checks in
  handler logic — W-071.
- Declared inter-stage context inputs/outputs — W-072.
- A per-run `--flow` CLI override flag.
- UI flow editor; the UI continues rendering from `status.json` data shape.
- Conditional transitions on arbitrary expressions (only schema-outcome
  triggers, matching today's semantics).
