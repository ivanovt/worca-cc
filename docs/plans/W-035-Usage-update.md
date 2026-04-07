# W-035: Complete Usage Object Logging & Cost Display

## Problem

The Claude API returns a rich `usage` object per turn with fields we currently ignore:

```json
{
  "usage": {
    "input_tokens": 14,
    "cache_creation_input_tokens": 56131,
    "cache_read_input_tokens": 489722,
    "output_tokens": 9229,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 56131,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "",
    "speed": "standard"
  },
  "modelUsage": {
    "claude-opus-4-6": {
      "webSearchRequests": 0,
      "costUSD": 0.8264747499999999,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  }
}
```

**What we capture today** (in `extract_token_usage`): `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.

**What we miss**: `server_tool_use` (web search/fetch counts), `cache_creation.ephemeral_1h_input_tokens`/`ephemeral_5m_input_tokens`, `speed`. We also don't use `modelUsage.*.webSearchRequests`, `contextWindow`, or `maxOutputTokens`.

We need to:
1. Log the complete usage object so we have a full audit trail
2. Extend cost settings to account for server tool use pricing
3. Show the new data in the UI without overwhelming users

---

## Part 1: Log Complete Usage Object

### Goal

Capture every field from the `usage` object and `modelUsage` so future analysis isn't blocked by missing data. Even if we don't display a field today, it should be in the logs.

### Changes

#### 1a. `src/worca/utils/token_usage.py` — extend `extract_token_usage`

Add new fields to the extracted dict:

```python
def extract_token_usage(raw_envelope: dict) -> dict:
    usage = raw_envelope.get("usage") or {}
    server_tool_use = usage.get("server_tool_use") or {}
    cache_creation = usage.get("cache_creation") or {}

    return {
        # Existing fields (unchanged)
        "input_tokens": usage.get("input_tokens", 0) or 0,
        "output_tokens": usage.get("output_tokens", 0) or 0,
        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens", 0) or 0,
        "cache_read_input_tokens": usage.get("cache_read_input_tokens", 0) or 0,
        "total_cost_usd": raw_envelope.get("total_cost_usd", 0) or 0,
        "duration_ms": raw_envelope.get("duration_ms", 0) or 0,
        "duration_api_ms": raw_envelope.get("duration_api_ms", 0) or 0,
        "num_turns": raw_envelope.get("num_turns", 0) or 0,
        "model": raw_envelope.get("_resolved_model") or raw_envelope.get("model", ""),

        # New fields
        "web_search_requests": server_tool_use.get("web_search_requests", 0) or 0,
        "web_fetch_requests": server_tool_use.get("web_fetch_requests", 0) or 0,
        "cache_ephemeral_1h_tokens": cache_creation.get("ephemeral_1h_input_tokens", 0) or 0,
        "cache_ephemeral_5m_tokens": cache_creation.get("ephemeral_5m_input_tokens", 0) or 0,
        "speed": usage.get("speed", ""),
    }
```

Update `_empty_token_usage` and `_SUMMABLE_FIELDS` accordingly. `web_search_requests` and `web_fetch_requests` are summable. `cache_ephemeral_*` are summable. `speed` is not summable (metadata).

#### 1b. `_SUMMABLE_FIELDS` update

```python
_SUMMABLE_FIELDS = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "total_cost_usd",
    "duration_ms",
    "duration_api_ms",
    "num_turns",
    # New
    "web_search_requests",
    "web_fetch_requests",
    "cache_ephemeral_1h_tokens",
    "cache_ephemeral_5m_tokens",
]
```

#### 1c. `aggregate_by_model` — add new fields

Add `web_search_requests` and `web_fetch_requests` to the per-model aggregate dict:

```python
by_model[model] = {
    ...existing fields...,
    "web_search_requests": 0,
    "web_fetch_requests": 0,
}
entry["web_search_requests"] += usage.get("web_search_requests", 0) or 0
entry["web_fetch_requests"] += usage.get("web_fetch_requests", 0) or 0
```

#### 1d. Event payloads — extend `cost_stage_total_payload`

Add optional fields to the stage total event so events.jsonl captures them:

```python
def cost_stage_total_payload(
    stage, iteration, cost_usd, input_tokens, output_tokens, model,
    cache_creation_input_tokens=0,
    cache_read_input_tokens=0,
    web_search_requests=0,
    web_fetch_requests=0,
) -> dict:
    p = {
        "stage": stage,
        "iteration": iteration,
        "cost_usd": cost_usd,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "model": model,
    }
    # Only include non-zero optional fields to keep events compact
    if cache_creation_input_tokens:
        p["cache_creation_input_tokens"] = cache_creation_input_tokens
    if cache_read_input_tokens:
        p["cache_read_input_tokens"] = cache_read_input_tokens
    if web_search_requests:
        p["web_search_requests"] = web_search_requests
    if web_fetch_requests:
        p["web_fetch_requests"] = web_fetch_requests
    return p
```

#### 1e. `runner.py` — pass new fields when emitting cost events

At the emit site (~line 1651), include the additional token fields from `usage`:

```python
emit_event(ctx, COST_STAGE_TOTAL, cost_stage_total_payload(
    stage=current_stage.value,
    iteration=iter_num,
    cost_usd=_stage_cost,
    input_tokens=_stage_input,
    output_tokens=_stage_output,
    model=...,
    cache_creation_input_tokens=usage.get("cache_creation_input_tokens", 0),
    cache_read_input_tokens=usage.get("cache_read_input_tokens", 0),
    web_search_requests=usage.get("web_search_requests", 0),
    web_fetch_requests=usage.get("web_fetch_requests", 0),
))
```

#### 1f. Tests

- `tests/test_token_usage.py` — add test cases for new fields in `extract_token_usage`, `aggregate_token_usage`, `aggregate_by_model`
- `tests/test_runner_cost_events.py` (if exists) — verify new fields appear in emitted events

### Backward compatibility

All new fields default to 0/empty. Existing status.json files without them will aggregate correctly since `usage.get("web_search_requests", 0) or 0` returns 0 for missing keys. No migration needed.

---

## Part 2: Extend Cost Settings & Calculation

### Current pricing structure (OUTDATED)

Our current `settings.json` has old Opus 4/4.1 pricing and is missing Haiku entirely:

```json
"pricing": {
  "models": {
    "opus": {
      "input_per_mtok": 15,          // WRONG — was 3x reduced for Opus 4.5/4.6
      "output_per_mtok": 75,         // WRONG
      "cache_write_per_mtok": 18.75, // WRONG — also needs 5m/1h split
      "cache_read_per_mtok": 1.5     // WRONG
    },
    "sonnet": {
      "input_per_mtok": 3,           // Correct
      "output_per_mtok": 15,         // Correct
      "cache_write_per_mtok": 3.75,  // Correct (5m tier) — but needs 1h tier too
      "cache_read_per_mtok": 0.3     // Correct
    }
  }
}
```

### What needs to change

Three things:

1. **Fix Opus pricing** — Opus 4.5/4.6 got a 3x price reduction vs Opus 4/4.1
2. **Add two cache write tiers** — The API now returns separate `ephemeral_5m` and `ephemeral_1h` token counts with different rates (1.25x and 2x input price respectively)
3. **Add Haiku pricing** — Missing entirely; needed for subagent cost estimation
4. **Add server tool use pricing** — Web search/fetch billed per request
5. **`total_cost_usd` remains primary** — Our `estimate_cost()` is a fallback for interrupted runs; the CLI's `total_cost_usd` is authoritative and already accounts for all pricing tiers

### Updated pricing reference

| | Opus 4.6 | Sonnet 4.6 | Haiku 4.5 |
|---|---|---|---|
| Input | $5.00/MTok | $3.00/MTok | $0.80/MTok |
| Output | $25.00/MTok | $15.00/MTok | $4.00/MTok |
| Cache write (5m) | $6.25/MTok (1.25x) | $3.75/MTok (1.25x) | $1.00/MTok (1.25x) |
| Cache write (1h) | $10.00/MTok (2x) | $6.00/MTok (2x) | $1.60/MTok (2x) |
| Cache read | $0.50/MTok (0.1x) | $0.30/MTok (0.1x) | $0.08/MTok (0.1x) |

**Note:** Claude Code uses 5-minute cache writes by default. The 1-hour tier is only used when explicitly requested via `cache_control` with a 1h TTL. For the `estimate_cost()` fallback, we use the 5m rate for `cache_creation_input_tokens` and the 1h rate only for `cache_ephemeral_1h_tokens` (the new field from Part 1).

### Changes

#### 2a. `src/worca/settings.json` — update pricing

```json
"pricing": {
  "models": {
    "opus": {
      "input_per_mtok": 5.00,
      "output_per_mtok": 25.00,
      "cache_write_per_mtok": 6.25,
      "cache_write_1h_per_mtok": 10.00,
      "cache_read_per_mtok": 0.50
    },
    "sonnet": {
      "input_per_mtok": 3.00,
      "output_per_mtok": 15.00,
      "cache_write_per_mtok": 3.75,
      "cache_write_1h_per_mtok": 6.00,
      "cache_read_per_mtok": 0.30
    },
    "haiku": {
      "input_per_mtok": 0.80,
      "output_per_mtok": 4.00,
      "cache_write_per_mtok": 1.00,
      "cache_write_1h_per_mtok": 1.60,
      "cache_read_per_mtok": 0.08
    }
  },
  "server_tools": {
    "web_search_per_request": 0.01,
    "web_fetch_per_request": 0.01
  },
  "currency": "USD",
  "last_updated": "2026-04-06"
}
```

`cache_write_per_mtok` stays as the default (5m) rate for backward compatibility. `cache_write_1h_per_mtok` is new and only used when we have the ephemeral breakdown from Part 1.

#### 2b. `estimate_cost()` — use tiered cache pricing + server tools

```python
def estimate_cost(token_usage: dict, pricing: dict, server_tools_pricing: dict = None) -> float:
    input_tokens = token_usage.get("input_tokens", 0) or 0
    output_tokens = token_usage.get("output_tokens", 0) or 0
    cache_read = token_usage.get("cache_read_input_tokens", 0) or 0

    # Cache write: use tiered pricing if ephemeral breakdown available
    cache_1h = token_usage.get("cache_ephemeral_1h_tokens", 0) or 0
    cache_5m = token_usage.get("cache_ephemeral_5m_tokens", 0) or 0
    cache_creation_total = token_usage.get("cache_creation_input_tokens", 0) or 0

    if cache_1h or cache_5m:
        # Use per-tier rates
        cache_write_cost = (
            cache_5m * pricing.get("cache_write_per_mtok", 0) / 1_000_000
            + cache_1h * pricing.get("cache_write_1h_per_mtok",
                                     pricing.get("cache_write_per_mtok", 0)) / 1_000_000
        )
    else:
        # Fallback: all cache writes at default (5m) rate
        cache_write_cost = cache_creation_total * pricing.get("cache_write_per_mtok", 0) / 1_000_000

    cost = (
        input_tokens * pricing.get("input_per_mtok", 0) / 1_000_000
        + output_tokens * pricing.get("output_per_mtok", 0) / 1_000_000
        + cache_write_cost
        + cache_read * pricing.get("cache_read_per_mtok", 0) / 1_000_000
    )

    # Server tool costs
    if server_tools_pricing:
        web_search = token_usage.get("web_search_requests", 0) or 0
        web_fetch = token_usage.get("web_fetch_requests", 0) or 0
        cost += web_search * server_tools_pricing.get("web_search_per_request", 0)
        cost += web_fetch * server_tools_pricing.get("web_fetch_per_request", 0)

    return cost
```

#### 2c. UI settings pricing editor

In `worca-ui/app/views/settings.js`:

- Add `"haiku"` to `PRICING_MODELS`
- Add `{ key: 'cache_write_1h_per_mtok', label: 'Cache Write 1h/MTok' }` to `PRICING_FIELDS`
- Update `DEFAULT_PRICING` with the corrected values above
- Add a "Server Tools" section below the model pricing grid with web search/fetch rates

#### 2d. Tests

- `tests/test_token_usage.py` — test `estimate_cost` with:
  - Tiered cache pricing (5m + 1h)
  - Fallback (no ephemeral breakdown)
  - Server tool pricing
  - Haiku model pricing lookup
- Verify `load_pricing` works with or without `server_tools` / `cache_write_1h_per_mtok` keys

---

## Part 3: UI Display

### Design principles

1. **Don't add columns to the cost table** — it already has 10 columns (Stage, Iter, Cost, Turns, Duration, API Duration, Input, Output, Cache Read, Cache Write). Adding more makes it unreadable.
2. **Progressive disclosure** — show summary data by default, details on demand.
3. **Skip `service_tier`** — per requirements. Also skip `inference_geo` and `speed` (operational metadata, not useful for cost analysis).

### What to show

| Data | Where | How |
|------|-------|-----|
| Web search/fetch request counts | Per-iteration detail | Inline badge below cost table row, only when non-zero |
| Cache tier breakdown (1h vs 5m) | Per-iteration tooltip | Tooltip on the "Cache Write" cell |
| Server tool costs | Summary card | Include in "Total Cost" (already included via `total_cost_usd`) |
| Web search totals | Summary section | New small stat next to "Total Tokens" card, only when > 0 |

### Implementation

#### 3a. Extend `/api/projects/:projectId/costs` endpoint

In `worca-ui/server/project-routes.js`, add `webSearchRequests` and `webFetchRequests` to the per-iteration data read from `iter-N.json`:

```javascript
// Inside the iter-N.json parsing loop:
const mu = data.modelUsage || {};
let webSearchRequests = 0;
for (const [model, usage] of Object.entries(mu)) {
    // ... existing token aggregation ...
    webSearchRequests += usage.webSearchRequests || 0;
}
iters.push({
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    webSearchRequests,
    models,
});
```

Also read from `data.usage.cache_creation` for ephemeral breakdown:

```javascript
const cacheCreation = data.usage?.cache_creation || {};
iters.push({
    ...existing,
    cacheEphemeral1hTokens: cacheCreation.ephemeral_1h_input_tokens || 0,
    cacheEphemeral5mTokens: cacheCreation.ephemeral_5m_input_tokens || 0,
});
```

#### 3b. Summary cards — conditional web search badge

In `worca-ui/app/views/token-costs.js`, extend `_sumTokens` to also sum web search requests:

```javascript
function _sumTokens(tokenData) {
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, webSearches = 0;
    for (const run of Object.values(tokenData)) {
        for (const stage of Object.values(run)) {
            for (const iter of stage) {
                input += iter.inputTokens || 0;
                output += iter.outputTokens || 0;
                cacheRead += iter.cacheReadInputTokens || 0;
                cacheWrite += iter.cacheCreationInputTokens || 0;
                webSearches += iter.webSearchRequests || 0;
            }
        }
    }
    return { input, output, cacheRead, cacheWrite, webSearches };
}
```

In `summaryCards()`, add a conditional 5th card only when `webSearches > 0`:

```javascript
${tokens.webSearches > 0 ? html`
  <div class="stat-card stat-web-search">
    <div class="stat-icon-ring">${unsafeHTML(iconSvg(Search, 20))}</div>
    <div class="stat-body">
      <span class="stat-number">${tokens.webSearches}</span>
      <span class="stat-label">Web Searches</span>
    </div>
  </div>
` : nothing}
```

#### 3c. Per-iteration detail — web search badge

In the cost table row, add an inline annotation below the cost cell when web searches are non-zero. Instead of a new column, render a small badge inside the existing row:

```javascript
<td>
  ${_formatCost(iter.cost_usd)}
  ${tokens.webSearchRequests
    ? html`<span class="cost-badge" title="Includes ${tokens.webSearchRequests} web search(es)">
        ${unsafeHTML(iconSvg(Search, 10))} ${tokens.webSearchRequests}
      </span>`
    : nothing}
</td>
```

#### 3d. Cache Write tooltip — ephemeral tier breakdown

Add a `title` attribute to the Cache Write cell showing the 1h/5m split:

```javascript
<td title="${tokens.cacheEphemeral1hTokens
    ? `1h: ${_formatTokens(tokens.cacheEphemeral1hTokens)}, 5m: ${_formatTokens(tokens.cacheEphemeral5mTokens)}`
    : ''}">
  ${tokens.cacheCreationInputTokens ? _formatTokens(tokens.cacheCreationInputTokens) : '-'}
</td>
```

#### 3e. CSS additions

```css
.cost-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 0.7rem;
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--muted);
  margin-left: 4px;
  vertical-align: middle;
}
```

#### 3f. Tests

- `worca-ui/server/test/costs-api.test.js` — add test for `webSearchRequests` field in response
- `worca-ui/app/views/token-costs.test.js` (if exists) — test conditional rendering of web search badge and tooltip

---

## Files to change

### Python (pipeline)

| File | Change |
|------|--------|
| `src/worca/utils/token_usage.py` | Add new fields to extraction, aggregation, estimation |
| `src/worca/events/types.py` | Extend `cost_stage_total_payload` with optional fields |
| `src/worca/orchestrator/runner.py` | Pass new fields when emitting cost events |
| `src/worca/settings.json` | Fix Opus pricing (3x reduction), add Haiku, add `cache_write_1h_per_mtok`, add `server_tools` |
| `tests/test_token_usage.py` | Test new fields |

### JavaScript (UI)

| File | Change |
|------|--------|
| `worca-ui/server/project-routes.js` | Extend `/costs` endpoint to include web search + cache tier data |
| `worca-ui/app/views/token-costs.js` | Conditional web search card, badge in cost cell, cache tooltip |
| `worca-ui/app/views/settings.js` | Add Haiku to pricing models, add `cache_write_1h_per_mtok` field, add server tools section, update defaults |
| `worca-ui/app/styles.css` | `.cost-badge` style |
| `worca-ui/server/test/costs-api.test.js` | Test new fields in response |

---

## Verification

1. Run a pipeline with web search enabled, verify `events.jsonl` contains new fields
2. Check `status.json` token_usage aggregates include `web_search_requests`
3. Open Costs dashboard — verify web search card appears only when count > 0
4. Expand a run — verify search badge appears next to cost in iterations that used web search
5. Hover Cache Write cell — verify tooltip shows 1h/5m breakdown
6. Run `pytest tests/test_token_usage.py` — all pass
7. Run `npx vitest run server/` — all pass

## Priority / Sequencing

1. **Part 1 (logging)** — do first, it's the data foundation. Low risk, additive only.
2. **Part 2 (cost settings)** — do second, small change since `total_cost_usd` handles most cases.
3. **Part 3 (UI)** — do last, depends on Part 1 data being available in the result files.

Parts 1 and 2 can be done in one commit. Part 3 is a separate UI commit.
