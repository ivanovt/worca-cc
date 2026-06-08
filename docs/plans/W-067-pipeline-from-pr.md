# W-067: Start a pipeline from a PR + review comments

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-06-04
**Depends on:** None (composes with W-065 deferrable-pr-creation — shared guardian PR seam)

## Problem

A worca run today can be sourced from a GitHub issue (`--source gh:issue:N`), a bead, a spec file, or a free-text prompt — all resolved in `work_request.py:normalize()` (`src/worca/orchestrator/work_request.py:343-372`). Every one of these **forks a fresh branch** `worca/{slug}-{run_id}` from a base (`utils/git.py:create_pipeline_worktree`, ~`:150-175`) and the guardian **always creates a new PR** via `gh pr create` (`agents/core/guardian.md:33-51`).

There is no way to feed an *existing* PR back into the pipeline. The common loop — a pipeline produces PR #N, a human reviews it and leaves inline comments, and we want a follow-up run to **address that feedback on the same PR** — is unsupported. Today the only options are to hand-edit the branch or start a brand-new run that re-implements from scratch and opens a *duplicate* PR, discarding the review context.

User-facing impact: the human-in-the-loop review cycle dead-ends at the first PR. Reviewers can't say "fix these 4 comments" and have worca pick them up.

## Proposal

Add a new source scheme `gh:pr:N` (and full PR URL) that:

1. Fetches the PR plus its **unresolved, human-authored review threads** (file:line anchored) via GitHub GraphQL, excluding worca's own comments.
2. Synthesizes a work request whose description is the original PR body plus a structured **"## Review Feedback to Address"** list.
3. Runs the worktree against the **existing PR head branch** (base taken from the PR's `baseRefName`), not a fresh fork.
4. Runs the Planner in a **constrained revision mode** (minimal diff, scoped strictly to the enumerated comments).
5. Has the guardian **update the PR in place** (`WORCA_REVISE_PR=N`): push the head branch, post a summary comment, reply to each addressed thread — **no `gh pr create`, no thread auto-resolve**.
6. Surfaces the run as a PR-revision in the UI, including a new panel that shows the review comments being addressed.

## Design

### Locked decisions (from analysis, 2026-06-04)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Update PR in place** (not a new/stacked PR) | Matches the "continue the review loop" intent; keeps one PR, one review thread. |
| D2 | **Constrained Planner revision mode** | Full re-planning risks re-architecting code the reviewer didn't object to. |
| D3 | **Reply-only on threads, never auto-resolve** | Human keeps resolution authority; worca replies with the addressing commit SHA. |

### Three correctness landmines (call out in every relevant phase)

| Landmine | Failure mode | Mitigation |
|----------|--------------|------------|
| **L1 — self-comment loop** | worca tries to "address" its own summary/reply comments, looping forever | Every comment worca posts starts with a content marker (`WORCA_COMMENT_MARKER`, `🤖 worca`); ingestion skips any comment whose body begins with it. Content-based, so it needs no dedicated bot account/token and never false-excludes human reviewers who share worca's login. |
| **L2 — head-branch-name drift** | recreating the head under a new name pushes to a *different* branch → spawns a **duplicate PR** instead of updating | Preserve the exact head branch name end-to-end; guardian pushes to it, never `gh pr create` in revise mode. |
| **L3 — concurrent checkout** | the PR head branch may still be checked out in the original run's live worktree; a branch can only be checked out once | Fetch the head from remote into a **fresh** worktree (`gh pr checkout N`), never assume the original worktree is gone. |

### 1. Source resolution — `normalize_github_pr()`

- **Current state:** `work_request.py:normalize()` (`:343-372`) dispatches on source scheme; `normalize_github_issue()` (`:203-230`) fetches `gh issue view N --json title,body` and auto-detects a plan link via `_extract_plan_path()` (`:182-200`). The `WorkRequest` dataclass is at `:98-108`.
- **Obstacle:** no PR scheme; no PR-comment fetch; `WorkRequest` carries no PR-revision metadata (head branch, base branch, PR number, the comment list).
- **Resolution:**
  - Add `gh:pr:N` parsing in `normalize()`, plus full-PR-URL acceptance via the existing `utils/pr_url.py:parse_pr_url()` (`:1-77`) so a pasted URL resolves to `{provider, repo_path, number}`. **v1 = GitHub only** (parity with issues today); other providers raise a clear "not yet supported".
  - New `normalize_github_pr()` fetches PR metadata (`gh pr view N --json title,body,baseRefName,headRefName,headRepositoryOwner,isCrossRepository,author`) and the review threads (see §2).
  - Extend `WorkRequest` (`:98-108`) with PR-revision fields:

```python
@dataclass
class WorkRequest:
    source_type: str            # + "github_pr"
    title: str
    description: str = ""
    source_ref: Optional[str] = None     # "gh:pr:N"
    priority: int = 2
    plan_path: Optional[str] = None
    guide_content: str = ""
    # --- new (W-067) ---
    pr_number: Optional[int] = None
    pr_head_branch: Optional[str] = None     # L2: preserve verbatim
    pr_base_branch: Optional[str] = None     # becomes target_branch
    pr_is_cross_repo: bool = False           # fork PR → gh pr checkout path
    review_comments: list = field(default_factory=list)  # see §2 schema
```

### 2. Comment ingestion — new `src/worca/utils/gh_pr.py`

- **Current state:** PR-side helpers don't exist; `utils/gh_issues.py` (`:1-212`) is the only lifecycle-writeback module (issue start/complete/fail, all error-suppressed, gated by `WORCA_NO_GITHUB`).
- **Obstacle:** the REST `/pulls/N/comments` endpoint does **not** expose thread resolution state. Resolution + thread grouping requires GraphQL `reviewThreads`. (This is a *different* GraphQL field than the classic-Projects `projectCards` one that's broken in this repo per CLAUDE.md — `reviewThreads` is safe.)
- **Resolution:** `gh_pr.py:fetch_review_feedback(nwo, pr_number)` runs a GraphQL query for `reviewThreads { isResolved, isOutdated, comments(first:N) { author { login }, path, line, originalLine, diffHunk, body, createdAt } }`, plus top-level `comments` and `reviews`. Then filter:
  1. **Unresolved** threads only (`isResolved == false`).
  2. **Not worca's own** — exclude any comment whose body begins with `WORCA_COMMENT_MARKER` (`🤖 worca`) (**L1**). Content-based, so no dedicated bot account/token is needed and human reviewers sharing worca's login are never false-excluded.
  3. Drop empty/whitespace bodies.

  Normalized comment shape (also the JSON stored in status — §5):

```json
{
  "thread_id": "PRRT_xxx",
  "path": "src/foo.py",
  "line": 42,
  "diff_hunk": "@@ -40,6 +40,8 @@ ...",
  "author": "reviewer-login",
  "body": "this leaks a file handle",
  "kind": "inline | pr_level | review_summary",
  "created_at": "2026-06-03T12:00:00Z"
}
```

  `attach_guide()` (`:279-340`) is **not** reused here — review feedback is task scope, not a normative guide. The description is synthesized:

```
<original PR title/body>

## Review Feedback to Address
- [src/foo.py:42] @reviewer: "this leaks a file handle"   (thread PRRT_1)
- [src/foo.py:88] @reviewer: "rename for clarity"          (thread PRRT_2)
- [PR-level]      @reviewer: "add a test for the empty case"
```

### 3. Worktree — check out the existing head (not a fresh fork)

- **Current state:** `run_worktree.py` (`:179-234`) defines `--source` (`:186`) and `--branch` (`:189`, the *base* to fork from, stored as `target_branch`); the head is auto-generated `worca/{slug}-{run_id}` (~`:293`). `create_pipeline_worktree()` (`utils/git.py:150-175`) always creates a new branch.
- **Obstacle:** revision work must operate on the PR's existing head branch; forking a new branch breaks D1/L2.
- **Resolution:**
  - For `source_type == "github_pr"`, the worktree checks out the **PR head**. Robust path: `gh pr checkout N` inside the fresh worktree (handles cross-repo/fork PRs where head lives in another repo — `pr_is_cross_repo`). Fetch from remote into a brand-new worktree dir (**L3**); never reuse the original run's worktree.
  - `target_branch` = `pr_base_branch` (from `baseRefName`), **not** `--branch`.
  - **Reject `--branch` for this source** with a clear error (precedent: fleet rejects `--branch`). The base is owned by the PR.
  - Registry (`registry.py:register_pipeline`, `:50-100`) records `revises_pr: N` and keeps `branch` = the actual PR head branch name (preserved verbatim — **L2**).

### 4. Guardian revise mode — `WORCA_REVISE_PR=N`

- **Current state:** guardian context (`guardian_context.py:1-76`) computes `pr_title_prefix` (`:21-34`), `pr_footer` (`:37-56`), `defer_pr` (`:59-66`, true iff `WORCA_DEFER_PR=="1"`). `guardian.md` has a defer branch (`:19-30`) and the normal `gh pr create` branch (`:33-51`). Post-run, `runner.py:4090-4119` parses/verifies (`_verify_pr_via_gh`, `:1067-1130`) and stores `status.json.pr`.
- **Obstacle:** no "update existing PR" mode; guardian unconditionally creates a PR.
- **Resolution:** add a third guardian mode, gated by a new `revise_pr` context var (true iff `WORCA_REVISE_PR` is set to a PR number), computed in `guardian_context.py` alongside `defer_pr`:
  - Push the existing head branch (**L2**: same name → PR auto-updates).
  - Post a **summary comment** on PR #N ("addressed N items, commit `<sha>`").
  - **Reply to each addressed thread** with the addressing commit SHA (D3). **Never resolve** threads.
  - **Skip `gh pr create`.** Re-read the existing PR via `_verify_pr_via_gh()` so `status.json.pr` still populates (number/url unchanged).
  - **Compose with W-065 deferrable creation:** `revise_pr` and `defer_pr` are mutually exclusive; revise implies the PR already exists, so defer is a no-op. Document the precedence in `guardian_context.py` and `guardian.md`.

  Thread-reply + summary live in `gh_pr.py` (`reply_to_thread()`, `post_revision_summary()`), error-suppressed and `WORCA_NO_GITHUB`-gated like `gh_issues.py`.

### 5. State & status

- **Current state:** `status.py:init_status()` (`:281-311`) sets `branch`, `git_head`, `pr: None`, milestones. PR object schema in `schemas/pr.json`.
- **Resolution:** add top-level status fields:
  - `source_type` / `source_ref` (also needed by the UI — they're surfaced *nowhere* today).
  - `revises_pr: N`.
  - `review_feedback: [...]` — the normalized comment list (§2 schema) so the UI panel (§7) renders from status without a live GitHub call.

### 6. Planner constrained revision mode + coordinator decomposition

- **Current state:** planner/coordinator core prompts in `src/worca/agents/core/`.
- **Resolution:**
  - **Planner:** a revision-mode instruction block (templated when `source_type == github_pr`): "produce a minimal-diff plan scoped strictly to the enumerated review feedback; preserve everything the reviewer did not object to; do not re-architect." For very small comment sets the plan may be a thin checklist.
  - **Coordinator:** decompose each unresolved comment into a bead, carrying its `thread_id` + file:line anchor so the implementer acts precisely and the guardian can map commit→thread for replies.

### 7. UI (worca-ui)

- **7a Launcher (cheap).** Source dropdown already exists (`fleet-launcher.js:397-462`, option list ~`:415`, input ~`:426-437`; `new-run.js:580-597`; label in `launcher-shared.js:112-116`). The free-text source field already POSTs `source` → `process-manager.js:507-522` → `--source`. Add a **"GitHub PR"** option + hint text. `gh:pr:N`/URL flows through with no server plumbing change.
- **7b Source indicator (needs plumbing).** `source_type`/`source_ref` is surfaced in **no** view. Plumb it through `watcher.js:_shapeRunFromFile()` (`:146-178`, alongside the worktree fields at `:162-172`), then render a **"Revising PR #N" badge** on `run-card.js` (~`:135-152`) and a **Source row** in the `run-detail.js` overview.
- **7c PR strip semantic reorder.** `run-detail.js:_prInfoStripView()` (`:57-127`) renders the PR worca *created*, only in the PR stage. For a revise run the PR is the **input** — show it from run start; the `changes_requested` `review_status` badge is now the *trigger*, not an outcome.
- **7d Review-comments panel (the real new surface).** No PR-review-comment surface exists anywhere in the UI. New `worca-ui/app/views/run-detail-pr-comments.js` renders the `status.json.review_feedback` list: each comment with file:line anchor, author, body, and (when available) the bead/commit that addressed it + the thread-reply worca posted. **Renders from status — no new streaming event needed for v1** (comments are fetched once at ingestion).
- **Gates:** new view file pulls in `worca-ui-card-consistency-reviewer` / `worca-ui-design-reviewer`, plus the npm `files`-allowlist check (`npm pack --dry-run | grep run-detail-pr-comments`).

ASCII flow:

```
gh:pr:N / URL
   │  normalize_github_pr()  +  gh_pr.py (GraphQL: unresolved, non-worca)    [L1]
   ▼
WorkRequest{ description = body + "## Review Feedback to Address",
             pr_head_branch, pr_base_branch, review_comments[] }
   │  run_worktree: gh pr checkout N into fresh worktree                     [L3]
   │  target_branch = baseRefName ; --branch rejected
   ▼
constrained Planner ─► coordinator (comment → bead w/ thread_id)
   ▼  implementer / tester
   ▼
guardian (WORCA_REVISE_PR=N): push head [L2] ─► no gh pr create
                              ─► summary comment + per-thread reply (no resolve)  [D3]
   ▼
status.json{ source_type, revises_pr, review_feedback[] } ─► UI badge + comments panel
```

## Implementation Plan

### Phase 1 — Source + ingestion (Python, no side effects)
**Files:** `src/worca/orchestrator/work_request.py`, `src/worca/utils/gh_pr.py` (new), `src/worca/utils/pr_url.py`
**Tasks:**
1. Add `gh:pr:N` + PR-URL parsing in `normalize()` (`:343-372`); GitHub-only guard for other providers.
2. `normalize_github_pr()` — fetch PR metadata; extend `WorkRequest` (`:98-108`) with PR fields.
3. `gh_pr.py:fetch_review_feedback()` — GraphQL `reviewThreads`, filter unresolved + drop worca's own marker-prefixed comments (**L1**), normalize to the §2 schema.
4. Synthesize the "## Review Feedback to Address" description.

### Phase 2 — Worktree checkout-existing-head
**Files:** `src/worca/scripts/run_worktree.py`, `src/worca/utils/git.py`, `src/worca/orchestrator/registry.py`
**Tasks:**
1. For `github_pr`, check out PR head via `gh pr checkout N` into a fresh worktree (**L3**); fork-PR aware.
2. `target_branch = baseRefName`; **reject `--branch`** for this source.
3. Preserve head branch name verbatim (**L2**); record `revises_pr` in registry (`:50-100`).

### Phase 3 — Guardian revise mode + writeback
**Files:** `src/worca/orchestrator/guardian_context.py`, `src/worca/agents/core/guardian.md`, `src/worca/utils/gh_pr.py`, `src/worca/orchestrator/runner.py`, `src/worca/state/status.py`
**Tasks:**
1. `revise_pr` context var (true iff `WORCA_REVISE_PR` set); mutual-exclusion + precedence vs `defer_pr` (W-065).
2. guardian.md third branch: push head, **no `gh pr create`**, re-verify existing PR.
3. `gh_pr.py:reply_to_thread()` + `post_revision_summary()` (reply-only, no resolve — D3); `WORCA_NO_GITHUB`-gated.
4. `init_status()` (`:281-311`): add `source_type`, `source_ref`, `revises_pr`, `review_feedback`.

### Phase 4 — Planner revision mode + coordinator beads
**Files:** `src/worca/agents/core/planner.md`, `src/worca/agents/core/coordinator.md`
**Tasks:**
1. Planner revision-mode block (minimal diff, scoped to feedback).
2. Coordinator: comment → bead carrying `thread_id` + file:line.

### Phase 5 — UI (MVP) + follow-up
**Files:** `worca-ui/app/views/fleet-launcher.js`, `worca-ui/app/views/new-run.js`, `worca-ui/app/views/launcher-shared.js`, `worca-ui/server/watcher.js`, `worca-ui/app/views/run-card.js`, `worca-ui/app/views/run-detail.js`, `worca-ui/app/views/run-detail-pr-comments.js` (new)
**Tasks (MVP):**
1. "GitHub PR" launcher option + hint.
2. Plumb `source_type`/`source_ref` through `watcher.js:_shapeRunFromFile` (`:146-178`).
3. "Revising PR #N" badge (`run-card.js`) + Source row (`run-detail.js`).
4. PR strip reorder — show target PR from run start (`run-detail.js:57-127`).
5. New `run-detail-pr-comments.js` panel from `status.review_feedback`.
6. Rebuild bundle; `npm pack --dry-run | grep run-detail-pr-comments`; lint + vitest + (UI-diff) playwright.

**Follow-up (out of v1):** run→PR / run→run lineage links; a "PRs awaiting revision" launch surface.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/work_request.py` | `gh:pr:N` parse, `normalize_github_pr()`, extend `WorkRequest` |
| `src/worca/utils/gh_pr.py` (new) | GraphQL fetch/filter, thread reply, revision summary |
| `src/worca/utils/pr_url.py` | reuse `parse_pr_url()` for URL → PR number |
| `src/worca/scripts/run_worktree.py` | checkout-existing-head mode, reject `--branch` |
| `src/worca/utils/git.py` | worktree-on-existing-branch path |
| `src/worca/orchestrator/registry.py` | `revises_pr` field |
| `src/worca/orchestrator/guardian_context.py` | `revise_pr` var + precedence vs `defer_pr` |
| `src/worca/agents/core/guardian.md` | revise-mode branch (push, no create, reply) |
| `src/worca/agents/core/planner.md` | constrained revision-mode block |
| `src/worca/agents/core/coordinator.md` | comment → bead w/ thread_id |
| `src/worca/orchestrator/runner.py` | re-verify existing PR in revise mode |
| `src/worca/state/status.py` | `source_type`/`source_ref`/`revises_pr`/`review_feedback` |
| `worca-ui/server/watcher.js` | plumb `source_type`/`source_ref` |
| `worca-ui/app/views/{fleet-launcher,new-run,launcher-shared}.js` | "GitHub PR" option |
| `worca-ui/app/views/run-card.js` | "Revising PR #N" badge |
| `worca-ui/app/views/run-detail.js` | source row + PR strip reorder |
| `worca-ui/app/views/run-detail-pr-comments.js` (new) | review-comments panel |

## Considerations

- **Breaking changes:** none. New source scheme is additive; existing issue/prompt/bead/spec flows untouched.
- **Migration:** none. New status fields default to absent/empty on existing runs; UI badge/panel render only when present.
- **Governance:** `gh pr checkout`/`gh pr comment`/`gh api graphql` run from agent or runner context; confirm they pass the `pre_tool_use` hook (read-vs-mutate classification). Thread replies/summary are runner-side writeback (like `gh_issues.py`), not agent tool calls.
- **W-065 overlap:** revise mode shares the guardian PR seam (`guardian_context.py` `defer_pr`). Land order shouldn't matter, but the mutual-exclusion rule (revise ⇒ defer is no-op) must be implemented whichever lands second.
- **Fork PRs:** `gh pr checkout` handles cross-repo head; pushing back requires write access to the fork (maintainer-edit) — degrade with a clear error if not permitted, and fall back to documenting that fork PRs may need a new PR.
- **Multi-provider:** GitLab/Bitbucket PR/MR comment fetch is provider-specific; v1 GitHub-only, others raise "not yet supported".

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_normalize_github_pr_builds_work_request` | `gh:pr:N` → WorkRequest with head/base/comments |
| Python | `test_pr_url_resolves_to_number` | full PR URL → PR number (GitHub) |
| Python | `test_fetch_review_feedback_filters_resolved` | resolved threads dropped |
| Python | `test_fetch_review_feedback_excludes_worca_marker` | **L1** — worca's own marker-prefixed comments excluded |
| Python | `test_review_feedback_description_synthesis` | "## Review Feedback to Address" formatting + anchors |
| Python | `test_worktree_pr_source_rejects_branch_flag` | `--branch` rejected for `gh:pr:N` |
| Python | `test_worktree_pr_target_branch_from_base` | `target_branch == baseRefName` |
| Python | `test_guardian_context_revise_pr_var` | `WORCA_REVISE_PR` → `revise_pr` true; mutual-exclusion w/ `defer_pr` |
| Python | `test_init_status_pr_revision_fields` | `source_type`/`revises_pr`/`review_feedback` present |
| JS (vitest) | `run-card` source badge | "Revising PR #N" renders when `revises_pr` set |
| JS (vitest) | `run-detail-pr-comments` panel | renders comments from `review_feedback`, file:line anchors |

### Integration / E2E Tests
- Mock-claude pipeline run with `--source gh:pr:N` (PR + comments stubbed via mock `gh`): head branch checked out (**L2/L3**), guardian pushes without `gh pr create`, status carries `review_feedback`.
- Playwright: launcher "GitHub PR" option present; run-detail shows source row + comments panel (UI-diff triggers playwright per CLAUDE.md).

### Existing Tests to Update
- `work_request` normalize tests — add `github_pr` dispatch case.
- guardian-context tests — add `revise_pr` matrix alongside `defer_pr`.
- `watcher`/`_shapeRunFromFile` server tests — assert `source_type`/`source_ref` passthrough.

## Files to Create/Modify

See **Files Changed Summary** table above. New files: `src/worca/utils/gh_pr.py`, `worca-ui/app/views/run-detail-pr-comments.js`, and the test files enumerated in the Test Plan.

## Out of Scope

- Non-GitHub providers (GitLab MRs, Bitbucket, etc.) — GitHub-only in v1.
- Auto-resolving review threads (explicitly rejected — D3).
- Live-streaming new review comments during a run (panel renders the once-ingested snapshot).
- run→run / run→PR lineage links in the UI (follow-up).
- A "PRs awaiting revision" discovery/launch surface (follow-up).
- Stacked/new-PR mode (explicitly rejected — D1).
