# W-005: Cross-Bead Design Notes (Advisory)

**Status:** Draft (re-scoped 2026-05-24 — supersedes the original "Agent Memory & Context Sharing" design below)
**Priority:** P2
**Area:** cc
**Date:** 2026-05-24
**Depends on:** None. Builds on mechanisms already shipped in current HEAD: the `.block.md` template rail + `build_context()` (W-037), the conditional prompt-injection idiom and authority order established by the guide (W-040) and graphify (W-053), and the `prompt_context.json` resume lane (W-001 checkpointing).

## Problem

Each bead's implementer runs as a fresh Claude subprocess. The coordinator decomposes a run into beads that the runner then implements **sequentially** — "Phase 1: implement all beads sequentially", `src/worca/orchestrator/runner.py:2266`, claiming the next ready bead one at a time (`_query_ready_bead` → `_claim_bead`, `runner.py:2269-2272`). Bead *N* has no visibility into design decisions bead *N-1* made that the plan did not anticipate. The result is locally-reasonable but globally-inconsistent micro-decisions: one bead returns `Result<T>`, another throws; one caches config in a module singleton, another re-reads it; naming and error-handling conventions diverge.

The information that *would* prevent this is not carried anywhere a sibling bead can see it:

- **The plan** (`MASTER_PLAN.md`, injected as `plan_content`) carries only what the planner anticipated. Emergent, in-the-trenches decisions are by definition not in it.
- **The committed code** is ground truth, but the guardian commits only at the *end* of the run — mid-run, beads are closed (`runner.py:2992`) without their code being committed, so a sibling bead cannot read another bead's work.
- **The knowledge graph** (W-053, `has_graphify` at `src/worca/orchestrator/prompt_builder.py:169`) reflects *committed* structure from prior commits, not the current run's pre-commit intent.

So there is a genuine, uncovered slice: **pre-commit design intent and rationale, shared across sibling beads within a run.**

> **Note on the re-scope.** The original W-005 (preserved verbatim under "Superseded design" below) proposed a much broader `ContextManager` owning a `context.md` file as the *sole* vehicle for all cross-stage context, written by the planner, coordinator, and guardian. That over-reached on two counts. (1) The planner already emits `MASTER_PLAN.md`; a planner→`context.md` lane is a second home for plan-level truth and invites drift. The same logic removes the coordinator writer (decomposition lives in bead structure) and the guardian writer. (2) Its core premise — "`_context` is lost on resume" — is no longer true: the resume lane (`save_context`/`load_context` at `prompt_builder.py:96,131`, `backfill_prompt_context` at `resume.py:168`, wired at `runner.py:1955,1976`) already persists operational `_context` across pause/resume. This rework narrows W-005 to the one slice none of those mechanisms cover, and rides the existing rails rather than introducing a competing persistence layer.

## Proposal

Add an optional `design_notes` string to the implementer's structured output (`implement.json`). After each bead completes, the runner accumulates the per-bead note into `_context` (riding the existing `prompt_context.json` resume lane — not a new file). Each subsequent bead's implementer prompt renders an `## Accumulated design notes (advisory)` block, using the same conditional-injection idiom as the guide's `## Reference Guide (normative)` (W-040) and graphify's advisory note (W-053). Notes are **advisory and lowest-authority** (`guide > plan > graph > description > accumulated design notes`). No new file, no new persistence layer, no arbiter.

## Design

### 1. Authoring — `implement.json` + selection criterion

- **Current state:** `src/worca/schemas/implement.json` requires `bead_id` + `files_changed`, with optional `tests_added`. The implementer already emits structured output that the runner extracts (`runner.py:1226`, parsed into `result` at `runner.py:2982`).
- **Resolution:** add one optional scalar.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "ImplementOutput",
  "type": "object",
  "required": ["bead_id", "files_changed"],
  "properties": {
    "bead_id": { "type": "string" },
    "files_changed": { "type": "array", "items": { "type": "string" } },
    "tests_added": { "type": "array", "items": { "type": "string" } },
    "design_notes": {
      "type": "string",
      "maxLength": 400,
      "description": "Optional: design decisions the plan did not specify. 2-3 sentences max."
    }
  }
}
```

`maxLength: 400` makes brevity a contract, not a hope — the model cannot blow past ~2-3 sentences without violating the schema. The field stays out of `required`, so beads with no novel decision emit nothing and validation is unchanged for them.

**Selection criterion (lives in the prompt, not the schema).** The implementer's role template instructs: *record a note only when the decision is one the plan did not already specify.* This is deliberately the criterion the implementer can actually execute — it can read the plan and check — rather than "a decision a sibling might contradict," which would require reasoning about beads it cannot see. The reader-facing block title can be general; the write-side gate stays "plan didn't specify."

### 2. Accumulation in `runner.py`

- **Current state:** after each bead, the runner already accumulates artifacts across beads in `_context` (`runner.py:3007-3013`):

```python
all_files = prompt_builder.get_context("all_files_changed") or []
all_files.extend(new_files)
prompt_builder.update_context("all_files_changed", all_files)
```

- **Resolution:** `design_notes` is read **unconditionally** from `result` — alongside `files_changed`/`tests_added` at `runner.py:3002-3006`, outside the `if impl_trigger in ("initial", "next_bead")` guard. This ensures retries (`test_failure`, `review_changes`) can surface or revise design notes.

```python
# alongside runner.py:3003-3004 (unconditional, all trigger types)
new_note = (result.get("design_notes") or "").strip()
```

Accumulation into `all_design_notes` differs by trigger:

- **`initial` / `next_bead`** (first implementation of a bead): append `{bead_id, note}` if non-empty.
- **`test_failure` / `review_changes`** (retry of the same bead): if the retry emits a note, **replace** the existing entry for this `bead_id` in `all_design_notes`. If the retry emits no note, leave the original entry unchanged. Rationale: a retry may change the design decision (e.g., switching from exceptions to Result types after a test failure), and the stale original note would mislead subsequent beads.

```python
# inside the bead-close block at runner.py:3028 (initial/next_bead only)
all_notes = prompt_builder.get_context("all_design_notes") or []
if new_note:
    all_notes.append({"bead_id": claimed_bead, "note": new_note})
prompt_builder.update_context("all_design_notes", all_notes)

# outside the bead-close guard, for retry triggers (test_failure/review_changes)
if impl_trigger not in ("initial", "next_bead") and new_note:
    all_notes = prompt_builder.get_context("all_design_notes") or []
    claimed_bead = prompt_builder.get_context("assigned_bead_id")
    replaced = False
    for i, entry in enumerate(all_notes):
        if entry.get("bead_id") == claimed_bead:
            all_notes[i] = {"bead_id": claimed_bead, "note": new_note}
            replaced = True
            break
    if not replaced:
        all_notes.append({"bead_id": claimed_bead, "note": new_note})
    prompt_builder.update_context("all_design_notes", all_notes)
```

The accumulated structure is a list of `{bead_id, note}` so each rendered bullet can be attributed (attribution also lets a reader discount a note whose bead was later redone). At most one entry exists per `bead_id` — retries replace, they do not append a second entry for the same bead.

### 3. Rendering — `PromptBuilder` + `implement.block.md`

- **Current state:** `build_context()` already exposes per-stage gates and bodies — `guide_content`/`has_guide` (`prompt_builder.py:167-168`) and `has_graphify` (`:169`).
- **Resolution:** add two keys in the same place:

```python
_DESIGN_NOTES_CAP = 2000  # chars — ~5 full notes; <2% of _MAX_CONTEXT_BYTES (100KB)

# build_context(), alongside prompt_builder.py:167-169
notes = self._context.get("all_design_notes") or []
current = ctx.get("assigned_bead_id")
siblings = [n for n in notes if n.get("bead_id") != current]   # self-exclusion
ctx["accumulated_design_notes"] = _render_notes(siblings, cap=_DESIGN_NOTES_CAP)
ctx["has_design_notes"] = bool(siblings)
```

`_render_notes` emits an attributed bullet list and applies a **block-level character cap of 2000 characters** (constant `_DESIGN_NOTES_CAP = 2000` in `prompt_builder.py`), using drop-oldest semantics — recent beads' decisions are likeliest to bear on current work. The cap sits on top of the per-note `maxLength: 400`. Sizing rationale: 2000 chars ≈ 5 full-length notes, which covers typical sequential runs (3-8 beads) while consuming <2% of the 100KB `prompt_context.json` cap (`_MAX_CONTEXT_BYTES`) and staying small relative to plan/guide content that occupies the higher-authority prompt space. When notes exceed the cap, the oldest entries (earliest `bead_id`s) are dropped first until the rendered block fits:

```markdown
## Accumulated design notes (advisory)

- [bead-001] Errors returned as Result<T>, not exceptions.
- [bead-003] Config cached in a module singleton, loaded once at startup.
```

Only `implement.block.md` renders the block — only implementers author and consume these notes. It is gated exactly like `has_guide`, and added to **both** branches (`is_retry` and first-run) so a note survives the implement↔test/review loopback. The block renders *below* `{{work_request}}` (lower authority sits nearer the task; the guide stays the top normative anchor):

```markdown
{{#if has_design_notes}}
{{accumulated_design_notes}}

_Advisory: sibling beads' decisions for consistency. The plan and guide override these._
{{/if}}
```

### 4. Authority & advisory semantics

The notes are the lowest tier in the existing authority order — extending `guide > plan > graph > description` (established by W-040/W-053, documented in `CLAUDE.md` "Guide Precedence" and "Knowledge Graph") to:

```
guide > plan > graph > description > accumulated design notes
```

Because entries are *observations of what a sibling did*, not *instructions*, two contradictory entries are not a crisis demanding reconciliation — they are simply visible, and the reading implementer applies judgment. This is what lets W-005 drop the arbiter/reconciler entirely. The trade-off is explicit (see Considerations): this **nudges** consistency, it does not **enforce** it.

### 5. Persistence & resume — coexistence with `prompt_context.json`

Because `all_design_notes` lives in `_context`, it is written to `prompt_context.json` at the existing between-bead checkpoint — `prompt_builder.save_context(prompt_context_path)` at `runner.py:3026-3027` — so resume preserves it with **zero new persistence code**. On resume, `load_context` / `backfill_prompt_context` (`runner.py:1976`) restore it alongside everything else. This is precisely the coexistence the issue review asked for: notes ride the operational JSON resume lane (W-001) rather than becoming a second memory system. `prompt_context.json` stays operational resume state; `all_design_notes` is just another key in it.

### 6. Relationship to shipped mechanisms

| Mechanism (origin) | What it carries | Direction | Authority | This feature reuses |
|---|---|---|---|---|
| Guide — `## Reference Guide (normative)` (W-040, `work_request.py` `attach_guide`, `has_guide`) | External normative spec | Inbound, static | Highest | The conditional `{{#if …}}` injection idiom and the authority order |
| Graphify — advisory note (W-053, `has_graphify` `prompt_builder.py:169`) | Committed-code structure | Query-on-demand | Advisory | The advisory-injection pattern; complementary content (graph = committed, notes = pre-commit) |
| `.block.md` + `build_context()` (W-037) | Per-stage prompt assembly | — | — | The exact rail; two new ctx keys |
| `prompt_context.json` resume lane (W-001) | Operational `_context` | Persisted | — | Free persistence + resume; no new layer |

### 7. Bead ordering & the parallelism boundary

Within one pipeline, beads are sequential (`runner.py:2266`), so bead *N* deterministically sees notes from beads *1…N-1*. There is **no within-run race**. The parallelism caveat applies only across *separate* pipelines (parallel-implementer execution, W-002; parallel pipeline execution, W-030) — those run beads concurrently in different processes and would not share `_context`. That case is explicitly out of scope here; this feature targets the sequential bead loop only.

## Implementation Plan

### Phase 1: Schema
**Files:** `src/worca/schemas/implement.json`
**Tasks:**
1. Add the optional `design_notes` property (Design §1). Keep it out of `required`.

### Phase 2: Accumulation
**Files:** `src/worca/orchestrator/runner.py`
**Tasks:**
1. Read `new_note` from `result` **unconditionally** alongside `files_changed`/`tests_added` at `runner.py:3003-3004` — outside the `if impl_trigger in ("initial", "next_bead")` guard.
2. For `initial`/`next_bead` triggers: append `{bead_id, note}` to `all_design_notes` in `_context` in the bead-close block at `runner.py:3028`.
3. For retry triggers (`test_failure`/`review_changes`): if `new_note` is non-empty, replace the existing entry for this `bead_id` in `all_design_notes` (or append if none exists). If `new_note` is empty, leave the existing entry unchanged.
4. No new save call — the existing `save_context` at `:3048` persists it.

### Phase 3: Rendering
**Files:** `src/worca/orchestrator/prompt_builder.py`, `src/worca/agents/core/implement.block.md`
**Tasks:**
1. Add constant `_DESIGN_NOTES_CAP = 2000` at module level in `prompt_builder.py`.
2. In `build_context()` (alongside `:167-169`) compute `accumulated_design_notes` (attributed bullet list, self-exclusion of `assigned_bead_id`, drop-oldest to fit within `_DESIGN_NOTES_CAP`) and `has_design_notes`. Add a small `_render_notes(notes, cap=_DESIGN_NOTES_CAP)` helper.
3. In `implement.block.md`, add the `{{#if has_design_notes}} ## Accumulated design notes (advisory) … {{/if}}` block below `{{work_request}}` in **both** the `is_retry` and first-run branches.

### Phase 4: Implementer prompt
**Files:** `src/worca/agents/core/implementer.md`
**Tasks:**
1. Write side: instruct the implementer to populate `design_notes` only for decisions the plan did not specify (2-3 sentences).
2. Read side: explain the `## Accumulated design notes (advisory)` block — sibling beads' decisions, advisory only, plan and guide override.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/schemas/implement.json` | Add optional `design_notes` (string, `maxLength` 400) |
| `src/worca/orchestrator/runner.py` | Read `result["design_notes"]`; accumulate `all_design_notes` in `_context` |
| `src/worca/orchestrator/prompt_builder.py` | Add `accumulated_design_notes` + `has_design_notes` to `build_context()`; `_render_notes` helper |
| `src/worca/agents/core/implement.block.md` | Render the advisory block (both branches) |
| `src/worca/agents/core/implementer.md` | Write criterion + read-side note |

## Considerations

- **Advisory ≠ enforced.** A non-binding note relies on the model voluntarily aligning; convergence is probabilistic, not guaranteed. Accepted: the cheaper, no-arbiter design is worth more than enforced consistency, and the cost of a note being ignored is "no worse than today."
- **The implementer is poorly positioned to judge cross-bead relevance** (it sees only its own bead). Mitigated, not solved, by the "plan didn't specify" criterion + the 400-char cap + a small per-run volume. A note that strays into restating what the code does is redundant with reading the code/graph and should be discouraged in the prompt.
- **Retry semantics.** When the implementer re-runs due to `test_failure` or `review_changes`, a new note **replaces** the original for that bead (at most one entry per `bead_id`). If the retry emits no note, the original stands. This is correct because a retry may revise the design decision (e.g., switching error-handling strategy after a test failure), and subsequent beads should see the final decision, not the stale original.
- **Ordering.** A note is only visible to beads that start after the authoring bead closes. Sequential execution makes this deterministic; parallel execution (W-002/W-030) breaks it and is out of scope.
- **Governance:** no new governed surface. The implementer does **not** write a file — it returns a structured field; the runner does the accumulation. So there is no `pre_tool_use` hook carve-out to add, and no file-write race.
- **Breaking changes:** none. `design_notes` is optional and additive; existing implementer outputs validate unchanged; absent the field, no block renders.
- **Migration:** none.

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_implement_schema_allows_missing_design_notes` | Output without `design_notes` validates |
| Python | `test_implement_schema_rejects_overlong_design_notes` | `maxLength` 400 enforced |
| Python | `test_runner_accumulates_design_notes` | `result["design_notes"]` appends `{bead_id, note}` to `all_design_notes` |
| Python | `test_runner_skips_empty_design_notes` | Empty/absent note adds nothing |
| Python | `test_runner_retry_replaces_design_note` | `test_failure`/`review_changes` trigger with new note replaces the existing entry for that bead |
| Python | `test_runner_retry_empty_note_preserves_original` | Retry with empty/absent note leaves the original entry unchanged |
| Python | `test_runner_retry_appends_if_no_prior_note` | Retry that emits a note for a bead with no existing entry appends it |
| Python | `test_build_context_renders_accumulated_notes` | `has_design_notes` true, bullet list present |
| Python | `test_build_context_excludes_current_bead` | A bead does not see its own note |
| Python | `test_render_notes_drop_oldest_cap` | Block-level cap (2000 chars) drops oldest entries, keeps most recent |
| Python | `test_implement_block_no_notes_no_section` | `has_design_notes` false → no `## Accumulated design notes` heading |

### Integration / E2E Tests
- Mock multi-bead run (≥3 sequential beads): bead 1 emits a note; assert bead 2's rendered implement prompt contains `## Accumulated design notes (advisory)` with bead 1's note and **not** bead 2's own.
- Resume: pause mid-run after bead 1, resume; assert `all_design_notes` survives via `prompt_context.json` and is injected into the next bead.

### Existing Tests to Update
- `tests/test_event_types.py` / schema-validation tests if they assert the exact `implement.json` property set — extend to allow `design_notes`.

## Files to Create/Modify

| File | New/Modify | Purpose |
|------|------------|---------|
| `src/worca/schemas/implement.json` | Modify | Optional `design_notes` field |
| `src/worca/orchestrator/runner.py` | Modify | Read + accumulate notes |
| `src/worca/orchestrator/prompt_builder.py` | Modify | Render block + gate in `build_context()` |
| `src/worca/agents/core/implement.block.md` | Modify | Advisory block (both branches) |
| `src/worca/agents/core/implementer.md` | Modify | Write criterion + read note |
| `tests/test_prompt_builder*.py` | Modify | Render/gate/self-exclusion/cap tests |
| `tests/integration/` | Modify | Multi-bead + resume scenarios |

## Out of Scope

- **Within-bead loopback memory** (the implementer remembering its *own* prior attempts) — operational retry context already flows via `previous_attempts` / `test_failures_formatted`.
- **Planner / coordinator / guardian writers** — removed in this re-scope (redundant with `MASTER_PLAN.md` and bead structure).
- **Cross-pipeline / parallel-implementer visibility** (W-002, W-030).
- **Cross-run memory** — notes do not persist between runs.
- **An arbiter/reconciler** for contradictory notes — advisory framing makes one unnecessary.
- **A `context.md` file / `ContextManager`** — replaced by the structured-field + `_context` approach.
- **UI display of notes** — worca-ui reads `status.json`.

---

---

# Superseded design (original W-005, pre-2026-05-24)

> The content below is the original "Agent Memory & Context Sharing" plan. It is retained for history and is **superseded** by the re-scoped design above. Do not implement it.

**Goal:** Give every pipeline stage a durable, human-readable view of accumulated decisions, rationale, failures, and artifacts from all prior stages. Loop-backs (test failure → implement retry, review changes → implement retry) automatically inject the failure context so the retrying agent understands exactly what went wrong and why. Crucially, the context survives pause/resume — a resumed pipeline picks up the full history without loss.

**Architecture:** A new `ContextManager` class owns one Markdown file per run at `.worca/runs/{run_id}/context.md`. This file is the **primary and sole vehicle** for accumulated cross-stage context. The `runner.py` creates the file at run start, passes a `ContextManager` instance through the pipeline loop, and calls `append_stage_entry()` after each stage completes. `PromptBuilder` reads the file via `ContextManager.build_prompt_section()` and injects a `## Shared Run Context` section into every agent prompt. On resume, `PromptBuilder` starts with an empty `_context` dict, but the context file on disk preserves the full run history — this is the key advantage over in-memory accumulation.

**Design decision — file as primary context source:** The existing `prompt_builder._context` dict accumulates stage results in memory, but this state is lost on pause/resume (a fresh `PromptBuilder` is created). Rather than serializing the dict to disk (reinventing the file with worse readability) or reconstructing from `status.json` (which lacks rationale, decisions, and failure details), the context file serves as both the persistence layer and the richer accumulator. Agents receive context exclusively via `PromptBuilder`'s prompt injection — they do not read the file directly via tool calls.

*(The full original Sections 1–10 — `ContextManager` API, the `context.md` format, per-stage append points for plan/coordinate/guardian, the six `_build_*` injection sites, and the original task breakdown — are preserved in version control history prior to the 2026-05-24 re-scope. They are intentionally not reproduced here to avoid presenting two competing designs as both live.)*
