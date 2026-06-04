# W-065: Deferrable PR Creation with Manual Promote-from-UI

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-06-04
**Depends on:** None

## Problem

When iterating on a pipeline template's prompts, parameters, or model choices, every run that reaches the guardian stage opens a real GitHub PR via `src/worca/agents/core/guardian.md:51` (`gh pr create …`). Across N iterations on the same work request that produces N noisy PRs — most of which are throwaways that have to be closed by hand. There's currently no first-class way to say "commit + push the work, but don't open the PR until I explicitly ask."

The deferral *mechanism* already exists: `WORCA_DEFER_PR=1` (set today only by `src/worca/workspace/dag_executor.py:99` for workspace children) flips guardian into a "commit + push, no `gh pr create`" branch via `src/worca/orchestrator/guardian_context.py:59-66` and `src/worca/agents/core/guardian.md:19-31`. The orchestrator (`src/worca/orchestrator/runner.py:1287-1288`) swaps to `src/worca/schemas/pr-deferred.json` and skips PR-URL verification. But this is plumbed exclusively as an internal contract between the workspace parent and its children — there is no template-level or user-level toggle, and no way to *resume* PR creation later from outside a workspace flow.

Two user-facing impacts:

1. **Iteration on templates costs PR noise.** A dev tuning a prompt either disables the PR stage entirely (loses the commit + push, governance blocks manual git commit, work stays uncommitted in the worktree) or accepts the spam.
2. **No "promote to PR" affordance.** Even if the user *did* configure deferral via env var, there is no CLI command or UI button to later open the PR for a deferred run — the workspace orchestrator does it inline in its own state machine.

## Proposal

Expose the existing deferral mechanism as a template-level config toggle, extend the deferred contract so guardian also stashes the PR title/body/base for later use, and add a UI button that triggers a new `worca pr create <run-id>` CLI command which opens the PR (or reconciles to an existing one) and writes the result back to `status.json`.

- **Toggle:** `worca.stages.pr.defer: true` (default false). Runner translates to `WORCA_DEFER_PR=1` in guardian's subprocess env.
- **Schema extension:** `pr-deferred.json` requires `pr_title`, `pr_body`, and `base_branch` on `outcome: success`. Guardian composes them in the `{{#if defer_pr}}` branch (same logic that lives in the non-deferred branch today, terminal action is stash instead of ship). Workspace deferred path updated to produce these fields too — single source of truth.
- **UI:** When a run reaches `done` with `pr_deferred: true`, the run-detail PR section shows an orange "deferred" badge and a "Create PR" action button. Click → `POST /api/projects/:project/runs/:id/pr` → server shells `worca pr create <run-id>` → idempotent reconcile via `gh pr list --head <branch>` → `gh pr create` if absent → result written back to `status.json`.
- **Events:** New `pipeline.git.pr_deferred` fires when run reaches `done` deferred; existing `pipeline.git.pr_created` fires on button-click success.

## Design

### 1. Config toggle and runner translation

**Current state:** `src/worca/orchestrator/guardian_context.py:59-66` (`compute_defer_pr`) reads `WORCA_DEFER_PR` directly from the subprocess env. The only producer of that env var is `src/worca/workspace/dag_executor.py:99`. There is no project-config or template-config key that influences it.

**Obstacle:** Templates set things via `worca.stages.*` and `worca.agents.*` config blocks. There's no seam today for a stage to inject env vars into its agent's subprocess based on stage config.

**Resolution:** Add `worca.stages.pr.defer: bool` (default `false`). In `src/worca/orchestrator/runner.py` where the PR-stage subprocess env is built (immediately before `_render_agent_templates` consumes `build_guardian_context`), translate the config to the env var:

```python
# src/worca/orchestrator/runner.py — PR stage dispatch
pr_stage_cfg = config.get("stages", {}).get("pr", {})
if pr_stage_cfg.get("defer") is True and not subprocess_env.get("WORCA_DEFER_PR"):
    subprocess_env["WORCA_DEFER_PR"] = "1"
```

The `not …` guard preserves the workspace path: `dag_executor.py:99` already set the env var explicitly for its children, and we don't want to silently override it (`stages.pr.defer: false` in a child's template config should NOT undo the workspace deferral). The two producers compose monotonically — either one says "defer" and we defer.

**Schema validation.** Document the new key in `docs/configuration-precedence.md` and CLAUDE.md's "Configuration" section (the `Template-driven keys` list includes `worca.stages` already — no change needed there).

### 2. Schema extension: `pr-deferred.json`

**Current state:** `src/worca/schemas/pr-deferred.json` requires `outcome`, and on `outcome: success` adds `deferred` and `commit_sha`. `source_branch` / `target_branch` / `provider` / `review_status` are all optional.

**Obstacle:** With deferral now controllable by users, the click-time PR creation needs the title and body that guardian would have composed at PR-creation time. Today nothing is stashed — the workspace parent composes its own title/body when it eventually opens the linked PR. For standalone deferred runs (the new case), there is no parent to fall back on.

**Resolution:** Extend `pr-deferred.json` so `outcome: success` also requires `pr_title`, `pr_body`, and `base_branch`. Three required string fields; no schema-shape change beyond the `then.required` list:

```json
{
  "if":   { "properties": { "outcome": { "const": "success" } } },
  "then": {
    "required": [
      "deferred",
      "commit_sha",
      "pr_title",
      "pr_body",
      "base_branch"
    ]
  }
}
```

`base_branch` is logically equivalent to the existing `target_branch` field, but the click-time CLI needs an unambiguous answer. Using a separate field name avoids overloading `target_branch`, which has a different meaning in the non-deferred case (where it's optional and serves as a hint, not the authoritative base for `gh pr create`). Alternative: alias `target_branch` and require it; pick whichever causes less churn in existing callers — TBD during implementation.

Workspace deferred path (`dag_executor.py:99`'s children) updated to produce these fields too. Workspace parent's own PR-creation code remains free to override them — but the *child* now always produces a self-contained record, so the deferral contract has a single shape regardless of consumer.

### 3. Guardian.md template change

**Current state:** `src/worca/agents/core/guardian.md:33-51` (the `{{else}}` branch) contains the title and body composition prose: read `target_branch` from `status.json`, derive title from work request, prepend prefix, build body from work request + approach summary, append `pr_footer`. The `{{#if defer_pr}}` branch (`:19-31`) skips all of that and returns only `commit_sha`.

**Obstacle:** With the new schema, deferred guardian must also compose `pr_title`, `pr_body`, and `base_branch` — the same content the non-deferred branch composes — but its terminal action is `stash`, not `gh pr create`.

**Resolution:** Move the composition prose into a shared "Step 2" block that runs in both branches. The branches differ only in their terminal step:

```markdown
### Step 2 — Compose PR title and body

Derive the PR title from the work request. Prepend `{{pr_title_prefix}}` verbatim
with a single space; if the prefix is empty, use the derived title alone.
Read `target_branch` from `status.json` and use it as the base branch (fall back
to the project's default base branch from settings if unset).
Build the PR body from the work request and approach summary. If `{{pr_footer}}`
is non-empty, append it verbatim.

{{#if defer_pr}}
### Step 3 — Stash, do not open
PR creation is deferred. Do not call `gh pr create`. Return:
  outcome: "success"
  deferred: true
  commit_sha: "<short or full SHA>"
  pr_title: "<composed title>"
  pr_body: "<composed body>"
  base_branch: "<resolved base branch>"
{{else}}
### Step 3 — Open the PR
Run: `gh pr create --base <base_branch> --head <head_branch> \
  --title "<prefixed_title>" --body "<body>"`
{{/if}}
```

### 4. CLI: `worca pr create <run-id>`

**Current state:** `src/worca/cli/` ships `init.py`, `run_pipeline.py`, `workspace.py`, `templates.py`, `cleanup.py`, `control.py`, plus graphify/crg helpers. No existing CLI command opens or manipulates PRs.

**Resolution:** New module `src/worca/cli/pr.py` registered in `src/worca/cli/main.py` as the `pr` sub-command group with `create` as its first verb (room for future verbs like `worca pr status <run-id>` if needed).

```
worca pr create <run-id> [--project <path>] [--dry-run]
```

Algorithm:

1. Resolve the run's worktree path and `status.json` from the run-id (use existing helpers in `worca.state` — the same way `worca cleanup --run-id` resolves it).
2. Load `status.json`. Read the PR stage output. Validate `deferred: true` and presence of `pr_title` / `pr_body` / `base_branch` / `head_branch`. If `pr_url` is already set, print it and exit 0 (idempotent no-op).
3. Inspect `status.pr_creation` lock block. If `state == "in_progress"` and the lock is younger than the stale threshold (default: 5 minutes), exit 1 with a clear "PR creation already in progress (started at X)" message. If older, treat as stale and proceed.
4. **Ground-truth reconcile.** Run `gh pr list --head <head_branch> --json number,url --limit 1` from the worktree. If a PR already exists for this branch (manual creation, prior attempt that succeeded but failed to write back), capture the URL.
5. If no PR exists, claim the lock by writing `status.pr_creation = { state: "in_progress", started_at: <iso8601> }`, then run `gh pr create --base <base_branch> --head <head_branch> --title "<pr_title>" --body "<pr_body>"` from the worktree. Parse the URL from stdout.
6. On success, write `status.pr_creation = { state: "done", started_at, completed_at: <iso8601>, pr_url: <url> }` AND set the top-level `status.pr_url` so the existing UI render path (`worca-ui/app/views/run-detail.js:1009,1066,1684`) shows the link.
7. On failure (`gh` exit non-zero), write `status.pr_creation = { state: "failed", started_at, completed_at, error: <stderr> }`. Exit non-zero with the error.
8. Fire the `pipeline.git.pr_created` event with the same payload shape the guardian-success path uses today.

**Governance.** The CLI runs outside any agent subprocess, so the pre_tool_use commit hook does not apply (it gates Claude tool calls, not direct process spawns). `git push` is not gated. `gh pr create` is not gated. No new governance surface.

### 5. UI server endpoint and run-detail button

**Current state:** `worca-ui/server/app.js` defines an Express app with project-scoped routes like `/api/projects/:project/runs/:run_id/plan`. `worca-ui/app/views/run-detail.js` renders the run, reading `pr?.url || run?.pr_url` at lines 1009 / 1066 / 1684 to show the PR link in the PR section.

**Obstacle:** No endpoint exposes "open the PR for a deferred run." Run-detail has no concept of "deferred" — when `pr_url` is empty, the section either shows nothing or shows in-progress iterations.

**Resolution.**

**Server (`worca-ui/server/app.js`):**

```js
const inFlightPrCreation = new Map(); // key: `${project}/${runId}` -> Promise

app.post('/api/projects/:project/runs/:runId/pr', async (req, res) => {
  const key = `${req.params.project}/${req.params.runId}`;
  if (inFlightPrCreation.has(key)) {
    return res.status(409).json({ error: 'pr_creation_in_progress' });
  }
  const work = (async () => {
    // spawn `worca pr create <runId>` with --project <projectPath>
    // capture stdout/stderr, await exit
    // read updated status.json, return { pr_url } or { error }
  })();
  inFlightPrCreation.set(key, work);
  try {
    const result = await work;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    inFlightPrCreation.delete(key);
  }
});
```

The in-process `Map` guard handles two near-simultaneous clicks. The CLI's `status.json` lock handles concurrent-process races (in practice unlikely, but cheap to include).

**UI (`worca-ui/app/views/run-detail.js`):**

In the PR section, when `run.pr_deferred === true` and `!run.pr_url`:

- Render an orange `sl-badge` with text "deferred" (orange per `worca-ui/docs/badge-color-language.md` — caution / action required).
- Render an `action-btn action-btn--primary` "Create PR" button. On click: disable, show inline spinner, `fetch('/api/projects/.../runs/.../pr', { method: 'POST' })`. On success: re-render with `pr_url` populated (existing render path takes over). On error: inline error text, re-enable button.
- If `status.pr_creation?.state === 'in_progress'`, show button in disabled "Creating PR…" state with elapsed-time text.
- If `status.pr_creation?.state === 'failed'`, show inline error with the recorded stderr message and a "Retry" button (re-POSTs the same endpoint).

**Where `pr_deferred` comes from.** Lifted from stage output to the run level: in `src/worca/orchestrator/runner.py` (the same block that consumes stage output around line 4075-4111), when the PR stage's `stage_output.deferred is True`, set `status.pr_deferred = True` so the UI can read it from a single top-level field.

### 6. Events

**Current state:** `src/worca/events/types.py:58` defines `GIT_PR_CREATED = "pipeline.git.pr_created"`. No deferred event exists.

**Resolution:** Add `GIT_PR_DEFERRED = "pipeline.git.pr_deferred"` to `src/worca/events/types.py`. Payload builder mirrors `GIT_PR_CREATED`'s shape minus `pr_url` / `pr_number`, plus the stashed `pr_title`, `base_branch`, `head_branch`, `commit_sha`.

- Fires when the run reaches `done` with `pr_deferred: true` (in the same orchestrator block that sets `status.pr_deferred`).
- `GIT_PR_CREATED` fires from the new CLI on button-click success, with the same payload shape it fires with today from guardian.

Tier 1? `GIT_PR_CREATED` today is Tier 1 (renders to chat via `worca-ui/server/integrations/renderers.js`). `GIT_PR_DEFERRED` should be Tier 1 too — it's a "your attention is needed" event, which is exactly what chat notifications are for. Renderer text: `"PR deferred for run <id> — branch <head_branch> pushed; open <run url> and click Create PR to publish."`

## Implementation Plan

### Phase 1: Schema + guardian.md + runner translation (Python only)

**Files:**
- `src/worca/schemas/pr-deferred.json`
- `src/worca/agents/core/guardian.md`
- `src/worca/orchestrator/guardian_context.py` (no change expected — `compute_defer_pr` already does the right thing)
- `src/worca/orchestrator/runner.py`
- `src/worca/workspace/dag_executor.py` (update to produce new schema fields if it constructs stage_output anywhere — TBD; may need only to validate that workspace children's guardian renders the same updated prompt)

**Tasks:**
1. Add `pr_title`, `pr_body`, `base_branch` to `pr-deferred.json` `then.required`.
2. Restructure `guardian.md`: move title/body composition into shared Step 2; split Step 3 by `{{#if defer_pr}}` (stash) vs `{{else}}` (open).
3. In `runner.py` PR stage env build, translate `worca.stages.pr.defer: true` → `WORCA_DEFER_PR=1` (preserve existing value when set by `dag_executor.py`).
4. In `runner.py` stage-output consumer block, lift `stage_output.deferred` to `status.pr_deferred`.

### Phase 2: `worca pr create` CLI

**Files:**
- `src/worca/cli/pr.py` (new)
- `src/worca/cli/main.py` (register sub-command)
- `src/worca/state/__init__.py` or equivalent (small helper if needed for `pr_creation` lock read/write)

**Tasks:**
1. New CLI module with the algorithm from Design §4.
2. Wire `gh pr list --head <branch>` reconciliation.
3. Wire `gh pr create` + stdout URL parse.
4. Write `pr_creation` lock block and top-level `pr_url` to `status.json`.
5. Emit `pipeline.git.pr_created` event with existing payload shape.

### Phase 3: UI server endpoint + run-detail view

**Files:**
- `worca-ui/server/app.js`
- `worca-ui/app/views/run-detail.js`
- `worca-ui/app/views/run-detail.test.js`

**Tasks:**
1. New `POST /api/projects/:project/runs/:run_id/pr` endpoint with in-process mutex.
2. Endpoint spawns `worca pr create <run-id> --project <path>`, parses output, returns `{ pr_url }` or error.
3. Run-detail PR section: render deferred badge + Create PR button when `pr_deferred && !pr_url`.
4. Button click handler with disabled/spinner/error states.
5. Lock-state rendering (`pr_creation.state === 'in_progress' | 'failed'`).

### Phase 4: Events

**Files:**
- `src/worca/events/types.py`
- payload builder (same file or sibling — wherever `GIT_PR_CREATED`'s builder lives)
- `worca-ui/server/integrations/renderers.js`
- `tests/test_event_types.py`

**Tasks:**
1. Define `GIT_PR_DEFERRED` constant + payload builder.
2. Fire from runner when run reaches done deferred.
3. Add Tier 1 renderer in `renderers.js`.

### Phase 5: Tests

See Test Plan.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/schemas/pr-deferred.json` | Add `pr_title` / `pr_body` / `base_branch` to required list |
| `src/worca/agents/core/guardian.md` | Move title/body composition into shared Step 2; split Step 3 by branch |
| `src/worca/orchestrator/runner.py` | Translate `stages.pr.defer` → env; lift `deferred` to `status.pr_deferred` |
| `src/worca/workspace/dag_executor.py` | (Possibly) ensure workspace children's guardian still produces valid schema |
| `src/worca/cli/pr.py` (NEW) | `worca pr create <run-id>` command |
| `src/worca/cli/main.py` | Register `pr` sub-command |
| `src/worca/events/types.py` | `GIT_PR_DEFERRED` constant + payload builder |
| `worca-ui/server/app.js` | `POST /api/projects/:project/runs/:run_id/pr` endpoint with mutex |
| `worca-ui/server/integrations/renderers.js` | Tier 1 renderer for `pipeline.git.pr_deferred` |
| `worca-ui/app/views/run-detail.js` | Deferred badge + Create PR button + lock-state rendering |
| `worca-ui/app/views/run-detail.test.js` | Test new render branches |
| `tests/test_event_types.py` | Cover new event type |
| `tests/integration/test_pr_deferral.py` (NEW) | End-to-end deferred run + button promote |
| `docs/events.md` | Document new event type |
| `CLAUDE.md` | Document `worca.stages.pr.defer` toggle |

## Considerations

- **Workspace compatibility.** Workspace children today set `WORCA_DEFER_PR=1` directly via `dag_executor.py:99`. The new code path must not break them: the `not subprocess_env.get('WORCA_DEFER_PR')` guard in the runner ensures the workspace-set value wins (or rather, composes monotonically). Workspace children's guardian will now produce `pr_title` / `pr_body` / `base_branch` per the new schema; the workspace parent's PR-creation code (location TBD during impl) must be allowed to override them when composing its own linked PR.
- **Iteration on the same worktree.** Re-running the pipeline with `stages.pr.defer: true` on the same worktree adds more commits to the same branch. The latest run's stashed `pr_title` / `pr_body` overwrite the previous run's. When the button is clicked, the PR contains all accumulated commits and uses the latest title/body. This is the intended behavior; document in CLAUDE.md.
- **Run terminal state.** Stays `done` (no new `awaiting_pr` state). The discriminator is `status.pr_deferred: true` lifted to the run level. Keeps the state machine simple; the learner / webhooks / runs-list filter all continue working unchanged; the UI just adds a conditional.
- **Lock staleness.** A server crash mid-`gh pr create` leaves `pr_creation.state = "in_progress"` in `status.json` permanently. The CLI's reconcile-via-`gh pr list` covers this for most cases (ground truth wins). For the residual case (lock stuck, no PR opened), age-based staleness (default 5 min) lets the next button click reclaim.
- **Two-click races.** Two near-simultaneous HTTP requests both pass the lock check before either writes. Handled at the HTTP layer by the in-process `Map<key, Promise>` mutex in the UI server. Single-server assumption is fine — the UI server is a single Node process.
- **PR title/body edit affordance.** Out of scope for this plan. The button uses the stashed values verbatim. If users want to edit before opening, that's a follow-up (small Shoelace dialog pre-filling the cached values).
- **Governance.** No new surface. The CLI runs outside Claude tool calls. `git push` and `gh pr create` are not gated.
- **Breaking changes:** None for existing users — `worca.stages.pr.defer` defaults to `false`, preserving current behavior. The schema change is gated by `outcome: success`; existing workspace deferred runs that currently produce only `commit_sha` will fail validation under the new schema until guardian.md is updated to produce the new fields. The two changes ship together in Phase 1.
- **Migration:** No old→new config rename. New optional key.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_compute_defer_pr_from_config` | New runner translation: `stages.pr.defer: true` produces `WORCA_DEFER_PR=1` in env; workspace-set value not overridden. |
| Python | `test_pr_deferred_schema_requires_new_fields` | `pr-deferred.json` rejects success outputs missing `pr_title` / `pr_body` / `base_branch`. |
| Python | `test_status_pr_deferred_flag_lifted` | Runner lifts `stage_output.deferred` to `status.pr_deferred` on success. |
| Python | `test_pr_creation_lock_block_shape` | CLI writes the structured lock block correctly across `in_progress` / `done` / `failed` states. |
| Python | `test_pr_create_cli_reconciles_existing_pr` | `gh pr list` returns an existing PR → CLI captures URL without calling `gh pr create`. |
| Python | `test_pr_create_cli_stale_lock_reclaim` | Lock older than 5 min is treated as stale and reclaimed. |
| Python | `test_pr_create_cli_idempotent_when_pr_url_set` | Re-running CLI on a run with `pr_url` already set exits 0 without re-attempting. |
| Python | `test_event_pr_deferred_payload` | `GIT_PR_DEFERRED` payload contains expected fields. |
| JS (vitest) | `run-detail.test.js: renders deferred badge + button when pr_deferred && !pr_url` | UI conditional render. |
| JS (vitest) | `run-detail.test.js: renders disabled "Creating PR…" when pr_creation.state === 'in_progress'` | Lock-state UI. |
| JS (vitest) | `run-detail.test.js: renders inline error + Retry on pr_creation.state === 'failed'` | Failure-state UI. |
| JS (vitest) | `app.test.js: POST /api/projects/:p/runs/:r/pr returns 409 on double-fire` | Server mutex. |

### Integration / E2E Tests

- `tests/integration/test_pr_deferral.py` — full pipeline run with a template setting `stages.pr.defer: true`, asserts: commit lands on branch, branch pushed, no PR opened, `status.pr_deferred: true`, `pr_title` / `pr_body` / `base_branch` stashed. Then invokes `worca pr create <run-id>` and asserts: PR opened (mock `gh`), `status.pr_url` set, `pr_creation.state: "done"`.
- Playwright spec `worca-ui/e2e/run-detail-deferred-pr.spec.js` — load a run-detail view for a deferred run (seeded `status.json`), click "Create PR" (mock backend), assert spinner appears, assert button replaced by PR link on success, assert error rendering on failure.

### Existing Tests to Update

- Any existing tests that build `pr-deferred.json`-shaped outputs (workspace integration tests) need to start producing the three new required fields. Likely 2-3 fixtures in `tests/integration/test_workspace_*.py`.
- `tests/test_event_types.py` adds coverage for `GIT_PR_DEFERRED`.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `src/worca/schemas/pr-deferred.json` | Modify | Extend `then.required` |
| `src/worca/agents/core/guardian.md` | Modify | Restructure Step 2/3 |
| `src/worca/orchestrator/runner.py` | Modify | Env translation + status lift |
| `src/worca/workspace/dag_executor.py` | Modify | Confirm schema compatibility |
| `src/worca/cli/pr.py` | Create | New `worca pr create` command |
| `src/worca/cli/main.py` | Modify | Register sub-command |
| `src/worca/events/types.py` | Modify | New `GIT_PR_DEFERRED` constant |
| `src/worca/events/<payload>.py` | Modify | New payload builder |
| `worca-ui/server/app.js` | Modify | New endpoint + mutex |
| `worca-ui/server/integrations/renderers.js` | Modify | Tier 1 renderer |
| `worca-ui/app/views/run-detail.js` | Modify | Badge + button + lock-state UI |
| `worca-ui/app/views/run-detail.test.js` | Modify | Vitest coverage |
| `worca-ui/e2e/run-detail-deferred-pr.spec.js` | Create | Playwright coverage |
| `tests/test_event_types.py` | Modify | Cover `GIT_PR_DEFERRED` |
| `tests/integration/test_pr_deferral.py` | Create | End-to-end coverage |
| `tests/integration/test_workspace_*.py` | Modify | Updated fixtures for new required fields |
| `docs/events.md` | Modify | Document `GIT_PR_DEFERRED` |
| `CLAUDE.md` | Modify | Document `worca.stages.pr.defer` toggle |

## Out of Scope

- **PR title/body edit dialog before click.** The button uses the stashed values verbatim. A pre-flight edit dialog is a follow-up.
- **A "Discard run" button.** If the user iterates 10 times without clicking Create PR, the worktree accumulates commits on a local branch (and pushed to remote — branches without PRs are still on the remote). `worca cleanup` handles worktree removal; deleting the remote branch is manual.
- **A shipped template that demonstrates the toggle.** This plan adds the *capability*; a new built-in template that sets `stages.pr.defer: true` (e.g. `iterate`) is a follow-up — likely a 30-line `template.json` once the toggle exists.
- **Workspace parent re-using `worca pr create`.** Refactoring the workspace parent's PR-creation code to share the new CLI is desirable but out of scope. The CLI is designed so the refactor is straightforward later.
- **Non-GitHub providers.** The CLI currently shells `gh`. Adapting to `glab` / Bitbucket / Gerrit follows the same pattern guardian.md uses today (provider-aware CLAUDE.md sections) but is not addressed here.
