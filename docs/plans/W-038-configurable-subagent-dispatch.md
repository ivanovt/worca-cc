# W-038: Configurable Subagent Dispatch Rules

**Goal:** Replace the hardcoded `DISPATCH_RULES` dict in `tracking.py` with a configurable, settings-driven `subagent_dispatch` system. Grant `explore` access to `tester` and `plan_reviewer`. Fix the missing `reviewer` entry (W-037 gap). Add a hardcoded denylist for dangerous subagent types.

**Why:** Today `DISPATCH_RULES` is a frozen Python dict that projects cannot customize without patching the package. Meanwhile, a dead `governance.dispatch` key exists in `settings.json` that is never read and contains semantically wrong values. As the plugin ecosystem grows (feature-dev, hookify, etc.), teams need to tailor subagent access per pipeline agent without forking.

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

## 3. Files Changed

| File | Change |
|------|--------|
| `src/worca/hooks/tracking.py` | Rename constant, add denylist, add config loading, update `check_dispatch` |
| `src/worca/settings.json` | Remove `governance.dispatch`, add `governance.subagent_dispatch` |
| `src/worca/agents/core/plan_reviewer.md` | Update dispatch rule in governance section |
| `src/worca/cli/init.py` | Add `governance.dispatch` → `governance.subagent_dispatch` migration |
| `tests/test_tracking.py` | Update existing tests, add config/denylist/fallback tests |

---

## 4. Test Plan

### Existing tests to update

| Test | Current | New |
|------|---------|-----|
| `test_blocks_tester_dispatching_anything` | asserts block | asserts allow (explore) |
| `test_plan_reviewer_dispatch_rules_is_empty_set` | asserts empty | asserts `{"explore"}` |
| `test_blocks_plan_reviewer_dispatching_anything` | asserts block | asserts allow (explore) |

### New tests

| Test | Validates |
|------|-----------|
| `test_reviewer_dispatching_explore` | W-037 gap: `reviewer` can dispatch `explore` |
| `test_denylist_blocks_general_purpose` | `general-purpose` blocked even with no parent agent rule |
| `test_denylist_blocks_general_purpose_even_if_configured` | User config with `general-purpose` is stripped |
| `test_config_replaces_defaults_per_agent` | User config `implementer: ["explore", "foo"]` overrides default |
| `test_config_fallback_for_missing_agent` | Unconfigured agents get `DEFAULT_SUBAGENT_DISPATCH` values |
| `test_config_empty_list_removes_all` | User config `planner: []` removes explore access |
| `test_default_constant_matches_settings_json` | `DEFAULT_SUBAGENT_DISPATCH` keys/values match `settings.json` defaults |
| `test_settings_migration_renames_dispatch_key` | `worca init --upgrade` renames `governance.dispatch` → `governance.subagent_dispatch` |

---

## 5. Breaking Changes

| What | Impact | Mitigation |
|------|--------|------------|
| `governance.dispatch` removed from settings.json | None — key was never read by any code | `worca init --upgrade` migrates to new key |
| `DISPATCH_RULES` renamed to `DEFAULT_SUBAGENT_DISPATCH` | Tests that import `DISPATCH_RULES` by name break | Update tests in same PR |
| `tester` and `plan_reviewer` can now dispatch `explore` | Changes behavior for running pipelines | Intentional — explore is read-only, no governance risk |
| `reviewer` added to dispatch rules | Previously fell through to empty set (blocked) | Bug fix — reviewer was always intended to have explore |

---

## 6. Out of Scope

- Pipeline-level agent spawning rules (coordinator → implementer) — this is governed by agent prompts, not settings.
- Subagent dispatch for agents not in the worca pipeline (e.g., custom user agents).
- Runtime validation that configured subagent types actually exist as installed plugins — mismatches cause dispatch failures at runtime (same as today for typos), documented but not prevented.
