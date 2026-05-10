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

**Current state:** `stages.py:80-87` already contains `_resolve_model(shorthand, model_map)` which resolves model shorthands to full IDs. `get_stage_config()` at `stages.py:113-117` calls it:

```python
model_map = worca.get("models", {})
raw_model = agent_config.get("model", "sonnet")
return {
    "agent": agent_name,
    "model": _resolve_model(raw_model, model_map),  # already resolved ID
    ...
}
```

The runner at `runner.py:1039` calls `get_stage_config()` and receives an already-resolved model string at `:1056` via `config.get("model")`. Separately, `work_request.py:71` hard-codes `--model haiku` and calls `subprocess.run` directly (no `get_stage_config()` path).

**Obstacle:** `_resolve_model()` does `model_map.get(shorthand, ...)` which returns the raw value — with the new schema this can be a dict `{"id": "x", "env": {...}}` instead of a string. Custom names like `alt-fast` also won't be recognized by the Claude CLI's own shorthand handling. The function must handle both forms and surface the env dict to callers.

**Resolution:** add a public `resolve_model()` in `settings.py` (alongside `normalize_model_entry`), then update `stages.py:_resolve_model` and `get_stage_config()` to use it and surface `model_env` in the returned config dict.

```python
# src/worca/utils/settings.py — new public resolver
_DEFAULT_MODEL_MAP = {
    "opus": "claude-opus-4-6",
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5-20251001",
}

def resolve_model(name, models_cfg):
    """Look up a model shorthand in a worca.models config dict.

    Returns (resolved_id, env_dict). When the name is not in models_cfg,
    falls back to _DEFAULT_MODEL_MAP, then treats it as an opaque
    pass-through ID (preserves today's behaviour where users can put
    a full Anthropic ID in the agent config).
    """
    if name is None:
        return None, {}
    raw = models_cfg.get(name, _DEFAULT_MODEL_MAP.get(name))
    if raw is None:
        return name, {}
    entry = normalize_model_entry(raw)
    return entry["id"], entry["env"]
```

```python
# src/worca/orchestrator/stages.py — update _resolve_model + get_stage_config
from worca.utils.settings import resolve_model

def _resolve_model(shorthand, model_map):
    """Resolve a model shorthand to (full_id, env_dict)."""
    return resolve_model(shorthand, model_map)

def get_stage_config(stage, settings_path=".claude/settings.json"):
    ...
    model_map = worca.get("models", {})
    raw_model = agent_config.get("model", "sonnet")
    model_id, model_env = _resolve_model(raw_model, model_map)
    return {
        "agent": agent_name,
        "model": model_id,
        "model_env": model_env,       # NEW — env dict for subprocess injection
        "max_turns": agent_config.get("max_turns", 30),
        "schema": STAGE_SCHEMA_MAP.get(stage, f"{stage.value}.json"),
    }
```

The `_DEFAULT_MODEL_MAP` currently defined at `stages.py:73-77` is moved into `settings.py` alongside `resolve_model`, and `stages.py` no longer needs its own copy (it delegates entirely). This keeps fallback logic in one place.

Call sites:

- `runner.py:1056` (`run_stage`): `config` already comes from `get_stage_config()` — add `model_env=config.get("model_env")` to the `run_agent()` call. No duplicate resolution needed.
- `runner.py:1834` (`run_iteration` stage launch path): same — `stage_config` already comes from `get_stage_config()`, thread `model_env`.
- `work_request.py:71` (`generate_smart_title`): hard-codes `--model haiku`. Import `resolve_model` from `settings.py`, resolve `"haiku"` through it, and use the returned `(id, env)` in the `subprocess.run` call. This is the only call site that needs to call `resolve_model` directly because it bypasses `get_stage_config()`.

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

### 5a. Settings validator — dynamic model validation

**Current state:** `worca-ui/server/settings-validator.js:16` hardcodes `VALID_MODELS = ['opus', 'sonnet', 'haiku']` and `:30` hardcodes `VALID_PRICING_MODELS = ['opus', 'sonnet']`. The `validateSettingsPayload(body)` function rejects any `worca.agents.<name>.model` value not in `VALID_MODELS` (`:66`), any `worca.pricing.models.<name>` key not in `VALID_PRICING_MODELS` (`:204`), and any `worca.circuit_breaker.classifier_model` value not in `VALID_MODELS` (`:868-869`).

**Obstacle:** with user-defined models (e.g. `alt-fast`), a `PUT /api/settings` request containing `worca.agents.implementer.model = "alt-fast"` would be rejected with HTTP 400, even though the same payload includes `worca.models.alt-fast`. The UI Models tab would let users create models that can never be assigned to agents.

**Resolution:** make the valid model list dynamic within `validateSettingsPayload()`. Derive it from the incoming payload's `worca.models` keys (since the UI sends the full `worca` object on each PUT), unioned with the three built-in defaults.

```js
// settings-validator.js — replace hardcoded constants with a dynamic derivation
const DEFAULT_MODELS = ['opus', 'sonnet', 'haiku'];
const DEFAULT_PRICING_MODELS = ['opus', 'sonnet'];

export function validateSettingsPayload(body) {
  const details = [];
  if (body.worca !== undefined) {
    ...
    const w = body.worca;

    // Derive valid models from the payload's worca.models keys + defaults
    const configuredModels = w.models && typeof w.models === 'object' && !Array.isArray(w.models)
      ? Object.keys(w.models)
      : [];
    const validModels = [...new Set([...DEFAULT_MODELS, ...configuredModels])];
    const validPricingModels = [...new Set([...DEFAULT_PRICING_MODELS, ...configuredModels])];

    // agents — use validModels instead of VALID_MODELS
    ...
    if (cfg.model !== undefined && !validModels.includes(cfg.model)) { ... }

    // pricing — use validPricingModels instead of VALID_PRICING_MODELS
    ...
    if (!validPricingModels.includes(model)) { ... }

    // circuit_breaker.classifier_model — use validModels
    ...
    if (w.circuit_breaker?.classifier_model !== undefined &&
        !validModels.includes(w.circuit_breaker.classifier_model)) { ... }
  }
}
```

The exported `VALID_MODELS` constant is kept for backward compatibility with any test that imports it, but it becomes `DEFAULT_MODELS` semantically — the validator no longer uses it as the sole source of truth. Alternatively, remove the export and update tests to use the dynamic derivation.

**Second validation path:** `worca-ui/server/preferences-routes.js:6` independently hardcodes `const VALID_MODELS = ['opus', 'sonnet', 'haiku']` and uses it at `:75-76` to validate `worca.circuit_breaker.classifier_model` in the global preferences endpoint (`validateGlobalSettingsPayload`). This is a separate code path from `settings-validator.js` and must also be updated, or custom models will be rejected when set through the global preferences UI. Both validators are refactored to share a `deriveValidModels(worcaObj)` helper from `worca-ui/server/model-validation.js` to prevent drift.

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

### Phase 1 — schema + loader normalization + resolver

**Files:** `src/worca/utils/settings.py`, `src/worca/orchestrator/stages.py`, `tests/test_settings_normalize.py` (new), `tests/test_model_resolver.py` (new)

**Tasks:**
1. Add `normalize_model_entry()` to `settings.py` and unit tests covering: string form, full object form, missing `id`, non-dict env, extra keys.
2. Move `_DEFAULT_MODEL_MAP` from `stages.py:73-77` into `settings.py`. Add `resolve_model(name, models_cfg)` to `settings.py` (public function, returns `(id, env)` tuple).
3. Update `stages.py:_resolve_model` to delegate to `settings.resolve_model`. Update `get_stage_config()` to return `model_env` in its result dict.
4. Unit tests for `resolve_model` (known string, known object, unknown passthrough, None name, normalize errors).

### Phase 2 — subprocess env injection + runner/work_request wiring

**Files:** `src/worca/utils/env.py`, `src/worca/utils/claude_cli.py`, `src/worca/orchestrator/runner.py`, `src/worca/orchestrator/work_request.py`

**Tasks:**
1. Add `RESERVED_ENV_KEYS`, `RESERVED_PREFIXES`, `filter_model_env()` to `env.py`.
2. Add `model_env` parameter to `claude_cli.run_agent()`; thread through `subprocess.Popen` env. Log dropped reserved keys to stderr.
3. Update `runner.py` call site at `:1056` to pass `model_env=config.get("model_env")` to `run_agent()`. Update `:1834` similarly.
4. Update `work_request.py:71` (`generate_smart_title`) to import `resolve_model` from `settings.py`, resolve `"haiku"` through it, and pass the resolved ID + env to `subprocess.run`.
5. Unit tests for `filter_model_env` (every reserved key, every prefix match, valid pass-through).

### Phase 3 — worktree propagation

**Files:** `src/worca/utils/runtime.py`, `tests/test_runtime_propagate.py`

**Tasks:**
1. Add `"models"` to `PROPAGATED_LOCAL_WORCA_KEYS`.
2. Test: parent has `settings.local.json` with `worca.models.foo.env.SECRET = "x"`, worktree's `settings.json` after `copy_claude_config()` contains the merged value.

### Phase 4 — UI: dynamic model list + Models tab + validators

**Files:** `worca-ui/app/views/settings.js`, `worca-ui/server/settings-validator.js`, `worca-ui/server/preferences-routes.js`, `worca-ui/app/views/settings-models.test.js` (new), `worca-ui/server/settings-validator.test.js` (update), `worca-ui/server/preferences-routes.test.js` (update)

**Tasks:**
1. Replace `MODEL_OPTIONS` and `PRICING_MODELS` constants with `getModelKeys(worca)`. Update `agentsTab`, `pricingTab`, `readAgentsFromDom`, `readPricingFromDom` accordingly.
2. Make `settings-validator.js` model validation dynamic: derive valid models from incoming `body.worca.models` keys + the three defaults, replacing the hardcoded `VALID_MODELS` at `:16` and `VALID_PRICING_MODELS` at `:30`. Update all three validation sites: `agents.<name>.model` (`:66`), `pricing.models.<name>` (`:204`), and `circuit_breaker.classifier_model` (`:868-869`).
3. Update `preferences-routes.js` to use the same dynamic model derivation. `preferences-routes.js:6` hardcodes `VALID_MODELS = ['opus', 'sonnet', 'haiku']` and uses it at `:75-76` to validate `worca.circuit_breaker.classifier_model` in the global preferences endpoint (`validateGlobalSettingsPayload`). Extract a shared helper `deriveValidModels(worcaObj)` into a new `worca-ui/server/model-validation.js` utility (returns `[...new Set([...DEFAULT_MODELS, ...Object.keys(worcaObj?.models || {})])]`) and use it from both `settings-validator.js` and `preferences-routes.js`. This prevents the two validators from drifting.
4. Add `modelsTab(worca, rerender)` rendering one card per model with id + env-rows + actions.
5. Wire the new tab into `settingsView`'s `<sl-tab-group>` (`settings.js:2194`).
6. Save handler writes back via existing `PUT /api/settings`.
7. Add validator tests: custom model accepted when included in `worca.models`; custom model rejected when `worca.models` is absent or doesn't include it; pricing accepts custom models; circuit_breaker.classifier_model accepts custom models. Add preferences-routes tests: custom model accepted for `classifier_model` when present in `worca.models`; rejected when absent.

### Phase 5 — UI: Secrets panel + endpoints

**Files:** `worca-ui/server/secrets-routes.js` (new), `worca-ui/server/app.js`, `worca-ui/app/views/secrets-modal.js` (new), `worca-ui/server/secrets-routes.test.js` (new)

**Tasks:**
1. Implement `GET /api/settings/secrets` and `PUT /api/settings/secrets` per §10. Mount inside the `createApp()` function in `worca-ui/server/app.js` — import the secrets router and add it via `app.use('/api/settings/secrets', createSecretsRouter({ ... }))` alongside the existing project-scoped routes.
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
| `src/worca/utils/settings.py` | Add `normalize_model_entry()`, `resolve_model()`, `_DEFAULT_MODEL_MAP` |
| `src/worca/orchestrator/stages.py` | Update `_resolve_model` to delegate to `settings.resolve_model`; `get_stage_config()` returns `model_env` |
| `src/worca/utils/env.py` | Add `RESERVED_ENV_KEYS`, `RESERVED_PREFIXES`, `filter_model_env()` |
| `src/worca/utils/claude_cli.py` | Add `model_env` param to `run_agent()`, merge into Popen env |
| `src/worca/orchestrator/runner.py` | Thread `config["model_env"]` through to `run_agent()` at stage launch sites |
| `src/worca/orchestrator/work_request.py` | Resolve `"haiku"` via `settings.resolve_model` for the work-request subprocess |
| `src/worca/utils/runtime.py` | Add `"models"` to `PROPAGATED_LOCAL_WORCA_KEYS` |
| `worca-ui/app/views/settings.js` | Dynamic model list; new Models tab |
| `worca-ui/server/settings-validator.js` | Dynamic model validation: derive valid models from payload's `worca.models` keys + defaults |
| `worca-ui/app/views/secrets-modal.js` | **NEW** — secrets modal component |
| `worca-ui/server/secrets-routes.js` | **NEW** — `/api/settings/secrets` GET+PUT |
| `worca-ui/server/app.js` | Mount the new secrets route inside `createApp()` |
| `worca-ui/server/model-validation.js` | **NEW** — shared `deriveValidModels(worcaObj)` helper used by both validators |
| `worca-ui/server/preferences-routes.js` | Replace hardcoded `VALID_MODELS` with dynamic derivation via `model-validation.js` |
| `worca-ui/server/reserved-env-keys.json` | **NEW** — shared denylist |
| `tests/test_settings_normalize.py` | **NEW** |
| `tests/test_model_resolver.py` | **NEW** |
| `tests/test_filter_model_env.py` | **NEW** |
| `tests/test_runtime_propagate.py` | Extend with models-allowlist test |
| `worca-ui/app/views/settings-models.test.js` | **NEW** |
| `worca-ui/server/secrets-routes.test.js` | **NEW** |
| `worca-ui/server/settings-validator.test.js` | Extend with dynamic model validation tests |
| `worca-ui/server/preferences-routes.test.js` | Extend with dynamic model validation tests for global preferences |
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

The test pyramid mirrors the implementation phases: phase-1/2/3 are covered by Python unit + integration tests, phase-4/5 by Vitest, and phase-6 (docs) is covered by a single fixture round-trip plus manual smoke. Each test below names the file to put it in, the public API it exercises, and the precise assertion — implementer should not need to invent shape.

### Unit Tests (Python)

All new tests follow the existing `tests/test_<module>.py` naming. New files: `tests/test_settings_normalize.py`, `tests/test_filter_model_env.py`, `tests/test_model_resolver.py`. `test_runtime_propagate.py` already exists and gains one new case. `tests/test_stages.py` (if it exists) gains cases for the updated `get_stage_config()` return shape.

#### `tests/test_settings_normalize.py` — `worca.utils.settings.normalize_model_entry`

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_normalize_string_form` | `normalize_model_entry("claude-opus-4-6")` | Returns `{"id": "claude-opus-4-6", "env": {}}` |
| `test_normalize_full_object` | `normalize_model_entry({"id": "x", "env": {"K": "v"}})` | Returns `{"id": "x", "env": {"K": "v"}}` (env is a copy, not the same object) |
| `test_normalize_object_no_env` | `normalize_model_entry({"id": "x"})` | `env` defaults to `{}` |
| `test_normalize_extra_keys_ignored` | `normalize_model_entry({"id": "x", "env": {}, "future_field": 42})` | No raise; extras dropped silently — keeps schema forward-compatible |
| `test_normalize_missing_id_raises` | `normalize_model_entry({"env": {}})` | `ValueError` whose message names the offending shape |
| `test_normalize_id_not_string_raises` | `normalize_model_entry({"id": 42})` | `ValueError` |
| `test_normalize_env_not_dict_raises` | `normalize_model_entry({"id": "x", "env": "not-a-dict"})` | `ValueError` mentioning `dict` |
| `test_normalize_unknown_type_raises` | `normalize_model_entry(42)` | `ValueError` |

#### `tests/test_filter_model_env.py` — `worca.utils.env.filter_model_env`

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_filter_passes_through_anthropic_keys` | `filter_model_env({"ANTHROPIC_BASE_URL": "u", "API_TIMEOUT_MS": "5000"})` | Both keys preserved; `dropped == []` |
| `test_filter_strips_path` | `filter_model_env({"PATH": "/tmp"})` | Returns `({}, ["PATH"])` |
| `test_filter_strips_claudecode` | `filter_model_env({"CLAUDECODE": "1"})` | Returns `({}, ["CLAUDECODE"])` |
| `test_filter_strips_worca_prefix` | `filter_model_env({"WORCA_FOO": "x", "WORCA_RUN_ID": "y"})` | Both dropped |
| `test_filter_mixed_pass_and_strip` | `{"ANTHROPIC_AUTH_TOKEN": "sk", "PATH": "/tmp", "WORCA_X": "v"}` | Safe = `{"ANTHROPIC_AUTH_TOKEN": "sk"}`, dropped sorted = `["PATH", "WORCA_X"]` |
| `test_filter_coerces_values_to_str` | `filter_model_env({"ANTHROPIC_BASE_URL": 42})` | Value becomes `"42"` (`subprocess.Popen` requires str env values) |
| `test_filter_empty_input` | `filter_model_env({})` | Returns `({}, [])` |
| `test_reserved_keys_match_shared_json_file` | Loads `worca-ui/server/reserved-env-keys.json` | `RESERVED_ENV_KEYS == set(json["keys"])` and `RESERVED_PREFIXES == tuple(json["prefixes"])` — guards against drift |

#### `tests/test_model_resolver.py` — `worca.utils.settings.resolve_model`

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_resolve_known_string` | `resolve_model("opus", {"opus": "claude-opus-4-6"})` | Returns `("claude-opus-4-6", {})` |
| `test_resolve_known_object` | `resolve_model("alt", {"alt": {"id": "x", "env": {"A": "1"}}})` | Returns `("x", {"A": "1"})` |
| `test_resolve_unknown_passthrough` | `resolve_model("custom-id", {})` | Returns `("custom-id", {})` — preserves today's "full-ID-as-shorthand" behavior |
| `test_resolve_falls_back_to_default_map` | `resolve_model("opus", {})` | Returns `("claude-opus-4-6", {})` — falls back to `_DEFAULT_MODEL_MAP` when not in `models_cfg` |
| `test_resolve_none_name` | `resolve_model(None, {})` | Returns `(None, {})` (covers `config.get("model")` returning None) |
| `test_resolve_propagates_normalize_errors` | `resolve_model("bad", {"bad": {"env": {}}})` (no id) | `ValueError` from `normalize_model_entry` bubbles up |

#### `tests/test_stages.py` — `get_stage_config` returns `model_env`

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_stage_config_returns_model_env_for_object_model` | Settings with `worca.models.custom = {id: "x", env: {K: "v"}}`, `worca.agents.planner.model = "custom"` | `get_stage_config(Stage.PLAN)["model_env"] == {"K": "v"}` |
| `test_stage_config_returns_empty_env_for_string_model` | Settings with `worca.models.opus = "claude-opus-4-6"` | `get_stage_config(Stage.PLAN)["model_env"] == {}` |
| `test_stage_config_model_still_resolved_to_id` | Settings with `worca.models.custom = {id: "full-id", env: {}}` | `get_stage_config(...)["model"] == "full-id"` (not the shorthand) |

#### `tests/test_runtime_propagate.py` — extend existing file

Add `test_propagate_models_into_worktree`:

```python
def test_propagate_models_into_worktree(tmp_path):
    # Parent: settings.local.json has worca.models.alt.env.SECRET = "s"
    src = tmp_path / "src"; src.mkdir()
    (src / "settings.local.json").write_text(json.dumps({
        "worca": {"models": {"alt": {"env": {"SECRET": "s"}}}}
    }))
    # Worktree: settings.json with worca.models.alt.id only
    dst = tmp_path / "dst"; dst.mkdir()
    (dst / "settings.json").write_text(json.dumps({
        "worca": {"models": {"alt": {"id": "x", "env": {"PUBLIC": "p"}}}}
    }))
    propagate_runtime_local_keys(str(src), str(dst))
    merged = json.loads((dst / "settings.json").read_text())
    assert merged["worca"]["models"]["alt"]["env"] == {"PUBLIC": "p", "SECRET": "s"}
    assert merged["worca"]["models"]["alt"]["id"] == "x"
```

Plus a negative case `test_propagate_models_when_models_not_in_allowlist` is N/A (this PR adds it). Keep the existing webhooks/events tests untouched.

#### Existing Python tests to update

- `tests/test_settings.py` (loader smoke tests) — assert that an object-form entry survives `load_settings` deep-merge unchanged when both files agree, and that `settings.local.json` `env` keys merge into the parent's `env` map (verifies deep_merge handles the nested case).
- `tests/test_claude_cli.py` — add a test for `run_agent(..., model_env={"WORCA_FOO": "1", "ANTHROPIC_BASE_URL": "http://x"})` that monkeypatches `subprocess.Popen` and asserts the captured `env` kwarg contains `ANTHROPIC_BASE_URL` but not `WORCA_FOO`, and that the stderr capture mentions the dropped key.
- `tests/test_work_request.py` (or add one if absent) — verify `extract_work_request` resolves `"haiku"` through `resolve_model` (decision #2: routing through the resolver). Mock the settings to map `haiku` to a custom id+env, monkeypatch `subprocess.run`, assert the captured `--model` arg matches the custom id and the captured env contains the custom env.

### Unit Tests (JS / Vitest)

All new tests live next to their source (`worca-ui/app/views/*.test.js` or `worca-ui/server/*.test.js`) per the existing convention. Vitest config already auto-discovers them.

#### `worca-ui/app/views/settings-models.test.js` (new)

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_get_model_keys_returns_configured_keys` | `getModelKeys({models: {opus: "x", "alt-fast": {id: "y"}}})` | `["opus", "alt-fast"]` (insertion order preserved) |
| `test_get_model_keys_falls_back_to_defaults` | `getModelKeys({})` and `getModelKeys(undefined)` | `["opus", "sonnet", "haiku"]` |
| `test_models_tab_renders_card_per_model` | Render `modelsTab(worca)` with two entries | Two `.model-card` nodes; ids in DOM match config |
| `test_models_tab_save_strips_object_form_when_env_empty` | Save handler with `{id: "x", env: {}}` row | Outgoing PUT body has `models.x = "x"` (string form), not the object form |
| `test_models_tab_save_keeps_object_form_when_env_present` | Env row with `{ANTHROPIC_BASE_URL: "u"}` | Outgoing body has `models.x = {id: "x", env: {ANTHROPIC_BASE_URL: "u"}}` |
| `test_models_tab_secret_keys_render_masked_readonly` | Render with secrets-API response marking key as `secret` | Input shows `••••••••` and is `disabled` |
| `test_models_tab_delete_model_removes_card` | Click "Delete model" on second card | Card removed from DOM; agents-tab dropdown reactively shrinks |

#### `worca-ui/app/views/secrets-modal.test.js` (new)

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_modal_lists_keys_with_source_tags` | Mount modal with API response containing `public`, `secret`, `override` keys | Each row carries the right badge label |
| `test_modal_set_secret_calls_put_local_only` | Type new secret, click Save | Captures `PUT /api/settings/secrets` with `{model, key, value}`; no `PUT /api/settings` |
| `test_modal_clear_secret_sends_null_value` | Click "Clear" on a secret row | PUT body has `value: null` |
| `test_modal_focused_input_unmasked_then_masked_on_blur` | Focus a secret row's input | While focused, value shows plain; on blur, dots return — DOM-level assertion via `:focus` simulation |

#### `worca-ui/server/settings-validator.test.js` (extend existing)

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_custom_model_accepted_when_in_models` | Payload has `worca.models["alt-fast"] = {id: "x"}` and `worca.agents.implementer.model = "alt-fast"` | Validation passes — no details for the model |
| `test_custom_model_rejected_when_not_in_models` | Payload has `worca.agents.implementer.model = "alt-fast"` but no `worca.models` | Validation fails with `Invalid model "alt-fast"` |
| `test_custom_pricing_model_accepted` | Payload has `worca.models["alt-fast"]` and `worca.pricing.models["alt-fast"]` | Validation passes |
| `test_circuit_breaker_custom_model_accepted` | Payload has `worca.models["alt-fast"]` and `worca.circuit_breaker.classifier_model = "alt-fast"` | Validation passes |
| `test_default_models_always_valid` | Payload with no `worca.models` but `worca.agents.planner.model = "opus"` | Validation passes — defaults are always accepted |

#### `worca-ui/server/preferences-routes.test.js` (extend existing)

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_global_prefs_custom_classifier_model_accepted` | Payload has `worca.models["alt-fast"] = {id: "x"}` and `worca.circuit_breaker.classifier_model = "alt-fast"` | Validation passes |
| `test_global_prefs_custom_classifier_model_rejected_when_not_in_models` | Payload has `worca.circuit_breaker.classifier_model = "alt-fast"` but no `worca.models` | Validation fails |
| `test_global_prefs_default_models_always_valid` | Payload with `worca.circuit_breaker.classifier_model = "opus"`, no `worca.models` | Validation passes |

#### `worca-ui/server/secrets-routes.test.js` (new)

Pattern follows existing `worca-ui/server/*.test.js` (tmpdir + supertest). Each test creates a tmp `.claude/` with a fresh `settings.json` and `settings.local.json`.

| Test | Setup | Assertion |
|------|-------|-----------|
| `test_put_writes_to_local_only` | `PUT /api/settings/secrets` with `{model: "alt", key: "TOKEN", value: "sk"}` | `settings.local.json` updated; `settings.json` byte-identical to before |
| `test_put_atomic_via_temp_rename` | Mock `fs.rename` to throw; PUT | No partial write — `settings.local.json` unchanged on disk |
| `test_put_rejects_reserved_key` | PUT with `{key: "PATH"}` | Status 400; body mentions `PATH`; no file write |
| `test_put_rejects_reserved_prefix` | PUT with `{key: "WORCA_FOO"}` | Status 400 |
| `test_put_null_value_deletes_key` | Seed local with the key, then PUT with `value: null` | Key removed; if `env` becomes empty, `env` key removed too (keep JSON minimal) |
| `test_put_rejects_empty_model_name` | PUT with `model: ""` | Status 400 |
| `test_get_marks_public_secret_override` | Local has `{TOKEN: "sk"}`, public has `{BASE_URL: "u", TOKEN: "old"}` | Response: `BASE_URL` source `public`, `TOKEN` source `override`, value masked for both `secret` and `override` |
| `test_get_returns_empty_for_unconfigured_model` | Empty config | Returns `{ok: true, models: {}}` |
| `test_reserved_keys_loaded_from_shared_json` | At server boot | Module reads `worca-ui/server/reserved-env-keys.json` and uses it for validation; deleting the file at startup raises a clear error (mirror Python source-of-truth test) |

### Integration Tests

#### `tests/integration/test_model_env_injection.py` (new)

This validates the end-to-end path: agent stage → resolver → subprocess env → mock claude → result. Uses the existing `pipeline_env` fixture in `tests/integration/conftest.py`.

The mock claude already supports a `run_command` directive (`tests/mock_claude/mock_claude.py:144-145`) that runs an arbitrary shell command before emitting its result. Use this to dump the subprocess env to a tmpfile — **no mock_claude changes needed**.

The `pipeline_env` fixture (defined in `tests/integration/conftest.py`) exposes `pipeline_env.run(scenario, prompt)` — settings are written to `project/.claude/settings.json` at fixture setup time. To inject custom settings for these tests, write directly to the fixture's settings file before calling `run()`.

```python
import json

def test_model_env_reaches_subprocess(pipeline_env):
    env_dump = pipeline_env.tmp_path / "planner-env.txt"

    # Patch settings.json on disk before running the pipeline.
    # pipeline_env.project is the project root; settings live at .claude/settings.json.
    settings_path = pipeline_env.project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {})["models"] = {
        "opus": "claude-opus-4-6",
        "custom-fast": {
            "id": "claude-haiku-4-5-20251001",
            "env": {"PIPELINE_TEST_MARKER": "hello-from-models-env"},
        },
    }
    settings["worca"].setdefault("agents", {})["planner"] = {
        "model": "custom-fast", "max_turns": 10
    }
    settings_path.write_text(json.dumps(settings))

    scenario = {
        "agents": {
            "planner": {
                "action": "succeed",
                "run_command": f"env > {env_dump}",
            },
            "default": {"action": "succeed"},
        }
    }
    pipeline_env.run(scenario, "smoke")

    dump = env_dump.read_text()
    assert "PIPELINE_TEST_MARKER=hello-from-models-env" in dump  # env reached subprocess
    assert "WORCA_AGENT=planner" in dump  # the legitimate reserved key survives
```

Note: `PIPELINE_TEST_MARKER` does not match the `WORCA_*` reserved prefix, so it passes through `filter_model_env` and reaches the subprocess. This validates the happy path for non-reserved model env vars.

Add a second test in the same file:

```python
def test_reserved_key_in_model_env_is_stripped_with_warning(pipeline_env):
    env_dump = pipeline_env.tmp_path / "planner-env.txt"

    settings_path = pipeline_env.project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    settings.setdefault("worca", {})["models"] = {
        "custom": {
            "id": "claude-haiku-4-5-20251001",
            "env": {
                "PATH": "/tmp/should-be-stripped",
                "ANTHROPIC_BASE_URL": "http://localhost:1",
            },
        },
    }
    settings["worca"].setdefault("agents", {})["planner"] = {
        "model": "custom", "max_turns": 10
    }
    settings_path.write_text(json.dumps(settings))

    scenario = {
        "agents": {
            "planner": {
                "action": "succeed",
                "run_command": f"env > {env_dump}",
            },
            "default": {"action": "succeed"},
        }
    }
    result = pipeline_env.run(scenario, "x")

    dump = env_dump.read_text()
    assert "PATH=/tmp/should-be-stripped" not in dump  # silent-strip in effect (decision #3a)
    assert "ANTHROPIC_BASE_URL=http://localhost:1" in dump  # non-reserved passes through
    # Stderr warning surfaced (decision #3a — visibility via stderr)
    assert "model env keys dropped (reserved)" in result.stderr
    assert "PATH" in result.stderr
```

#### `tests/integration/test_work_request_routing.py` (new)

Validates **decision #2** (work_request routes through the resolver). Smaller scope than full pipeline — exercises only `generate_smart_title` (`work_request.py:54`), the function that hard-codes `--model haiku`.

```python
def test_generate_smart_title_uses_resolver_for_haiku(monkeypatch, tmp_path):
    settings = {"worca": {"models": {
        "haiku": {"id": "custom-haiku-id",
                  "env": {"ANTHROPIC_BASE_URL": "http://custom"}}}}}
    captured = {}
    def fake_run(cmd, **kw):
        captured["cmd"] = cmd; captured["env"] = kw["env"]
        class R: returncode = 0; stdout = "Title"; stderr = ""
        return R()
    monkeypatch.setattr("worca.orchestrator.work_request.subprocess.run", fake_run)
    monkeypatch.setattr("worca.orchestrator.work_request.load_settings", lambda *a, **kw: settings)
    generate_smart_title("Some content to title")
    assert "--model" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--model") + 1] == "custom-haiku-id"
    assert captured["env"]["ANTHROPIC_BASE_URL"] == "http://custom"
```

### Existing Tests to Update

- `tests/test_stages.py` (if existing) — update any test that asserts on `get_stage_config()` return keys, since the dict now includes `model_env`. Existing tests that destructure only `agent`, `model`, `max_turns`, `schema` should continue to work (extra key is harmless with dict access).
- `worca-ui/app/views/settings-pricing-haiku.test.js` and any test asserting exactly three pricing rows — drive the assertion off `getModelKeys(worca)` instead of a hardcoded count.
- `worca-ui/app/views/settings-form-roundtrip.test.js` — add a case where input `worca.models = {opus: "x", alt: {id: "y", env: {K: "v"}}}` round-trips through render→read unchanged.
- `worca-ui/server/settings-validator.test.js` — existing tests that use `VALID_MODELS` export may need updating if the export is removed or renamed. Grep before starting: `cd worca-ui && grep -rn "VALID_MODELS" app/ server/`.
- Any test importing the `MOCK_CLAUDE_OPTIONS` / `MODEL_OPTIONS` constant — switch to the new helper. Grep before starting: `cd worca-ui && grep -rn "MODEL_OPTIONS" app/ server/`.
- `tests/test_claude_cli.py` (existing) — extend the `build_command` test set with a case asserting `--model` always receives the resolved id, never the shorthand, when the runner has done its job (this is a contract test, not a behavioral change).

### Done criteria

All of these must be green before opening the PR:

1. `pytest tests/` — all unit + integration tests pass on a clean checkout.
2. `pytest tests/integration/test_model_env_injection.py tests/integration/test_work_request_routing.py` specifically — these are the new behavior-validating tests.
3. `cd worca-ui && npx vitest run` — all UI unit tests pass.
4. `cd worca-ui && npm run lint` — biome is strict in CI, fix before commit.
5. `cd worca-ui && npm pack --dry-run | grep secrets-routes && npm pack --dry-run | grep secrets-modal` — verify the new files ship in the npm package (per CLAUDE.md's "files allowlist" guidance).
6. `python scripts/coverage.py ci --include-unit-tests` — coverage of new code in `settings.py` (`normalize_model_entry`, `resolve_model`), the `filter_model_env` helper, and the secrets routes is ≥ 90%.
7. **Manual smoke (cannot be automated):** configure a model with `env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999"` (deliberately unreachable), assign it to the planner, run `worca run --prompt "smoke"`, and verify the planner stage's logged subprocess error references the configured base URL — proves end-to-end that the env reaches the real `claude` subprocess, not just the mock.
8. **Manual UI smoke:** in the UI, add a new model in the Models tab, set a public env var, save; open Secrets modal, set a token, save; reload page; verify (a) settings.json contains only the public env, (b) settings.local.json contains only the secret, (c) the Models tab shows the secret as masked + override-tagged.

## Files to Create/Modify

See "Files Changed Summary" table above.

## Out of Scope

- **Per-agent env overrides.** Env attaches to the *model*; if two agents need different envs they reference different models. Per-agent overrides can be added later as a deep-merge layer if a real use case appears.
- **`$VAR` interpolation in env values.** Out of v1; values are literal.
- **Non-env Claude Code settings** (e.g. `skipWebFetchPreflight`). Those live in Claude Code's own `settings.json` and are not replicated through this feature.
- **Auto-detection of third-party pricing.** Pricing is user-entered.
- **Secrets stored anywhere other than `settings.local.json`.** No keychain / OS secret store integration in v1.
- **Multi-server coordination of `settings.local.json` writes.** The Secrets panel assumes a single UI server (same assumption the rest of the UI server makes today).
