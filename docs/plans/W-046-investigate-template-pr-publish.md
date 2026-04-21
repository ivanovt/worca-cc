# W-046: Investigate Template — Publish Plan as PR

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-04-21
**Depends on:** None

## Problem

The Investigate pipeline template (`templates/investigate/template.json:9-14`) disables all stages after PLAN — including PR. This means the analysis output (`plan-001.md`) stays in `.worca/runs/{run_id}/`, which is gitignored and ephemeral. To act on the investigation, a human must:

1. Manually copy the plan to `docs/plans/W-NNN-slug.md`
2. Commit and push
3. Edit the GitHub issue to add the plan link
4. Run the implementation pipeline with `--source gh:issue:N`

User-facing impact: the investigate → implement handoff is a multi-step manual process that breaks the otherwise automated pipeline flow. Investigation results can be lost if the run directory is cleaned up before the plan is copied.

## Proposal

Enable the PR stage in the Investigate template with a replacement guardian agent prompt. The guardian copies the generated plan to `docs/plans/`, commits, pushes, and creates a PR linking to the source GitHub issue. No new stages, no schema changes, no governance modifications — just template config and a prompt override.

## Design

### 1. Enable PR Stage in Investigate Template

- **Current state:** `templates/investigate/template.json:14` — `"pr": { "enabled": false }`
- **Obstacle:** PR stage is disabled, so the guardian never runs.
- **Resolution:** Change to `"pr": { "enabled": true }`.

```json
// templates/investigate/template.json — before
"stages": {
  "coordinate": { "enabled": false },
  "implement":  { "enabled": false },
  "test":       { "enabled": false },
  "review":     { "enabled": false },
  "pr":         { "enabled": false }
}

// after
"stages": {
  "coordinate": { "enabled": false },
  "implement":  { "enabled": false },
  "test":       { "enabled": false },
  "review":     { "enabled": false },
  "pr":         { "enabled": true }
}
```

No milestone gates block this. The investigate template already sets all milestones to `false` (`template.json:19-23`), and the PR stage handler in `runner.py` has no milestone checks — it runs the agent unconditionally and checks the result for `pr_url`/`pr_number` (`runner.py:2589-2597`).

### 2. Guardian Prompt Override (Replace Mode)

- **Current state:** Base guardian (`agents/core/guardian.md`) requires proof_status = verified and review_outcome = approve before committing. These preconditions don't apply to an investigate run (no implementation, no tests, no review).
- **Obstacle:** Using `<!-- append -->` mode would leave the base preconditions in place, causing the guardian to refuse to proceed.
- **Resolution:** Create `templates/investigate/agents/guardian.md` in **replace mode** (default — no tag needed). The override contains only the investigate-specific workflow.

The replacement prompt must:

1. Read `status.json` from the run directory to extract `plan_file` and `work_request.source_ref`
2. Determine the next available `W-NNN` number by scanning `docs/plans/W-*.md`
3. Derive the slug from the work request title
4. Copy the plan to `docs/plans/W-{NNN}-{slug}.md`
5. `git add docs/plans/W-{NNN}-{slug}.md`
6. `git commit` with a scoped message (e.g., `docs(W-{NNN}): add investigation plan`)
7. `git push -u origin <branch-name>`
8. `gh pr create` referencing the source issue
9. Return `{ pr_number, pr_url, review_status: "pending" }` per the existing `pr.json` schema

**Prompt file:** `templates/investigate/agents/guardian.md`

```markdown
# Guardian Agent — Investigate Mode

## Role

You are the Guardian in an investigation pipeline. Your job is to publish the
generated analysis plan as a versioned file in docs/plans/ and open a PR.

There is no implementation, no test proof, and no code review to verify — the
deliverable is the plan file itself.

## Context

The planner has completed an investigation and written a plan file. The plan
file path is in status.json under the `plan_file` key. The source issue
reference (if any) is in `work_request.source_ref` (format: `gh:{number}`).

## Process

**Every step below is required. A completed PR stage MUST produce a new commit
pushed to the remote and a PR opened. Skipping these is a stage failure.**

1. Read the run's `status.json` to get `plan_file` and `work_request.source_ref`.
2. Determine the next available `W-NNN` number:
   ```
   ls docs/plans/W-*.md | grep -o 'W-[0-9]*' | sort -t- -k2 -n | tail -1
   ```
   Take the highest number and add 1. Zero-pad to three digits.
3. Derive a URL-safe slug from the work request title (lowercase, replace
   non-alphanumeric with hyphens, collapse runs, trim).
4. Copy the plan file:
   ```
   mkdir -p docs/plans
   cp <plan_file> docs/plans/W-<NNN>-<slug>.md
   ```
5. Stage the plan file:
   ```
   git add docs/plans/W-<NNN>-<slug>.md
   ```
6. Sanity-check what you're about to commit:
   ```
   git status
   git diff --cached --stat
   ```
   If nothing is staged, STOP and produce `outcome: reject` with a clear reason.
7. Commit with a scoped message:
   ```
   git commit -m "$(cat <<'EOF'
   docs(W-<NNN>): add investigation plan

   Analysis of <work_request.title>.
   Plan file: docs/plans/W-<NNN>-<slug>.md

   Co-Authored-By: Claude <noreply@anthropic.com>
   EOF
   )"
   ```
8. Push the branch:
   ```
   git push -u origin <branch-name>
   ```
9. Open the PR. If the source is a GitHub issue, reference it in the body:
   ```
   gh pr create --title "docs(W-<NNN>): <short-title>" --body "$(cat <<'EOF'
   ## Summary

   Investigation plan for <work_request.title>.

   - Adds `docs/plans/W-<NNN>-<slug>.md`
   - Analysis only — no implementation changes

   Resolves #<issue_number> (plan phase)

   ## Plan

   - [docs/plans/W-<NNN>-<slug>.md](docs/plans/W-<NNN>-<slug>.md)
   EOF
   )"
   ```
10. Record the commit SHA (`git rev-parse HEAD`) and PR URL.

**If any of steps 5–9 fails**, produce `outcome: reject` with a descriptive reason.

## Output

Produce a structured result following the `pr.json` schema:

```json
{
  "pr_number": <integer>,
  "pr_url": "<url>",
  "review_status": "pending"
}
```

## Rules

<!-- governance -->
- **You MUST execute Process steps 5–9.** A `success` outcome REQUIRES a commit pushed and a PR opened.
- Do NOT modify any files other than copying the plan to docs/plans/.
- Do NOT invoke skills or execute implementation code.
- Do NOT modify the plan content — publish it as-is.
- The PR title MUST start with `docs(W-NNN):` to distinguish plan PRs from implementation PRs.
```

### 3. Template Description Update

Update `template.json` description to reflect the new behavior:

```json
// before
"description": "Analysis only. Opus planner explores codebase and produces a detailed report. No code changes, no PR. Output is a reusable MASTER_PLAN.md."

// after
"description": "Analysis mode. Opus planner explores codebase and produces a detailed report. The guardian publishes the plan to docs/plans/ and opens a PR. No implementation changes."
```

Also update `tags` to remove `"plan-only"` and add `"plan-pr"`:

```json
// before
"tags": ["analysis", "no-code", "plan-only"]

// after
"tags": ["analysis", "no-code", "plan-pr"]
```

### 4. PR Block Override

The user message template (`pr.block.md`) tells the guardian to "stage all implementation changes." This wording is wrong for investigate mode. Create a block override:

**File:** `templates/investigate/agents/pr.block.md`

```markdown
Publish the investigation plan as a PR now. Execute the Process steps in your
system prompt: copy the plan to docs/plans/, commit, push, and open the PR.
Do NOT ask for confirmation — the orchestrator has already approved.

## Work Request

{{work_request}}
```

This replaces the base `pr.block.md` for investigate runs only (the three-tier block resolution in `overlay.py:144-195` applies template overlays last).

### 5. Status Semantics — Distinguishing Plan PRs

**Decision:** Rely on the `pipeline_template` field in `status.json` to distinguish investigate PRs from implementation PRs. The field is already set to `"worca:investigate"` for investigate runs (`run_pipeline.py:241`).

Additionally, the PR title convention `docs(W-NNN): ...` makes plan PRs visually distinct in GitHub, the UI, and CI.

No schema changes needed. Consumers that need to distinguish can check:
- `status.pipeline_template` contains `"investigate"`, OR
- `stages.pr.iterations[0].outcome` data includes only a plan file path

## Implementation Plan

### Current State

The runtime copy (`.claude/worca/templates/investigate/`) is **already updated** with all template config changes, the guardian prompt override, and the PR block override. Specifically:

- `.claude/worca/templates/investigate/template.json` — PR stage enabled, description and tags updated
- `.claude/worca/templates/investigate/agents/guardian.md` — replace-mode guardian prompt (exists)
- `.claude/worca/templates/investigate/agents/pr.block.md` — replace-mode user message (exists)

The source package (`src/worca/templates/investigate/`) still has the old config: `pr: { enabled: false }`, old description/tags, and no `agents/guardian.md` or `agents/pr.block.md`.

**Implementation therefore starts from Phase 1 (source package sync), not from template authoring.**

### Phase 1: Source Package Sync

**Files:** `src/worca/templates/investigate/template.json` (modify), `src/worca/templates/investigate/agents/guardian.md` (create), `src/worca/templates/investigate/agents/pr.block.md` (create)
**Tasks:**
1. Update `src/worca/templates/investigate/template.json` to match the runtime copy: enable PR stage, update description, update tags
2. Copy `guardian.md` from `.claude/worca/templates/investigate/agents/` to `src/worca/templates/investigate/agents/`
3. Copy `pr.block.md` from `.claude/worca/templates/investigate/agents/` to `src/worca/templates/investigate/agents/`
4. Verify content matches between runtime and source copies
5. Verify `worca init --upgrade` round-trips correctly (source → runtime)

All tests in Phase 2 run against `src/worca/` (the editable install), so they validate the source package directly.

### Phase 2: Fix Existing Tests

**Files:** `tests/test_preset_templates.py` (modify), `tests/test_builtin_templates.py` (no change — see below)
**Tasks:**
1. Update `tests/test_preset_templates.py:18` — change `EXPECTED_OVERLAYS["investigate"]` from `{"planner.md"}` to `{"planner.md", "guardian.md", "pr.block.md"}`
2. **Do NOT** add `("investigate", "guardian")` to `tests/test_builtin_templates.py:22-33` `TEMPLATE_OVERLAYS` — that list is specifically for **append-mode** overlays (the test at line 63 asserts `<!-- append -->` as the first line). The investigate guardian uses **replace mode** (no `<!-- append -->` tag), so including it would cause `test_template_overlay_uses_append_mode` to fail. The `pr.block.md` is also replace-mode and should not be added.

**Why test_builtin_templates.py is safe as-is:** The `TEMPLATE_OVERLAYS` list tests append-mode overlay behavior (governance preservation, content injection). Replace-mode overlays have different semantics — they fully substitute the base prompt. The new unit tests in Phase 3 validate replace-mode behavior separately.

### Phase 3: New Tests

See Test Plan below.

**Files:** `tests/test_investigate_template.py` (create), `tests/integration/test_investigate_pr.py` (create)

### Phase 4: Documentation

**Files:** `CLAUDE.md` (if needed)
**Tasks:**
1. No CLAUDE.md changes needed — the template system is already documented
2. The PR itself serves as documentation of the new behavior

### Files Changed Summary

| File | Action | Description |
|------|--------|-------------|
| `src/worca/templates/investigate/template.json` | Modify | Enable PR stage, update description and tags (mirror of runtime copy) |
| `src/worca/templates/investigate/agents/guardian.md` | Create | Replace-mode guardian prompt for plan publishing (mirror of runtime copy) |
| `src/worca/templates/investigate/agents/pr.block.md` | Create | Replace-mode user message for investigate PR (mirror of runtime copy) |
| `tests/test_preset_templates.py` | Modify | Update EXPECTED_OVERLAYS for investigate to include guardian.md and pr.block.md |

## Considerations

- **No Python code changes.** The entire feature is template config + agent prompt overrides. The pipeline runner, governance hooks, schemas, and stage machinery are untouched.
- **No schema changes.** The investigate guardian returns the standard `pr.json` output (`pr_number`, `pr_url`, `review_status`). No new fields needed.
- **No governance changes.** The agent role is still `guardian` (set via `WORCA_AGENT` from the stage-agent mapping in `stages.py:39`), so `guard.py:247` allows the commit.
- **Plan_check hook allows `.md` writes.** The hook (`plan_check.py:31-33`) checks file extensions — `.md` is not in `SOURCE_EXTENSIONS`, so writing to `docs/plans/` returns exit 0 (allow). Note that `plan_check.py` also allows source file writes (`.py`, `.js`, etc.) when a plan file exists (`plan_check.py:40-46`), which is always true by the PR stage. The investigate guardian is prompt-constrained (not governance-constrained) to only write `.md` files. A stage-aware restriction (e.g., limiting guardian to `.md` writes) could be added in a future plan.
- **Guardian prompt divergence.** The investigate override fully replaces the base guardian prompt. If the base guardian receives significant updates (commit format, output schema, security rules), the investigate override must be manually synced. This is documented as a known coupling.
  - **Mitigation:** Keep the investigate guardian prompt minimal — only the objective and steps differ. The output schema reference and governance rules tag are identical to the base. When modifying the base guardian, `grep -r guardian.md .claude/worca/templates/` surfaces all overrides.
- **Branch sequencing.** The investigate pipeline creates a plan-only PR on its own branch. The implementation pipeline (run later) creates a separate branch. The recommended workflow is: merge the plan PR first, then run the implementation pipeline with `--source gh:issue:N`. The implementation pipeline auto-discovers the plan via the issue body link (now present because the plan PR body includes the `## Plan` section with the file link).
- **Breaking changes:** None. Existing investigate runs continue to work — the PR stage simply runs at the end instead of being skipped. If a user wants the old behavior (no PR), they can override with `--set worca.stages.pr.enabled=false` on the command line.
- **Backward compatibility for `worca init --upgrade`:** Users who have already run `worca init` will get the updated template on their next `--upgrade`. The new files are additive (new agent overrides), so no migration needed.

## Test Plan

### Unit Tests — Template Loading

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_investigate_template_enables_pr_stage` | After applying investigate template, `get_enabled_stages()` returns `[PREFLIGHT, PLAN, PR]` — not COORDINATE, IMPLEMENT, TEST, or REVIEW |
| Python | `test_investigate_template_disables_milestones` | All three milestones (`plan_approval`, `pr_approval`, `deploy_approval`) are `false` in merged config |
| Python | `test_investigate_template_planner_config` | Planner model is `opus`, max_turns is `200` |
| Python | `test_investigate_template_tags` | Tags include `"plan-pr"` and do not include `"plan-only"` |

### Unit Tests — Agent Overlay

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_investigate_guardian_replaces_base` | `OverlayResolver` resolving `guardian` with investigate template agents dir returns the investigate prompt, NOT the base guardian prompt |
| Python | `test_investigate_guardian_no_proof_check` | Resolved guardian prompt does NOT contain "proof status" or "review outcome" |
| Python | `test_investigate_guardian_has_plan_copy_steps` | Resolved guardian prompt contains "docs/plans/W-" and "cp" |
| Python | `test_investigate_guardian_has_pr_json_schema` | Resolved guardian prompt contains "pr_number" and "pr_url" |
| Python | `test_investigate_pr_block_replaces_base` | `OverlayResolver` resolving `pr` block with investigate template agents dir returns the investigate user message, NOT the base "stage all implementation changes" message |
| Python | `test_investigate_pr_block_no_implementation_ref` | Resolved pr.block does NOT contain "implementation changes" |
| Python | `test_base_guardian_unaffected` | Resolving `guardian` WITHOUT the investigate template agents dir returns the base prompt unchanged (no cross-contamination) |

### Unit Tests — W-Number Generation

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_w_number_sequential` | Given `docs/plans/` containing W-044 and W-045, the next number is W-046 |
| Python | `test_w_number_zero_padded` | Numbers below 100 are zero-padded to three digits (e.g., W-007) |
| Python | `test_w_number_empty_dir` | If `docs/plans/` is empty, the first number is W-001 |
| Python | `test_w_number_gaps` | If plans are W-001, W-003, W-010, the next is W-011 (highest + 1, not gap-fill) |

Note: W-number generation is executed by the guardian agent via shell commands, not by Python code. These tests validate the *expected behavior* described in the prompt. To test deterministically, create a helper function `next_w_number(plans_dir: str) -> str` in a utility module that the tests (and optionally the prompt) can reference. If the decision is to keep it prompt-only (agent runs the shell commands), these tests become integration tests instead.

### Integration Tests — Full Pipeline Flow

These extend the existing integration test harness in `tests/integration/` which uses `tests/mock_claude/mock_claude.py` to simulate Claude responses.

| Test | Setup | Expected Outcome |
|------|-------|------------------|
| `test_investigate_pipeline_creates_pr` | Run investigate template with `--source gh:issue:99` (mocked). Mock planner produces a plan. Mock guardian copies plan and returns `{ pr_number: 1, pr_url: "...", review_status: "pending" }`. | Pipeline completes with `pipeline_status: "completed"`. `stages.pr.status == "completed"`. `stages.pr.iterations[0].outcome == "success"`. `GIT_PR_CREATED` event emitted in `events.jsonl`. |
| `test_investigate_pipeline_stages_correct` | Same setup. | Only PREFLIGHT, PLAN, and PR stages appear in `status.json`. COORDINATE, IMPLEMENT, TEST, REVIEW are absent or have `skipped: true`. |
| `test_investigate_pipeline_template_field` | Same setup. | `status.pipeline_template == "worca:investigate"` |
| `test_investigate_guardian_rejects_on_no_plan` | Mock planner fails (no plan file produced). PR stage runs. | Guardian produces `outcome: reject` because there's no plan file to publish. Pipeline status reflects the rejection. |
| `test_investigate_without_source_issue` | Run investigate template with `--prompt "Analyze X"` (no `--source`). | Guardian still creates PR but without issue reference in body. No `Resolves #N` line. Pipeline completes successfully. |

### Integration Tests — Guardian Governance

| Test | Setup | Expected Outcome |
|------|-------|------------------|
| `test_investigate_guardian_can_commit` | Investigate pipeline reaches PR stage. Guardian runs `git commit`. | `guard.py` allows the commit (agent role is `guardian`). No "Blocked" error. |
| `test_investigate_guardian_md_write_allowed` | Guardian writes to `docs/plans/W-046-test.md`. | `plan_check.py` returns exit 0 (allow). |

**Note — no `plan_check.py` guardrail for source file writes during PR stage:** `plan_check.py:40-46` only blocks source file writes when the plan file is missing (`os.path.exists(plan_file)` returns `False`). By the time the PR stage runs in an investigate pipeline, the planner has already created the plan file and `WORCA_PLAN_FILE` points to it, so `plan_check.py` returns exit 0 for all writes — including `.py` files. The investigate guardian is instructed via its prompt not to modify any files other than copying the plan to `docs/plans/`, but this is a prompt-level constraint, not a governance-enforced one. Adding a stage-aware check to `plan_check.py` (e.g., restricting the guardian role to `.md` writes only) is a potential future improvement but is out of scope for this plan.

### Integration Tests — Overlay Isolation

| Test | Setup | Expected Outcome |
|------|-------|------------------|
| `test_investigate_overlay_does_not_leak` | Run investigate template, then run a normal (non-investigate) pipeline in the same project. | Normal pipeline's guardian uses the base prompt (proof/review checks present). Investigate override does not persist. |
| `test_investigate_planner_overlay_preserved` | Run investigate template. | Planner uses the `<!-- append -->` override (deep analysis mode). Guardian uses the replace override. Both overlays active simultaneously. |

### Edge Case Tests

| Test | Setup | Expected Outcome |
|------|-------|------------------|
| `test_investigate_plan_file_missing` | Pipeline reaches PR stage but `status.plan_file` points to a deleted file. | Guardian detects missing file, produces `outcome: reject`. |
| `test_investigate_docs_plans_dir_missing` | `docs/plans/` doesn't exist. | Guardian creates the directory (`mkdir -p`) before copying. |
| `test_investigate_duplicate_w_number` | `docs/plans/` already has a file with the expected next W-number (race condition with parallel runs). | Guardian detects the conflict (file exists after `cp`), increments to next available number, and retries. |
| `test_investigate_no_git_changes` | Plan file is identical to an existing file at the target path (e.g., re-running investigate on the same issue). | `git add` + `git status` shows nothing staged. Guardian produces `outcome: reject` — nothing new to publish. |
| `test_investigate_source_ref_formats` | `source_ref` is `gh:45`, `gh:issue:45`, or `None`. | Guardian handles all formats: extracts issue number for `gh:*`, omits issue reference when `None`. |

### Existing Tests to Update

Two existing test files contain assertions that will break. These are **guaranteed breakages**, not hypotheticals:

1. **`tests/test_preset_templates.py:18`** — `EXPECTED_OVERLAYS["investigate"]` is currently `{"planner.md"}`. After adding `guardian.md` and `pr.block.md` to `src/worca/templates/investigate/agents/`, the `test_agent_overlays_exist` test (line 68) will find 3 files but expect 1. **Fix:** Change to `{"planner.md", "guardian.md", "pr.block.md"}`.

2. **`tests/test_builtin_templates.py:22-33`** — `TEMPLATE_OVERLAYS` only lists `("investigate", "planner")`. This list does **NOT** need the new guardian overlay because the test suite validates **append-mode** overlays specifically (line 63 asserts `<!-- append -->`). The investigate guardian uses **replace mode**, so adding it here would cause `test_template_overlay_uses_append_mode` to fail. **No change needed.**

3. **No other existing tests break.** The `TestInvestigateConfig` class in `test_preset_templates.py:137-151` tests `coordinate_disabled`, `implement_disabled`, `planner_opus`, and `planner_200_turns` — none of these assert `pr.enabled == false`, so they pass unchanged.

### Done Criteria

All of the following must pass before this plan is considered complete:

1. `pytest tests/test_templates.py` — template loading tests pass (or equivalent)
2. `pytest tests/test_overlay.py` — overlay resolution tests pass (or equivalent)
3. `pytest tests/integration/` — full pipeline integration tests pass
4. Manual smoke test: run `python -m worca.scripts.run_pipeline --template investigate --source gh:issue:<N>` against a real issue, verify PR is created with plan file

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/worca/templates/investigate/template.json` | Modify | Enable PR stage, update description and tags (sync from runtime copy) |
| `src/worca/templates/investigate/agents/guardian.md` | Create | Replace-mode guardian prompt for plan publishing (sync from runtime copy) |
| `src/worca/templates/investigate/agents/pr.block.md` | Create | Replace-mode user message for investigate PR (sync from runtime copy) |
| `tests/test_preset_templates.py` | Modify | Update `EXPECTED_OVERLAYS["investigate"]` to include `guardian.md` and `pr.block.md` |
| `tests/test_investigate_template.py` | Create | Unit tests for template config and overlay resolution |
| `tests/integration/test_investigate_pr.py` | Create | Integration tests for investigate→PR pipeline flow |

Note: `.claude/worca/templates/investigate/` files (template.json, agents/guardian.md, agents/pr.block.md) are **already updated** in the runtime copy. They are not listed as changes because no further modification is needed.

## Out of Scope

- **New pipeline stages** (PUBLISH, EXPORT) — this plan reuses the existing PR stage.
- **Schema changes to `pr.json`** — the existing schema is sufficient.
- **Guard.py modifications** — the agent role remains `guardian`; no new roles needed.
- **Automatic implementation pipeline chaining** — the user manually runs the implementation pipeline after merging the plan PR.
- **Post-run hooks or `post_run` config** — deferred to a future plan if multiple templates need post-completion actions.
- **`{{block:}}` refactoring of the base guardian prompt** — the base guardian works fine as-is; block extraction is a separate refactor.
- **GitHub issue body editing** — the PR body includes the plan link; the issue body is not modified. GitHub auto-links the PR to the issue via `Resolves #N`.
- **Stage-aware `plan_check.py` restrictions** — currently `plan_check.py` allows all writes once a plan file exists. Adding role-based or stage-based restrictions (e.g., guardian can only write `.md` files) would provide governance-level enforcement beyond prompt instructions. Deferred as a potential future improvement.
