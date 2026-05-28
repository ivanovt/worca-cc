# W-057: Optional code-review-graph (CRG) MCP Integration

**Status:** Draft
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-05-24
**Depends on:** W-053 (graphify integration — shares the per-commit cache, flock/`.complete`, detection, and UI-tab scaffolding)

## Problem

Worca's nine-stage pipeline pays an orientation tax on every `claude -p` subprocess, which W-053 addressed by integrating [graphify](https://github.com/safishamsi/graphify) — a multimodal knowledge-graph builder consumed via the **CLI** (`graphify query`) over Bash (`src/worca/utils/claude_cli.py:117-119`, `src/worca/hooks/guard.py:198-283`). graphify's query surface is *exploratory* (`query`, `path`, `explain`); it has no task-shaped primitive for "blast radius of this symbol" or "minimal context for this task."

[code-review-graph](https://github.com/tirth8205/code-review-graph) (CRG; PyPI `code-review-graph`, MIT, Python 3.10+) builds a Tree-sitter AST graph in SQLite and exposes ~24 **MCP tools** — including `get_minimal_context`, `get_impact_radius`, `get_review_context`, and `detect_changes` — that map directly onto worca's Plan → Implement → Review hot loop. CRG is **purely local** (no LLM/API key for structural builds) and incremental (`update` in <2s).

The gap: worca has **zero MCP plumbing today** (`src/worca/utils/claude_cli.py:117-119` and `docs/governance.md:54-57` explicitly state MCP "flows through other channels" and is out of scope for `--tools`), so there is no way to give a pipeline a task-shaped AST engine, and no way for a user to *choose* between (or combine) graph engines. User-facing impact: operators who want review-grade impact analysis instead of exploratory orientation have no option.

## Proposal

Add **code-review-graph as an optional, off-by-default second AST engine** alongside graphify, controlled by a two-tier toggle (`worca.code_review_graph.enabled`) mirroring W-053's resolution. Unlike graphify's CLI-over-Bash model, CRG is integrated **MCP-first**:

- worca **builds** the CRG graph at preflight (base HEAD), content-addressed in the shared per-commit cache, then seeds a **run-scoped writable copy** that is **refreshed after each implementer iteration** so reviewer/tester tools see in-flight code.
- Agents reach CRG via a **per-agent stdio MCP server** (`code-review-graph serve`) injected with `--mcp-config <inline-json> --strict-mcp-config`. worca already passes `--dangerously-skip-permissions`, so MCP tools auto-approve.
- **Per-stage tool exposure is governed server-side** via the `CRG_TOOLS` env in the mcp-config `env` block — no new `--tools` MCP channel needed. Mutating/code-editing tools are hard-excluded.
- **Both engines may be enabled simultaneously**, building as siblings under one per-commit snapshot dir.
- A **full UI tab** mirrors the shipped graphify Settings tab (status / build / clear / query surfaces) plus a per-iteration CRG tool-call badge in run detail.

Structural-only for v1 (no embeddings / `semantic_search` / `embed_graph`). worca never runs `code-review-graph install`.

## Decisions

Locked via `/worca-analyze` triage (2026-05-24):

1. **Blocking validation gates** (read tools emit no DML; `serve` honors `CRG_DATA_DIR`/`CRG_REPO_ROOT` for reads) — clear them with a **standalone spike *before* the Phase 3 build**, not inline. The read-only governance model (§5) and the copied-base-DB design (§3) both rest on these gates, so a short spike beats discovering a violation mid-build and reworking Phases 3-5. **Fallback strategies are documented in §5** ("Fallback strategies if validation gates fail") so a spike failure does not stall the feature: `CRG_TOOLS` falls back to `--disallowedTools` with MCP tool names; `CRG_DATA_DIR` falls back to CRG's default project-relative path; worst case, a thin MCP proxy filters tools. *(Resolves Known-unknowns 1-2.)*
2. **CRG MCP `serve` lifecycle** — **per-invocation stdio child**: one `code-review-graph serve` per `claude` process, torn down on exit (§4 as written). Zero port/concurrency management, safe for parallel agents and worktrees. Defer server warming; revisit only if the startup-latency measurement (Known-unknown 3) proves prohibitive. *(Resolves Known-unknown 3.)*
3. **WAL checkpoint before base-DB copy** — run `PRAGMA wal_checkpoint(TRUNCATE)` after the base build, before copying `graph.db` into the run-scoped dir (§3). Yields a clean single-file copy with no `-wal` side-file and avoids "copied DB missing recent writes" bugs. *(Resolves Known-unknown 4.)*

## Design

### 1. Settings schema — `worca.code_review_graph` block

**Current state:** `src/worca/settings.json:350-365` defines the `worca.graphify` block (two-tier toggle, `mode`, `version_range`, `update_on`, `freshness`, `preflight_timeout_seconds`, `nudge`). Resolution lives in `src/worca/utils/graphify.py:174-245` (`effective_graphify_config`).

**Resolution:** add a sibling `worca.code_review_graph` block. Enablement semantics are identical to graphify (project opts in; explicit global `false` is a kill-switch).

```jsonc
// src/worca/settings.json (worca-cc defaults)
"worca": {
  "code_review_graph": {
    "enabled": false,                  // global default — opt-in
    "embeddings": false,               // v1: structural-only (no semantic_search / embed_graph)
    "update_on": {
      "preflight": true,               // build base snapshot before planner
      "post_implement": true,          // `crg update` after each implementer iteration
      "guardian_post_commit": true     // warm base cache for new HEAD (fire-and-forget)
    },
    "freshness": "clean_only",         // base snapshot: cache only if tree clean, else run-scoped throwaway
    "min_repo_files": 100,             // recommendation threshold for `worca crg recommend`
    "version_range": ">=2,<3",         // CRG pin
    "fastmcp_min": "3.2.4",            // hard dependency floor (stdio EOF fixes)
    "preflight_timeout_seconds": 300,
    "stage_tools": null                // null = built-in per-stage CRG_TOOLS map (§5); object overrides per role
  }
}
```

**Effective-state resolution** reuses the W-053 algorithm (`enabled = global !== false && project.enabled`). A new `EffectiveCrgConfig` dataclass parallels `EffectiveGraphifyConfig`. Both engines resolve independently; coexistence (§12) is the union.

### 2. Detection layer — shared probe, CRG-specific binary

**Current state:** `src/worca/utils/graphify.py` exposes `detect_graphify(version_range)` → `GraphifyDetect` (probes CLI version, checks compat).

**Resolution:** extract the generic probe (binary-on-PATH + `--version` parse + semver compat) into `src/worca/utils/tool_detect.py`, then:

```python
# src/worca/utils/code_review_graph.py
@dataclass(frozen=True)
class CrgDetect:
    installed: bool
    version: Optional[str]            # CRG version, e.g. "2.2.3.1"
    compatible: bool                  # matches version_range
    fastmcp_ok: bool                  # fastmcp >= fastmcp_min present
    error: Optional[str]

def detect_code_review_graph(version_range=">=2,<3", fastmcp_min="3.2.4") -> CrgDetect:
    """Probe `code-review-graph --version` + fastmcp floor. Cached per run / per UI boot."""
    ...
```

Detection runs **once per pipeline run** (cached) and **once per UI server boot** (refreshed by the Re-check button). Never per agent stage. Same four runtime states as W-053 (`disabled` / `enabled-but-missing` / `enabled-but-incompatible` / `enabled-and-ready`); CRG adds a `fastmcp-too-old` degraded sub-state.

### 3. Cache model — base snapshot + run-scoped writable copy

This is the CRG-specific heart of the plan. graphify is pure orientation, so a single immutable per-commit snapshot suffices. CRG's `detect_changes`/`get_impact_radius` are about the **delta**, and the owner chose **base + post-implement refresh** — so the graph must reflect uncommitted in-flight edits, which no longer map to a commit SHA. Resolution:

```
$WORCA_CACHE/ast/<repo-id>/<base-sha>/        # shared, content-addressed, flock-guarded (W-053 machinery)
├── .lock  .complete
├── graphify/                                 # if graphify enabled (W-053)
└── code-review-graph/graph.db                # BASE snapshot (read warm-start, never mutated in place)

<run-dir>/code-review-graph/graph.db          # RUN-SCOPED writable copy (per run / per worktree)
```

- **Base snapshot** — built at preflight on base HEAD via `CRG_REPO_ROOT=<worktree> CRG_DATA_DIR=<snapshot>/code-review-graph code-review-graph build`, run from any cwd. Content-addressed; serialized across parallel same-SHA builders by reusing graphify's `snapshot_lock` flock + `.complete` (`src/worca/utils/graphify.py:317-385`). `freshness: clean_only` → dirty tree builds a run-scoped throwaway directly (no shared publish).
- **Run-scoped copy** — at run start, **copy** the base `graph.db` into `<run-dir>/code-review-graph/` (or build fresh there if no base cache hit). All agents' `serve` point `CRG_DATA_DIR` here. This dissolves the WAL read-only problem (CRG opens the DB **read-write** with `PRAGMA journal_mode=WAL` and has **no read-only/`immutable` open path** — confirmed in `graph.py`/`registry.py`; so the shared base must never be opened by `serve`, only copied from).
- **Refresh** — after each implementer iteration, `CRG_REPO_ROOT=<worktree> CRG_DATA_DIR=<run-dir>/... code-review-graph update` (git-diff change detection picks up uncommitted edits) so tester/reviewer/guardian query current code.
- **Concurrency** — CRG has **no internal flock** (relies on SQLite WAL). The run-scoped copy is single-run, so cross-process write contention is eliminated; worca's flock only guards the shared base build.

### 4. MCP wiring — net-new `--mcp-config` path

**Current state:** `build_command()` (`src/worca/utils/claude_cli.py:160-235`) passes `-p, --agent, --output-format, --no-session-persistence, --dangerously-skip-permissions, --tools, --disallowedTools, --model`. **No MCP flags.** Env is built in `run_agent()` (`:425-445`) via `get_env(**overrides)` (`src/worca/utils/env.py:57-74`); `GRAPHIFY_OUT` is injected post-`get_env` at `:436-440` as the template for tool env injection. `CRG_*` keys are not reserved (`src/worca/utils/env.py:26-40`), so they pass through.

**Resolution:** when CRG is `ready`, the runner builds a per-agent mcp-config and `run_agent` forwards it to `build_command`:

```python
# new: src/worca/utils/code_review_graph.py
def crg_mcp_config(repo_root: str, data_dir: str, crg_tools: list[str]) -> str:
    """Inline JSON for a single stdio CRG MCP server, scoped to this agent."""
    return json.dumps({"mcpServers": {"code-review-graph": {
        "type": "stdio", "command": "code-review-graph", "args": ["serve"],
        "env": {"CRG_REPO_ROOT": repo_root, "CRG_DATA_DIR": data_dir,
                "CRG_TOOLS": ",".join(crg_tools)},
    }}})

# build_command() additions (claude_cli.py)
if mcp_config:                       # only when CRG ready for this stage
    cmd.extend(["--mcp-config", mcp_config, "--strict-mcp-config"])
```

`--strict-mcp-config` ensures only worca's injected server loads (ignores user/project/plugin MCP). `--dangerously-skip-permissions` (already set) auto-approves the MCP tools — no `--permission-mode` work. stdio server is a child of each `claude` process, torn down on exit; no ports, so concurrent agents are safe (each spawns its own). Note `MCP_TIMEOUT` for startup latency (validation item).

**Signature cascade.** Threading `--mcp-config` through the call stack requires changes at four levels, mirroring the existing `graphify_out` pattern:

1. **`build_command()`** (`claude_cli.py:200`) gains `mcp_config: Optional[str] = None`. When set, appends `--mcp-config <value> --strict-mcp-config` to the cmd list (after the existing `--model` / `--json-schema` block, before the return at `:275`).
2. **`run_agent()`** (`claude_cli.py:484`) gains `mcp_config: Optional[str] = None` — passed through to `build_command(mcp_config=mcp_config)` at `:520-527`. Unlike `graphify_out` (which becomes an env var at `:542-546`), `mcp_config` is a CLI flag, not an env injection.
3. **`run_stage()`** (`runner.py:1180`) gains `crg_data_dir: Optional[str] = None`. When set, it resolves the per-stage `CRG_TOOLS` list via `crg_tools_for_stage(stage)` (new helper in `code_review_graph.py`), calls `crg_mcp_config(repo_root, crg_data_dir, tools)` to build the inline JSON, and passes `mcp_config=<json>` to `run_agent()` at `:1255-1269`. The `repo_root` comes from `context["_project_root"]` (already available in context).
4. **Pipeline main loop** (`runner.py:2496-2504`) threads `_crg_data_dir` alongside `_graphify_out`: `run_stage(..., graphify_out=_graphify_out, crg_data_dir=_crg_data_dir)`. `_crg_data_dir` is set by CRG preflight (§7) at the same point `_graphify_out` is set (`:2789`), and reattached on resume (`:2064` pattern).

### 5. Tool governance — server-side `CRG_TOOLS` + Bash guard

**Exposure is controlled server-side**, not through worca's `--tools` channel (which only governs built-ins). Per-stage `CRG_TOOLS` allow-lists are injected into the mcp-config `env` (`code-review-graph serve --tools` / `CRG_TOOLS` filters at startup; "unlisted tools are removed").

**Hard-excluded everywhere** (mutating / code-editing / out-of-scope):

| Tool | Reason |
|---|---|
| `apply_refactor_tool` | **Edits code on disk** — violates "only guardian commits." |
| `refactor_tool` | Pairs with apply; no value without it. |
| `build_or_update_graph_tool`, `run_postprocess_tool`, `embed_graph_tool` | Mutate the DB; worca owns builds. |
| `generate_wiki_tool` | Writes files to disk. |
| `list_repos_tool`, `cross_repo_search_tool` | Multi-repo registry — out of scope v1. |
| `semantic_search_nodes_tool`, `get_docs_section_tool` | Need embeddings — deferred (v1 structural-only). |

**Default per-stage `CRG_TOOLS` map** (`stage_tools: null` → built-in):

| Stage | CRG_TOOLS |
|---|---|
| planner / coordinator | `get_architecture_overview_tool, get_minimal_context_tool, query_graph_tool, list_communities_tool` |
| implementer | `get_minimal_context_tool, get_impact_radius_tool, query_graph_tool` |
| tester | `get_impact_radius_tool, detect_changes_tool, get_affected_flows_tool` |
| reviewer | `detect_changes_tool, get_review_context_tool, get_impact_radius_tool, query_graph_tool` |
| guardian | `detect_changes_tool` |

**Bash guard generalization.** Generalize `_is_graphify_mutation` (`src/worca/hooks/guard.py:198-283`) into `_is_tool_mutation(verbs, command)` and add a CRG instance blocking mutating CLI verbs (`build`, `update`, `install`, `serve`, `register`, `unregister`, `watch`, `daemon`) — defense-in-depth in case an agent shells out to the CLI. Gated by `worca.governance.guards.block_crg_mutation` (default `true`).

**Fallback strategies if validation gates fail.** The primary plan assumes `CRG_TOOLS` filters tools server-side and `CRG_DATA_DIR`/`CRG_REPO_ROOT` redirect reads. If the Phase 2 spike (Decisions §1) reveals these are not honored:

- **If `CRG_TOOLS` is not honored by `serve`:** switch to Claude CLI `--disallowedTools` for MCP tool names. The Claude CLI names MCP tools as `mcp__<server>__<tool>` (e.g. `mcp__code-review-graph__apply_refactor_tool`). `run_stage()` would build the disallow list from the hard-excluded set (§5 table) and append it to the existing `disallowed_tools` list returned by `_resolve_tool_args()`. The `crg_mcp_config()` function drops the `CRG_TOOLS` env key. This is less precise (the agent sees the tool in its tool list but calls are rejected) but functionally equivalent for governance.
- **If `CRG_DATA_DIR` is not honored for reads:** place the run-scoped copy at CRG's default project-relative path (`<project-root>/.code-review-graph/graph.db`) instead of `<run-dir>/code-review-graph/`. The mcp-config `env` sets `CRG_REPO_ROOT` to the project root; CRG's `find_project_root()` walk-up resolves the `.code-review-graph/` directory naturally. This constrains the run-scoped DB to one-per-project-root (acceptable — parallel agents within a single run already share the run-scoped copy; cross-run isolation is handled by the flock on the `.lock` file). Worktrees are unaffected (each has its own project root).
- **If both fail:** CRG is still viable but with a thinner MCP proxy wrapper (a small Python stdio script that imports CRG's tools, filters by allow-list, and delegates). This is the most invasive fallback and would add ~50 lines to `src/worca/utils/crg_proxy.py`. Only pursued if both primary mechanisms fail.

### 6. Agent prompts — advisory `## Code graph (advisory)` + `has_code_review_graph`

**Current state:** each `src/worca/agents/core/*.md` has a static `## Knowledge graph (advisory)` section teaching `graphify query`; `.block.md` files carry a one-line note gated on `{{#if has_graphify}}`; `PromptBuilder.set_graphify_available(bool)` sets the flag (`src/worca/orchestrator/prompt_builder.py:55-64,169`).

**Resolution:** add a parallel static `## Code graph (advisory)` block to the agents that get CRG, teaching the MCP-tool idiom (e.g. "call `get_impact_radius` before editing a symbol; `detect_changes`/`get_review_context` when reviewing"), plus a `{{#if has_code_review_graph}}` availability note in `.block.md` and `PromptBuilder.set_crg_available(bool)`. Advisory posture (agents *may* call on demand). **Authority order:** `guide > plan > graph(s) > description` — unchanged. When both engines are enabled, graphify and CRG are **co-equal advisory peers** at the `graph` rung (neither outranks the other; agents pick whichever answers the question).

### 7. Preflight integration

**Current state:** `src/worca/scripts/graphify_preflight.py` runs after base preflight, never raises, returns a status dict; wired at `src/worca/orchestrator/runner.py:1516-1521`.

**Resolution:** new `src/worca/scripts/crg_preflight.py` (sibling), chained in `run_preflight` alongside graphify. Builds the base snapshot, seeds the run-scoped copy, records `crg_status` (`skipped|degraded|ready`) + `crg_data_dir` into run state. On `ready`, runner calls `prompt_builder.set_crg_available(True)` (mirror `:2708`) and threads `crg_data_dir` into `run_stage` (mirror `_graphify_out` at `:2425`), including the resume reattach path (`:1380-1396`).

### 8. Post-implement refresh + post-guardian warm

**Post-implement — injection point and semantics.** The IMPLEMENT→TEST transition in `runner.py` has two code paths:

- **Bead iteration loop** (`:3094-3144`): when more beads remain, `stage_idx` resets to IMPLEMENT via `continue` at `:3144`. **CRG refresh does NOT run between bead iterations** — the tester hasn't started, and the next implementer iteration will make further edits. Running `update` here would be wasted work.
- **All beads done** (`:3150-3153`): after the last bead (or in fix mode at `:3154`), flow falls through to `update_stage()` at `:3157` which marks IMPLEMENT completed.

The CRG refresh runs **after `update_stage()` at `:3157` and before `save_status()` at `:3158`**:

```python
# runner.py, inside the IMPLEMENT handler, after line 3157
update_stage(status, current_stage.value, **stage_extras)

# --- CRG post-implement refresh (new) ---
if _crg_data_dir and crg_cfg and crg_cfg.get("update_on", {}).get("post_implement"):
    _crg_ok = _crg_post_implement_refresh(_crg_data_dir, project_root, timeout=30)
    if not _crg_ok:
        _log("CRG post-implement refresh failed or timed out — tester proceeds with stale graph", "warn")
# --- end CRG ---

save_status(status, actual_status_path)
```

**Blocking with timeout.** The refresh is **blocking** (subprocess with 30s timeout), not fire-and-forget, because the tester needs the updated graph to provide accurate `detect_changes`/`get_impact_radius` results. On timeout or failure: log a warning, set a `crg_refresh_failed` flag in the iteration extras (surfaced in UI), and proceed — the tester runs with a stale graph rather than failing the pipeline.

**Test-failure loopback interaction.** When tester fails and the loop at `:3254` resets `stage_idx` to IMPLEMENT, the implementer runs again with a `test_failure` trigger. When *that* IMPLEMENT iteration completes, the CRG refresh fires again at the same injection point — correct behavior, as the tester should always see the latest edits from the most recent implementer pass. Each implement→test cycle gets its own refresh.

**Helper function** (`_crg_post_implement_refresh`): lives in `runner.py` near the graphify warm helpers (`:1399-1442`). Runs `CRG_REPO_ROOT=<worktree> CRG_DATA_DIR=<run-dir>/... code-review-graph update` as a subprocess, returns `True` on success. The `update` command uses git-diff change detection, so it picks up uncommitted in-flight edits.

**Post-guardian — base cache warm.** Reuse the W-053 detached-warm pattern (`runner.py:1399-1442`) to refresh the **base** cache for the new HEAD after guardian commits (`update_on.guardian_post_commit`). Fire-and-forget (detached subprocess), logged, never fails the pipeline. Skipped in worktrees (base cache is per-SHA in the shared `$WORCA_CACHE`, not per-worktree).

### 9. Worktree implication

Each worktree is its own project root — CRG's `find_project_root()` returns the worktree root (`.git` file walk-up), and `CRG_REPO_ROOT` pins it explicitly. The run-scoped writable DB lives under the run dir, so parallel worktrees never share a writable `graph.db`. Base-snapshot reuse across worktrees on the same SHA is via copy (read warm-start only).

### 10. Fleet implication

Mirror graphify's per-child handling: `run_fleet.py` honors each child's effective CRG config independently; fleet manifest records per-child `crg_status`; circuit breaker does **not** count CRG-degraded as failure.

### 11. Workspace implication

`run_workspace.py` honors per-project CRG config; each child pipeline (standard `run_worktree.py`) builds/refreshes its own run-scoped DB. No cross-project CRG sharing in v1 (the `register`/`cross_repo_search` path is out of scope).

### 12. Coexistence with graphify

Both engines may be enabled. Preflight builds both as siblings under `<base-sha>/{graphify,code-review-graph}/`. Agents receive both the graphify availability note **and** the CRG MCP tools. No either/or warning. Cost: doubled preflight build time (surfaced in UI/logs).

### 13. CLI surface

Add a `worca crg` command group (`src/worca/cli/crg_cmd.py`) mirroring `worca graphify`:

```bash
worca crg status        # effective config + detection (CRG + fastmcp) + base-snapshot state
worca crg recommend     # survey project, suggest enable/skip (min_repo_files)
worca crg enable        # write project setting
worca crg disable
worca crg rebuild       # force clean base build
```

### 14. UI — full Code Review Graph tab (mirrors shipped graphify UI)

**Current state (ground truth, resolves the W-053 §10 vs shipped discrepancy):** the graphify UI is a **Settings tab**, not a project badge. Server endpoints live at `worca-ui/server/app.js:1052-1155` (`GET /api/graphify/status`, `POST /api/graphify/{recheck,build,clear}`, `GET /api/graphify/graph.html`) backed by `worca-ui/server/graphify-status.js`. Frontend is `worca-ui/app/views/settings-graphify.js` (`graphifyTab(worca, rerender, projectId)`), registered in `worca-ui/app/views/settings.js:43` (import) and `:3486-3498` (tab + panel in the settings `sl-tab-group`). Data flow is fetch-based, polling `/api/graphify/status` every 1.5–2s while building. Run detail shows a per-iteration `graphify_invocations` badge (`worca-ui/app/views/run-detail.js:841-843`). CSS at `worca-ui/app/styles.css:6478-6515`. Tests: `settings-graphify.test.js`, `run-detail-graphify-badge.test.js`, `server/graphify-status.test.js`, `e2e/run-detail-graphify-badge.spec.js`.

**Resolution — mirror it 1:1 for CRG:**

- **Server:** new `worca-ui/server/code-review-graph-status.js` (effective-config parity with the Python `effective_crg_config`, detection caching + 60s TTL, `?project=<id>` global-mode scoping). New endpoints in `worca-ui/server/app.js`: `GET /api/crg/status`, `POST /api/crg/{recheck,build,clear}`, `GET /api/crg/graph.html` (serves CRG `visualize` D3 output; generated on build). **Extend the `files` allowlist in `worca-ui/package.json`** for the new server module (`server/**/*.js`) and `npm pack --dry-run | grep` to verify.
- **Frontend:** new `worca-ui/app/views/settings-code-review-graph.js` exporting `crgTab(worca, rerender, projectId)` with: status control (Off / Structural), `embeddings` toggle (disabled in v1 with "coming soon" hint), cache location box + copy, install notice (`pip install code-review-graph` + fastmcp floor) when missing, Build / Clear buttons, status message (building/complete/failed via polling), and an info box listing the per-stage exposed MCP tools (read-only).
- **Tab registration:** import + tab/panel in `worca-ui/app/views/settings.js` `sl-tab-group`, placed next to the Graphify tab.
- **Run detail badge:** per-iteration **CRG MCP tool-call count** badge on the effort row, parsed from the agent's stream-json tool-use events (`mcp__code-review-graph__*`), mirroring `graphify_invocations`. Requires the Python runner to count CRG tool calls per iteration into `crg_invocations` (new status field) — parallels the existing graphify invocation counter.
- **Badge/color compliance:** follow `worca-ui/docs/badge-color-language.md` (blue=active/building, green=ready, orange=caution/degraded). Watch the lit-html `<elem attr="val"${expr}>` binding gotcha — use proper attribute bindings.
- **CSS:** add `.crg-*` classes mirroring `.graphify-*` (`styles.css`).

### 15. Dependency management

- Pin `code-review-graph >=2,<3` + require `fastmcp >=3.2.4` (validated at detection).
- **Never run `code-review-graph install`** — its bundled hooks (`hooks.json`: `EnterWorktree`→`build`, `Write|Edit|Bash`→`update`) would mutate the graph mid-run, break immutability, and collide with worca's `PostToolUse` hook. worca builds directly and injects the mcp-config.
- Document install in `worca crg status` / the UI install notice; never auto-install.

## Implementation Plan

### Phase 1: Settings + detection + CLI (no behavior change)
**Files:** `src/worca/settings.json` (+`worca.code_review_graph`), `src/worca/utils/code_review_graph.py` (new), `src/worca/utils/tool_detect.py` (new, shared probe extracted from graphify), `src/worca/cli/crg_cmd.py` (new), `tests/test_crg_settings.py`, `tests/test_crg_detect.py`.
**Done:** `worca crg status` reports detection (CRG + fastmcp) with toggle off by default; never invokes CRG.

### Phase 2: Base/run-scoped cache + preflight (build only, no agent consumption)
**Files:** `src/worca/scripts/crg_preflight.py` (new), `src/worca/utils/graphify.py` (extract `snapshot_lock`/`.complete`/repo-id helpers into a shared `src/worca/utils/ast_cache.py`), `src/worca/orchestrator/runner.py` (chain CRG preflight; seed run-scoped copy), `tests/test_crg_cache.py`, `tests/test_crg_preflight.py`, `tests/mock_crg/` (stub CLI).
**Done:** preflight builds a base snapshot (mock), seeds a run-scoped copy; `enabled=false` is byte-identical to today.

### Phase 3: MCP wiring + governance + prompts
**Files:** `src/worca/utils/claude_cli.py` (`build_command` gains `mcp_config` param; `--mcp-config`/`--strict-mcp-config`), `src/worca/utils/code_review_graph.py` (`crg_mcp_config`, `crg_tools_for_stage`), `src/worca/hooks/guard.py` (generalize mutation guard + CRG verbs), `src/worca/orchestrator/runner.py` (`run_stage` gains `crg_data_dir` param; pipeline loop threads `_crg_data_dir`), `src/worca/orchestrator/prompt_builder.py` (`set_crg_available`/`has_code_review_graph`), `src/worca/agents/core/*.md` + `*.block.md` (advisory section + note), `tests/test_guard.py` (CRG verbs), `tests/test_crg_mcp_config.py`, `tests/test_prompt_builder_crg.py`.
**Signature cascade** (see §4): `build_command()` + `run_agent()` + `run_stage()` + pipeline loop — four functions gain new parameters, mirroring the `graphify_out` threading pattern.
**Gated on** validation items 1–2 (read tools emit no DML; `serve` honors `CRG_DATA_DIR`/`CRG_REPO_ROOT` for reads) — confirm before wiring. If the spike fails, apply the fallback strategy from §5 (switch to `--disallowedTools` for MCP names / default project-relative path).
**Done:** a `ready` CRG run injects the MCP server with the right per-stage `CRG_TOOLS`; mutating verbs blocked; prompts carry the availability note.

### Phase 4: Post-implement refresh + post-guardian + fleet + workspace
**Files:** `src/worca/orchestrator/runner.py` (post-implement `update`; post-guardian base warm), `src/worca/scripts/run_fleet.py` + fleet manifest (per-child `crg_status`), `src/worca/scripts/run_workspace.py` (per-project), `tests/test_post_implement_crg.py`, `tests/test_fleet_crg_per_child.py`, `tests/integration/test_crg_pipeline.py`, `tests/integration/test_crg_missing_degrades_gracefully.py`.
**Done:** reviewer/tester query a graph reflecting in-flight edits; fleet/workspace honor per-unit CRG state; missing CRG degrades gracefully.

### Phase 5: UI (full tab — mirrors graphify)
**Files:** `worca-ui/server/code-review-graph-status.js` (new), `worca-ui/server/app.js` (+5 `/api/crg/*` endpoints), `worca-ui/package.json` (`files` allowlist), `worca-ui/app/views/settings-code-review-graph.js` (new), `worca-ui/app/views/settings.js` (tab registration), `worca-ui/app/views/run-detail.js` (`crg_invocations` badge), `worca-ui/app/styles.css` (`.crg-*`), `worca-ui/app/views/settings-code-review-graph.test.js`, `worca-ui/app/views/run-detail-crg-badge.test.js`, `worca-ui/server/code-review-graph-status.test.js`, `worca-ui/e2e/run-detail-crg-badge.spec.js`.
**Done:** Settings tab writes config; build/clear/status polling work; run detail shows per-iteration CRG tool-call count; `npm pack --dry-run` includes the new server module.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/settings.json` | + `worca.code_review_graph` block |
| `src/worca/utils/code_review_graph.py` | NEW — detect + effective config + `crg_mcp_config` |
| `src/worca/utils/tool_detect.py` | NEW — shared CLI probe (extracted from graphify) |
| `src/worca/utils/ast_cache.py` | NEW — shared snapshot/lock/repo-id helpers (extracted) |
| `src/worca/scripts/crg_preflight.py` | NEW — base build + run-scoped seed |
| `src/worca/utils/claude_cli.py` | `build_command()` + `mcp_config` param; `run_agent()` + `mcp_config` param; `--mcp-config`/`--strict-mcp-config` flags |
| `src/worca/hooks/guard.py` | generalize mutation guard; + CRG verbs |
| `src/worca/orchestrator/runner.py` | `run_stage()` + `crg_data_dir` param; pipeline loop threads `_crg_data_dir`; chain CRG preflight; `_crg_post_implement_refresh` helper; post-guardian warm |
| `src/worca/orchestrator/prompt_builder.py` | + `set_crg_available`/`has_code_review_graph` |
| `src/worca/agents/core/*.md` + `*.block.md` | + `## Code graph (advisory)` + availability note |
| `src/worca/cli/crg_cmd.py` | NEW — `worca crg {status,recommend,enable,disable,rebuild}` |
| `src/worca/scripts/run_fleet.py` / `run_workspace.py` | per-unit CRG state |
| `worca-ui/server/code-review-graph-status.js` | NEW |
| `worca-ui/server/app.js` | + 5 `/api/crg/*` endpoints |
| `worca-ui/package.json` | `files` allowlist for new server module |
| `worca-ui/app/views/settings-code-review-graph.js` | NEW |
| `worca-ui/app/views/settings.js` | tab registration |
| `worca-ui/app/views/run-detail.js` | + `crg_invocations` badge |
| `worca-ui/app/styles.css` | + `.crg-*` classes |
| `tests/` + `worca-ui/**/*.test.js` + `e2e/` | NEW per phase |

## Considerations

### Governance and permissions
- **Guardian remains the only committer.** CRG's `apply_refactor`/`build`/`update` are excluded from `CRG_TOOLS` and blocked at the Bash guard.
- **MCP exposure is server-side** (`CRG_TOOLS`), not via worca's `--tools`. A new `worca.governance.guards.block_crg_mutation` (default `true`) gates the Bash guard.
- **`--strict-mcp-config`** prevents leakage of the user's other MCP servers into pipeline agents.
- Add a `worca.governance.dispatch` note that MCP tools remain out of the `--tools` channel (still true; CRG is governed by injection + `CRG_TOOLS`).

### Breaking changes
- **None.** All defaults off; existing projects inherit disabled. graphify behavior unchanged (only shared helpers are *extracted*, not altered — covered by existing graphify tests as regression guards).

### Migration
- New config keys only. The graphify→shared-util extraction (`ast_cache.py`, `tool_detect.py`) must keep `src/worca/utils/graphify.py`'s public surface intact; run the full graphify test suite as the regression gate.

### Known unknowns (validation/spike — resolve in Phase 2/3)

**Items 1–2 are BLOCKING GATES for Phase 3** — the entire MCP-read-only governance model rests on them, so they are done-criteria, not optional spikes. **Decided** (Decisions §1): clear them via a standalone spike *before* the Phase 3 build. Items 3–5 are tuning.

1. Confirm allow-listed read tools emit **no DML** under a real `serve` (CRG's `tests/test_tools.py` asserts this via `set_trace_callback` — verify for our subset). *[blocking]* **Fallback if violated:** the Bash guard (§5) already blocks CLI mutation verbs as defense-in-depth; if read MCP tools also emit DML, the run-scoped copy isolates damage to the current run (shared base is never opened by `serve`), but the graph becomes unreliable — downgrade CRG to `degraded` and emit a warning.
2. Confirm `serve` honors `CRG_DATA_DIR`/`CRG_REPO_ROOT` for **reads** (CHANGELOG: "supported by CLI, MCP tools, and registry"). *[blocking]* **Fallback if not honored:** see §5 "Fallback strategies" — place the run-scoped copy at CRG's default project-relative path (`<project-root>/.code-review-graph/`) instead of `<run-dir>/...`; CRG's `find_project_root()` resolves it naturally. If `CRG_TOOLS` is also not honored, fall back to `--disallowedTools` with `mcp__code-review-graph__<tool>` names, or (worst case) a thin MCP proxy wrapper. These fallbacks are sketched in §5 so a spike failure does not stall the feature.
3. Measure per-agent `serve` **startup latency** (`MCP_TIMEOUT`). **Decided** (Decisions §2): per-invocation stdio child; server warming deferred, revisit only if latency is prohibitive.
4. **Decided** (Decisions §3): `PRAGMA wal_checkpoint(TRUNCATE)` after build, before copying the base DB (clean single-file copy, no `-wal` side-file).
5. Confirm CRG `visualize` HTML output path for the `/api/crg/graph.html` endpoint. *(still open)*

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_detect_crg_missing` / `_version_mismatch` / `_fastmcp_too_old` | Detection states |
| Python | `test_effective_crg_global_off_kills_project` | Kill-switch semantics |
| Python | `test_crg_mcp_config_shape` | Inline JSON: stdio server + `CRG_TOOLS`/`CRG_DATA_DIR`/`CRG_REPO_ROOT` env |
| Python | `test_crg_stage_tools_map` | Per-stage allow-list; mutating tools never present |
| Python | `test_guard_blocks_crg_mutation_verbs` | `build/update/install/serve/...` blocked; reads allowed |
| Python | `test_crg_cache_base_then_runscoped_copy` | Base snapshot reused via copy; run-scoped writable |
| Python | `test_crg_preflight_degraded_on_missing` | Returns `degraded`, no failure |
| Python | `test_post_implement_refresh_updates_runscoped` | `update` runs on run-scoped DB after implement |
| JS | `settings-code-review-graph.test.js` | Tab controls, install notice, build/clear |
| JS | `run-detail-crg-badge.test.js` | Per-iteration CRG tool-call badge |

### Integration / E2E
- `tests/integration/test_crg_pipeline.py` — full pipeline, `mock_crg`; asserts base build, run-scoped seed, MCP config injected, post-implement refresh, completion.
- `tests/integration/test_crg_missing_degrades_gracefully.py` — enabled but CLI absent → one warning, byte-identical to disabled.
- `tests/integration/test_crg_and_graphify_coexist.py` — both enabled → both build under one snapshot; agents get both surfaces.
- `worca-ui/server/code-review-graph-status.test.js` — endpoint behavior + Python parity.
- `worca-ui/e2e/run-detail-crg-badge.spec.js` — badge renders for a CRG-enabled run.

### Existing Tests to Update
- `tests/test_settings.py` — include `worca.code_review_graph` defaults.
- graphify suite (`tests/test_graphify_*`) — regression guard after helper extraction (must stay green unchanged).
- `worca-ui/app/views/settings.test.js` — new tab present.

## Files to Create/Modify
See "Files Changed Summary." Estimate: ~14 new files (6 Python, 2 JS source, ~6 tests/mocks) + ~12 modified.

## Out of Scope
- **Embeddings / `semantic_search_nodes` / `embed_graph` / `get_docs_section`** — v1 is structural-only. Follow-up plan when there's a token/value case.
- **Multi-repo `register` / `cross_repo_search` / daemon** — no cross-project CRG graph in v1 (workspace runs build per-project).
- **`apply_refactor`/`refactor`** — code-editing MCP tools are permanently excluded (governance).
- **Running `code-review-graph install`** or registering CRG's bundled hooks — worca owns the integration.
- **Generic multi-tool abstraction** — v1 is a sibling integration; a unified `code_graph` engine interface is deferred (only `ast_cache.py`/`tool_detect.py` are shared).
- **Promoting CRG over graphify as primary** — both are peers; engine choice is the user's.
