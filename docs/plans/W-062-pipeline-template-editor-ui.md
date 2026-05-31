# W-062: Pipeline Template Editor UI

**Status:** Draft
**Priority:** P2
**Area:** ui (primary) + cc (minor backend additions)
**Date:** 2026-05-31
**Depends on:** Phase 1 (branch work — `worca.default_template` field, template-driven merge exclusion for `agents/stages/loops/circuit_breaker/effort/governance.dispatch`, `_legacy-settings` auto-migration, Settings → Pipeline tab split into "Always applied" / "Template-driven")

## Problem

Today, authoring/editing/deleting a worca pipeline template is **CLI-only**:

- `worca templates save/delete` (`src/worca/cli/templates.py`)
- `/worca-template` skill (drives the CLI)
- Manual edits to `.claude/templates/<id>/template.json` or `~/.worca/templates/<id>/template.json`

The UI is read-only. `GET /api/projects/:projectId/templates` in `worca-ui/server/project-routes.js:1637` exists only to populate the new-run dropdown — there are no `POST/PUT/DELETE` routes and no view for editing.

The existing read endpoint has two known issues:

1. **No dedup** (`project-routes.js:1639-1670`): a template id present in multiple tiers (user + project + worca runtime copy) appears 3× in the dropdown with no winner indication. `TemplateResolver.list()` (`src/worca/orchestrator/templates.py:145`) dedupes; the UI route does not.
2. **No "default" surfacing**: Phase 1 introduces `worca.default_template`, but the new-run flow currently has no UI to preselect or edit it.

After Phase 1, the Settings → Pipeline tab visually splits into "Always applied" vs "Template-driven", and the Template-driven sub-panel is supposed to deep-link to a real editor — which doesn't exist yet.

User impact: pipeline customization is a CLI-only skill ceremony; teammates can't discover or share templates through the same surface they use to launch runs.

## Proposal

Add a new top-level **Pipelines** section in worca-ui with full CRUD over project + user templates, backed by a new `worca-ui/server/templates-routes.js` and a structured form editor (with a JSON power-user toggle). Fix the existing list endpoint to dedup by id with `effectiveTier` indication. Surface **★ Default** badges and a "Set as default" action wired to Phase 1's `worca.default_template`. Optionally harmonize the Models tab to use the same card layout for visual + interaction consistency.

## Design

### 1. Backend Python — `TemplateResolver` additions

- **Current state:** `src/worca/orchestrator/templates.py` ships `save()` (line 222), `delete()` (line 305), `get()` (line 185), `list()` (line 145), `apply()` (line 337). `src/worca/orchestrator/bundle.py` handles export/import with secret redaction.
- **Gap:** no `validate(config)` (simulate the deep-merge + check shape against schemas), no `duplicate(src_id, dst_id, dst_scope)` for clone-then-edit.
- **Resolution:** two new methods on `TemplateResolver`:

```python
def validate(self, config: dict, base_settings: dict | None = None) -> list[dict]:
    """Simulate apply() over base_settings (or {}); return a list of
    {field, severity, message} entries. severity ∈ {"error", "warning"}.
    'error' means a run with this config would break; 'warning' is suspicious
    but legal (e.g. references a model alias not in worca.models — silently
    falls back via _DEFAULT_MODEL_MAP, but worth flagging)."""

def duplicate(self, src_id: str, dst_id: str, dst_scope: str = "project") -> Template:
    """Resolve src_id from any tier, write a copy to dst_scope as dst_id.
    Raises TemplateError(builtin_conflict) if dst_id matches a built-in.
    Raises TemplateError(name_collision) if dst_id already exists in dst_scope."""
```

### 2. Backend Node — new `templates-routes.js`

- **Current state:** `worca-ui/server/project-routes.js:1637-1670` exposes only `GET /api/projects/:id/templates`. The handler walks three directories (user / project / `.claude/worca/templates`), emits all entries with no dedup, and tags each with `tier`.
- **Resolution:** extract to a dedicated `worca-ui/server/templates-routes.js` (consistent with `model-env-routes.js`), fix the dedup gap, and add the missing CRUD + bundle routes:

```
GET    /api/projects/:id/templates                       — list, deduped by id, with `effectiveTier` + `shadows: [...]` fields
GET    /api/projects/:id/templates/:tid                   — fetch resolved template body (project → user → builtin)
POST   /api/projects/:id/templates                        — create {scope, id, name, description, config, params, tags}
PUT    /api/projects/:id/templates/:tid                   — update (rejects scope=builtin)
DELETE /api/projects/:id/templates/:tid?scope=project|user — delete (rejects scope=builtin)
POST   /api/projects/:id/templates/:tid/duplicate         — clone-then-edit {dst_id, dst_scope}
POST   /api/projects/:id/templates/:tid/validate          — validate without saving {config}
GET    /api/projects/:id/templates/:tid/bundle            — export bundle (redacted, via bundle.py)
POST   /api/projects/:id/templates/import                 — import bundle (multipart file OR {url} OR {gist_id})
PUT    /api/projects/:id/default-template                 — write Phase 1's worca.default_template {tid}
```

**Dedup fix in `GET /templates`:** walk project → user → builtin (matches the swap in `dae2500`/`3027314`), `setdefault` per id like `TemplateResolver.list()`. The deduped row carries `effectiveTier` (which tier actually applies) and a `shadows: [...]` array (the tiers being hidden). The UI can then render "Project (shadows: user, built-in)" badges.

**Backend wiring:** routes delegate to the Python CLI via subprocess (`worca templates save/delete/validate/duplicate/bundle/import ...`). This keeps the Node side a thin shim and avoids re-implementing logic. If the subprocess pattern proves too slow, we can swap to a small Python HTTP shim in a follow-up — out of scope for this plan.

**Files allowlist:** add `worca-ui/server/templates-routes.js` to the `files` field in `worca-ui/package.json` (per the npm-pack allowlist rule in CLAUDE.md and the `worca-ui-design-reviewer` checklist). Use a `server/**/*.js` glob if not already present.

### 3. Frontend — top-level Pipelines section

- **Current state:** templates surface only as a read-only dropdown in new-run; no top-level view.
- **Resolution:** new top-level section per `/worca-ui-add-page` (5 wire-up points):

| Wire-up | File | Change |
|---|---|---|
| View file | `worca-ui/app/views/pipelines.js` | NEW — list + grid |
| Main dispatch | `worca-ui/app/main.js` | Route `pipelines` |
| Header title | `worca-ui/app/main.js` / header config | `pipelines` → "Pipelines" |
| Sidebar entry | sidebar config | Between Runs and Settings |
| Fetch + WS hooks | view bootstrap | Live updates when a template edit broadcasts |

**Layout:** grid of cards grouped by tier section (`Built-in`, `User`, `Project`), following `worca-ui/docs/card-layout.md`. Each card shows:

- Tier badge (per `worca-ui/docs/badge-color-language.md`)
- Name + one-line description + tags
- **★ Default** badge if this id equals `worca.default_template`
- Action row: **Edit**, **Duplicate**, **Set as default**, **Export bundle**, **Delete**
- Built-ins: **Edit** is replaced by **Duplicate to project** (immutability)
- "Shadows: built-in" hint when `effectiveTier !== "builtin"` and the id exists in builtin

**Empty states:** "Start from a built-in", "Import from a teammate", "Author from scratch".

### 4. Frontend — structured form editor

Modal (or dedicated `/pipelines/:tid/edit` route — TBD via a design call during impl). Sections:

- **Stages** — toggle list of every stage (`preflight`, `planner`, `plan_review`, `coordinator`, `implementer`, `tester`, `reviewer`, `guardian`, `learner`). Each row shows the agent it dispatches to (defaults from `STAGE_AGENT_MAP` in `settings.js:47`).
- **Agents matrix** — per agent: `model` (alias picker pulled from `worca.models`), `max_turns` (number), `effort` (dropdown: `low / medium / high / xhigh / max`, model-aware ladder per `docs/effort.md`).
- **Loops** — number inputs for `implement_test`, `review`, `plan_review`, etc. Placeholders show the built-in defaults so editing is comparative.
- **Circuit breaker** — `enabled` toggle, `max_consecutive_failures` number, classifier toggles.
- **Governance dispatch** — per-agent allowlists for `tools`, `skills`, `subagents` (the W-054 shape audited by `worca-dispatch-governance-reviewer`).
- **JSON power-user toggle** — same underlying data, raw JSON editor. Saving from JSON runs server-side `validate` first.
- **Diff vs built-in** — for project/user templates whose id exists in builtin, show what differs and offer "reset key to built-in value".

Save flow: structured form → `POST /validate` (debounced on field blur, plus once on save) → on success `POST /` (create) or `PUT /:tid` (update) → cards refresh.

### 5. Frontend — import / export bundle flow

Reuse `bundle.py` mechanics (already exercised by `/worca-template`):

- **Export:** download a redacted JSON bundle (env secrets stripped per `bundle.py`'s existing rules). Also offer "copy gist URL" when `gh` is available on the server.
- **Import:** modal accepts file upload, URL, or gist id. Server fetches/parses and previews:
  - Templates contained in the bundle
  - Redacted env keys (stripped on import per existing behavior)
  - Collisions with existing user/project templates (offer **rename** or **overwrite** per collision)
- On confirm, creates templates in the chosen scope.

### 6. Default-template wiring (Phase 1 surface)

- **Set as default** action on a card → `PUT /api/projects/:id/default-template { tid }`. Server writes `worca.default_template` into `.claude/settings.json`.
- **New-run dialog** (`worca-ui/app/views/new-run.js`): pre-fill the template picker with `worca.default_template` if set; show "★ Default" annotation alongside the selected entry.
- **Settings → Pipeline tab** (split in Phase 1): the "Template-driven" sub-panel becomes a single link card — "Edit pipelines →" deep-linking to `#pipelines`.

### 7. Models tab harmonization (optional / stretch)

Refactor Settings → Models (`settings.js:2517` `modelsTab`) to use the same card layout as Pipelines. Each model alias becomes a card with `id` + `env` editing + delete; new alias is an "Add card" affordance. CRUD already exists in `model-env-routes.js`; only the view shape needs reshaping. Worth doing in this plan to keep the visual language consistent, but can split out if the editor work overruns.

## Implementation Plan

### Phase A — Backend additions
**Files:** `src/worca/orchestrator/templates.py`, `tests/test_templates.py`
**Tasks:**
1. Add `TemplateResolver.validate()`.
2. Add `TemplateResolver.duplicate()`.
3. Unit tests covering merge sim, scope refusal, builtin-conflict, name collision.

### Phase B — Node API
**Files:** `worca-ui/server/templates-routes.js` (new), `worca-ui/server/project-routes.js` (remove old route), `worca-ui/package.json` (files allowlist), `worca-ui/server/templates-routes.test.js` (new)
**Tasks:**
1. Extract existing `GET /templates` → new router; add dedup + `effectiveTier` + `shadows`.
2. Add the 9 new routes (POST / PUT / DELETE / duplicate / validate / bundle GET / import / default-template).
3. Vitest coverage per route, plus dedup regression test.
4. Verify `cd worca-ui && npm pack --dry-run` includes the new file.

### Phase C — Pipelines section (list view)
**Files:** `worca-ui/app/views/pipelines.js` (new), `worca-ui/app/main.js`, `worca-ui/app/styles.css`, e2e spec
**Tasks:**
1. View file with cards + tier groups + action stubs.
2. 5 wire-up points per `/worca-ui-add-page`.
3. Dispatch `worca-ui-routing-reviewer` + `worca-ui-card-consistency-reviewer`.

### Phase D — Editor
**Files:** `worca-ui/app/views/pipelines-editor.js` (new — or merged into `pipelines.js` if it stays small)
**Tasks:**
1. Structured form per section (stages, agents, loops, CB, governance).
2. JSON power-user toggle with bi-directional sync.
3. Diff-vs-built-in view.
4. Wire save → `validate` → `POST/PUT`.
5. e2e specs (`pipelines-create.spec.js`, `pipelines-edit.spec.js`, `pipelines-delete.spec.js`) — Playwright, `--workers=1`.

### Phase E — Import/Export + default wiring
**Files:** `worca-ui/app/views/pipelines.js` (extend), server-side bundle handler in `templates-routes.js`, e2e
**Tasks:**
1. Export action → download.
2. Import modal with redaction preview + collision handling.
3. "Set as default" wired to `PUT /default-template`.
4. New-run dialog reads `worca.default_template` and pre-selects.
5. Settings → Pipeline "Template-driven" sub-panel becomes deep-link card.

### Phase F — Models tab harmonization (stretch)
**Files:** `worca-ui/app/views/settings.js` (`modelsTab` refactor)
**Tasks:**
1. Reshape `modelsTab` into card grid matching `pipelines.js` layout.
2. Dispatch `worca-ui-design-reviewer` + `worca-ui-a11y-reviewer`.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/orchestrator/templates.py` | Add `validate()`, `duplicate()` |
| `tests/test_templates.py` | New tests for both methods |
| `worca-ui/server/templates-routes.js` | NEW — 9 routes + dedup fix |
| `worca-ui/server/templates-routes.test.js` | NEW — vitest |
| `worca-ui/server/project-routes.js` | Remove old `GET /templates` handler |
| `worca-ui/package.json` | Add new server file to `files` allowlist |
| `worca-ui/app/views/pipelines.js` | NEW — list view |
| `worca-ui/app/views/pipelines-editor.js` | NEW — editor (may merge with pipelines.js) |
| `worca-ui/app/main.js` | Route + sidebar + header wire-up |
| `worca-ui/app/views/new-run.js` | Read `worca.default_template`, preselect |
| `worca-ui/app/views/settings.js` | (stretch) `modelsTab` refactor; deep-link in `pipelineTab` |
| `worca-ui/e2e/pipelines-*.spec.js` | NEW — 3-4 specs |
| `docs/configuration-precedence.md` | Cross-link to Pipelines section |
| `docs-site/src/content/docs/configuration/precedence.md` | Cross-link to Pipelines section |
| `docs-site/src/content/docs/configuration/pipelines-editor.md` | NEW — user-facing walkthrough |
| `MIGRATION.md` | "Pipeline editor UI" entry under next version |

## Considerations

- **Phase 1 dependency.** Phases C-E assume `worca.default_template` exists, the merge exclusion is wired, and the Settings tab is split. Until Phase 1 lands, "Set as default" and the Settings deep-link have no target. Phases A-B can land independently if useful.
- **Built-in immutability.** Editing a built-in must auto-duplicate (same model as `/worca-template`). Surface explicitly: "Built-ins can't be modified — duplicate to project?".
- **Scope governance.** "User" templates are machine-global; editable from any project. The UI picks scope at create time and never silently promotes/demotes.
- **Concurrent edits.** Templates resolve at run start, so live runs are safe — but show "N runs in flight use this template" before destructive edits (delete / overwrite). Mirrors the existing "save locked while pipeline is running" pattern in Settings.
- **Validation latency.** `validate` runs the full deep-merge sim — target sub-100ms. If we ever add expensive checks (model availability, network probes), debounce and move to a background validation badge.
- **Subagent reviewers to dispatch after impl:** `worca-ui-routing-reviewer` (Phase C wire-up), `worca-ui-card-consistency-reviewer` (cards), `worca-ui-a11y-reviewer` (editor modal + form), `worca-ui-design-reviewer` (badge colors, package files allowlist).

### Breaking changes

- **`GET /templates` shape change.** Pre-W-062 the route returned one row per tier-instance; post, it returns one row per id with `effectiveTier` + `shadows`. **Mitigation:** no known internal consumer relies on duplicate rows. The new-run dropdown is the only known caller; updated in lockstep. External tooling that snapshots the endpoint will need to flatten — call out in MIGRATION.md.

### Migration

- **None required.** Phase 1 already owns the schema migration (`_legacy-settings` + `worca.default_template`). Phase 2 is purely additive UI on top.

## Test Plan

### Unit Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Python | `test_template_validate_ok_for_empty_config` | `validate({})` returns `[]` |
| Python | `test_template_validate_flags_unknown_agent` | `agents.foo` flagged when `foo` not in stage-agent map |
| Python | `test_template_validate_warns_missing_model_alias` | `agents.x.model: "ghost"` → warning (silent code fallback) |
| Python | `test_template_validate_flags_invalid_effort` | `effort.auto_cap: "nuclear"` → error |
| Python | `test_template_duplicate_creates_in_dst_scope` | `duplicate(src, "copy", "user")` writes to user dir |
| Python | `test_template_duplicate_refuses_collision_in_same_scope` | Refuses overwrite |
| Python | `test_template_duplicate_refuses_builtin_dst_id` | `builtin_conflict` |
| Node | `templates-routes.test.js: GET dedupes by id` | Same id in 3 tiers returns 1 row, `effectiveTier: "project"`, `shadows: ["user", "builtin"]` |
| Node | `templates-routes.test.js: POST rejects scope=builtin` | 400 |
| Node | `templates-routes.test.js: DELETE rejects scope=builtin` | 400 |
| Node | `templates-routes.test.js: PUT /default-template writes settings.json` | `worca.default_template` set correctly |
| Node | `templates-routes.test.js: POST /import handles redaction preview` | env keys stripped, surfaced in response |

### Integration / E2E Tests

| Layer | Test | Validates |
|-------|------|-----------|
| Playwright | `e2e/pipelines-list.spec.js` | All tiers render, deduped, ★ default shown |
| Playwright | `e2e/pipelines-editor.spec.js` | Create from blank, edit, JSON toggle round-trip, save → toast |
| Playwright | `e2e/pipelines-duplicate.spec.js` | Built-in → duplicate → edit → save |
| Playwright | `e2e/pipelines-import-export.spec.js` | Export → re-import round trip preserves config; collision dialog appears on second import |
| Playwright | `e2e/pipelines-set-default.spec.js` | Set-as-default updates star + pre-fills new-run dropdown |

### Existing Tests to Update

| Test | Change |
|------|--------|
| `tests/test_templates.py` | Add `validate()` / `duplicate()` cases (separate from existing tier-priority tests) |
| `worca-ui/app/views/new-run-template.test.js` | New case: "default template is preselected when `worca.default_template` is set" (Phase 1 + Phase 2 interaction) |
| Any caller of `GET /templates` that expects the old multi-row shape | Update to expect deduped output with `effectiveTier` |

## Files to Create / Modify

See "Files Changed Summary" above; no separate table needed.

## Out of Scope

- **Phase 1 itself** (schema field, merge exclusion, `_legacy-settings` migration, Settings tab split). Tracked as branch work; this plan depends on it.
- **Worca-hosted template gallery / marketplace.** Bundles ship via file / URL / gist only.
- **Cross-project template sharing UI** (importing a template *from* another local worca project on the same machine). Could be added later; for now stick with file/URL/gist.
- **Per-template versioning / history.** `created_at` is the only timestamp; full version history requires a separate plan.
- **Editor for `worca.webhooks`, `worca.pricing`, `worca.graphify`, `worca.code_review_graph`.** These stay in Settings — they're cross-template per Phase 1's classification.
- **Re-implementing the Python adapter in pure Node.** The `templates-routes.js` shim subprocesses out to `worca templates …`. A native rewrite is a follow-up if latency demands it.
