# W-065: Scoped Reviewer Diff Base and Pre-existing Observations

**Status:** Draft
**Priority:** P1
**Area:** cc
**Date:** 2026-06-04
**Depends on:** None

## Problem

The reviewer agent diffs against the base branch tip (`develop`/`main`) to find what changed.
In multi-commit branch topologies, the worca branch is often created from a commit that is
already ahead of the base branch tip — prior work that landed on the branch before the
pipeline ran. The reviewer then sees and evaluates all of that prior work too.

Observed in run `20260604-094825-458-094a` (`worca/w-001-problem-specification-chirpstack-a-4gb`):
- `git diff develop..HEAD --stat` → 56 files, 2,574 insertions (full v1 implementation)
- Correct diff (`git diff b7fbae2..HEAD --stat`) → 8 files, ~100 lines (pipeline-only changes)

The reviewer flagged `critical`/`major` issues in `ComponentProvider.java`,
`MQTTPahoClient.java`, and `DeviceProvider.java` — files untouched by the pipeline,
introduced by a prior commit (`60c606f`). These triggered 4 implement–test–review cycles
costing ~$25 and never reaching `approve`.

The correct base commit is already recorded in `status.json` as `git_head`
(`src/worca/orchestrator/runner.py:2121`), but it is never loaded into the
`PromptBuilder` context — confirmed: `git_head` is absent from `prompt_context.json`
in all observed runs, and `_STAGE_CONTEXT_MAP` in `src/worca/orchestrator/resume.py:139`
does not include it. The reviewer therefore has no `{{review_base}}` variable and
re-derives the base branch itself via `git symbolic-ref`
(`src/worca/agents/core/reviewer.md:15`), which returns the branch tip rather than the
pipeline start commit.

A second gap: the reviewer currently has no way to report findings in pre-existing code
without those findings triggering an implement cycle. There is no structured output path
for "I see this problem but it is not in scope for this pipeline run."

## Proposal

Inject `git_head` as `{{review_base}}` into the review stage context so the reviewer always
diffs against the exact commit the pipeline started from, not the base branch tip. Add an
`observations` array to `review.json` for pre-existing findings that are surfaced to the user
but never trigger pipeline loop-backs. Persist observations to `docs/reviews/observations-<run_id>.md`
after each review iteration.

## Design

### 1. Review base injection — `prompt_builder.py`

**Current state:** `src/worca/orchestrator/prompt_builder.py:301–315`

```python
elif stage == "review":
    test_passed = ctx.get("test_passed")
    ...
    files_changed = ctx.get("files_changed")
    if files_changed:
        ctx["files_changed_formatted"] = "\n".join(f"- {f}" for f in files_changed)
    else:
        ctx["files_changed_formatted"] = ""
```

**Obstacle:** `git_head` is stored in `status.json` but is never loaded into the
`PromptBuilder` context. The review stage's `ctx` dict is built from `prompt_context.json`,
which does not contain `git_head` because nothing calls
`prompt_builder.update_context("git_head", ...)` in the pipeline lifecycle.
`ctx.get("git_head")` therefore returns `None` at review time.

**Resolution — two changes required:**

**Change 1A — `runner.py:2411`:** Load `git_head` into the PromptBuilder context alongside
the other status-derived template variables (immediately after the existing
`prompt_builder.update_context("run_id", ...)` call):

```python
prompt_builder.update_context("run_id", status.get("run_id", ""))
prompt_builder.update_context("branch", branch_name)
prompt_builder.update_context("title", work_request.title)
# NEW: expose git_head so review stage can use it as review_base
prompt_builder.update_context("git_head", status.get("git_head") or "")
```

This runs once at pipeline init (fresh runs) and is also re-loaded on resume via
`prompt_builder.load_context(prompt_context_path)` at `runner.py:2299`, because
`save_context` persists all keys including `git_head`.

**Change 1B — `prompt_builder.py:315`:** Expose `git_head` as `review_base` in the
review stage context block:

```python
elif stage == "review":
    test_passed = ctx.get("test_passed")
    ...
    files_changed = ctx.get("files_changed")
    if files_changed:
        ctx["files_changed_formatted"] = "\n".join(f"- {f}" for f in files_changed)
    else:
        ctx["files_changed_formatted"] = ""
    # Inject the exact commit the pipeline started from as the diff base.
    # Using git_head rather than the base branch name avoids reviewing
    # pre-existing commits that landed on the branch before the pipeline ran.
    ctx["review_base"] = ctx.get("git_head") or ""
```

When `git_head` is absent (non-git project, fresh branch with no prior commits),
`review_base` is empty string and the reviewer falls back to `git merge-base` (see §3).

### 2. `observations` array — `schemas/review.json`

**Current state:** `src/worca/schemas/review.json`

```json
{
  "required": ["outcome"],
  "properties": {
    "outcome": { ... },
    "issues": {
      "type": "array",
      "items": {
        "properties": {
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "severity": { "type": "string", "enum": ["critical", "major", "minor", "suggestion"] },
          "description": { "type": "string" }
        }
      }
    },
    "iteration_count": { ... },
    "guide_conflicts": { ... }
  }
}
```

**Obstacle:** No output path exists for findings outside the diff. Any finding the reviewer
flags goes into `issues`, and `critical`/`major` issues in `issues` always trigger an
implement cycle in `runner.py:3868`.

**Resolution:** Add an `observations` array with the same item shape as `issues`:

```json
{
  "required": ["outcome"],
  "properties": {
    "outcome": { ... },
    "issues": {
      "type": "array",
      "description": "Findings within the pipeline's diff (git_head..HEAD). Critical/major items here trigger implement loop-back.",
      "items": {
        "type": "object",
        "properties": {
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "severity": { "type": "string", "enum": ["critical", "major", "minor", "suggestion"] },
          "description": { "type": "string" }
        }
      }
    },
    "observations": {
      "type": "array",
      "description": "Pre-existing findings outside the pipeline's diff. Reported at honest severity but never trigger implement loop-back. Persisted to docs/reviews/ for user follow-up.",
      "items": {
        "type": "object",
        "properties": {
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "severity": { "type": "string", "enum": ["critical", "major", "minor", "suggestion"] },
          "description": { "type": "string" }
        }
      }
    },
    "iteration_count": { ... },
    "guide_conflicts": { ... }
  }
}
```

### 3. Reviewer process and output — `reviewer.md`

**Current state:** `src/worca/agents/core/reviewer.md:13–16`

```
2. Review all changes against the base branch:
   - Detect base branch via `git symbolic-ref refs/remotes/origin/HEAD | sed 's|refs/remotes/origin/||'` or fall back to `main`/`master`
   - Run `git diff <base>..HEAD` to see all changed files
```

**Obstacle:** `git symbolic-ref` returns the branch name (`develop`), not the commit the
pipeline started from. In multi-commit topologies these diverge. The reviewer then sees
work from prior commits it should not review.

**Resolution — Process step 2:**

```
2. Establish your diff base and review scope:
   - Use `{{review_base}}` as your diff base — this is the exact commit the pipeline
     started from, recorded when the run began. Run:
     `git diff {{review_base}}..HEAD --stat`
     to see all files this pipeline changed.
   - If `{{review_base}}` is empty, fall back to:
     `git merge-base HEAD origin/HEAD`
     Do NOT use `git symbolic-ref` or the base branch tip — they may point to a commit
     earlier than where this pipeline started, pulling in pre-existing work.
   - Per file, run `git diff {{review_base}}..HEAD -- <file>` to see the exact changed
     lines. Read surrounding file context only when needed to evaluate a changed line.
```

**Resolution — Output section:** extend to document both arrays:

```
## Output

Produce a structured result following the `review.json` schema:

- `outcome`: `"approve"` | `"request_changes"` | `"reject"` | `"restart_planning"`
- `issues`: findings **within** `git diff {{review_base}}..HEAD` — drives pipeline decisions
- `observations`: findings **outside** the diff (pre-existing code) — user-facing only,
  never triggers loop-back; report at the same severity you would assign to in-diff findings — no downgrading because the code is pre-existing
- `iteration_count`: integer — which review iteration this is (start at 1)
```

**Resolution — Rules section:** add scope enforcement rule:

```
- **Scope gate:** Put findings in `issues` only when the affected code appears in
  `git diff {{review_base}}..HEAD`. Code you read for context that is outside the diff
  belongs in `observations`, regardless of severity. The pipeline acts only on `issues`;
  `observations` are persisted for the user and never cause an implement cycle.
```

### 4. Scope framing in user message — `review.block.md`

**Current state:** `src/worca/agents/core/review.block.md:1`

```
Review the code changes for correctness, style, security, and adherence to the plan. ...
```

**Obstacle:** The reviewer reads its role prompt and the block in sequence. If the block
does not mention the diff scope, the model forms its review intent ("review all files")
before reaching the Rules section where the scope constraint lives.

**Resolution:** Prepend a scope framing sentence to the block — fires before the model
reads any other content:

```
Review the code changes for correctness, style, security, and adherence to the plan. You
are strictly read-only: do NOT modify code, do NOT run tests (the tester already produced
proof artifacts). Produce your structured review output.

**Review scope:** `git diff {{review_base}}..HEAD` is your primary review surface — only
what this pipeline produced. Findings within that diff go in `issues` and drive pipeline
decisions. Findings in code outside the diff (pre-existing) go in `observations` at
whatever severity you honestly believe is correct — they are saved for the user but never
trigger an implement cycle.{{#if review_base}}{{else}} `review_base` is not set for this
run — use `git merge-base HEAD origin/HEAD` as your fallback diff base instead.{{/if}}
```

Note: the worca template engine supports `{{#if name}}...{{else}}...{{/if}}` but not
`{{#unless}}` (`src/worca/orchestrator/overlay.py:320–354`). The empty-truthy branch
`{{#if review_base}}{{else}}...{{/if}}` renders the fallback only when `review_base` is
empty string, and renders nothing (the common case) when it is set.

### 5. Observations persistence — `runner.py`

**Current state:** `src/worca/orchestrator/runner.py:3828–3880` — review handler reads
`result.get("issues", [])` and `result.get("outcome")`. `observations` is not read.

**Obstacle:** Pre-existing findings have no persistence path. They would be lost after
each review iteration.

**Resolution:** After each review iteration completes, if `observations` is non-empty,
append them to `docs/reviews/observations-<run_id>.md` relative to the project root
(the runner's CWD throughout execution). The file is created on first write and appended
on subsequent review iterations. File I/O failures are logged as warnings and never halt
the pipeline — the review outcome proceeds normally.

```python
# After existing review result handling (_emit_guide_conflicts call),
# before next_stage routing:
_observations = result.get("observations", [])
if _observations:
    try:
        obs_path = os.path.join("docs", "reviews",
                                f"observations-{status.get('run_id', 'unknown')}.md")
        os.makedirs(os.path.dirname(obs_path), exist_ok=True)
        _iter = result.get("iteration_count", iter_num)
        _is_first = not os.path.exists(obs_path)
        with open(obs_path, "a", encoding="utf-8") as _f:
            if not _is_first:
                _f.write("\n")
            _f.write(f"## Review iteration {_iter}\n\n")
            for obs in _observations:
                _sev = obs.get("severity", "?")
                _file = obs.get("file", "?")
                _line = obs.get("line")
                _loc = f"{_file}:{_line}" if _line else _file
                _desc = obs.get("description", "")
                _f.write(f"- **[{_sev}]** `{_loc}` — {_desc}\n")
        _log(f"Observations written to {obs_path}", "ok")
    except Exception as _obs_err:
        _log(f"Could not write observations: {_obs_err}", "warn")
```

One file per `run_id`. Accumulated across all review iterations within that run.
Appended not overwritten, so partial observations from early iterations survive if the run
hits the review limit. The `_is_first` check avoids a leading blank line on file creation.

## Implementation Plan

### Phase 1: Context injection and schema

**Files:** `src/worca/orchestrator/runner.py`, `src/worca/orchestrator/prompt_builder.py`, `src/worca/schemas/review.json`

**Tasks:**
1. `runner.py:2411` — add `prompt_builder.update_context("git_head", status.get("git_head") or "")` immediately after the existing `update_context("run_id", ...)` call, so `git_head` is available in the prompt context throughout the pipeline lifecycle including resume.
2. `prompt_builder.py:315` — add `ctx["review_base"] = ctx.get("git_head") or ""` at the end of the `elif stage == "review":` block.
3. `schemas/review.json` — add `observations` array property with same item shape as `issues`; add `description` annotations to both arrays. Do NOT add `observations` to the `required` array — it remains optional for backward compatibility.

### Phase 2: Reviewer prompt updates

**Files:** `src/worca/agents/core/reviewer.md`, `src/worca/agents/core/review.block.md`

**Tasks:**
1. `reviewer.md:14–16` — replace Process step 2 with `{{review_base}}`-based diff instruction and `git merge-base` fallback.
2. `reviewer.md` Output section — document `observations` array alongside `issues`, with explicit routing rules.
3. `reviewer.md` Rules section — add scope gate rule.
4. `review.block.md:1` — prepend scope framing paragraph referencing `{{review_base}}` and `observations`.

### Phase 3: Runner observations persistence

**Files:** `src/worca/orchestrator/runner.py`

**Tasks:**
1. In the `elif current_stage == Stage.REVIEW:` handler, after `_emit_guide_conflicts` and before the `next_stage` routing block — read `result.get("observations", [])` and append to `docs/reviews/observations-<run_id>.md`.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/runner.py` | Load `git_head` into prompt context at init; append observations to `docs/reviews/` after each review iteration (with error handling) |
| `src/worca/orchestrator/prompt_builder.py` | Add `ctx["review_base"]` in review stage block |
| `src/worca/schemas/review.json` | Add `observations` array (optional); annotate `issues` and `observations` with descriptions |
| `src/worca/agents/core/reviewer.md` | Process step 2, Output section, Rules section |
| `src/worca/agents/core/review.block.md` | Prepend scope framing paragraph with `{{#if review_base}}{{else}}...{{/if}}` fallback |

## Considerations

- **`files_changed_formatted` unchanged** — it remains in the block as-is. It reflects the last implementer bead's files, which is a subset of the full diff. The reviewer is now told to use `{{review_base}}` for the authoritative file list, so the existing field is harmless context rather than a scope signal.
- **`observations` is optional** — `review.json` schema does not add it to `required`. Existing reviewer outputs without the field remain valid; the runner treats absence as an empty list.
- **`docs/reviews/` gitignore** — projects may want to add `docs/reviews/` to `.gitignore` to keep observation files out of the repository, or commit them for a persistent audit trail. This is a per-project decision not enforced by worca.
- **No breaking change to runner loop-back logic** — `critical_issues` is still derived from `result.get("issues", [])` only. The `observations` array is additive and does not affect any existing runner branching.
- **Fallback robustness** — when `git_head` is absent, `review_base` is empty string. The `{{#if review_base}}{{else}}...{{/if}}` block in `review.block.md` activates the `git merge-base` fallback instruction. The reviewer never falls back to `git symbolic-ref`. Note: `{{#unless}}` is not supported by the worca template engine (`overlay.py:320`); use `{{#if}}...{{else}}...{{/if}}` with an empty truthy branch instead.
- **Observations write failure is non-fatal** — I/O errors during observations persistence are caught and logged as warnings; the review outcome and pipeline flow are unaffected.
- **`observations` not in schema `required`** — existing reviewer outputs without the field remain valid; the runner treats absence as an empty list and writes no file.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_git_head_loaded_into_prompt_context` | After `prompt_builder.update_context("git_head", sha)` at runner init, `build_context("review")` returns `ctx["review_base"] == sha` |
| Python | `test_review_stage_review_base_empty_when_no_git_head` | `ctx["review_base"] == ""` when `git_head` not in context |
| Python | `test_review_schema_accepts_observations` | `observations` array with valid items passes schema validation |
| Python | `test_review_schema_observations_optional` | Output without `observations` field passes schema validation |
| Python | `test_runner_writes_observations_file` | When review result contains `observations`, `docs/reviews/observations-<run_id>.md` is created with correct content |
| Python | `test_runner_appends_observations_across_iterations` | Two review iterations both append to the same file |
| Python | `test_runner_no_observations_file_when_empty` | When `observations` is `[]` or absent, no file is written |
| Python | `test_runner_observations_do_not_affect_loop_back` | `observations` with `critical` severity does not cause `review_issues` to be set |

### Existing Tests to Update

- Any test that constructs a review result dict and validates runner behavior should be checked to ensure `observations` absent still passes (no required field breakage in `review.json` schema).
- Tests that mock `build_context("review")` and assert on returned keys should be updated to expect `review_base` in the output dict.
- Tests that mock runner init should be updated to verify `prompt_builder.update_context("git_head", ...)` is called with the value from `status`.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/worca/orchestrator/runner.py` | Modify | Load `git_head` into prompt context at init (runner.py:2411); append observations in review handler |
| `src/worca/orchestrator/prompt_builder.py` | Modify | One line added in review stage block to expose `review_base` |
| `src/worca/schemas/review.json` | Modify | Add `observations` property; add `description` annotations |
| `src/worca/agents/core/reviewer.md` | Modify | Process step 2, Output section, Rules section |
| `src/worca/agents/core/review.block.md` | Modify | Prepend scope framing paragraph |
| `src/worca/orchestrator/runner.py` | Modify | Append observations after each review iteration |
| `docs/reviews/observations-<run_id>.md` | Created at runtime | Per-run, not versioned by worca |

## Out of Scope

- No changes to how `files_changed_formatted` is computed or displayed.
- No changes to the runner's loop-back severity gate (`critical`/`major` in `issues` → implement cycle). Only the source of findings changes, not the gate logic.
- No UI for browsing observations — the markdown file is the user-facing artifact.
- No deduplication of observations across review iterations.
- No enforcement that `docs/reviews/` is or is not gitignored — per-project decision.
- No changes to `git_head` recording at pipeline start — it already works correctly.
- No changes to the `lorawan` project's `.claude/worca/` copy — that is a separate submodule and would need a separate sync.
