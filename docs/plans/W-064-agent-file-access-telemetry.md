# W-064: Agent file-access & search telemetry

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-06-04
**Depends on:** None

## Problem

worca has no record of what files each agent iteration actually **reads, writes, or searches**. The implementer self-reports `files_changed`/`tests_added` in its structured output (`runner.py:3590-3593`), but that is unvalidated, write-only, and coarse — it cannot tell us whether two beads touched the same file, how often a file was re-read, or how much an agent searched before finding its target. As a result we have no evidence base for three open questions:

1. **Does the coordinator decompose work into file-disjoint beads?** This is the go/no-go signal for ever running implementers in parallel — without it we are guessing.
2. **Are agent prompts efficient?** Re-reads (context thrashing), write-churn, and whole-repo greps (orientation deficit) are invisible today.
3. **Does graphify pay off?** The `graphify_nudge` hook (`src/worca/hooks/graphify_nudge.py`) suggests `graphify query` over broad searches, but we have no way to measure whether it reduces blind grepping.

The data needed to answer all three is already flowing through the `PostToolUse` hook (`src/worca/claude_hooks/post_tool_use.py:58-69`) — we simply never record it.

## Proposal

Capture, per agent iteration, the set of files read/written and the searches performed, via the existing `PostToolUse` hook; aggregate and canonicalize at iteration completion in the runner; persist into the iteration record and emit one `pipeline.iteration.access` event. Zero behavior change; data accrues passively from every run. The records are structured so that downstream analysis — visualization, and eventually a disjointness-scheduler — can consume them offline. **This plan is capture/record only; visualization is explicitly out of scope** (a future, separate `area:ui` plan).

## Design

### 1. Capture — `PostToolUse` hook (dumb, fast, raw)

- **Current state:** `src/worca/claude_hooks/post_tool_use.py:58-69` already parses `tool_name`, `tool_input`, `tool_response` and does per-tool work (bd-link, test-gate). `src/worca/hooks/guard.py:288` shows the `file_path` extraction pattern.
- **Obstacle:** the hook runs per tool call in the agent subprocess; it must stay cheap and must not do path math (which needs repo+git context it doesn't cleanly have).
- **Resolution:** add a recorder that classifies the tool into one of three **op categories** and appends a single raw JSONL line. No normalization, no filtering, no git in the hook.

| Op | Tools | Path key | Notes |
|----|-------|----------|-------|
| `write` | `Write`, `Edit`, `MultiEdit` | `file_path` | `MultiEdit` = **1** write (one atomic call) |
| `write` | `NotebookEdit` | `notebook_path` | different key — per-tool map required |
| `read` | `Read` | `file_path` | pagination (offset/limit) inflates count — documented |
| `search` | `Grep`, `Glob` | `pattern`, `path`, `glob`/`type` | `result_count` parsed from `tool_response` |

Count semantics: **one tool call = one increment.** `Grep`/`Glob` are *not* content reads — they are a distinct category and must never inflate the read set.

**Record location (per-process, never shared append):**
```
.worca/runs/<run_id>/access/<stage>-<iter>[-<bead>].jsonl
```
One file per (stage, iteration, bead). Each concurrent writer owns its own file → no cross-process append contention on any OS, and forward-compatible with future parallel beads. Opened explicitly `encoding="utf-8", newline="\n"`. Line shape:
```jsonc
{ "ts": "...", "op": "read|write|search", "tool": "Read",
  "path": "<raw, as captured>",            // read/write
  "pattern": "...", "scope": "...", "filter": "...", "result_count": 3 }  // search
```

### 2. Attribute — runner env stamping (the one new seam)

- **Current state:** the runner already exports `WORCA_AGENT` into each agent subprocess (read by hooks at `post_tool_use.py:73`, `guard.py`). Env is built in `run_stage` (`src/worca/orchestrator/runner.py:1243-1396`).
- **Obstacle:** the hook subprocess knows `WORCA_RUN_ID` and `WORCA_AGENT` but not the stage, iteration number, or bead — so it cannot name its own per-iteration JSONL file.
- **Resolution:** export `WORCA_STAGE`, `WORCA_ITERATION`, and (in IMPLEMENT) `WORCA_BEAD_ID` into the agent subprocess env via the same mechanism as `WORCA_AGENT`. ~5 lines. Load-bearing for the whole feature.

### 3. Path canonicalization (runner-side, OS-critical)

This repo has a documented history of Windows path bugs (`2eb9767` "fix Windows path bug … source-grep test", `efb3f48` "preserve literal case in UI"). The records key on file paths, so cross-OS runs **must** produce identical keys or aggregation silently double-counts. New module: `src/worca/orchestrator/path_canon.py`. Two layers with different jobs.

**Layer 1 — `canonicalize(raw, root) -> str | None`** (pure path math, deterministic, no git):
```python
canonical_root = realpath(WORCA_PROJECT_ROOT)        # resolve mount symlinks once
abs_ = raw if isabs(raw) else join(canonical_root, raw)
abs_ = realpath(abs_)                                 # same resolution on both sides
try:    rel = relpath(abs_, canonical_root)
except ValueError:    return None                     # Windows: different drive
if rel == "." or rel.startswith(".."):    return None # escaped repo → drop
return PurePath(rel).as_posix()                       # '\'→'/', collapse '.'/'..', literal case
```
- `realpath` on **both** sides cancels a symlinked repo root out of the common prefix (e.g. `/Volumes/Apps/...` mounts). Tradeoff: a *tracked symlink file* resolves to its target and may drop — rare for source, documented.
- `relpath` + `..` check is the repo-containment test (drops `/etc`, temp, sibling clones).
- `PurePath.as_posix()` normalizes separators; case is **preserved** (never lowercased here).

**Layer 2 — `GitPathOracle` (adopt git's exact spelling, filter to source):**
```bash
git -c core.quotepath=false ls-files -z               # all tracked files  → reads oracle
git -c core.quotepath=false status --porcelain=v1 -z  # changed source set → writes oracle
```
`-z` + `quotepath=false` is mandatory: raw NUL-delimited paths, no octal-escaping/quoting, unicode-safe. Build an exact map and a lowercased map from each. Re-spell rule (same for reads/writes, different oracle):
1. **Exact match** → adopt git's spelling. (Common on Linux.)
2. Miss → **unique case-insensitive match** → adopt git's spelling, flag `case_remapped`. (Folds hook `src/Auth.py` onto git `src/auth.py` on macOS/Windows without wrongly merging distinct Linux files — only if the lowercased lookup is unique.)
3. Still miss → not in git's view: **gitignored → drop** (this is the source filter, for free — `node_modules`, `dist`); **untracked-new → keep** Layer-1 form, flag `untracked`.

Reads use the `ls-files` oracle; writes use the `status` oracle. Search scopes use **Layer 1 only** (git doesn't track dirs).

### 4. Writes — per-iteration counts from hook, identity from git

`git status` is **cumulative** (worca accumulates uncommitted writes until guardian), so it cannot attribute a write to an iteration. Split the concerns:

- **Per-iteration write counts** come from the **hook** (its JSONL lines are already per-iteration via the env stamps). Canonicalize + re-spell each → `{git_path: count}`.
- **Canonical key + existence** come from **git** (re-spell adopts git's string; a hook write that re-spells to nothing in `status` is reverted/non-source → dropped to `unmatched_hook_writes`).
- **`leakage_pct` is run-level**: at run end, symmetric difference between `union(all hook writes)` and the final `git status` source set. Git-only paths = Bash-writes the hook missed; hook-only = reverted/non-source. This is the **capture-reliability metric** — turning "is the hook reliable?" into a logged number, without per-iteration git snapshots.

> **Git decides which-file and how-it's-spelled; the hook decides how-many and which-iteration; their difference is the reliability signal.**

### 5. Search scope normalization

Each search normalized to a repo-relative **directory** for the future tree-region rollup:
- **Grep:** `path` arg → repo-relative; if a file, take its parent; **absent → repo root (`.`)**.
- **Glob:** static prefix before the first wildcard — `src/**/*.py` → `src/`; fully-wildcarded → root.
- **Filter dimension:** Grep `glob`/`type` (`*.py`, `type=js`) recorded separately from the tree scope.
- **`pattern`** truncated to ~200 chars (intent/thrashing signal; messier, secondary).
- **`root_scoped`** count (whole-repo greps) is itself the **orientation-deficit** signal.

### 6. Aggregated record + event (runner, at `complete_iteration`)

- **Current state:** `src/worca/state/status.py` `complete_iteration` (~L177-196) merges arbitrary kwargs into the last iteration record; `start_iteration` (~L134-174) appends. Iterations are free-form dicts.
- **Resolution:** at completion, read the iteration's JSONL, canonicalize + re-spell + filter + count, then (a) stamp `file_access` into the iteration dict (no schema migration), (b) emit one `pipeline.iteration.access` event.

```jsonc
file_access: {
  reads:  { "src/api/auth.py": 7, ... },
  writes: { "src/api/auth.py": 3, ... },
  searches: [ { "tool":"grep", "pattern":"def authenticate", "scope":"src/api",
               "filter":"*.py", "result_count":3 }, ... ],
  totals: { distinct_read, total_read, distinct_write, total_write,
            grep, glob, zero_result, root_scoped },
  capture: { hook_writes, git_writes, leakage_pct, oracle: "ok|degraded" }
}
```

**Event:** `pipeline.iteration.access`, scaffolded via `/worca-event-add`. **Tier 2/3 — NOT chat-notifiable, no `renderers.js` entry.** Flows to the WS/UI stream and opt-in analytics webhooks; never to chat. Payload = the aggregate above plus `run_id/stage/agent/iteration/bead_id`.

**Robustness:** git failure must **never** break telemetry — degrade to Layer-1 form, set `oracle: "degraded"`, continue. Cache `ls-files` once per run; `status` per iteration-end. Resume rebuilds the oracle from live git state (no persisted path state).

## Implementation Plan

**Files:** `src/worca/claude_hooks/post_tool_use.py`, `src/worca/orchestrator/runner.py`, `src/worca/orchestrator/path_canon.py` (new), `src/worca/events/types.py`, `tests/`

**Tasks:**
1. Add the `WORCA_STAGE`/`WORCA_ITERATION`/`WORCA_BEAD_ID` env stamping in `run_stage` (`runner.py:1243-1396`).
2. Add the three-category recorder to `post_tool_use.py` — raw per-call append to the per-iteration JSONL.
3. Write `path_canon.py` — `canonicalize()` + `GitPathOracle` (`respell_read`/`respell_write`).
4. Add the aggregation step at the `complete_iteration` call site in the runner — read JSONL, canonicalize/re-spell/filter/count, stamp `file_access`, compute run-level `leakage_pct`.
5. Add `pipeline.iteration.access` via `/worca-event-add` (constant + payload builder + test; **no renderer**).
6. Add the `worca.telemetry.file_access.enabled` (default **on**) gate.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/path_canon.py` | **New** — `canonicalize()` + `GitPathOracle` |
| `src/worca/claude_hooks/post_tool_use.py` | Add 3-category raw recorder |
| `src/worca/orchestrator/runner.py` | Env stamping in `run_stage`; aggregation at `complete_iteration` |
| `src/worca/events/types.py` (+ payload builder) | `pipeline.iteration.access` event |
| `src/worca/.../settings` | `worca.telemetry.file_access.enabled` default on |

## Considerations

- **Honest limits:** Bash-mediated source *writes* are invisible to the hook but **measured** via the git cross-check (`leakage_pct`); Bash *reads* have no git fallback (accepted — agents read via `Read` overwhelmingly). Pagination inflates read counts (documented). Glob scope extraction is heuristic (brace-expansion / leading `**` → root). Subagent tool calls attribute to the parent iteration (acceptable — it is that iteration's footprint).
- **Event volume** is controlled by aggregating at `complete_iteration` (one event per iteration, not per tool call).
- **Governance:** read-only; observability only. No new dispatch/guard rules. The recorder runs in `PostToolUse` (after the action), so it cannot block.
- **`core.autocrlf` skew** (Windows): EOL-only `status` modifications are minor — the agent did write those files, so they still match a hook write; note as a small wobble in `leakage_pct`, not a correctness bug.
- **Breaking changes:** none. `file_access` is additive to free-form iteration dicts; the event is new and non-chat. No status schema migration.
- **Migration:** none. New config key `worca.telemetry.file_access.enabled` (default `true`) is the only addition.

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_canonicalize_windows_separators` | `src\api\Auth.py` vs tracked `src/api/auth.py` → `src/api/auth.py` + `case_remapped` |
| Python | `test_canonicalize_symlinked_root` | mount-symlink root resolves; in-repo paths key correctly |
| Python | `test_canonicalize_outside_repo` | `../x`, `/etc/x`, other-drive → `None` |
| Python | `test_git_oracle_respell_and_filter` | gitignored → dropped; untracked → kept+flagged; exact spelling adopted |
| Python | `test_writes_counts_from_hook_keys_from_git` | per-iteration counts + git-spelled keys; `leakage_pct` = symmetric diff |
| Python | `test_search_scope_normalization` | Grep path/parent/absent→`.`; Glob static prefix; `root_scoped` |
| Python | `test_recorder_categories_and_counts` | MultiEdit=1 write; NotebookEdit `notebook_path`; Grep ≠ read |
| Python | `test_event_payload_pipeline_iteration_access` | payload shape; not chat-notifiable |

### Integration Tests
- Mock-claude pipeline run produces per-iteration `access/*.jsonl`, `file_access` in `status.json`, and `pipeline.iteration.access` events; `leakage_pct` computed at run end.

### Existing Tests to Update
- Any iteration-record assertions that snapshot the full dict (now includes `file_access`).
- Event-type roster/count tests (`tests/test_event_types.py`) — one new constant.

## Files to Create/Modify

| Path | Create/Modify | Purpose |
|------|---------------|---------|
| `src/worca/orchestrator/path_canon.py` | Create | Canonicalization + git oracle |
| `src/worca/claude_hooks/post_tool_use.py` | Modify | 3-category recorder |
| `src/worca/orchestrator/runner.py` | Modify | Env stamping + aggregation |
| `src/worca/events/types.py` | Modify | New event + payload builder |
| `tests/test_path_canon.py` | Create | Layer-1/2 unit tests |
| `tests/test_file_access_recorder.py` | Create | Recorder/aggregation tests |
| `tests/test_event_types.py` | Modify | New event coverage |

## Out of Scope

- **Visualization / UI** — the entire `worca-ui` surface (file matrix, cross-run aggregate, search tree-region heatmap, efficiency profile). Deferred to a future, separate `area:ui` plan that consumes the records and event this plan produces.
- **The disjointness scheduler** (predicting bead file-sets, conflict-graph independent-set dispatch). Records are designed so it is replayable **offline** against collected data.
- **Runtime write leases / PreToolUse enforcement** ("retry in 10s").
- **Parallel implementers themselves** (worktree/scratch isolation, merge-back, reconciliation iterations).
- **Coordinator-declared per-bead file scope** — a prerequisite of the scheduler, not of this telemetry.
