# Architecture Review — June 2026

Point-in-time audit of worca-cc across four dimensions: **design**, **robustness**, **composability & modularity**, and **duplication**. Produced by a multi-agent sweep over the orchestrator, governance/hooks, events/integrations, worca-ui, and the Python↔JS boundary, with the highest-severity claims manually verified.

> **Caveats.** Line numbers are anchors as of commit `3b6bb4b7` (2026-06-10) and will drift — treat them as approximate; the structural claims were verified to hold. This doc records findings, not decisions; rationale for accepted designs lives in [`design-principles.md`](./design-principles.md).

## Overall Verdict

The architecture is **strong at the macro level and uneven at the micro level**. Subsystem boundaries (orchestrator / hooks / events / UI), the entry-script layering, and the governance model are coherent and well-documented. The two structural debts:

1. **`runner.py` is a ~5,000-line monolith** with heavily copy-pasted per-stage logic.
2. **The Python↔JS boundary duplicates ~6 logic clusters** with inconsistent sync mechanisms — some codegen'd, some test-enforced, some entirely manual.

---

## 1. Design

### Strengths

- **Pipeline state machine** — clean declarative core: `Stage` enum + explicit `TRANSITIONS` dict validated via `can_transition()` (`src/worca/orchestrator/stages.py:32-87`), with dynamic enabled-stage resolution.
- **Three-tier dispatch governance** is coherent with no bypass paths in the algorithm itself: one implementation of `check_allowed()` + `_matches_any()` (`src/worca/hooks/tracking.py:378-486`), explicit fallthrough semantics (`[]` → `_defaults`, `["none"]` lockdown sentinel), fail-closed on malformed settings (`ConfigUnreadable` → exit 2), correctly allow-all in interactive mode.
- **Event system** — well-defined envelope (`schema_version`, UUID, ISO timestamp) across ~86 typed events with one payload builder each (`src/worca/events/types.py`); explicit Tier 1/Tier 2 renderer split prevents chat noise; control webhooks cleanly modeled (separate `control: true` flag, mandatory secret, synchronous delivery at gates).
- **UI state model** — hand-rolled immutable pub-sub store with no-op detection and log-buffer coalescing (`worca-ui/app/state.js:94-228`) is a sound fit for the pure-functional lit-html layer.

### Weaknesses

- **Declarative model abandoned in the implementation**: transitions are executed via array indexing (`stage_order.index(Stage.IMPLEMENT)`, `runner.py:~3973, ~4301`), and iteration status is stringly-typed (`"interrupted"` literal at `runner.py:~3061`, `src/worca/state/status.py:158-161`) — invalid states can persist.
- **Loop semantics are implicit**: loopback triggers live in an ad-hoc `_next_trigger` dict + unvalidated `loop_counters` (`runner.py:~2672, ~3892`); plan-review's `review_and_edit` mode creates implicit agent state with no enum.
- **Event payload schema is implicit** — only the envelope is versioned; payload field semantics have no versioning or JSON Schema, so a meaning change is invisible to subscribers.
- **No central UI section registry** (known, documented) — `worca-ui/app/main.js` has 14 `route.section ===` branches in both `contentHeaderView()` and `mainContentView()`.

---

## 2. Robustness

### Strengths

- **Atomic writes everywhere it matters**: `status.json` via `mkstemp + os.replace` (`src/worca/state/status.py:94-99`); JS mirror in `worca-ui/server/atomic-write.js`.
- **Layered crash handling**: signal handler → persisted interrupted status → atexit fallback converting stale "running" (`runner.py:~711-801`); PID files + UI-side `reconcileStatus()` stale-run reaping (`worca-ui/server/process-manager.js:~182-340`).
- **Failure isolation in events**: webhook delivery is daemon-threaded with exponential backoff, per-(url, event_type) rate limiting, and never propagates into the pipeline (`src/worca/events/webhook.py:90-195`); chat adapter failures caught per-adapter.
- **WS reconnect** is solid: exponential backoff + jitter, queued sends, pending-request rejection on disconnect (`worca-ui/app/ws.js:45-144`).

### Weaknesses (by severity)

| Sev | Finding | Location |
|---|---|---|
| **High** | `prompt_builder.load_context()` silently swallows `OSError`/`JSONDecodeError` — corrupt `prompt_context.json` means stages run with missing context (e.g. `test_failures` → None) and produce silent logic errors | `src/worca/orchestrator/prompt_builder.py:142-158`, `runner.py:~2705, ~4240` |
| **High** | Multi-field status updates aren't transactional — loop counters and stage status saved in separate `save_status()` calls; a crash between them corrupts resume's loop history | `runner.py:~2907-3027` |
| **High** | `_guard_flag_enabled()` loads settings via raw `.claude/settings.json`, **not** `WORCA_SETTINGS_PATH` — graphify/CRG mutation guards can diverge from the pinned effective settings the dispatch hooks use | `src/worca/hooks/guard.py:266-284` vs `tracking.py:303-334` |
| **Med** | TOCTOU window in `_is_already_terminal()` — cross-process duplicate terminal events possible | `runner.py:~540-570` |
| **Med** | Guard string-matching brittleness: `"git commit" in command` substring (blocks `git commit-graph`; misses creative quoting), test-command list misses `vitest`/`jest`/`make test` | `guard.py:134-150` |
| **Med** | Control-webhook response parsing has no shape/action validation — malformed response silently means "continue" | `src/worca/events/emitter.py:264-268` |
| **Med** | In-place pipeline spawn resolves on a 2s timer, not actual startup — double-spawn window | `process-manager.js:~654-658` |
| **Low** | No delivery-status audit trail — webhook failures go to stderr only, never `events.jsonl` | `webhook.py` |
| **Low** | `control.json` read has no `JSONDecodeError` handling — a malformed control file crashes the reader | `src/worca/orchestrator/control.py:67-71` |

### Non-issues (claims investigated and rejected)

- **Signal-handler `json.dumps`/`uuid4`/`open()`** (`runner.py:_emit_interrupted_event_signal_safe`): flagged as a critical bug during the sweep, but the code explicitly documents the tradeoff — CPython delivers signals between bytecode ops, the event is also stashed for deferred main-thread dispatch, and all errors are swallowed by design. Residual risk is limited to non-CPython runtimes. **Documented design choice, not a defect.**
- **"Python HMAC not timing-safe"**: misdirected — `webhook.py:56` only *signs outbound* payloads (signing needs no constant-time compare); verification lives on the JS inbox side, which correctly uses `timingSafeEqual` (`worca-ui/server/integrations/verify.js:12-18`). **No issue.**
- **Pipeline-global circuit-breaker counter** (`error_classifier.py`): flagged as "failures cascade across stages," but the counter resets on *any* stage success (`record_success`) and the cross-stage escalation is explicitly documented as intentional at the retry site (`runner.py`, "repeated failures anywhere in the pipeline should escalate severity, not reset per stage"). **Documented design choice, not a defect.**

---

## 3. Composability & Modularity

### Where it's genuinely good

- **Entry-script layering is exemplary**: `run_pipeline.py` (pure entry) ← `run_worktree.py` (spawns run_pipeline in a worktree) ← `run_fleet.py` / `run_workspace.py` (orchestrate run_worktree children). Composition by process spawning, not code copying — governance and hooks are unchanged in children.
- **Governance is centralized**: one `check_allowed()`, one `_matches_any()`, one agent-role extractor (`agent_role.py`), one safe-command bypass — consumed by all hooks.
- **Chat adapters** have a clean uniform interface (`worca-ui/server/integrations/adapter.js:24-31`: name/start/stop/send/onInbound) with hot-reload (`index.js:182-206`).
- **Settings tier/template precedence** is a thought-through design (template-owned key stripping, tier pinning, atomic leaf paths) — the problem is enforcement, not design (see §4).

### Where it's weak

- **`runner.py` is the anti-modular core**: `run_pipeline()` spans roughly half of the ~5,000-line file; each stage inlines ~200-300 lines of iteration setup, context building, error handling, and completion sequencing with no stage-execution abstraction. **The single highest-leverage refactor target.**
- **UI sections cost ~5-7 manual wire-up points** (~100-150 lines spread across module state, `resetProjectState()`, route handler, header view, content view, WS handlers, init) — all in `main.js`, no lifecycle API. The `/worca-ui-add-page` skill and `worca-ui-routing-reviewer` subagent mitigate but don't fix the structure.
- **`app.js` is a route monolith**: ~50 inline routes (beads, webhooks, integrations, graphify, CRG) alongside the properly-modularized routers (project/fleet/workspace/templates/models).
- **Renderer registry is hardcoded** (`worca-ui/server/integrations/renderers.js:561-598`) with no runtime check that Tier-1 events have renderers — a new chat-notifiable event silently never reaches chat if the entry is missed (mitigated by `/worca-event-add` + `worca-event-payload-reviewer`).
- **Emitter dispatch is hardwired** — `dispatch_event()` directly imports webhook + shell-hook delivery (`emitter.py:212-242`); adding a dispatch target means editing the emitter.

---

## 4. Duplication

### Intra-Python (`runner.py`) — highest density

- **6× identical stage-completion sequence** (`complete_iteration → update_stage → save_status → emit_event → control-response check → pause handling`): `runner.py:~3655, ~3732, ~3834, ~4020, ~4205, ~4254`.
- **56+ `save_status()` call sites**, per-stage copy-pasted error handling (`~3305-3434`), iteration startup (`~3003-3027`), loop-back sequences, token-usage extraction (3 variants). Factoring `_complete_stage()` / `_handle_stage_error()` / `_loopback_to_stage()` would remove a large fraction of the file.

### Python ↔ JS clusters, ranked by risk × existing protection

| Cluster | Python | JS | Sync mechanism | Risk |
|---|---|---|---|---|
| Settings merge + precedence | `src/worca/utils/settings.py` (~300 ln) | `worca-ui/server/settings-merge.js` (~190 ln) | manual mirror | **High** — plus raw-read bypasses: `tracking.py:350-364` (known `--tools` issue), `templates-routes.js:~55`, several `project-routes.js` reads skip `readEffectiveSettings()` |
| Event-type strings (~86) | `events/types.py` | `renderers.js:561-597`, `app/views/integrations.js:15-31` | **none** | **High** — silent non-rendering on drift |
| Reserved env keys | `utils/env.py:26-39` | `server/reserved-env-keys.json` | test-enforced (`tests/test_filter_model_env.py:101-119`) but two hand-maintained copies | Med |
| Atomic leaf paths | `settings.py:44-47` | `settings-merge.js:90-93` | comment link only | Med |
| Dispatch defaults | `tracking.py:18-84` | `server/dispatch-defaults.js:9-75` | ✅ **test-enforced** — `tests/test_denylist_sync.py` covers all three sections + agent roster + migration parity | Low |
| Status constants | `state/status.py` | `app/utils/status-constants.js` | ✅ **codegen at every build** (`worca-ui/scripts/build-frontend.js:64-116`) — the model to copy | None |

### Other clusters

- **Markdown rendering ×6**: Slack/Discord/Telegram adapters each render `msg.body[].kind`, and `webhook_out.js:14-74` re-implements all three again. Plus 3 independent backoff arrays.
- **Card views**: ~150-170 extractable lines across run/fleet/workspace cards — duplicated `_formatCost()`, 4 separate status→variant maps with no single source.
- **Agent .md templates**: shared sections copy-pasted across the ~21 files in `src/worca/agents/core/` (correction: the files are 88–186 *lines* each, not the thousands originally reported — that figure was byte counts). The concrete verbatim duplication: the graphify orientation section (×9 agent files), the graphify reminder note (×9 stage blocks), and the CRG reminder note (×9 stage blocks). A `{{block:name}}` include mechanism already exists (`overlay.py`) but had zero core usages.
- **83+ raw `subprocess.run` sites** with inconsistent capture/strip/raise conventions.

---

## Remediation status (2026-06-10)

Addressed on branch `fix/architecture-review-2026-06`:

- **All 10 severity-table findings**: prompt_context fail-loud; transactional gate sequences via extracted helpers; `guard.py` pinned to `WORCA_SETTINGS_PATH`; terminal-transition TOCTOU closed with an atomic `O_CREAT|O_EXCL` claim marker; boundary-aware `git commit` / test-runner detection; control-webhook response validation; resume double-spawn guard (PID liveness + in-flight set); webhook delivery audit trail (`webhook-deliveries.jsonl`); `control.json` parse errors discarded instead of fatal.
- **Sync/duplication**: reserved-env-keys single-sourced (`src/worca/schemas/reserved_env_keys.json` → Python via importlib.resources, JS via build copy); app Tier-1 event list codegen'd from the renderer registry (caught a real drift: `pipeline.run.cancelled` had no renderer); event-type↔renderer parity test (`tests/test_event_types_sync.py`); shared `formatCost`; shared chat-adapter segment renderer (`render-segments.js`, 6 copies → 1); agent .md graphify/CRG sections single-sourced via `{{block:...}}` with a byte-identical render proof (and a nested-block resolution fix in the runner's stage-prompt path that the dedup surfaced).
- **runner.py**: 15 copy-pasted emit→control-gate blocks replaced by `_emit_stage_completed_and_gate` / `_emit_milestone_and_gate` / `_emit_loop_triggered_and_gate`. The error handling and iteration startup turned out to already be centralized (the audit overstated those). The remaining recommendation — a full stage-executor decomposition of the main loop — is a W-NNN-scale refactor and was deliberately **not** attempted here.

## Top 5 Recommendations (by leverage)

1. **Decompose `runner.py`'s stage loop** — extract `_complete_stage()`, `_handle_stage_error()`, `_prepare_stage_prompt()`, `_loopback_to_stage()`. Kills the largest duplication cluster *and* the atomicity gaps it hides (one function = one place to make multi-field saves transactional).
2. **Extend the `status-constants.js` codegen pattern** to event-type names and reserved-env-keys (single source of truth). It's already proven in the build; the high-risk clusters are exactly the ones without it.
3. **Pin `guard.py` to `WORCA_SETTINGS_PATH`** via `tracking.py:_settings_path()` — closes the only real governance enforcement gap found, and aligns with the known raw-settings `--tools` resolution issue.
4. **Fail loudly on corrupt `prompt_context.json`** (`prompt_builder.py:142-158`) and add `JSONDecodeError` handling to `control.py:67-71` — the two cheapest robustness wins.
5. **Validate control-webhook responses and audit webhook delivery** — malformed control responses silently mean "continue", and delivery failures leave no per-run trail.
