# Fleet Events: Webhooks + Chat Integrations

> Proposal for surfacing fleet-run lifecycle through the same delivery
> channels that already carry pipeline events. Targets parity with
> pipeline observability while preserving fleet semantics (one fleet = N
> pipelines fanned across repos with shared circuit-breaker rules).

## Today's surface area

### Pipeline events (existing, shipped)
- Defined in `src/worca/events/types.py`
- Naming: `pipeline.<area>.<verb>` (40+ event types)
- Emitted in-process from `runner.py` via `emit_event(ctx, TYPE, payload)`
- Persisted to `events.jsonl` per run + dispatched to webhooks + chat adapters

### Fleet observability today (gaps)
- Manifests at `~/.worca/fleet-runs/<fleet_id>.json` — append-only on disk
- WS `fleet-update` event broadcast when a manifest changes — UI-only
- **No webhook events** — external systems can't subscribe
- **No chat events** — Slack / Discord / Telegram users can't be notified
- **No chat commands** — fleets are invisible from chat
- Per-child runs DO emit pipeline events, but consumers can't reconstruct
  the fleet view without joining N streams by `fleet_id` themselves

## Part 1 — Webhooks

### Goal

Deliver `fleet.*` events with the same vocabulary, signing, and delivery
guarantees as `pipeline.*` events, so a single webhook subscriber can
reason about both single and fleet runs.

### Naming convention

Mirror the pipeline naming exactly: `fleet.<area>.<verb>`. This keeps
the fnmatch filter patterns symmetric (`fleet.*` mirrors `pipeline.*`).

| Event type | When | Payload essentials |
|---|---|---|
| `fleet.run.started`         | Manifest written, before dispatch | `fleet_id`, `work_request`, `targets[]`, `max_parallel`, `head_template`, `base_branch`, `plan_mode`, `guide.bytes`, `created_at` |
| `fleet.targets.checked`     | Readiness check completed | `fleet_id`, `ready[]`, `unready[{project, reason}]`, `aborted: bool` |
| `fleet.plan_first.started`  | Reference child dispatched (only if `--plan-first`) | `fleet_id`, `reference_project`, `reference_run_id` |
| `fleet.plan_first.completed`| Shared plan extracted | `fleet_id`, `shared_plan_path`, `duration_ms` |
| `fleet.plan_first.failed`   | Reference Planner failed | `fleet_id`, `reason` |
| `fleet.child.dispatched`    | Each child's `run_worktree.py` exits ok | `fleet_id`, `project_path`, `run_id`, `worktree_path`, `head_branch` |
| `fleet.child.failed_to_dispatch` | `run_worktree.py` exits non-zero | `fleet_id`, `project_path`, `exit_code`, `stderr_tail` |
| `fleet.child.completed`     | Child pipeline finishes (any terminal state) | `fleet_id`, `run_id`, `project_path`, `pipeline_status`, `duration_ms`, `cost_usd`, `pr_url?` |
| `fleet.progress`            | Throttled aggregate snapshot | `fleet_id`, `total`, `completed`, `failed`, `running`, `paused`, `pending`, `cost_usd_running` |
| `fleet.circuit_breaker.tripped` | Failure ratio crossed threshold | `fleet_id`, `failed_count`, `terminal_count`, `threshold`, `unstarted_count` |
| `fleet.halted`              | User halt OR readiness-check abort OR plan-first failure | `fleet_id`, `halt_reason`, `halted_at`, `failed_count`, `total_count` |
| `fleet.resumed`             | `--resume` re-launches failed/pending children | `fleet_id`, `relaunched_count`, `unrecoverable_count` |
| `fleet.run.completed`       | All children terminal AND none failed beyond threshold | `fleet_id`, `total`, `completed`, `failed`, `cost_usd`, `duration_ms` |
| `fleet.run.failed`          | All children terminal AND fleet-level failure | `fleet_id`, same shape, plus `halt_reason` |

### Ordering guarantee

Events for a single fleet must be delivered **in causal order** to the
extent that `pipeline.*` events already are (per-run JSONL append +
queued webhook delivery). Fleet event publisher must:

1. Emit synchronously from the dispatcher process (`run_fleet.py`), not
   from the per-child processes — that keeps a single emit_order.
2. Tag every fleet event with a monotonic `seq` field
   (`fleet_id` + `seq` is unique). Webhook receivers can detect
   out-of-order or dropped events.
3. **Per-child** events that the dispatcher learns about (start, exit)
   are emitted by the dispatcher; the child's *own* `pipeline.*` events
   continue to fire from inside the child process, carrying both
   `run_id` AND `fleet_id` so a downstream system can join.

The full ordered stream for a healthy 3-child fleet:
```
fleet.run.started               seq=0
fleet.targets.checked           seq=1
fleet.child.dispatched (a)      seq=2
fleet.child.dispatched (b)      seq=3
fleet.child.dispatched (c)      seq=4
  pipeline.run.started (a)        ← fired by child a
  pipeline.stage.started (a)
  ...
  pipeline.run.completed (a)
fleet.child.completed (a)       seq=5
fleet.progress                  seq=6   (throttled)
  pipeline.run.completed (b)
fleet.child.completed (b)       seq=7
  pipeline.run.completed (c)
fleet.child.completed (c)       seq=8
fleet.run.completed             seq=9
```

### Payload schema

Top-level envelope reuses the existing webhook envelope; only the
`event_type` namespace and `payload` shape change. New common payload
fields:

```json
{
  "event_type": "fleet.child.completed",
  "fleet_id": "f_202605131248_abcdef01",
  "fleet_id_short": "abcdef01",
  "seq": 5,
  "timestamp": "2026-05-13T12:50:32.451Z",
  "payload": {
    "run_id": "20260513-125012-001-abc1",
    "project_path": "/repos/repo-a",
    "pipeline_status": "completed",
    "duration_ms": 184_512,
    "cost_usd": 1.27,
    "pr_url": "https://github.com/org/repo-a/pull/42"
  }
}
```

### Filtering

Existing fnmatch filters extend naturally. Examples:

| Pattern | Matches |
|---|---|
| `fleet.*` | All fleet events |
| `fleet.run.*` | Fleet lifecycle only (start/complete/fail/halt) |
| `fleet.child.*` | Per-child dispatch + completion |
| `fleet.run.failed,fleet.circuit_breaker.tripped` | Operator paging |
| `fleet.*,pipeline.run.*` | Fleet roll-up + per-run start/end |

### Rate limiting

`fleet.progress` is the noisy one. Recommend default rate-limit of
30 seconds between deliveries per `(webhook_url, fleet_id)` pair, with
an "always deliver on terminal state change" override (so the last
progress snapshot always lands even if rate-limited).

### Implementation outline

1. **New file** `src/worca/events/fleet_types.py`: constants for the 14
   event types.
2. **New file** `src/worca/events/fleet_payloads.py`: helpers
   `fleet_run_started_payload(...)`, `fleet_child_completed_payload(...)`,
   etc. — same shape as the existing `*_payload()` helpers.
3. **New file** `src/worca/events/fleet_emitter.py`: `emit_fleet_event(
   fleet_id, event_type, payload, *, manifest_dir=...)` that:
   - Bumps a per-fleet seq counter (lock-protected)
   - Writes to `~/.worca/fleet-runs/<fleet_id>/events.jsonl` (mirrors
     per-run events.jsonl)
   - Dispatches via the existing `dispatch_event()` so webhooks AND chat
     adapters fire from one path
4. **Wire-up** in `run_fleet.py`: call `emit_fleet_event()` at every
   transition (after manifest write, after readiness check, after each
   spawn, on poll completion, on circuit-breaker trip, on halt/resume).
5. **Per-child enrichment**: when child runs fire `pipeline.run.*`
   events, attach `fleet_id` + `fleet_run_seq` if the child was
   spawned with `WORCA_FLEET_ID` env var. Already half-done — the
   registry entry carries `fleet_id`; just need to inject into the
   event ctx.
6. **Tests**: extend `tests/test_webhook.py` with fleet-event filter
   patterns and fleet payload roundtrip.

### Settings (deltas to `worca.events.webhooks[]`)

No schema changes. The same `event_filter: ["fleet.run.*"]` config
already accepted by `_matches_filter` works unchanged. The only operator
guidance to add is which patterns are sensible (covered in `events.md`).

---

## Part 2 — Chat Integrations

Chat is more about *useful* than *exhaustive*. Pipeline integrations
already proactively push the most actionable events (started / failed /
completed / paused). Fleets need the same, plus a couple of fleet-only
signals.

### Proactive pushes (fleet → chat)

| Event | Push? | Rationale |
|---|---|---|
| `fleet.run.started` | ✅ | "I started a 3-repo migration" — operator wants confirmation |
| `fleet.targets.checked` (with unready) | ✅ | Aborts are silent failures otherwise |
| `fleet.circuit_breaker.tripped` | ✅ | Loud signal: "stop everything, look at me" |
| `fleet.halted` (halt_reason != user) | ✅ | Auto-halts surface as alerts |
| `fleet.run.completed` | ✅ | Roll-up summary the operator was waiting for |
| `fleet.run.failed` | ✅ | Same |
| `fleet.child.dispatched` | ❌ | Noisy at scale (10+ repos) — covered by /status |
| `fleet.child.completed` | ❌ | Same — N×3 messages per fleet drowns the channel |
| `fleet.progress` | ❌ | Polled via /status, not pushed |
| `fleet.plan_first.completed` | ⚠ Optional | Useful when plan-first is slow; default off |

Push throttling: two `fleet.*` notifications in <30s for the same fleet
collapse into one "Fleet xyz: 2 events" digest, expandable via the link
to the fleet detail page.

Notification format (Slack/Discord/Telegram-friendly markdown):

```
🚀 Fleet started: Migrate to v2 API
   ID: f_…abcdef01 · 3 projects · plan: shared
   Repos: repo-a, repo-b, repo-c
   ↗ http://localhost:3400/#/fleet-runs/f_202605131248_abcdef01
```

```
🛑 Fleet halted (circuit breaker): Migrate to v2 API
   2 of 3 projects failed (threshold 30%)
   Failed: repo-a, repo-b · Pending: 0 · Running: 1 (will finish naturally)
   ↗ http://localhost:3400/#/fleet-runs/f_202605131248_abcdef01
```

```
✅ Fleet completed: Migrate to v2 API
   3/3 projects · 22m 14s · $4.81
   PRs: org/repo-a#42, org/repo-b#17, org/repo-c#88
   ↗ http://localhost:3400/#/fleet-runs/f_202605131248_abcdef01
```

### New chat commands

Add to `worca-ui/server/integrations/commands/global.js`:

| Command | Output |
|---|---|
| `/fleets` | List active + recent halted fleets across all projects (the chat-equivalent of the dashboard's Active section) |
| `/fleet [fleet_id_short]` | One-fleet status: title, projects N/M completed/failed, cost, PR roll-up. Resolves `*xyz` suffix shorthand like the existing `/status *2db5`. |
| `/fleet-cost [fleet_id_short]` | Cost across all children, per-project breakdown |
| `/fleet-resume [fleet_id_short]` | Trigger fleet resume — equivalent to clicking the Resume button. Confirm step required. |
| `/fleet-halt [fleet_id_short]` | Trigger fleet halt — same confirm flow as `/stop` for a single run |

`/fleets` example output:

```
Fleets:

🟢 f_…abcdef01 — Migrate to v2 API
   2/3 completed · 1 running · 3 projects · 18m elapsed
   Last: completed repo-b 4m ago

🟡 f_…b008265c — Apply auth changes (halted: user, 2h ago)
   1/3 completed · 1 failed · 1 pending · resume available
```

`/fleet f_…abcdef01` example output:

```
Fleet: Migrate to v2 API
ID: f_202605131248_abcdef01
Status: 🟢 running · started 18m ago · 3 projects

Projects:
  ✅ repo-a — completed · $1.27 · PR #42
  🟢 repo-b — running, stage=test, iter 2 · 4m elapsed
  🔴 repo-c — failed at review · $2.04

Aggregate: $3.31 · circuit-breaker 33% (1/3 failed → at threshold)
↗ http://localhost:3400/#/fleet-runs/f_202605131248_abcdef01
```

### Existing commands to enrich with fleet info

Where pipeline commands list runs, augment with a `Fleet:` line so users
can tell which runs are fleet members at a glance. Mostly small text
additions:

| Command | Today's output | Add |
|---|---|---|
| `/active` | "Run: …, Project:, Title:, Stage:, Duration:" | Add `Fleet: f_…abcdef01 (2/3 done)` line when `run.fleet_id` is set |
| `/runs [N]` | Recent runs list | Same — append fleet pointer per-row |
| `/last` | Most recent run details | Add fleet pointer + link to fleet page |
| `/status [run_id]` | Single-run status | Add fleet pointer + "/fleet" command hint |
| `/cost [run_id]` | Cost for a single run | When run has fleet_id, add a "Fleet aggregate cost: $X — see /fleet-cost" footer |
| `/help` | List of commands | Append the new `/fleet*` commands with one-line descriptions |
| `/whoami` | Chat ID, active project, mute state | Add `Active fleet: f_…abcdef01` when `chatContext` carries one (see below) |

### Chat context for fleets

Mirror the per-chat `active_project` mechanism with an `active_fleet`
slot. `/use-fleet f_…abcdef01` (or auto-set when `/fleet` is invoked
with an explicit id) sets it; subsequent `/fleet`, `/fleet-cost`,
`/fleet-resume`, `/fleet-halt` commands without an id resolve to it.
Same UX as `active_project` for individual pipelines.

### Permissions / control gates

`/fleet-halt` and `/fleet-resume` are destructive. Apply the same
allowlist + confirm flow that `/stop` already uses (allowlist.js gates
`pipeline.control.*` events; we extend with `fleet.control.halt` and
`fleet.control.resume`).

### Adapter-specific considerations

- **Slack**: link unfurls — use the fleet detail URL so Slack expands
  to a card. Already supported by the existing renderer.
- **Discord**: embed colour by status — green completed, red failed,
  orange halted (matches the badge color guide).
- **Telegram**: max message length 4096 chars. `/fleets` with 50+
  fleets needs paging — reuse the existing `[N]` cap pattern from
  `/runs`.

---

## Migration / rollout order

1. **Phase 1 (server-side events)** — implement `fleet_emitter.py` +
   wire `run_fleet.py`. Webhooks light up immediately for
   subscribers using `event_filter: ["fleet.*"]`. No client changes.
2. **Phase 2 (chat enrichment)** — add `Fleet:` line to `/active`,
   `/runs`, `/status`, `/last`, `/cost` outputs. Trivial string edits;
   regression risk near zero.
3. **Phase 3 (new chat commands)** — `/fleets`, `/fleet`, `/fleet-cost`.
   Read-only, no allowlist gating needed.
4. **Phase 4 (control commands)** — `/fleet-halt`, `/fleet-resume`,
   `chatContext.active_fleet` slot. Requires allowlist updates +
   confirm dialogs in adapters.
5. **Phase 5 (pushed notifications)** — wire the proactive 5 events
   listed above through the chat adapters' renderers. Default-on for
   subscribed channels, with a `/mute fleet` shortcut to silence just
   fleet pushes while keeping pipeline pushes.

Each phase ships independently. Webhooks are the highest-leverage
phase because external automation (CI dashboards, on-call paging,
audit logs) can light up on day one without UI changes.

## Out of scope (for now)

- Per-child cost rollup published as a separate `fleet.cost.*` event —
  defer until a real budget-warning use case exists.
- Slack interactive buttons (Halt / Resume from inline message) —
  needs OAuth flow, defer to a follow-up.
- Webhook delivery retries with exponential backoff specific to fleet
  events — reuse the existing pipeline retry policy.
