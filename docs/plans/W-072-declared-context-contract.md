# W-072: Declared Inter-Stage Context Contract

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-06-10
**Depends on:** W-070, W-071

## Problem

Data flows between stages through an ambient, undeclared context dict. The
runner mutates it via scattered `prompt_builder.update_context(key, value)`
calls (100+ sites across `src/worca/orchestrator/runner.py` — e.g. plan outputs
at `runner.py:3862`, review issues around `runner.py:4246`), and prompts consume
whatever happens to be present via `{{placeholder}}` resolution
(`PromptBuilder.build_context`, `src/worca/orchestrator/prompt_builder.py:170`;
`resolve_agent`, `src/worca/orchestrator/overlay.py:409`). Consequences:

- **No contract:** nothing states which keys a stage may rely on. A typo'd
  placeholder silently renders as empty string
  (`overlay.py:359-366` — missing keys default to `""`), the exact bug class
  the guardian hygiene test catches only for builtin templates.
- **Custom stages are second-class:** a W-071 generic stage has no sanctioned
  way to publish data downstream — its schema'd output is persisted to
  `status.json` iterations but never enters the prompt context.
- **Fragile persistence:** `prompt_context.json` is an untyped key soup; this
  branch made corruption fail loudly (`prompt_builder.py:142-171`) but the
  *content* remains unverifiable.

## Proposal

Each flow stage declares `outputs` — named values extracted from its validated
schema output — which the executor (W-071) publishes automatically under a
namespaced key `stages.<name>.<output>`. Prompts reference namespaced keys;
flow validation (W-070) lints that every placeholder consumed by a stage's
templates is produced by some upstream stage (or is a runtime-provided builtin).
Legacy flat keys are preserved through a generated alias table during
migration, then runner `update_context` call sites are converted incrementally.

## Design

### 1. Output declarations in the flow spec

- **Current state:** stage outputs are implicit — e.g. PLAN sets
  `plan_approach` / `plan_tasks_outline` (`runner.py:3862`) by hand after
  parsing the schema result.
- **Obstacle:** declarations must be expressive enough for today's extractions,
  which are mostly direct field picks plus a few light transforms (joins,
  truncation).
- **Resolution:** extend the W-070 stage entry with an `outputs` map of output
  name → JSON-pointer into the stage's validated schema result. Transforms stay
  in code (handlers); declarative outputs cover the pick-and-publish majority:

```json
{ "name": "plan", "agent": "planner", "schema": "plan.json",
  "outputs": {
    "approach":      "/approach",
    "tasks_outline": "/tasks"
  } }
```

The executor publishes `stages.plan.approach` etc. after schema validation.
Pointers are validated against the schema's `properties` at flow load — an
output naming a nonexistent field fails launch (consistent with W-070
fail-loud validation).

### 2. Namespaced context and placeholder syntax

- **Current state:** flat keys only; placeholder regex accepts
  `[a-zA-Z_][a-zA-Z0-9_]*` (`overlay.py:328-330`), so dots are currently
  invalid in `{{name}}`.
- **Obstacle:** extending the regex must not disturb `{{block:...}}` /
  `{{#if}}` parsing (`overlay.py:333`, `_BLOCK_RE`), and `{{#if}}` key lookup
  must support the same dotted paths.
- **Resolution:** extend `_PLACEHOLDER_RE` and `_INNER_COND_RE` key syntax to
  `[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)*`; `resolve_placeholders`
  (`overlay.py:336`) gains a dotted-path lookup into nested dicts:

```python
# before (overlay.py:359)
return str(context.get(key, ""))

# after
return str(_dig(context, key, default=""))   # "stages.plan.approach"
```

`PromptBuilder` stores `stages` as a nested dict inside `self._context`;
`prompt_context.json` gains `"schema_version": 2` with the nested shape
(version 1 files load via the alias table in §4 — no fail-loud needed, the
shape is detectable).

### 3. Consumption linting

- **Current state:** unresolved placeholders silently become `""`; the only
  net is per-template hygiene tests (e.g.
  `tests/test_guardian_state_machine.py`).
- **Obstacle:** templates are user-overridable (three-tier overlay), so linting
  must run against the *resolved* template set for this run, at launch.
- **Resolution:** at flow load, render each enabled stage's resolved agent +
  block templates with a probe context and collect referenced dotted keys
  (reuse the existing unresolved-token scan, `prompt_builder.py:385`). For each
  `stages.<s>.<o>` reference, require `<s>` to precede the consumer in the flow
  (or be reachable via a declared loop) and `<o>` to be in `<s>`'s `outputs`.
  Builtin runtime keys (work request, branch, iteration, trigger — enumerated
  in a `RESERVED_CONTEXT_KEYS` constant) are exempt. Violations are launch-time
  errors for custom flows, **warnings** for the default flow until Phase 3
  completes (the builtin templates still use flat keys mid-migration).

### 4. Legacy flat-key aliases and incremental migration

- **Current state:** builtin templates and runner code use ~30 flat keys
  (`plan_approach`, `test_failures`, `review_issues`, `unresolved_plan_issues`
  at `runner.py:4246`, guardian PR metadata, …).
- **Obstacle:** converting 100+ `update_context` sites and 13 agent templates
  at once is unreviewable; and project-level agent *overlays* may reference
  flat keys we don't control.
- **Resolution:** a generated alias table maps flat → namespaced
  (`plan_approach` → `stages.plan.approach`); `_dig` consults aliases on miss,
  and publication writes both forms during migration. Builtin stages convert
  one stage per commit (declare `outputs`, update its templates, drop its
  hand-rolled `update_context` calls). The dual-write + alias layer is kept for
  two releases for third-party overlays, then flat publication is dropped
  (alias *read* support stays indefinitely — it is ~20 lines).

## Implementation Plan

### Phase 1: Namespaced context plumbing
**Files:** `src/worca/orchestrator/overlay.py`,
`src/worca/orchestrator/prompt_builder.py`, `tests/test_overlay.py`,
`tests/test_prompt_builder_context_persistence.py`
**Tasks:**
1. Dotted-path placeholder/conditional syntax + `_dig` (§2).
2. `prompt_context.json` schema_version 2 read/write; v1 load path.
3. Alias table mechanism (read-through + dual-write hooks, empty table).

### Phase 2: Executor auto-publish + lint
**Files:** `src/worca/orchestrator/flow.py`, `src/worca/orchestrator/executor.py`,
`tests/test_flow.py`, `tests/test_executor.py`
**Tasks:**
1. `outputs` field in flow schema + pointer-vs-schema validation (§1).
2. `GenericHandler`/executor publishes declared outputs post-validation.
3. Launch-time consumption lint (§3), warning-mode for default flow.

### Phase 3: Builtin stage conversion (one stage per commit)
**Files:** `src/worca/orchestrator/runner.py` / `executor.py` handlers,
`src/worca/agents/core/*.md` + `*.block.md`, alias table
**Tasks:**
1. Conversion order: plan → plan_review → coordinate → test → review → pr →
   learn (implement last; it consumes the most upstream keys).
2. Flip default-flow lint from warning to error; remove dual-write after the
   deprecation window.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/overlay.py` | Dotted-path keys in placeholders/conditionals |
| `src/worca/orchestrator/prompt_builder.py` | Nested context, schema_version 2, alias read-through |
| `src/worca/orchestrator/flow.py` | `outputs` declarations + consumption lint |
| `src/worca/orchestrator/executor.py` | Auto-publish declared outputs |
| `src/worca/orchestrator/runner.py` | Hand-rolled `update_context` sites removed per stage |
| `src/worca/schemas/flow.json` | `outputs` map |
| `src/worca/agents/core/*.md`, `*.block.md` | Namespaced placeholder migration |
| `tests/test_overlay.py`, `tests/test_flow.py`, `tests/test_executor.py`, `tests/test_prompt_builder_context_persistence.py` | New/updated suites |
| `docs/flow.md`, `docs/configuration-precedence.md` | Contract + migration docs |

## Considerations

- **Breaking changes:**
  - `prompt_context.json` v2 shape — mitigated: v1 detected and loaded via
    aliases; resumes across the version boundary work.
  - Flat-key *publication* removal (end of Phase 3) — mitigated: two-release
    deprecation, launch-time warning listing flat keys referenced by project
    overlays, alias reads kept indefinitely.
  - Placeholder syntax widening — additive; existing templates parse
    identically (dot only valid *inside* a key, `{{block:...}}` unaffected —
    regression-tested against the full 84-combination render corpus from
    PR #320).
- **Migration:** flat→namespaced table published in `docs/flow.md` and
  MIGRATION.md; project overlay authors grep their `.claude/agents/` for flat
  keys.
- **Governance:** none — context is data, not capability.
- **Known unknown:** a few context values are transforms, not picks
  (truncated diffs, joined failure lists). They remain handler code publishing
  into the namespace directly; the lint treats handler-published names as
  declared via a `code_outputs` list on the builtin handler class.

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_dotted_placeholder_resolution` | `{{stages.plan.approach}}` digs nested dict |
| Python | `test_dotted_conditional` | `{{#if stages.test.failed}}` |
| Python | `test_block_re_unaffected_by_dots` | `{{block:...}}`/`{{#if}}` parsing unchanged |
| Python | `test_outputs_pointer_validated_against_schema` | §1 launch failure on bad pointer |
| Python | `test_executor_publishes_declared_outputs` | Namespaced publication post-validation |
| Python | `test_consumption_lint_orders_and_outputs` | §3 upstream/declared checks incl. loop reachability |
| Python | `test_alias_read_through_and_dual_write` | §4 both directions |
| Python | `test_prompt_context_v1_loads_via_aliases` | Cross-version resume |

### Integration / E2E Tests
- Render-parity corpus: all builtin agent×context combinations render
  byte-identical before/after each Phase 3 stage conversion (extends the
  PR #320 84-combination proof).
- Custom-stage e2e (from W-071) extended: custom stage declares an output,
  downstream custom stage consumes it via namespaced placeholder.
- Full `tests/integration/` suite green per Phase 3 commit.

### Existing Tests to Update
- `tests/test_prompt_builder_context_persistence.py` — v2 shape.
- Template hygiene tests (`tests/test_guardian_state_machine.py`,
  `tests/test_agent_md_refs.py`) — assert namespaced keys once each stage
  converts.

## Out of Scope

- Typed/validated context values beyond JSON-pointer extraction (no schemas for
  individual context values).
- Expression language in placeholders (no filters/formatting — transforms stay
  in handler code).
- Cross-run or cross-project context (fleet/workspace context injection is
  separate machinery).
- Removing alias *read* support — kept indefinitely.
