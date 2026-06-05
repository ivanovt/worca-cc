# W-069: Coordinator max-beads decomposition cap

**Status:** Draft
**Priority:** P2
**Area:** cc
**Date:** 2026-06-05
**Depends on:** None

## Problem

The Coordinator decomposes the approved plan into Beads tasks purely by its own
judgment — `src/worca/agents/core/coordinator.md:14` ("Break down into atomic
implementation tasks") gives no guidance on *how many* beads to create, and
`coordinate.block.md` carries no count constraint. There is no way for a project,
a template, or an operator to say "keep this to a single atomic unit" or "don't
fragment this into more than N tasks." A `quick-fix` run that should be one bead
can fan out into five; a tightly-scoped template can't express its decomposition
posture. The only count the runner tracks today is *post-hoc* —
`runner.py` sets a local `max_beads = len(beads_ids)` (the number of beads the
coordinator *did* create) to bound the implement loop — there is no *input* cap.

## Proposal

Add a template-owned integer config key `worca.agents.coordinator.max_beads`
(default `0` = auto = today's behavior). `1` is a single-bead **mandate**; `>1`
is an advisory **budget**. The value can be set by a pipeline template, edited in
the template editor, and overridden per-run from the launcher (a dropdown where
`0` renders as "Auto"). The coordinator prompt is templated three ways on the
resolved value. Enforcement is soft: deviations are logged and the run proceeds
with the decomposition as-is. Ships as pure opt-in (all built-ins stay `0`) except
`quick-fix`, which adopts `max_beads: 1`.

## Design

### 1. Config key + semantics

- **Current state:** `src/worca/settings.json:176` — `worca.agents.coordinator`
  holds `{model, max_turns, effort}`. `worca.agents` is template-owned
  (`src/worca/orchestrator/templates.py:23`, `TEMPLATE_OWNED_KEYS`), so a key
  placed here is (a) overridable by templates, (b) stripped from project Settings
  when a template is in play, (c) cleanly absent → defaulted when a template is
  silent. This is exactly the ownership model we want.
- **Resolution:** add `"max_beads": 0` to the shipped coordinator block.

Semantics of the resolved value:

| Value | Meaning | Prompt | Enforcement |
|-------|---------|--------|-------------|
| `0` | Auto — no cap (current behavior) | no block | none |
| `1` | Single-bead mandate | "Single bead" block | soft (log on deviation) |
| `>1` | Advisory budget | "Decomposition budget" block | soft (log on overage) |

**Precedence (highest wins):** per-run launcher/CLI override → template config →
`0`.

### 2. Override plumbing (runtime-param, msize-style)

- **Current state:** `--msize`/`--mloops` (`run_pipeline.py:31`,`:34`) are the
  precedent for a per-run knob: CLI flag → POST body → `process-manager.js` args
  → argparse → threaded into the runner; they are *not* written into the merged
  settings file. Template config, by contrast, is deep-merged and written to a
  temp settings file (`run_pipeline.py:301-342`); with no template,
  `args.settings` is used directly.
- **Obstacle:** the override must win over the template-config value and must work
  in both the template and no-template launch paths, without forcing a temp
  settings file to be materialized when there's no template.
- **Resolution:** treat the override as a runtime parameter, exactly like `msize`.
  - `run_pipeline.py`: add `--max-beads` (type `int`, **default `None`** =
    "unset, use config"). Thread it into `run_pipeline()` and on into the runner.
  - The runner resolves the **effective cap** when it builds the coordinate prompt
    context: `override if override is not None else stage_config["max_beads"] else 0`.
  - Persist the resolved cap into `status.json` (same as `msize`) so `--resume`
    reuses it. `--max-beads` on resume is allowed without a force flag (unlike
    `--template`, which gates behind `--force-template-change`).

### 3. Prompt templating (three-way, truthiness-driven)

- **Current state:** the overlay engine (`src/worca/orchestrator/overlay.py:314-424`)
  supports `{{#if key}}…{{/if}}` with **truthiness** semantics (`:354`,
  `context.get(key)`); `0`/`""`/`None` are falsy. There is **no** equality
  operator (`== 1` is not expressible). The coordinate work-request body lives in
  `src/worca/agents/core/coordinate.block.md`; coordinator role rules live in
  `coordinator.md`.
- **Resolution:** resolve the case in Python and expose three context vars from
  `prompt_builder.py` (coordinate branch, `:232-246`):
  - `ctx["max_beads"]` — the int (drives `{{max_beads}}` rendering)
  - `ctx["bead_cap_single"]` — `True` when effective cap `== 1`
  - `ctx["bead_cap_multi"]` — `True` when effective cap `> 1`

Two mutually exclusive blocks in `coordinate.block.md` (auto=0 renders neither):

```handlebars
{{#if bead_cap_single}}
## Single bead

Create one bead covering the entire approved plan. One implementer will execute the
whole plan in a single session, so capture the full scope in that bead's description.
{{/if}}
{{#if bead_cap_multi}}
## Decomposition budget

Create at most {{max_beads}} beads total. Treat this as a budget, not a quota —
prefer fewer, well-scoped beads. If the plan naturally exceeds it, group related
work into composite beads whose descriptions enumerate the sub-steps so the total
stays in budget.
{{/if}}
```

Plus a one-line cross-reference in `coordinator.md`'s Rules section.

**Impl detail:** the placeholder substitution does string replacement, so the
int must be `str()`-coerced when injected (or stored as both int for the
conditional and a string for the value).

### 4. PR-revision mode interaction (correctness trap)

- **Current state:** `coordinator.md:77-99` defines a `{{#if has_review_comments}}`
  mode that mandates **one bead per unresolved review comment**. A cap — especially
  `1` — directly contradicts this (5 comment-threads cannot collapse to 1 bead).
- **Resolution:** the cap is **suppressed whenever `has_review_comments` is true**.
  In `prompt_builder.py`, when the coordinate context has review comments, force
  `bead_cap_single`/`bead_cap_multi` to `False` (and `max_beads` to `0`) so neither
  budget block renders and the comment-to-bead rule wins outright. Documented in
  the prompt and the config docs.

### 5. Enforcement (soft + log)

- After the COORDINATE stage returns, compare the actual bead count against the
  effective cap (skip when cap is `0` or in PR-revision mode):
  - cap `== 1` and count `!= 1`: log a warning.
  - cap `> 1` and count `> cap`: log a warning.
- In **both** cases, **proceed with the decomposition as produced** — no re-run, no
  pruning, no failure. The cap is guidance to a decomposition LLM, like effort
  labels. v1 emits a **log line only** (not a new `pipeline.*` event type); a
  webhook/chat event can be added later if needed.

### 6. Naming cleanup

- `runner.py` already has a local `max_beads = len(beads_ids)` meaning *"count of
  beads the coordinator created"* — a different concept from this *cap*. Rename
  that local to `created_bead_count` in the touched scope to remove the ambiguity.
  The user-facing name (`max_beads`) is used for config / flag / UI.

### 7. Validation

- `validate_merged_config` (`templates.py:188`) gains a coordinator `max_beads`
  rule: must be an integer, `>= 0`, and `<= 50` (the ceiling). Non-int / negative /
  over-ceiling → `severity: "error"`. This catches malformed templates at
  validate-time (CLI `worca templates validate` and the editor's live validation).

### 8. Launcher UI (`worca-ui/app/views/new-run.js`)

- **Current state:** the launcher fetches templates with their `config`
  (`:128-172`), tracks `selectedTemplate` (`:436-439`), renders static
  `msize`/`mloops` fields (`:740-750`), and builds the POST body at `:312-323`.
  The templates API already returns `config`, so the preset is readable client-side.
- **Resolution:** add an `sl-select` dropdown ("Max beads", options
  `Auto (0)`, `1`…`N`) beside msize/mloops.
  - On template select, seed from
    `template.config?.agents?.coordinator?.max_beads ?? 0`. Switching templates
    **always re-seeds** (discards a manual edit) — switching is an explicit
    "reset my knobs to this template" action.
  - On submit, include `maxBeads` in the body (send always, including `0`).

### 9. Template editor UI (`worca-ui/app/views/pipelines-editor.js`)

- **Current state:** `_agentsTab()` (`:1639`) renders a card per agent with
  model / max_turns / effort fields; the per-agent **effort** `sl-select`
  (`:1791-1818`) and the **auto-cap** `sl-select` (`:1695-1723`) are the dropdown
  precedents. The form buffer round-trips through `buildFormBuffer` (agents at
  `:259-264`) and `formBufferToConfig` (`:435-455`); `saveTemplate` (`:832-959`)
  PUTs the whole `config` and the server passes it through verbatim
  (`templates-routes.js:258-275`,`:656-668`) — so save needs **no** changes.
  `_original` spread already preserves unknown keys across the round-trip.
- **Resolution:**
  - `buildFormBuffer`: seed `max_beads: agentConfig.max_beads ?? 0` (coordinator
    only, or all agents harmlessly — coordinator is the only consumer).
  - `formBufferToConfig`: write `max_beads` back into the merged coordinator config
    (omit the key when `0` to keep templates clean, mirroring how `effort` is
    dropped when falsy).
  - `_agentsTab`: render a "Max beads" `sl-select` in the coordinator card with
    `Auto (0)` + `1`…`N`, mirroring the effort dropdown's binding.

### 10. Server pass-through

- **Launch:** `worca-ui/server/project-routes.js` POST runs (`:905-1058`) — add
  `maxBeads` to the body destructure (`:920-929`), clamp to `[0,50]` integer
  (mirroring the msize clamp at `:1010-1015`), and pass to `pm.startPipeline()`
  (`:1037-1046`). `process-manager.js` `startPipeline` (`:538-552`) pushes
  `--max-beads <n>` when provided (guarded like `--msize`).

### 11. Built-in templates

- `src/worca/templates/quick-fix/template.json` — set
  `config.agents.coordinator.max_beads: 1` (its intent — a whole fix as one atomic
  unit — fits the single-bead mandate exactly).
- All other built-ins stay `0` (auto) → zero behavior change for existing runs.

### 12. fleet / workspace

- `run_worktree.py` gets the `--max-beads` pass-through (single worktree runs are
  the launcher's target). `run_fleet.py` / `run_workspace.py` get the **flag**
  pass-through so it can be set on the command line, but **no new UI**. Note:
  template-defined caps already propagate to fleet/workspace child runs for free
  via template config — only the per-run *override* UI is scoped out.

## Implementation Plan

### Phase 1: Config + resolution core (Python)
**Files:** `src/worca/settings.json`, `src/worca/orchestrator/stages.py`,
`src/worca/orchestrator/templates.py`
**Tasks:**
1. Add `"max_beads": 0` to `worca.agents.coordinator` (`settings.json:176`).
2. Surface `max_beads` in `get_stage_config()`'s returned dict (`stages.py:124`).
3. Add the `max_beads` integer/range rule to `validate_merged_config`
   (`templates.py:188`).

### Phase 2: Prompt context + templating
**Files:** `src/worca/orchestrator/prompt_builder.py`,
`src/worca/agents/core/coordinate.block.md`, `src/worca/agents/core/coordinator.md`
**Tasks:**
1. In the coordinate branch (`prompt_builder.py:232-246`), resolve the effective
   cap (override → config → 0), apply PR-revision suppression, and set
   `max_beads` / `bead_cap_single` / `bead_cap_multi`.
2. Add the two blocks to `coordinate.block.md`; add the rule cross-ref to
   `coordinator.md`.

### Phase 3: Runtime plumbing + enforcement
**Files:** `src/worca/scripts/run_pipeline.py`, `src/worca/scripts/run_worktree.py`,
`src/worca/orchestrator/runner.py`, `src/worca/state/status.py` (if needed for
persistence)
**Tasks:**
1. `run_pipeline.py`: add `--max-beads` (int, default `None`); thread into
   `run_pipeline()` → runner; persist resolved value in status.json; reuse on
   resume.
2. `run_worktree.py`: pass `--max-beads` through.
3. `runner.py`: pass the override into the coordinate context build; add the
   post-stage soft check + warning log; rename the existing `max_beads` local to
   `created_bead_count`.

### Phase 4: UI (launcher + editor + server)
**Files:** `worca-ui/app/views/new-run.js`, `worca-ui/app/views/pipelines-editor.js`,
`worca-ui/server/project-routes.js`, `worca-ui/server/process-manager.js`
**Tasks:**
1. Launcher dropdown (seed from template, reseed on switch, submit `maxBeads`).
2. Editor coordinator-card dropdown + form-buffer round-trip.
3. Server: accept/clamp `maxBeads`, pass to `startPipeline`, push `--max-beads`.
4. `cd worca-ui && npm run build`.

### Phase 5: Built-ins, fleet/workspace flag, docs
**Files:** `src/worca/templates/quick-fix/template.json`,
`src/worca/scripts/run_fleet.py`, `src/worca/scripts/run_workspace.py`,
`CLAUDE.md`, `docs/configuration-precedence.md` (or coordinator/agent docs),
`.claude/skills/worca-template/*`
**Tasks:**
1. Set `quick-fix` coordinator `max_beads: 1`.
2. `--max-beads` pass-through on fleet/workspace launchers.
3. Document the key, semantics, precedence, and PR-revision suppression.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/settings.json` | Add `max_beads: 0` to coordinator |
| `src/worca/orchestrator/stages.py` | Surface `max_beads` in stage config |
| `src/worca/orchestrator/templates.py` | Validate `max_beads` (int, 0–50) |
| `src/worca/orchestrator/prompt_builder.py` | Resolve cap; set context flags; PR-revision suppression |
| `src/worca/agents/core/coordinate.block.md` | Single-bead + budget blocks |
| `src/worca/agents/core/coordinator.md` | Rule cross-reference |
| `src/worca/orchestrator/runner.py` | Thread override; soft check + log; rename local |
| `src/worca/scripts/run_pipeline.py` | `--max-beads` flag; persist; resume |
| `src/worca/scripts/run_worktree.py` | Pass-through |
| `src/worca/scripts/run_fleet.py`, `run_workspace.py` | Flag pass-through |
| `src/worca/templates/quick-fix/template.json` | `max_beads: 1` |
| `worca-ui/app/views/new-run.js` | Launcher dropdown (0=Auto), reseed, submit |
| `worca-ui/app/views/pipelines-editor.js` | Coordinator-card dropdown + round-trip |
| `worca-ui/server/project-routes.js` | Accept/clamp `maxBeads`, pass to pm |
| `worca-ui/server/process-manager.js` | Push `--max-beads` |
| `CLAUDE.md`, docs | Document key + semantics |

## Considerations

- **Soft enforcement by design.** A cap is guidance to a decomposition LLM; hard
  enforcement (re-run / prune) creates a thorny "what to do with the excess beads"
  problem (pruning breaks dependency edges; re-running may not converge). We log
  and proceed.
- **PR-revision suppression is mandatory**, not optional — without it a cap of `1`
  produces an incorrect decomposition of multi-comment revisions.
- **Naming collision** between the new cap and the runner's existing `max_beads`
  local (count of created beads) — resolved by renaming the local.
- **Template-owned key.** Because `worca.agents` is template-owned, a project's
  raw `settings.json` value for `max_beads` is stripped when a template is in play
  — consistent with the "template defines it" requirement, but worth stating.
- **Breaking changes:** one behavior change — `quick-fix` now caps at a single
  bead. All other templates and bare (no-template) runs are unchanged
  (default `0`). Called out in MIGRATION.md if cut in a release.
- **Migration:** none required; the key is additive and defaults to current
  behavior.

## Test Plan

### Unit Tests
| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_overlay_bead_cap_blocks` | `bead_cap_single`/`bead_cap_multi` render the right block; `0` renders neither |
| Python | `test_prompt_builder_resolves_max_beads` | override > config > 0 precedence; int → context flags |
| Python | `test_prompt_builder_pr_revision_suppresses_cap` | `has_review_comments` forces cap off |
| Python | `test_get_stage_config_max_beads` | key surfaced from settings |
| Python | `test_validate_merged_config_max_beads` | non-int / negative / >50 → error |
| Python | `test_run_pipeline_max_beads_flag` | flag parsed; threaded; persisted in status.json; reused on resume |
| Python | `test_runner_soft_warns_on_cap_deviation` | log on `!=1` (single) and `>cap` (budget); run proceeds |
| JS | `pipelines-editor` vitest | coordinator `max_beads` round-trips buildFormBuffer ↔ formBufferToConfig; `0` omitted |
| JS | `new-run` vitest | dropdown seeds from template; reseeds on switch; `maxBeads` in body |
| JS | `process-manager`/route vitest | `maxBeads` clamped + `--max-beads` pushed only when provided |

### Integration / E2E Tests
- Integration: a run with `--max-beads 1` (mock claude) → coordinate prompt
  contains the single-bead block; a `0`/auto run contains neither block.
- E2E (Playwright, since `worca-ui/app` changes): launcher shows the dropdown,
  template selection seeds it, `Auto` maps to `0`; editor coordinator card shows
  and saves the value.

### Existing Tests to Update
- `tests/test_stages.py` — `get_stage_config` shape now includes `max_beads`.
- `tests/test_prompt_builder.py` — coordinate context additions.
- Any template/settings snapshot tests that assert the coordinator block shape
  (`quick-fix` now carries `max_beads: 1`).

## Files to Create/Modify

See **Files Changed Summary** above. New test files:
`tests/test_coordinator_max_beads.py` (or extend existing per-module tests),
launcher/editor vitest specs under `worca-ui/app/views/`.

## Out of Scope

- Hard enforcement (re-run / prune to fit the cap).
- A dedicated `pipeline.*` event type for cap deviations (log line only in v1).
- Per-run override **UI** for fleet/workspace launches (CLI flag only).
- Per-agent caps for agents other than the coordinator.
- Changing any built-in other than `quick-fix`.
