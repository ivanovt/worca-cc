# W-059: Plan Reviewer-Editor (review_and_edit mode)

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-05-29
**Depends on:** None

## Problem

When plan review is enabled, a `revise` verdict resets the PLAN stage to `pending` and loops back to the **Planner** (`src/worca/orchestrator/runner.py:3137-3202`). The Planner then re-spawns cold: it re-reads `CLAUDE.md`, re-explores the codebase, re-reads the work request, re-reads the plan, and only then consumes the threaded review feedback before rewriting. The Plan Reviewer, meanwhile, is read-only (`src/worca/agents/core/plan_reviewer.md:5,66`) — it has just done all of that exploration and located the exact issues (often with a `suggestion` field naming the fix), then throws that warm context away.

The dominant cost of the review loop is therefore a **redundant second Opus cold-start per revision** (`worca.loops.plan_review` defaults to 2, so up to 2 extra Planner spawns). For plans that are mostly-good with occasional mechanical defects, paying for a full re-plan to fix a wrong file path or a missing test is wasteful.

## Proposal

Add an optional, opt-in **`review_and_edit`** mode to the `plan_review` stage. In this mode the Plan Reviewer rewrites the plan **in place** to resolve critical/major issues, self-approves, and the flow proceeds directly to COORDINATE — **terminal, no loopback**. The Planner still authors the initial plan; only the review→replan *loop* is replaced. Default behavior is unchanged (`review` mode, off by default). A project-level governance policy can force either mode across all pipelines.

This trades the loopback's independent re-verification for a single warm-context edit pass. The tradeoff is deliberate and gated; see [Considerations](#considerations).

## Design

### 1. Mode resolution & precedence

**Current state:** `worca.stages.plan_review` is `{ agent, enabled }` (`src/worca/settings.json:160-163`); there is no notion of a review *mode*.

**Resolution:** introduce two keys and a single resolution function (the *resolved mode* feeds every downstream consumer — prompt routing, governance flag, mode badge, logging):

- **Pipeline/template mode** — `worca.stages.plan_review.mode`: `"review"` | `"review_and_edit"`. Default `"review"`.
- **Project enforcement override** — `worca.governance.plan_review_enforce`: `"auto"` | `"review"` | `"review_and_edit"`. Default `"auto"`.

```
resolve_plan_review_mode(settings) -> (mode, reason):
    enforce = governance.plan_review_enforce  # default "auto"
    if enforce == "review_and_edit":  return ("review_and_edit", "forced by project (governance.plan_review_enforce)")
    if enforce == "review":           return ("review",          "forced by project (governance.plan_review_enforce)")
    # enforce == "auto" -> defer to pipeline/template
    mode = stages.plan_review.mode    # default "review"
    return (mode, "from template/pipeline" if mode set else "default")
```

Precedence: **governance enforce (if ≠ auto) → run/template mode → built-in `review`**. The `reason` string is logged and surfaced in the UI mode badge (§6, §9).

### 2. Stage flow & state-action transitions

**Current state:** `Stage.PLAN_REVIEW` transitions to COORDINATE (approve) or back to PLAN (revise) — `src/worca/orchestrator/stages.py:11,23`.

**Resolution:** the legal transition set becomes mode-dependent:

```
review mode (unchanged):
  PLAN ──> PLAN_REVIEW ──approve──> COORDINATE
                       └─revise──> PLAN  (bounded by loops.plan_review)

review_and_edit mode (terminal):
  PLAN ──> PLAN_REVIEW(edit+self-approve) ──> COORDINATE
  (no PLAN_REVIEW ──> PLAN edge)
```

- The `PLAN_REVIEW → PLAN` loopback edge is **removed** in edit mode.
- **No halt valve**: a plan the reviewer cannot fully fix is edited best-effort and the run proceeds; residual risk is recorded in the review summary.
- `restart_planning` (triggered downstream) still re-enters at PLAN and flows through the reviewer-editor again — the full planning sub-flow, unchanged.
- The `/state-action-matrix` spec must be updated to document this mode-dependent transition set.

### 3. Agent prompt routing (keep agent name, swap template files)

**Current state:** the core agent template is loaded by **agent name** as `{agent_name}.md` (`src/worca/orchestrator/runner.py:2567-2568`, `src/worca/orchestrator/prompt_builder.py:403`); the stage block is loaded via `_STAGE_BLOCK_MAP.get(current_stage)` (`runner.py:2607`), mapping `PLAN_REVIEW → "plan-review"` → `plan-review.block.md`. The read-only assertions live at `plan-review.block.md:2` and the `## Rules` block `plan_reviewer.md:65-76`.

**Resolution:** keep the **agent name `plan_reviewer`** (so the `guard.py` carve-out, `tracking.py` dispatch defaults, effort config, settings agent map, and `agent-names.js` are all untouched), but route to **new template files** when the resolved mode is `review_and_edit`:

- New `src/worca/agents/core/plan_editor.md` — the editor role (review process is identical; the difference is "rewrite the plan to resolve critical/major issues, then self-approve" + the in-place guide-conflict rule + a write-governance rules block scoped to the plan file).
- New `src/worca/agents/core/plan-edit.block.md` — the edit-mode dynamic block (no `plan_review_history` revision-round section, since there is no loopback).

Two mode-aware routing seams, both driven by the resolved mode:

1. **Core `.md` selection** (`runner.py:2567`): load `plan_editor.md` instead of `{agent_name}.md` when mode is `review_and_edit`. This intentionally decouples "agent name" from "template basename" for this stage.
2. **Block selection** (`runner.py:2607`, `_STAGE_BLOCK_MAP`): resolve `"plan-edit"` instead of `"plan-review"` in edit mode.

`_render_agent_templates` globs `agents/core/*.md` (`runner.py:405-422`), so both `plan_reviewer.md` and `plan_editor.md` are rendered into the run dir regardless; selection happens at stage-execution time. Project overrides for edit mode key on the template basename (`overlay.py:233`), i.e. `plan_editor.md` / `plan-edit.block.md`.

**Precedent:** this mirrors the Planner's existing single-agent mode fork — `plan.block.md:1` already forks the whole block on `{{#if plan_revision_mode}}` (initial vs revision). We choose separate files over an in-file `{{#if}}` fork for readability; see the [decision table](#alternatives-considered).

### 4. Governance write carve-out

**Current state:** `plan_reviewer` is in `read_only_agents` and is hard-blocked from `Write`/`Edit` and Bash file-writes (`src/worca/hooks/guard.py:351-358`). The Planner is restricted to writing exactly `WORCA_PLAN_FILE` (`guard.py:339-349`). Source writes are gated on plan existence by `plan_check.py:40-46`.

**Resolution:** the runner sets a new env flag **`WORCA_PLAN_REVIEWER_CAN_EDIT=1`** when the resolved mode is `review_and_edit` (alongside the existing `WORCA_PLAN_FILE`). The guard opens a single write path for `plan_reviewer` **only when all hold**: flag set AND `role == "plan_reviewer"` AND `abspath(target) == abspath(WORCA_PLAN_FILE)`. Everything else stays blocked: source/test file writes, file-writes via Bash, and running tests (`guard.py:357-365`).

```python
# guard.py, role-based restrictions
if role == "plan_reviewer":
    if os.environ.get("WORCA_PLAN_REVIEWER_CAN_EDIT") == "1" and tool_name in ("Write", "Edit"):
        plan_file = os.environ.get("WORCA_PLAN_FILE")
        if plan_file and os.path.abspath(file_path) == os.path.abspath(plan_file):
            pass  # allowed: edit-mode plan rewrite
        else:
            return (2, "Blocked: plan_reviewer (edit mode) may only write {}.".format(plan_file))
    elif tool_name in ("Write", "Edit"):
        return (2, "Blocked: plan_reviewer agent is read-only — may not write files.")
    # Bash file-writes + test runs remain blocked unconditionally (existing logic)
```

Dispatch `worca-dispatch-governance-reviewer` after this change.

### 5. Data model — outcome & events

**Current state:** `plan_review.json` `outcome` property (lines 8-11) has enum `["approve", "revise"]` on `src/worca/schemas/plan_review.json:10`.

**Resolution:**

- Add outcome value **`approve_with_edits`** to the schema. Edit-mode runs emit `approve` (clean, no edits needed) or `approve_with_edits` (plan was rewritten). `revise` is never the terminal outcome in edit mode.

```json
{
  "outcome": { "type": "string", "enum": ["approve", "revise", "approve_with_edits"] }
}
```

- New event **`PLAN_EDITED`** (scaffold via `/worca-event-add`): emitted when the reviewer-editor rewrites the plan. Payload includes `run_id`, `stage` (`plan_review`), resolved `mode`, `mode_reason`, issue counts by severity, and the original-plan record path (§6).
- **Propagation: UI notification + webhook payload only — no chat renderer** (not Tier 1).

### 6. Audit trail (land all three together)

These three replace the transparency the loopback provided and must ship together:

1. **Always-on mode badge** on the plan-review stage (§9) — states the resolved mode + the `reason`.
2. **`PLAN_EDITED` notification** (§5).
3. **Original-plan retention** — before the reviewer-editor rewrites the plan, the runner copies the Planner's original plan to a per-run record file `<run_dir>/plan-original.md`, suffixing with the restart counter (`plan-original-2.md`, …) only on `restart_planning` re-entry. No phase-1 diff UI; the artifact is retained so a diff view can be wired later.

### 7. Settings & validation

- Keys: `worca.stages.plan_review.mode` and `worca.governance.plan_review_enforce` (§1).
- `src/worca/settings.json`: add `"mode": "review"` under `stages.plan_review` (still `enabled: false`); add `plan_review_enforce: "auto"` under `governance`.
- Validation (`worca-ui/server/settings-validator.js` + the Python settings validator): enum-check both keys.
- `loops.plan_review` is a **silent no-op** in edit mode (no validation warning).
- `/worca-template` skill: add the mode + governance override to its interview.

### 8. Pipeline templates

- Default `review`; `plan_review` stays disabled by default — fully additive. `feature` and `refactor` templates are unchanged.
- New built-in template **`feature-fast`** = the full `feature` config **plus** `stages.plan_review.mode: "review_and_edit"`. (`feature` already ships with plan-review *on* in `review` mode with a 3-round loopback; the "fast" variant swaps that loopback for the cheaper single-pass terminal editor.) `loops.plan_review` becomes a silent no-op in edit mode. Minimal config — only the `mode` override beyond the inherited `feature` settings.

### 9. UI

- **Settings panel** (`worca-ui/app/views/settings.js:50,115`): both controls — the pipeline `mode` selector and the governance `plan_review_enforce` selector — together in the plan_review panel, with help text on the lost-independent-verification tradeoff. Mode selector enabled only when plan_review is enabled.
- **Mode badge** on the plan-review stage — **always shown**, **neutral** color (informational, not a status; follow `worca-ui/docs/badge-color-language.md`), states mode + why (`from template` / `default` / `forced by project`).
- **`approve_with_edits` outcome** rendered **green + an "edited" qualifier chip** (done state, modified).
- **Issues panel** reframed from "feedback to planner" to "issues resolved by reviewer" in edit mode (avoid issues sitting next to an approved badge looking like a bug).
- **Plan diff UI deferred** — the original-plan record file (§6) is retained now; `run-detail.js` `_planArtifactView` (~`worca-ui/app/views/run-detail.js:88`) is the existing plan-fetch surface to extend later.
- Dispatch `worca-ui-design-reviewer` + `worca-ui-routing-reviewer` after UI changes.

### 10. Fleet / workspace

Pure inheritance, per-child resolution: each child run resolves mode independently — its own project's `plan_review_enforce` wins, else the run/template mode, else its project default. Each child run-detail shows its own mode badge. No new launch flags on `run_fleet.py` / `run_workspace.py`.

## Implementation Plan

### Phase 1: Mode resolution + settings + validation
**Files:** `src/worca/settings.json`, settings resolution module, `worca-ui/server/settings-validator.js`
**Tasks:**
1. Add `stages.plan_review.mode` (default `"review"`) and `governance.plan_review_enforce` (default `"auto"`) to `settings.json`.
2. Implement `resolve_plan_review_mode(settings) -> (mode, reason)` per §1.
3. Enum-validate both keys (Python validator + JS `settings-validator.js`).

### Phase 2: Agent prompt files + routing seams
**Files:** `src/worca/agents/core/plan_editor.md` (new), `src/worca/agents/core/plan-edit.block.md` (new), `src/worca/orchestrator/runner.py` (~2567, ~2607, `_STAGE_BLOCK_MAP`)
**Tasks:**
1. Author `plan_editor.md` (review process shared with `plan_reviewer.md`; edit + self-approve behavior; in-place guide-conflict rule; plan-file-only write rules).
2. Author `plan-edit.block.md` (no revision-round/history section).
3. Make core `.md` selection mode-aware (load `plan_editor.md` in edit mode).
4. Make block selection mode-aware (`plan-edit`).

### Phase 3: Governance write carve-out
**Files:** `src/worca/hooks/guard.py`, `src/worca/orchestrator/runner.py`
**Tasks:**
1. Runner sets `WORCA_PLAN_REVIEWER_CAN_EDIT=1` for the plan_review subprocess when resolved mode is `review_and_edit`.
2. Guard opens the single plan-file write path per §4; keep all other blocks intact.
3. Dispatch `worca-dispatch-governance-reviewer`.

### Phase 4: Runner PLAN_REVIEW edit-mode branch
**Files:** `src/worca/orchestrator/runner.py` (PLAN_REVIEW handler ~3109-3229), `src/worca/orchestrator/stages.py`, `src/worca/schemas/plan_review.json`
**Tasks:**
1. Branch on resolved mode in the PLAN_REVIEW handler: in edit mode, skip the loopback path entirely, mark `plan_approved`, set outcome `approve`/`approve_with_edits`, proceed to COORDINATE.
2. Before the reviewer runs, copy the original plan to the per-run record file (§6).
3. Add `approve_with_edits` to the schema enum.
4. Update `stages.py` transitions to reflect the mode-dependent set.

### Phase 5: Events
**Files:** `src/worca/events/` (via `/worca-event-add`), `worca-ui/app/notifications.js`
**Tasks:**
1. Scaffold `PLAN_EDITED` (constant, payload builder, test).
2. Wire the UI notification + webhook payload. No chat renderer.

### Phase 6: Template
**Files:** `src/worca/templates/feature-fast/template.json` (new)
**Tasks:**
1. Create `feature-fast` mirroring the full `feature` template + `stages.plan_review.mode: "review_and_edit"` (plan_review is already enabled in `feature`).

### Phase 7: UI
**Files:** `worca-ui/app/views/settings.js`, `worca-ui/app/views/run-detail.js`
**Tasks:**
1. Add mode + enforce controls to the plan_review settings panel.
2. Always-on neutral mode badge on the plan-review stage.
3. `approve_with_edits` green + "edited" qualifier rendering.
4. Reframe the issues panel for edit mode.
5. Rebuild bundle; dispatch `worca-ui-design-reviewer` + `worca-ui-routing-reviewer`.

### Phase 8: Docs + migration + state-action matrix
**Files:** `docs/design-principles.md`, `docs/governance.md`, `docs/events.md`, `docs/effort.md`, `MIGRATION.md`, state-action-matrix spec, `CLAUDE.md`
**Tasks:**
1. Document the mode, governance override, resolution order, and the tradeoff.
2. Update the state-action-matrix spec with mode-dependent transitions.
3. Effort doc note: editing is harder; `auto_mode` escalation does not engage (no loopback).
4. Additive opt-in "new feature" note in `MIGRATION.md`.

### Phase 9: /worca-template skill
**Files:** `.claude/skills/worca-template/` (+ `src/worca/skills/worca-template`)
**Tasks:**
1. Add mode + governance override to the interview with the tradeoff explanation.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/settings.json` | Add `stages.plan_review.mode` + `governance.plan_review_enforce` defaults |
| `src/worca/orchestrator/runner.py` | Mode resolution; edit-mode PLAN_REVIEW branch; template-routing seams; env flag; original-plan retention |
| `src/worca/orchestrator/stages.py` | Mode-dependent transitions |
| `src/worca/hooks/guard.py` | Plan-file write carve-out for plan_reviewer under the edit flag |
| `src/worca/agents/core/plan_editor.md` | New editor role template |
| `src/worca/agents/core/plan-edit.block.md` | New edit-mode dynamic block |
| `src/worca/schemas/plan_review.json` | Add `approve_with_edits` outcome |
| `src/worca/events/` | New `PLAN_EDITED` event |
| `src/worca/templates/feature-fast/template.json` | New template |
| `worca-ui/app/views/settings.js` | Mode + enforce controls |
| `worca-ui/app/views/run-detail.js` | Mode badge, `approve_with_edits` rendering, issues panel reframe |
| `worca-ui/app/notifications.js` | `PLAN_EDITED` notification |
| `worca-ui/server/settings-validator.js` | Enum-validate both keys |
| docs + `MIGRATION.md` + state-action-matrix spec | Documentation |
| `.claude/skills/worca-template/` | Interview update |

## Considerations

### The core tradeoff: loss of independent verification
Collapsing reviewer + editor removes the second pair of eyes *on the fix* — the editor self-approves its own edits, and the edited plan reaches COORDINATE with no re-review. This is the deliberate cost of the feature. It is mitigated, not eliminated, by: keeping the mode **opt-in and off by default**; the **always-on mode badge + `PLAN_EDITED` notification + original-plan retention** audit triad; and the natural downstream catch at COORDINATE (which reads the plan to decompose it). The mode pays off only in the "mostly-good plans with occasional mechanical defects" regime; if reviews fire often, that signals a Planner-quality problem the mode would mask.

### Failure shape
In `review` mode a struggling loop fails visibly and bounded (`LOOP_EXHAUSTED`, unresolved issues carried to COORDINATE). In edit mode (best-effort, no halt) the failure mode shifts to a **silent best-effort approval**. The audit triad is what keeps that visible.

### Prompt duplication / drift risk
The overlay is whole-file (no partial includes), so `plan_editor.md` literally duplicates the shared review logic from `plan_reviewer.md`. This duplication is accepted as-is — no sync test is added (deliberately not over-engineered); the two files are maintained by hand.

### Governance security
The write carve-out is the most sensitive change. It must open exactly one path (the resolved `WORCA_PLAN_FILE`), only under the explicit flag, only for `plan_reviewer`, and must leave source/test writes, Bash file-writes, and test-runs blocked.

### Breaking changes
**None.** Default `mode: "review"`, `enforce: "auto"`, `plan_review.enabled: false` — existing users and the `feature`/`refactor` templates are byte-for-byte equivalent in behavior.

### Migration
Additive opt-in. `MIGRATION.md` gets a "new feature" note describing how to enable `review_and_edit` and the governance override; no required steps.

### Alternatives considered

| Decision | Chosen | Rejected alternative | Why |
|---|---|---|---|
| Loopback cost fix | Terminal reviewer-editor (opt-in) | Lean revision-mode Planner (skip re-exploration) | User preference; keep Planner exploration intact |
| Unfixable plan | Best-effort, always proceed | Halt for human / halt on unresolved critical | Maximize autonomy; accept silent-approval failure shape |
| Plan diff | Retain original on disk, no phase-1 UI | Core diff UI / don't retain | Cheapest audit trail now, wire UI later |
| Outcome signal | New `approve_with_edits` + `PLAN_EDITED` | Reuse `approve` / no new event | Preserve audit + UI distinction |
| Prompt files | New `plan_editor.md` + `plan-edit.block.md`, same agent name | In-file `{{#if}}` fork / new agent name | Readable single-purpose files without rippling a new agent through wiring |
| Override location | `worca.governance.plan_review_enforce` | Under the stage / new top-level key | Semantically a policy that overrides pipeline intent |

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_resolve_plan_review_mode_*` | Precedence: enforce force-wins; auto defers to mode; default `review` |
| Python | `test_guard_plan_reviewer_edit_allows_plan_file_only` | Write allowed only for plan_file under flag; source/test still blocked |
| Python | `test_guard_plan_reviewer_readonly_without_flag` | No flag ⇒ plan_reviewer remains read-only |
| Python | `test_plan_review_schema_outcome_enum` | `approve_with_edits` accepted |
| Python | `test_plan_editor_template_routing` | Edit mode loads `plan_editor.md` + `plan-edit.block.md` |
| Python | `test_event_plan_edited_payload` | `PLAN_EDITED` payload shape |
| JS | settings-validator enum tests | Both keys reject invalid values |

### Integration / E2E Tests
- Integration: a mock-claude run with `review_and_edit` where the reviewer returns issues ⇒ plan rewritten, outcome `approve_with_edits`, original-plan record written, proceeds to COORDINATE with **no** loopback, `PLAN_EDITED` emitted.
- Integration: `review` mode unchanged (loopback still fires) — regression guard.
- Integration: `governance.plan_review_enforce: review_and_edit` overrides a template set to `review`; logged reason reflects the override.
- E2E (Playwright): settings panel renders both controls; run-detail shows the neutral mode badge with reason and the `approve_with_edits` green+edited rendering.

### Existing Tests to Update
- `worca-ui/app/views/settings-plan-review.test.js`, `settings-form-roundtrip.test.js` — new controls.
- Any test asserting the PLAN_REVIEW handler always loops back on `revise` — scope to `review` mode.
- Stage-transition tests referencing the PLAN_REVIEW → PLAN edge — make mode-aware.

## Files to Create/Modify

See [Files Changed Summary](#files-changed-summary) above for the complete table.

## Out of Scope

- **Plan diff UI** — deferred; only the original-plan record file is produced now.
- **Halt valve** — explicitly rejected; edit mode is best-effort, always proceed.
- **Chat renderer for `PLAN_EDITED`** — notification + webhook only.
- **Lean revision-mode Planner** — rejected as the cost-fix approach.
- **Loud guide-conflict event** — guide conflicts are noted in the review summary only.
- **Changing `feature`/`refactor` templates** — they keep loopback review.
