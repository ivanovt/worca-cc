# W-038: Configurable Subagent Dispatch Rules

**Goal:** Replace the hardcoded `DISPATCH_RULES` dict in `tracking.py` with a configurable, settings-driven `subagent_dispatch` system. Grant `explore` access to `tester` and `plan_reviewer`. Fix the missing `reviewer` entry (W-037 gap). Add a hardcoded denylist for dangerous subagent types. Update worca-ui to support the rename with backwards-compatible legacy key handling, and add dispatch activity visualization to run detail views.

**Why:** Today `DISPATCH_RULES` is a frozen Python dict that projects cannot customize without patching the package. Meanwhile, a dead `governance.dispatch` key exists in `settings.json` that is never read and contains semantically wrong values. The UI renders this dead key but validates dispatch values against pipeline agent names — wrong, since values should be subagent types. As the plugin ecosystem grows (feature-dev, hookify, etc.), teams need to tailor subagent access per pipeline agent without forking, and need visibility into dispatch decisions during runs.

**Depends on:** None.

---

## 1. Current State

### Hardcoded rules (`src/worca/hooks/tracking.py:12-19`)

```python
DISPATCH_RULES = {
    "planner": {"explore"},
    "coordinator": set(),
    "implementer": {"explore"},
    "tester": set(),           # cannot explore
    "guardian": {"explore"},
    "plan_reviewer": set(),    # cannot explore
}
```

- No `reviewer` entry (W-037 renamed `guardian` to `reviewer` for the review stage, but tracking.py was never updated — falls through to empty set).
- No `learner` entry.
- `check_dispatch()` reads only from this dict, never from settings.

### Dead config (`src/worca/settings.json:246-254`)

```json
"governance": {
  "dispatch": {
    "planner": [],
    "coordinator": ["implementer"],
    "implementer": [],
    "tester": [],
    "guardian": []
  }
}
```

- **Never read by any code.** Grep for `governance.*dispatch|dispatch_rules|dispatch_config` across `src/worca/` returns zero hits outside the settings file itself.
- Values are semantically wrong — they describe pipeline stage spawning (coordinator → implementer), not Claude Code subagent type access (implementer → explore).
- Missing `reviewer`, `plan_reviewer`, `learner`.

### Prompt contradiction (`src/worca/agents/core/plan_reviewer.md:67`)

> Do NOT dispatch sub-agents or subagents

This line sits under a `<!-- governance -->` section. Granting `explore` without updating the prompt creates a mismatch — the hook allows it but the prompt forbids it.

### Hook invocation path

```
Claude Code Agent tool call
  → .claude/worca/claude_hooks/subagent_start.py
    → imports worca.hooks.tracking.check_dispatch
    → reads WORCA_AGENT env var (parent), agent_type from stdin (child)
    → exit 0 = allow, exit 2 = block
```

---

## 2. Design

### 2.1 Rename and replace the settings key

Remove `governance.dispatch` (dead, wrong). Add `governance.subagent_dispatch` with correct values:

```json
"governance": {
  "guards": { "..." : "..." },
  "test_gate_strikes": 2,
  "subagent_dispatch": {
    "planner": ["explore"],
    "coordinator": [],
    "implementer": ["explore"],
    "tester": ["explore"],
    "guardian": ["explore"],
    "reviewer": ["explore"],
    "plan_reviewer": ["explore"],
    "learner": []
  }
}
```

Name `subagent_dispatch` is chosen to disambiguate from pipeline-level agent spawning (which is governed by the coordinator's agent prompt, not settings).

### 2.2 Python constant rename

In `src/worca/hooks/tracking.py`:

```python
DEFAULT_SUBAGENT_DISPATCH = {
    "planner": {"explore"},
    "coordinator": set(),
    "implementer": {"explore"},
    "tester": {"explore"},
    "guardian": {"explore"},
    "reviewer": {"explore"},
    "plan_reviewer": {"explore"},
    "learner": set(),
}

_SUBAGENT_DENYLIST = frozenset({"general-purpose"})
```

- `DEFAULT_SUBAGENT_DISPATCH` is the fallback when settings are absent or a key is missing.
- `_SUBAGENT_DENYLIST` is hardcoded and **not overridable**. Any denylist entry found in user config is stripped with a stderr warning. Rationale: `general-purpose` has Write/Edit/Bash access and would bypass the "only guardian commits" governance guard.

### 2.3 Config loading

New function in `tracking.py`:

```python
_cached_rules: dict | None = None

def _load_subagent_dispatch() -> dict:
    """Load subagent dispatch rules from settings, with default fallback."""
    global _cached_rules
    if _cached_rules is not None:
        return _cached_rules

    rules = dict(DEFAULT_SUBAGENT_DISPATCH)  # start with defaults

    try:
        settings = _load_settings()  # reuse existing settings loader
        user_dispatch = settings.get("worca", {}).get("governance", {}).get("subagent_dispatch", {})

        for agent, allowed_list in user_dispatch.items():
            allowed = set(allowed_list)
            # Enforce denylist
            denied = allowed & _SUBAGENT_DENYLIST
            if denied:
                print(
                    f"[tracking] Warning: stripped denied subagent(s) {denied} "
                    f"from {agent} dispatch config",
                    file=sys.stderr,
                )
                allowed -= denied
            rules[agent] = allowed  # full replace per agent key
    except Exception:
        pass  # fall back to defaults silently

    _cached_rules = rules
    return rules
```

Semantics:
- **Per-agent replace** — if a user specifies `implementer: ["explore", "feature-dev:code-reviewer"]`, that is the complete set for `implementer`. No merging with defaults.
- **Missing agent keys fall through to defaults** — if a user only configures `implementer`, all other agents keep their default rules.
- **Module-level cache** — hook processes are short-lived (one per subagent dispatch), so caching is safe with no staleness concern.

Settings loading reuses the git-root resolution pattern already used by other hooks (`os.environ.get("CLAUDE_PROJECT_DIR")` or git rev-parse).

### 2.4 Updated `check_dispatch`

```python
def check_dispatch(parent_agent: str, child_agent: str) -> tuple:
    if not parent_agent:
        return (0, "")  # interactive mode, allow all

    if child_agent in _SUBAGENT_DENYLIST:
        return (2, f"Blocked: {child_agent} is on the subagent denylist")

    rules = _load_subagent_dispatch()
    allowed = rules.get(parent_agent, set())
    if child_agent in allowed:
        return (0, "")
    return (2, f"Blocked: {parent_agent} cannot dispatch {child_agent}")
```

The denylist check happens first, before config loading, so there's no way to bypass it.

### 2.5 Plan reviewer prompt update

In `src/worca/agents/core/plan_reviewer.md`, change line 67:

```diff
-- Do NOT dispatch sub-agents or subagents
+- Do NOT dispatch sub-agents except `explore` for codebase verification
```

The `<!-- governance -->` marker on the section is preserved — project overrides cannot replace this section (only append).

### 2.6 Settings migration in `worca init --upgrade`

Add to `_migrate_settings_paths` in `src/worca/cli/init.py`:

- Detect `governance.dispatch` key
- Rename to `governance.subagent_dispatch`
- Convert values to the new format (lists of subagent types, not pipeline agents)
- Since the old values were wrong/unused, the migration replaces them with the new defaults rather than attempting semantic conversion

---

## 3. worca-ui Changes

### 3.1 Current UI state

The Governance tab in `settings.js` already renders `governance.dispatch` as per-agent comma-separated input fields:

- **`worca-ui/app/views/settings.js:103`** — `DEFAULT_GOVERNANCE` includes `dispatch` with old values
- **`worca-ui/app/views/settings.js:188-190`** — merges `governance.dispatch` on load
- **`worca-ui/app/views/settings.js:365-377`** — `readGovernanceFromDom()` reads `dispatch-${agent}` DOM fields
- **`worca-ui/app/views/settings.js:599-634`** — `governanceTab()` renders dispatch input rows

The validator (`server/settings-validator.js:307-328`) validates `dispatch` entries against `VALID_AGENTS` — which is wrong for the new semantics since dispatch values are subagent *types* (e.g., `explore`, `feature-dev:code-reviewer`), not pipeline agent names.

The UI currently has **zero handling** of `pipeline.hook.dispatch_blocked` events (emitted by `subagent_start.py:27`). These events are logged by the event system but never surfaced.

### 3.2 Backwards-compatible settings key handling

The UI must handle three project states:

1. **New project** — has `governance.subagent_dispatch` (clean)
2. **Upgraded project** — `worca init --upgrade` migrated the key (clean)
3. **Old project** — still has `governance.dispatch` under the legacy key

In `settings.js` load logic and `DEFAULT_GOVERNANCE`:

```javascript
// Read from new key, fall back to legacy key
const subagentDispatch = governance.subagent_dispatch
  || governance.dispatch
  || DEFAULT_GOVERNANCE.subagent_dispatch;
```

When the fallback activates (legacy key detected):
- Show a warning banner in the Governance tab: _"Your project uses the legacy `governance.dispatch` key. Run `worca init --upgrade` to migrate."_
- Render values read-only or editable under the old key so users aren't staring at empty fields
- On save, always write to `subagent_dispatch` (effectively migrating via the UI)

In the validator (`settings-validator.js`):
- Accept both `dispatch` and `subagent_dispatch` — reject neither
- When both keys exist, prefer `subagent_dispatch`
- Validation of dispatch values must change: stop checking against `VALID_AGENTS` (pipeline agents) and instead accept any non-empty string (subagent types are open-ended, e.g. `explore`, `feature-dev:code-reviewer`, future plugins)

### 3.3 Settings UI improvements

Since we're touching the dispatch section, improve it from raw comma-separated inputs.

**Denylist notice:**
- Display a small `<sl-alert variant="neutral">` below the dispatch table: _"`general-purpose` is always blocked and cannot be added to dispatch rules."_

**Defaults vs overrides indication:**
- Visually distinguish agents with custom config vs defaults (e.g., a subtle "customized" badge or different input border color)
- Add a per-agent "reset to default" icon button (`<sl-icon-button name="arrow-counterclockwise">`) that restores the value from `DEFAULT_SUBAGENT_DISPATCH`
- When a row matches its default, the reset button is hidden or disabled

### 3.3.1 Tag input with suggestions popup

Replace the current comma-separated `<sl-input>` per agent row with a tag input component. The value space is open-ended (any user-defined agent name is valid) but has a known subset of built-in and common plugin types.

**Note on dual governance layers:** Claude Code has a built-in mechanism for restricting subagent dispatch via `Agent(type1, type2)` in agent `.md` frontmatter `tools` field. That layer filters the model's tool schema (prompt-level — the model never sees disallowed types). worca's `subagent_dispatch` is a runtime hook guard (defense in depth). Both accept the same agent type strings — built-in names (`explore`, `general-purpose`) and user-defined names (`feature-dev:code-reviewer`, custom `.claude/agents/*.md` names).

**Component structure:**

Each agent row renders a `dispatch-tags` container:

```
┌─────────────────────────────────────────────────────┐
│ [explore ×] [feature-dev:code-reviewer ×]  |type..| │
│                                                     │
│  ┌─ suggestions popup ──────────────────────────┐   │
│  │  explore                          (built-in) │   │
│  │  feature-dev:code-reviewer         (plugin)  │   │
│  │  feature-dev:code-architect        (plugin)  │   │
│  │  feature-dev:code-explorer         (plugin)  │   │
│  │  ── custom ──────────────────────────────── │   │
│  │  Press Enter to add "typ..."                 │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

**Behavior:**

1. **Container** — a `div.dispatch-tag-input` styled to look like an input field (border, padding, focus ring). Contains tag chips + a small inline `<input type="text">`.
2. **Tag chips** — each allowed subagent type rendered as a `<sl-tag size="small" removable>`. Click `×` to remove. Known types get a subtle variant color; custom/unknown types rendered plain.
3. **Inline text input** — no border, grows with content. On focus or keydown, shows the suggestions popup below.
4. **Suggestions popup** — a positioned `div.dispatch-suggestions` below the container:
   - Filtered by current input text (fuzzy or prefix match)
   - Excludes types already added as tags
   - Groups: **Built-in** (`explore`) → **Plugin** (known plugin agents) → **Custom** (freeform entry prompt)
   - Denylist items (`general-purpose`) shown greyed out / struck through with tooltip _"Blocked by denylist — cannot be used in pipeline mode"_
   - Click or arrow-key + Enter to select
   - Typing an unknown string and pressing Enter adds it as a custom tag
5. **Keyboard:** Backspace on empty input removes the last tag. Escape closes popup. Tab moves focus out.

**Known types list:**

Built from three sources, in priority order:

| Source | Types | Label |
|--------|-------|-------|
| Hardcoded built-ins | `explore`, `general-purpose`, `Plan` | `(built-in)` |
| Common plugin agents | `feature-dev:code-reviewer`, `feature-dev:code-architect`, `feature-dev:code-explorer` | `(plugin)` |
| Project agents (future) | Scanned from `.claude/agents/*.md` at server startup | `(project)` |

Initially, only the first two sources are implemented. Project agent scanning is a follow-up (requires a server-side API to list discovered agents).

**DOM read function:**

`readGovernanceFromDom()` changes from reading comma-separated `<sl-input>` values to reading tag chip data attributes:

```javascript
const dispatch = {};
for (const agent of AGENT_NAMES) {
  const container = document.getElementById(`dispatch-${agent}`);
  const tags = container?.querySelectorAll('sl-tag') || [];
  dispatch[agent] = Array.from(tags).map(t => t.dataset.value);
}
```

**Styling:**

```css
.dispatch-tag-input {
  display: flex; flex-wrap: wrap; gap: 4px;
  align-items: center; padding: 4px 8px;
  border: 1px solid var(--sl-color-neutral-300);
  border-radius: var(--sl-border-radius-medium);
  min-height: 32px; cursor: text;
}
.dispatch-tag-input:focus-within {
  border-color: var(--sl-color-primary-500);
  box-shadow: 0 0 0 var(--sl-focus-ring-width) var(--sl-color-primary-200);
}
.dispatch-tag-input input {
  border: none; outline: none; flex: 1; min-width: 60px;
  font-size: var(--sl-font-size-small);
  background: transparent;
}
.dispatch-suggestions {
  position: absolute; z-index: 100;
  background: var(--sl-color-neutral-0);
  border: 1px solid var(--sl-color-neutral-200);
  border-radius: var(--sl-border-radius-medium);
  box-shadow: var(--sl-shadow-large);
  max-height: 200px; overflow-y: auto;
}
.dispatch-suggestions .item { padding: 6px 12px; cursor: pointer; }
.dispatch-suggestions .item:hover,
.dispatch-suggestions .item.active { background: var(--sl-color-primary-50); }
.dispatch-suggestions .item.denied {
  opacity: 0.5; text-decoration: line-through; cursor: not-allowed;
}
.dispatch-suggestions .group-label {
  padding: 4px 12px; font-size: 11px; color: var(--sl-color-neutral-500);
  text-transform: uppercase; letter-spacing: 0.05em;
}
```

### 3.4 Dispatch activity visualization in run detail

`subagent_start.py` already emits `pipeline.hook.dispatch_blocked` events with payload `{agent, subagent_type, reason}`. Extend this to also emit allowed dispatches, then surface both in the run detail view.

**Python-side: emit `dispatch_allowed` event**

In `subagent_start.py`, add a success event alongside the existing block event:

```python
code, reason = check_dispatch(parent, child)
if code != 0:
    if emit_from_hook:
        emit_from_hook("pipeline.hook.dispatch_blocked", {...})
    print(reason, file=sys.stderr)
else:
    if emit_from_hook:
        emit_from_hook("pipeline.hook.dispatch_allowed", {
            "agent": parent,
            "subagent_type": child,
        })
sys.exit(code)
```

Add `HOOK_DISPATCH_ALLOWED = "pipeline.hook.dispatch_allowed"` to `events/types.py`.

**UI-side: dispatch event strip in run detail**

In `run-detail.js`, add a `_dispatchEventsView(iter)` function (similar pattern to `_classificationStripView`):

- Render within each stage iteration detail panel, after the classification strip
- Show a compact list of dispatch events for that iteration:
  - Green badge: "explore dispatched" — allowed dispatch
  - Red badge: "explore blocked — tester cannot dispatch explore" — blocked dispatch with reason
- Only visible when the run has dispatch events (no empty-state noise)

**Data flow:**
- Dispatch events are already written to `.worca/events.json` (JSONL) by the event system
- The server needs to expose these events per-run — either:
  - (a) Include dispatch events in the run snapshot/update WebSocket messages (preferred — they're small and infrequent), or
  - (b) Add a `GET /api/projects/:projectId/runs/:runId/events?type=dispatch` endpoint
- Events are keyed to a stage/iteration by their timestamp falling within the iteration's time window

### 3.5 UI files changed

| File | Change |
|------|--------|
| `worca-ui/app/views/settings.js` | Rename `dispatch` → `subagent_dispatch` in DEFAULT_GOVERNANCE, load logic, DOM reads, render. Add legacy fallback with warning banner. Add denylist notice. Replace comma-separated inputs with tag input + suggestions popup (see 3.3.1). |
| `worca-ui/app/views/dispatch-tag-state.js` | **New** — extracted pure state functions for tag input logic (see 5.1). |
| `worca-ui/server/settings-validator.js` | Accept both `dispatch` and `subagent_dispatch`. Change value validation from VALID_AGENTS check to any-string check. |
| `worca-ui/app/views/run-detail.js` | Add `_dispatchEventsView()` for dispatch event strips in iteration detail. |
| `src/worca/claude_hooks/subagent_start.py` | Emit `dispatch_allowed` event on successful dispatch. |
| `src/worca/events/types.py` | Add `HOOK_DISPATCH_ALLOWED` event type and payload builder. |

---

## 4. Files Changed (all)

### Python (worca-cc)

| File | Change |
|------|--------|
| `src/worca/hooks/tracking.py` | Rename constant, add denylist, add config loading with `_settings_override` param, `_reset_dispatch_cache()`, update `check_dispatch` |
| `src/worca/settings.json` | Remove `governance.dispatch`, add `governance.subagent_dispatch` |
| `src/worca/agents/core/plan_reviewer.md` | Update dispatch rule in governance section |
| `src/worca/cli/init.py` | Add `governance.dispatch` → `governance.subagent_dispatch` migration |
| `src/worca/claude_hooks/subagent_start.py` | Emit `dispatch_allowed` event on success |
| `src/worca/events/types.py` | Add `HOOK_DISPATCH_ALLOWED` event type and payload |
| `tests/test_tracking.py` | Update existing tests, add config/denylist/fallback/cache tests |
| `tests/test_init_migration.py` | **New** — settings migration tests for `governance.dispatch` → `governance.subagent_dispatch` |

### UI (@worca/ui)

| File | Change |
|------|--------|
| `worca-ui/app/views/settings.js` | Rename dispatch key, add legacy fallback + warning, denylist notice, tag input with suggestions |
| `worca-ui/app/views/dispatch-tag-state.js` | **New** — extracted pure state functions: `addTag`, `removeTag`, `filterSuggestions`, `isCustomized` |
| `worca-ui/server/settings-validator.js` | Accept both keys, change value validation to any-string |
| `worca-ui/app/views/run-detail.js` | Add `_dispatchEventsView()` for dispatch event strips in iteration detail |
| `worca-ui/server/test/settings-api.test.js` | Update dispatch test payloads, add legacy/migration tests |
| `worca-ui/app/views/dispatch-tag-state.test.js` | **New** — unit tests for tag state logic |
| `worca-ui/app/views/run-detail-dispatch.test.js` | **New** — render tests for dispatch event strips |
| `worca-ui/e2e/settings-dispatch.spec.js` | **New** — Playwright e2e tests for tag input interaction, legacy migration, save round-trip |

---

## 5. Test Plan

### 5.1 Testability design

**Python — settings injection for `_load_subagent_dispatch`:**

`check_dispatch` will call `_load_subagent_dispatch()` which reads `settings.json` from disk. To keep tests fast and deterministic without `tmp_path` fixtures, add an internal `_settings_override` parameter:

```python
_cached_rules: dict | None = None

def _load_subagent_dispatch(settings_override: dict | None = None) -> dict:
    global _cached_rules
    if _cached_rules is not None and settings_override is None:
        return _cached_rules
    # ... rest of loading logic, using settings_override or reading from disk
```

Tests call `_load_subagent_dispatch(settings_override={...})` directly. The cache must be resettable between tests:

```python
def _reset_dispatch_cache():
    global _cached_rules
    _cached_rules = None
```

Use a pytest `autouse` fixture in `test_tracking.py` that calls `_reset_dispatch_cache()` after each test to ensure isolation.

**UI — extract tag input state logic:**

Separate the tag input state management from DOM rendering into pure testable functions (either in `settings.js` or a new `dispatch-tag-state.js`):

```javascript
export function addTag(current, newTag, denylist) { ... }
export function removeTag(current, tag) { ... }
export function filterSuggestions(input, knownTypes, current, denylist) { ... }
export function isCustomized(current, defaults) { ... }
```

These are unit-tested with vitest (fast, no DOM). The DOM rendering and interaction are tested via Playwright e2e.

### 5.2 Python — existing tests to update

| Test | Current | New |
|------|---------|-----|
| `test_blocks_tester_dispatching_anything` | asserts block | asserts allow (explore) |
| `test_plan_reviewer_dispatch_rules_is_empty_set` | asserts empty | asserts `{"explore"}` |
| `test_blocks_plan_reviewer_dispatching_anything` | asserts block | asserts allow (explore) |

### 5.3 Python — new tests in `tests/test_tracking.py`

| Test | Validates |
|------|-----------|
| `test_reviewer_dispatching_explore` | W-037 gap: `reviewer` can dispatch `explore` |
| `test_learner_in_default_dispatch` | `learner` present in `DEFAULT_SUBAGENT_DISPATCH` with empty set |
| `test_denylist_blocks_general_purpose` | `general-purpose` blocked even with no parent agent rule |
| `test_denylist_blocks_general_purpose_even_if_configured` | User config with `general-purpose` is stripped, warning emitted to stderr |
| `test_config_replaces_defaults_per_agent` | User config `implementer: ["explore", "foo"]` overrides default — `foo` allowed, other defaults unchanged |
| `test_config_fallback_for_missing_agent` | Unconfigured agents get `DEFAULT_SUBAGENT_DISPATCH` values |
| `test_config_empty_list_removes_all` | User config `planner: []` removes explore access for planner |
| `test_default_constant_matches_settings_json` | `DEFAULT_SUBAGENT_DISPATCH` keys/values match `src/worca/settings.json` defaults |
| `test_cache_reset_between_config_changes` | After `_reset_dispatch_cache()`, new settings are loaded |

### 5.4 Python — new `tests/test_init_migration.py`

No `test_init.py` exists today. Create `tests/test_init_migration.py` focused on settings migration logic:

| Test | Validates |
|------|-----------|
| `test_migrate_dispatch_to_subagent_dispatch` | `governance.dispatch` key renamed to `governance.subagent_dispatch` |
| `test_migrate_dispatch_replaces_wrong_values` | Old values (pipeline agent names) replaced with new defaults (subagent types) |
| `test_migrate_preserves_other_governance_keys` | `guards`, `test_gate_strikes` untouched during migration |
| `test_migrate_no_op_when_subagent_dispatch_exists` | Already-migrated settings not modified |
| `test_migrate_no_op_when_no_dispatch_key` | Settings without any dispatch key pass through unchanged |

Uses `tmp_path` fixture to create a temporary `settings.json`, calls `_migrate_settings_paths()` directly, asserts on the returned dict.

### 5.5 UI — server API tests (vitest)

Existing tests in `worca-ui/server/test/settings-api.test.js` to update:

| Test | Change |
|------|--------|
| `SAMPLE_SETTINGS` fixture | Change `dispatch` → `subagent_dispatch` with correct values |
| "rejects dispatch arrays containing unknown agent names" | Remove — values are now open-ended strings, not `VALID_AGENTS` |

New tests:

| Test | Validates |
|------|-----------|
| `accepts subagent_dispatch with arbitrary subagent types` | `["explore", "feature-dev:code-reviewer"]` accepted |
| `accepts legacy dispatch key` | Old `governance.dispatch` key passes validation |
| `prefers subagent_dispatch when both keys present` | `subagent_dispatch` wins over `dispatch` |
| `rejects non-array values in subagent_dispatch` | `{ planner: "explore" }` (string, not array) rejected |
| `rejects non-string array elements` | `{ planner: [123] }` rejected |

### 5.6 UI — view render tests (vitest)

New file: `worca-ui/app/views/run-detail-dispatch.test.js`

Follows the existing `renderToString` pattern from `run-detail-circuit-breaker.test.js`:

| Test | Validates |
|------|-----------|
| `renders dispatch allowed events as green badge` | `_dispatchEventsView` with allowed event produces green badge HTML |
| `renders dispatch blocked events as red badge` | Blocked event produces red badge with reason text |
| `renders multiple dispatch events for same iteration` | Two events → two badges |
| `renders nothing when no dispatch events` | No dispatch data → `nothing` (no empty-state noise) |

New file: `worca-ui/app/views/dispatch-tag-state.test.js` (or inline in `settings.test.js`)

Tests the extracted pure state functions:

| Test | Validates |
|------|-----------|
| `addTag adds a new type to the list` | `addTag(["explore"], "foo", denylist)` → `["explore", "foo"]` |
| `addTag rejects duplicate` | `addTag(["explore"], "explore", denylist)` → `["explore"]` (unchanged) |
| `addTag rejects denied type` | `addTag([], "general-purpose", denylist)` → `[]` + returns rejection reason |
| `removeTag removes existing type` | `removeTag(["explore", "foo"], "foo")` → `["explore"]` |
| `filterSuggestions excludes already-added types` | Types in `current` not shown in suggestions |
| `filterSuggestions filters by input prefix` | Input `"feat"` → only `feature-dev:*` types shown |
| `filterSuggestions marks denied types` | `general-purpose` in results has `denied: true` flag |
| `isCustomized returns false when matching defaults` | `["explore"]` for planner matches default → not customized |
| `isCustomized returns true when different from defaults` | `["explore", "foo"]` for planner → customized |

### 5.7 UI — Playwright e2e tests

New file: `worca-ui/e2e/settings-dispatch.spec.js`

Uses the existing `startServer()` fixture from `e2e/fixtures.js`. Writes a `settings.json` to the temp project dir before navigating.

**Test: renders tag input with current dispatch values**
1. Write `settings.json` with `subagent_dispatch: { planner: ["explore"], implementer: ["explore", "feature-dev:code-reviewer"] }`
2. Navigate to settings page → Governance tab
3. Assert `planner` row has 1 tag chip ("explore")
4. Assert `implementer` row has 2 tag chips ("explore", "feature-dev:code-reviewer")

**Test: add a known subagent type via suggestions**
1. Start with default settings
2. Click into the `tester` tag input → type "exp"
3. Assert suggestions popup appears with "explore" highlighted
4. Click "explore" suggestion
5. Assert "explore" tag chip added to `tester` row

**Test: add a custom freeform subagent type**
1. Click into the `implementer` tag input → type "my-custom-agent"
2. Press Enter
3. Assert "my-custom-agent" tag chip added

**Test: remove a tag chip**
1. Start with `planner: ["explore"]`
2. Click the × on the "explore" chip
3. Assert chip removed, input is now empty

**Test: denied type shown greyed out in suggestions**
1. Click into any agent input → type "general"
2. Assert suggestions popup shows "general-purpose" with `denied` styling (greyed, struck-through)
3. Click it → assert it is NOT added as a tag

**Test: reset to default**
1. Start with `implementer: ["explore", "custom-thing"]` (customized)
2. Assert "reset to default" button visible for implementer row
3. Click reset button
4. Assert implementer row now shows only default tags (["explore"])

**Test: legacy key shows warning banner and migrates on save**
1. Write `settings.json` with old `governance.dispatch` key (no `subagent_dispatch`)
2. Navigate to settings → Governance tab
3. Assert migration warning banner visible ("Run `worca init --upgrade` to migrate")
4. Assert dispatch values still rendered from the legacy key
5. Click Save
6. Read `settings.json` from temp dir → assert `subagent_dispatch` key present, `dispatch` key absent

**Test: save round-trip preserves all dispatch values**
1. Start with default settings
2. Add "feature-dev:code-reviewer" to `implementer`
3. Click Save
4. Reload page
5. Assert `implementer` row still shows both "explore" and "feature-dev:code-reviewer"

### 5.8 Test execution summary

| Layer | Tool | Command | Files | Speed |
|-------|------|---------|-------|-------|
| Python dispatch logic | pytest | `pytest tests/test_tracking.py` | `tests/test_tracking.py` | Fast (<1s) |
| Python migration | pytest | `pytest tests/test_init_migration.py` | `tests/test_init_migration.py` (new) | Fast (<1s) |
| UI server API | vitest | `cd worca-ui && npx vitest run server/test/settings-api.test.js` | `server/test/settings-api.test.js` | Fast (<2s) |
| UI tag state logic | vitest | `cd worca-ui && npx vitest run app/views/dispatch-tag-state.test.js` | `app/views/dispatch-tag-state.test.js` (new) | Fast (<1s) |
| UI dispatch strips | vitest | `cd worca-ui && npx vitest run app/views/run-detail-dispatch.test.js` | `app/views/run-detail-dispatch.test.js` (new) | Fast (<1s) |
| UI e2e interaction | Playwright | `cd worca-ui && npx playwright test e2e/settings-dispatch.spec.js --workers=1` | `e2e/settings-dispatch.spec.js` (new) | Slow (~15s) |

All tests run in CI. Playwright tests must use `--workers=1` (serial) per CLAUDE.md.

---

## 6. Breaking Changes

| What | Impact | Mitigation |
|------|--------|------------|
| `governance.dispatch` removed from settings.json | None — key was never read by Python code | `worca init --upgrade` migrates to new key; UI reads both keys with fallback |
| `DISPATCH_RULES` renamed to `DEFAULT_SUBAGENT_DISPATCH` | Tests that import `DISPATCH_RULES` by name break | Update tests in same PR |
| `tester` and `plan_reviewer` can now dispatch `explore` | Changes behavior for running pipelines | Intentional — explore is read-only, no governance risk |
| `reviewer` added to dispatch rules | Previously fell through to empty set (blocked) | Bug fix — reviewer was always intended to have explore |
| UI validator no longer checks dispatch values against `VALID_AGENTS` | Freeform subagent type strings now accepted | Intentional — subagent types are open-ended (plugins, custom agents) |

---

## 7. Out of Scope

- Pipeline-level agent spawning rules (coordinator → implementer) — this is governed by agent prompts, not settings.
- Subagent dispatch for agents not in the worca pipeline (e.g., custom user agents).
- Runtime validation that configured subagent types actually exist as installed plugins — mismatches cause dispatch failures at runtime (same as today for typos), documented but not prevented.
- Dispatch rule visualization in run detail sidebar (effective rules per-run) — potential follow-up.
