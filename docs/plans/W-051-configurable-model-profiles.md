# W-051: Configurable Model Profiles with Per-Model Env Vars

**Status:** Draft
**Priority:** P2
**Area:** cc + ui
**Date:** 2026-05-10
**Depends on:** None

## Problem

`worca.models.<name>` is a flat string-to-string map: shorthand → full model ID (`src/worca/settings.json:142-146`). Agents reference a model by shorthand (`worca.agents.<agent>.model`), and the runner passes that shorthand verbatim to `claude -p --model` (`src/worca/utils/claude_cli.py:145-146`, `src/worca/orchestrator/runner.py:1056`). The subprocess inherits whatever environment is in `os.environ` plus a fixed set of overrides set by `get_env()` (`src/worca/utils/env.py:26-43`) — there is no per-agent or per-model way to inject environment variables.

This means a worca user cannot:

1. Point a single stage (e.g. `implementer`) at an alternative endpoint by setting `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` for *that* agent only — the closest workaround is exporting them globally, which forces *every* agent through the same endpoint and breaks the per-stage cost story.
2. Tune `API_TIMEOUT_MS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, or `MAX_THINKING_TOKENS` on a per-stage basis — these are Claude-Code-CLI env vars with no first-class config surface.
3. Run heterogeneous pipelines (e.g. a cheap third-party endpoint for the implementer loop while keeping planner/reviewer on Anthropic) without a hand-rolled wrapper script.

User-facing impact: power users who want to experiment with alternative providers, per-stage model tuning, or local proxy routing have no way to express the configuration in worca's own settings — they must either rebuild the runner or globally pollute their shell environment.

## Proposal

Extend `worca.models.<name>` from `string` to `string | { id: string, env?: Record<string, string> }`. The string form is preserved for backward compatibility and remains the default for the three built-in entries (`opus`, `sonnet`, `haiku`). Any agent referencing a model entry that carries an `env` map will have those variables merged into the subprocess environment when its stage runs. Secrets live in `settings.local.json` (already deep-merged by `load_settings()`) under the same `worca.models.<name>.env` path, with a UI "Secrets" panel that writes there exclusively. A reserved-key denylist prevents `model.env` from clobbering worca's own internal env vars (`WORCA_*`, `PATH`, `CLAUDECODE`).

## Design

### 1. Schema — polymorphic model entries

**Current state:** `src/worca/settings.json:142-146`

```jsonc
"models": {
  "opus":   "claude-opus-4-6",
  "sonnet": "claude-sonnet-4-6",
  "haiku":  "claude-haiku-4-5-20251001"
}
```

**Resolution:** value becomes `string | { id, env? }`. Both shapes accepted at every consumer; loader normalizes to object form internally.

```jsonc
// settings.json (committed)
"worca": {
  "models": {
    "opus":   "claude-opus-4-6",                    // string form preserved
    "sonnet": "claude-sonnet-4-6",
    "haiku":  "claude-haiku-4-5-20251001",

    "alt-fast": {                                   // new: object form with env
      "id": "some-fast-model-id",
      "env": {
        "ANTHROPIC_BASE_URL": "https://api.example.com/v1",
        "API_TIMEOUT_MS": "3000000",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8192"
      }
    }
  },
  "agents": {
    "implementer": { "model": "alt-fast", "max_turns": 300 }
  },
  "pricing": {
    "models": {
      "alt-fast": { "input_per_mtok": 0.50, "output_per_mtok": 2.00, ... }
    }
  }
}
```

```jsonc
// settings.local.json (gitignored, deep-merged over settings.json by load_settings)
"worca": {
  "models": {
    "alt-fast": { "env": { "ANTHROPIC_AUTH_TOKEN": "sk-..." } }
  }
}
```

After deep-merge, `worca.models["alt-fast"].env` contains both the public endpoint vars and the secret token. The string form continues to mean "no env, default routing — Claude Code resolves the shorthand or full ID itself".

### 2. Loader normalization

**Current state:** `src/worca/utils/settings.py:45` `load_settings()` returns the merged dict as-is. Consumers read `worca.models[name]` and assume it's a string.

**Resolution:** add a small normalization helper (no new file required) that consumers can call to get the canonical shape.

```python
# src/worca/utils/settings.py — new helper
def normalize_model_entry(value):
    """Canonicalize a worca.models entry to {id, env} form.

    - String value → {"id": value, "env": {}}
    - Dict value → must contain "id" (str); "env" defaults to {}; extra keys ignored.
    - Anything else → raise ValueError with a pointer to the offending key.
    """
    if isinstance(value, str):
        return {"id": value, "env": {}}
    if isinstance(value, dict) and isinstance(value.get("id"), str):
        env = value.get("env") or {}
        if not isinstance(env, dict):
            raise ValueError(f"model env must be a dict, got {type(env).__name__}")
        return {"id": value["id"], "env": dict(env)}
    raise ValueError(f"model entry must be a string ID or {{id, env}} object")
```

Normalization is *on read*, not on save — settings.json keeps whichever form the user wrote. The UI editor (§6) writes the object form for any model that has env vars and the string form for those that don't, to keep the JSON minimal.

### 3. Resolver — name → (id, env)

**Current state:** the runner currently does `config["model"]` (a shorthand) and threads it directly through to `--model` (`src/worca/orchestrator/runner.py:1056`, `:1855`; `src/worca/orchestrator/work_request.py:71`). Today this works because Claude Code's CLI resolves common shorthands like `opus`/`sonnet`/`haiku` itself.

**Obstacle:** custom names like `alt-fast` will not be recognized by Claude Code's CLI. The runner must resolve the name to the underlying `id` before invoking the subprocess.

**Resolution:** add a single resolver function that the runner consults before each agent invocation.

```python
# src/worca/orchestrator/model_resolver.py — new module
from worca.utils.settings import normalize_model_entry

def resolve_model(name: str, models_cfg: dict) -> tuple[str, dict[str, str]]:
    """Look up a model shorthand in worca.models.

    Returns (resolved_id, env_dict). When the name is not in worca.models,
    treats it as an opaque pass-through ID (preserves today's behaviour
    where users can put a full Anthropic ID in the agent config).
    """
    raw = models_cfg.get(name)
    if raw is None:
        return name, {}
    entry = normalize_model_entry(raw)
    return entry["id"], entry["env"]
```

Call sites (sequential changes):

- `runner.py:1056` (`run_stage`): `model_id, model_env = resolve_model(config.get("model"), settings["worca"]["models"])`. Pass `model_id` to `--model`, `model_env` to subprocess env.
- `runner.py:1855` (`run_iteration` stage launch path): same.
- `work_request.py:71` (`extract_work_request`): hard-codes `--model haiku`. Resolve `"haiku"` through the same path so a user who customized the haiku entry still gets the right routing for work-request extraction.

### 4. Subprocess env injection + reserved-key denylist

**Current state:** `src/worca/utils/claude_cli.py:332-335`

```python
proc = subprocess.Popen(
    cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, env=get_env(WORCA_AGENT=agent_name), start_new_session=True,
)
```

`get_env(**overrides)` (`src/worca/utils/env.py:26-43`) does `env = os.environ.copy(); ...; env.update(overrides)` — overrides win over `os.environ`.

**Resolution:** thread a `model_env` dict through `run_agent` and merge it. Add an explicit, *checked* denylist so model env cannot break worca's hooks or PATH plumbing.

```python
# src/worca/utils/env.py — new constant + helper
RESERVED_ENV_KEYS = frozenset({
    "PATH",
    "CLAUDECODE",
    "WORCA_AGENT",
    "WORCA_PROJECT_ROOT",
    "WORCA_RUN_ID",
    "WORCA_RUN_DIR",
    "WORCA_PLAN_FILE",
    "WORCA_EVENTS_PATH",
    "WORCA_TARGET_BRANCH",
    "WORCA_COVERAGE",
    "WORCA_SKIP_BEADS",
    "WORCA_CLAUDE_BIN",
})
# Anything matching WORCA_* is also reserved (catch-all for future vars).
RESERVED_PREFIXES = ("WORCA_",)


def filter_model_env(model_env: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Strip reserved keys from a model env dict.

    Returns (safe_env, dropped_keys). Caller is expected to log dropped keys
    so misconfigurations are visible to the user instead of silently ignored.
    """
    safe, dropped = {}, []
    for k, v in model_env.items():
        if k in RESERVED_ENV_KEYS or any(k.startswith(p) for p in RESERVED_PREFIXES):
            dropped.append(k)
            continue
        safe[k] = str(v)
    return safe, dropped
```

```python
# src/worca/utils/claude_cli.py — run_agent gains model_env arg
def run_agent(
    prompt, agent, max_turns=0, output_format="stream-json",
    json_schema=None, model=None, model_env=None,
    log_path=None, on_event=None,
):
    ...
    safe_env, dropped = filter_model_env(model_env or {})
    if dropped:
        print(
            f"[worca] model env keys dropped (reserved): {sorted(dropped)}",
            file=sys.stderr,
        )
    proc = subprocess.Popen(
        cmd, ..., env=get_env(WORCA_AGENT=agent_name, **safe_env),
        start_new_session=True,
    )
```

The `dict.update()` order in `get_env()` already guarantees that explicit kwargs (here: `WORCA_AGENT` and any safe model env) win over `os.environ`. Reserved-key filtering happens *before* that merge, so a hypothetical bad config like `model.env.PATH = "/tmp"` is silently stripped (with a warning to stderr) rather than corrupting the subprocess's tool resolution.

`work_request.py` calls `subprocess.run(["claude", ...], env=get_env())` directly (`:71-75`) — it gets the same treatment via a small refactor: introduce `get_env_for_model(model_env)` that wraps `get_env(**filter_model_env(model_env)[0])` so all three call sites use the same merged env.

### 5. CLI `--model` value

`build_command()` (`claude_cli.py:89-159`) takes `model` and emits `--model <model>`. With resolution moved upstream (§3), this argument is now always the resolved ID — no behavioural change in `build_command` itself. Documenting it: the contract becomes "the model arg passed here is the value the CLI receives verbatim", which is what `build_command`'s callers already assume.

### 6. UI — Models tab (new) and dynamic model dropdown

**Current state:**
- `worca-ui/app/views/settings.js:1-160` defines `MODEL_OPTIONS` (the model shorthand list used in `agentsTab`) and `PRICING_MODELS` (the pricing tab keys) as module-level constants.
- `agentsTab` (`settings.js:654`) renders an `<sl-select>` populated from `MODEL_OPTIONS`.
- `readPricingFromDom` (`settings.js:622`) iterates `PRICING_MODELS`.

**Resolution:** make the model list dynamic, sourced from `worca.models` at render time.

```js
// settings.js — replace the hardcoded constants with derived values

function getModelKeys(worca) {
  const models = (worca && worca.models) || {};
  // Preserve insertion order; fall back to the three defaults if nothing is configured.
  const keys = Object.keys(models);
  return keys.length > 0 ? keys : ['opus', 'sonnet', 'haiku'];
}

// agentsTab uses getModelKeys(worca) instead of MODEL_OPTIONS.
// pricingTab + readPricingFromDom iterate getModelKeys(worca).
```

**New "Models" tab.** A sibling to the existing tabs in `settingsView` (`settings.js:2194-2215`). Renders a card per `worca.models.<name>` entry. Each card:

- Editable `id` text input.
- Editable env-var table (key/value rows). Values *not* present in `settings.local.json` are shown plain. Values *present* in `settings.local.json` are shown masked (`••••••••`) and read-only with a "manage in Secrets" hint.
- "Add row" / "Remove row" buttons.
- "Add model" / "Delete model" buttons at the tab level.
- Save button writes the non-secret env keys back to `settings.json` via the existing `PUT /api/settings` endpoint.

Layout: cards laid out the same way as `agentsTab` for visual consistency.

### 7. UI — Secrets panel (new)

**Current state:** the UI server reads/writes `.claude/settings.json` only (`worca-ui/server/project-routes.js`). `settings.local.json` is currently invisible to the UI.

**Resolution:** add a focused Secrets panel that writes only to `settings.local.json`, never to the committed `settings.json`. New endpoints:

- `GET /api/settings/secrets` — returns a redacted view of `worca.models.<name>.env` for every model, marking each key as either `"public"` (defined in `settings.json`), `"secret"` (defined in `settings.local.json`), or `"override"` (defined in both — `settings.local.json` wins per deep-merge). Values for `"secret"` and `"override"` keys are returned masked.
- `PUT /api/settings/secrets` — accepts `{ model: string, key: string, value: string | null }`. `null` value deletes. Writes only to `settings.local.json`.

**UI surface:** a modal opened from a "Manage secrets" button on each Models-tab card. The modal lists all env keys for that model, marks which are public vs secret, and allows secret values to be set/cleared. Plain-text values for fields the user is currently typing are visible only while focused; otherwise masked.

**Why a separate panel rather than inline editing in the Models tab:** mixing committed and gitignored config in the same form is the existing footgun this plan is trying to avoid. A dedicated panel makes "this writes a secret to a gitignored file" explicit in the UI, the same way `git config --global` is the explicit habit for sensitive shell config. The split also keeps the Models tab safely shareable (e.g. for screenshots, support tickets) without leaking tokens.

### 8. Pricing tab — already keyed by model name

`worca.pricing.models` is keyed by the same shorthand as `worca.models` (`src/worca/settings.json:153-178`). With `getModelKeys(worca)` from §6 driving both tabs, adding a new model in the Models tab will automatically surface a row in the Pricing tab on the next render. Default values for newly-added models: zeros (the user explicitly fills them in for non-Anthropic providers).

The token-usage aggregator (`src/worca/utils/token_usage.py`) already keys cost computation by the resolved model returned in the `result` event from the CLI — no changes needed. The only caveat is the `_resolved_model` field set in `process_stream()` (`claude_cli.py:288`) comes from the upstream provider's response, so for non-Anthropic endpoints the cost math depends entirely on the user filling in the pricing tab correctly. This is documented in §9.

### 9. Worktree propagation

**Current state:** `src/worca/utils/runtime.py:14` `PROPAGATED_LOCAL_WORCA_KEYS = ("webhooks", "events")`. `copy_claude_config()` skips `settings.local.json` entirely (`runtime.py:95`), then `propagate_runtime_local_keys()` merges only the allowlisted keys from the parent's `settings.local.json` into the worktree's `settings.json`.

**Obstacle:** in worktree mode, secrets stored in the parent's `settings.local.json` would not reach the worktree's runtime, so any agent referencing a model with secret env would fail.

**Resolution:** add `"models"` to the allowlist.

```python
# src/worca/utils/runtime.py — extend the allowlist
PROPAGATED_LOCAL_WORCA_KEYS = ("webhooks", "events", "models")
```

Effect: at worktree creation, secrets are *materialized* into the worktree's `settings.json` on disk. The worktree directory is gitignored (per CLAUDE.md), so the secret never enters git. This is the same on-disk plaintext exposure as today's `~/.aws/credentials` style — acceptable, but documented in §11.

### 10. UI server endpoints

**`GET /api/settings/secrets`**

```jsonc
// Response
{
  "ok": true,
  "models": {
    "alt-fast": {
      "ANTHROPIC_BASE_URL":  { "source": "public", "value": "https://api.example.com/v1" },
      "ANTHROPIC_AUTH_TOKEN":{ "source": "secret", "value": "••••••••" },
      "API_TIMEOUT_MS":      { "source": "public", "value": "3000000" }
    }
  }
}
```

**`PUT /api/settings/secrets`**

```jsonc
// Request
{ "model": "alt-fast", "key": "ANTHROPIC_AUTH_TOKEN", "value": "sk-..." }
// Or to delete:
{ "model": "alt-fast", "key": "ANTHROPIC_AUTH_TOKEN", "value": null }
```

Server logic:

1. Load `settings.local.json` (or `{}`).
2. Set/delete `worca.models[<model>].env[<key>]`.
3. Atomically write `settings.local.json` (write-to-temp-then-rename, same pattern used elsewhere in `worca-ui/server`).
4. Return `{ ok: true }` or `{ ok: false, error: "..." }`.

Validation: reject keys matching `RESERVED_ENV_KEYS` or `RESERVED_PREFIXES` (mirror Python denylist via a shared JSON file). Reject empty model names.

### 11. Documentation

- `CLAUDE.md` — short subsection in "Configuration" describing the `{id, env}` shape, how to use `settings.local.json` for secrets, and the worktree-materialization note.
- `MIGRATION.md` — no migration required (purely additive); a one-line "you can now do X" entry is sufficient.

## Implementation Plan

### Phase 1 — schema + loader normalization

**Files:** `src/worca/utils/settings.py`, `tests/test_settings_normalize.py` (new)

**Tasks:**
1. Add `normalize_model_entry()` and unit tests covering: string form, full object form, missing `id`, non-dict env, extra keys.

### Phase 2 — resolver + subprocess env injection

**Files:** `src/worca/orchestrator/model_resolver.py` (new), `src/worca/utils/env.py`, `src/worca/utils/claude_cli.py`, `src/worca/orchestrator/runner.py`, `src/worca/orchestrator/work_request.py`

**Tasks:**
1. Add `resolve_model()` in a new module (keeps `runner.py` from growing further).
2. Add `RESERVED_ENV_KEYS`, `RESERVED_PREFIXES`, `filter_model_env()` to `env.py`.
3. Add `model_env` parameter to `claude_cli.run_agent()`; thread through `subprocess.Popen` env. Log dropped reserved keys to stderr.
4. Update `runner.py` call sites at `:1056` and `:1855` to resolve and pass `model_env`.
5. Update `work_request.py:71` (`extract_work_request`) and `:211`, `:234` to use `get_env_for_model()`.
6. Unit tests for `filter_model_env` (every reserved key, every prefix match, valid pass-through).

### Phase 3 — worktree propagation

**Files:** `src/worca/utils/runtime.py`, `tests/test_runtime_propagate.py`

**Tasks:**
1. Add `"models"` to `PROPAGATED_LOCAL_WORCA_KEYS`.
2. Test: parent has `settings.local.json` with `worca.models.foo.env.SECRET = "x"`, worktree's `settings.json` after `copy_claude_config()` contains the merged value.

### Phase 4 — UI: dynamic model list + Models tab

**Files:** `worca-ui/app/views/settings.js`, `worca-ui/app/views/settings-models.test.js` (new)

**Tasks:**
1. Replace `MODEL_OPTIONS` and `PRICING_MODELS` constants with `getModelKeys(worca)`. Update `agentsTab`, `pricingTab`, `readAgentsFromDom`, `readPricingFromDom` accordingly.
2. Add `modelsTab(worca, rerender)` rendering one card per model with id + env-rows + actions.
3. Wire the new tab into `settingsView`'s `<sl-tab-group>` (`settings.js:2194`).
4. Save handler writes back via existing `PUT /api/settings`.

### Phase 5 — UI: Secrets panel + endpoints

**Files:** `worca-ui/server/secrets-routes.js` (new), `worca-ui/server/server.js`, `worca-ui/app/views/secrets-modal.js` (new), `worca-ui/server/secrets-routes.test.js` (new)

**Tasks:**
1. Implement `GET /api/settings/secrets` and `PUT /api/settings/secrets` per §10. Mount via `server.js`.
2. Add a JSON file `worca-ui/server/reserved-env-keys.json` containing the same denylist used by Python; both languages read it.
3. Build the modal component (single-model scope, opened from the Models tab).
4. Vitest tests for the routes (write to a tmp `settings.local.json`, assert atomic rename, assert reserved-key rejection).

### Phase 6 — docs + CLAUDE.md note

**Files:** `CLAUDE.md`, `MIGRATION.md`

**Tasks:**
1. Add the configuration subsection.
2. One-line entry in `MIGRATION.md`.

### Files Changed Summary

| File | Change |
|------|--------|
| `src/worca/utils/settings.py` | Add `normalize_model_entry()` |
| `src/worca/utils/env.py` | Add `RESERVED_ENV_KEYS`, `RESERVED_PREFIXES`, `filter_model_env()` |
| `src/worca/utils/claude_cli.py` | Add `model_env` param to `run_agent()`, merge into Popen env |
| `src/worca/orchestrator/model_resolver.py` | **NEW** — `resolve_model(name, models_cfg) -> (id, env)` |
| `src/worca/orchestrator/runner.py` | Resolve model + thread `model_env` at stage launch sites |
| `src/worca/orchestrator/work_request.py` | Same for the work-request subprocess |
| `src/worca/utils/runtime.py` | Add `"models"` to `PROPAGATED_LOCAL_WORCA_KEYS` |
| `worca-ui/app/views/settings.js` | Dynamic model list; new Models tab |
| `worca-ui/app/views/secrets-modal.js` | **NEW** — secrets modal component |
| `worca-ui/server/secrets-routes.js` | **NEW** — `/api/settings/secrets` GET+PUT |
| `worca-ui/server/server.js` | Mount the new route |
| `worca-ui/server/reserved-env-keys.json` | **NEW** — shared denylist |
| `tests/test_settings_normalize.py` | **NEW** |
| `tests/test_filter_model_env.py` | **NEW** |
| `tests/test_runtime_propagate.py` | Extend with models-allowlist test |
| `worca-ui/app/views/settings-models.test.js` | **NEW** |
| `worca-ui/server/secrets-routes.test.js` | **NEW** |
| `CLAUDE.md` | Configuration subsection |
| `MIGRATION.md` | One-line entry |

## Considerations

- **Backward compatibility:** purely additive. Existing settings.json files with the string form continue to work unchanged. The three default models (`opus`, `sonnet`, `haiku`) keep their string shape and continue to resolve through Claude Code's built-in shorthand handling.
- **Pricing for non-default models:** when a user adds a custom model, the pricing tab will show zeros until they fill it in. Cost telemetry for that model will report `$0.00` — surfacing this clearly in the UI (a "no pricing configured" hint on the pricing card) avoids silent cost-tracking holes. Out of scope: auto-detecting third-party pricing.
- **Secrets on disk:** even in the `settings.local.json`-only path, secrets are plain text on the developer's machine — same exposure as `~/.aws/credentials`. In worktree mode they additionally land in the worktree's `settings.json`, which is gitignored but plain text. This matches existing behaviour for any `WORCA_*` env var the developer already exports.
- **Reserved-key denylist must be kept in sync** between Python and JS. The shared `reserved-env-keys.json` is the single source of truth; both languages load it at module init. Tests in both ecosystems assert the file is the source.
- **`work_request.extract_work_request` hard-codes `--model haiku`** (`work_request.py:71`). Resolving through the same path means a user who replaces their `haiku` entry with a custom-routed alternative also affects work-request extraction. This is desired (consistent routing for everything that calls `claude`), but worth documenting in CLAUDE.md.
- **No env var interpolation:** values written to `settings.local.json` are stored literally. Users wanting `$VAR` substitution must do it themselves at write time. Keeping the v1 contract simple.
- **Breaking changes:** none.
- **Migration:** none required. New schema is opt-in via the object form.

## Test Plan

### Unit Tests (Python)

| Layer | Test | Validates |
|-------|------|-----------|
| `utils/settings` | `test_normalize_string_form` | String value returns `{id, env: {}}` |
| `utils/settings` | `test_normalize_object_form` | Full object preserved |
| `utils/settings` | `test_normalize_missing_id_raises` | Object without `id` raises ValueError |
| `utils/settings` | `test_normalize_bad_env_raises` | Non-dict env raises ValueError |
| `utils/env` | `test_filter_model_env_strips_path` | `PATH` is dropped |
| `utils/env` | `test_filter_model_env_strips_worca_prefix` | `WORCA_FOO` is dropped |
| `utils/env` | `test_filter_model_env_passes_anthropic_keys` | `ANTHROPIC_BASE_URL` passes through |
| `orchestrator/model_resolver` | `test_resolve_known_string` | Returns `(id, {})` for string entry |
| `orchestrator/model_resolver` | `test_resolve_known_object` | Returns `(id, env_dict)` for object entry |
| `orchestrator/model_resolver` | `test_resolve_unknown_passthrough` | Unknown name returns `(name, {})` |
| `utils/runtime` | `test_propagate_models_into_worktree` | Parent local env reaches worktree settings.json |

### Unit Tests (JS / Vitest)

| Layer | Test | Validates |
|-------|------|-----------|
| `views/settings` | `test_get_model_keys_uses_worca_models` | Dynamic list reflects config |
| `views/settings` | `test_models_tab_renders_each_model_card` | One card per entry |
| `views/settings` | `test_models_tab_save_writes_string_form_when_no_env` | Minimal JSON for env-less models |
| `server/secrets-routes` | `test_put_writes_to_local_only` | settings.json untouched |
| `server/secrets-routes` | `test_put_rejects_reserved_key` | Returns 400 for `PATH` |
| `server/secrets-routes` | `test_get_marks_overrides` | `source` field correctly tagged |

### Integration Tests

- A new pipeline integration test (`tests/integration/test_model_env_injection.py`) configures a model entry with a benign env var (e.g. `WORCA_TEST_MARKER=hello`), runs the mock claude CLI, and asserts the marker reaches the subprocess. The mock claude in `tests/mock_claude/mock_claude.py` already echoes its env on demand — extend it minimally if needed.

### Existing Tests to Update

- `worca-ui/app/views/settings-pricing-haiku.test.js` and other tests that assert exactly three pricing rows — update to drive the assertion off `getModelKeys(worca)` rather than a hardcoded count.
- `worca-ui/app/views/settings-form-roundtrip.test.js` — add a case where `worca.models` contains an object-form entry; assert the round-trip preserves it.
- Any test depending on the constant value of `MODEL_OPTIONS` will need to read from the new helper.

### Done criteria

- All new and updated tests pass.
- `pytest tests/`, `cd worca-ui && npx vitest run`, `cd worca-ui && npm run lint` are green.
- Manual smoke: configure a model with `env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999"` (a deliberately unreachable endpoint), assign it to the planner, run `worca run-pipeline --prompt …`, and verify the planner stage's logged subprocess error references the configured base URL.

## Files to Create/Modify

See "Files Changed Summary" table above.

## Out of Scope

- **Per-agent env overrides.** Env attaches to the *model*; if two agents need different envs they reference different models. Per-agent overrides can be added later as a deep-merge layer if a real use case appears.
- **`$VAR` interpolation in env values.** Out of v1; values are literal.
- **Non-env Claude Code settings** (e.g. `skipWebFetchPreflight`). Those live in Claude Code's own `settings.json` and are not replicated through this feature.
- **Auto-detection of third-party pricing.** Pricing is user-entered.
- **Secrets stored anywhere other than `settings.local.json`.** No keychain / OS secret store integration in v1.
- **Multi-server coordination of `settings.local.json` writes.** The Secrets panel assumes a single UI server (same assumption the rest of the UI server makes today).
