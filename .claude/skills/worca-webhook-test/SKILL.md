---
name: worca-webhook-test
description: Sign and POST a synthetic worca event to a configured webhook URL — verifies HMAC signing, network reachability, response handling, and (for control webhooks) the control-action response shape. Useful when adding or tuning a webhook subscriber without running a full pipeline. Triggers on "test webhook", "webhook test", "send test event", "worca-webhook-test", or any request to validate a webhook configuration.
---

# Test a worca webhook locally

Builds a synthetic event envelope matching the `docs/events.md` schema, signs it with HMAC-SHA256 matching `src/worca/events/webhook.py`, POSTs it to the configured URL, and reports the result. Closes the dev loop on webhook configuration without needing a full pipeline run.

## Step 0: No-args mode

If invoked with no arguments, print this usage:

```
/worca-webhook-test --url:<webhook-url> [--secret:<secret> | --secret-env:<ENV_VAR>]
                    [--event-type:<dotted.type>] [--run-id:<id>]
                    [--control] [--save-response]

Examples:
  /worca-webhook-test --url:https://localhost:3400/api/webhooks/inbox \
    --secret-env:WORCA_WEBHOOK_SECRET --event-type:pipeline.run.completed

  /worca-webhook-test --url:https://my-system.example/hook \
    --secret:base64secret --control --event-type:pipeline.milestone.set
```

Stop if no arguments given.

## Step 1: Resolve the secret

If `--secret-env` is provided, read from `$ENV_VAR`. If `--secret`, use directly. If neither, the webhook is signed-less (still send, but warn — most production webhooks require a signature).

Never log the secret value. Print only "secret: provided" or "secret: not provided".

## Step 2: Pick a sensible default event type

If `--event-type` is omitted, default to `pipeline.run.completed` — it's the most common Tier 1 event and has a stable payload shape.

Validate the event type against `docs/events.md`:

```bash
grep -nE "\`<event-type>\`" docs/events.md
```

If not found, warn the user and ask whether they want to proceed with a synthetic unknown type.

## Step 3: Build the envelope

Match the schema in `src/worca/events/emitter.py` (see also `docs/events.md` — Envelope section):

```json
{
  "schema_version": 1,
  "event_id": "<generated UUID>",
  "event_type": "<event-type from args>",
  "timestamp": "<current ISO-8601 with Z>",
  "run_id": "<--run-id or 'test-run-' + 8 hex chars>",
  "pipeline": {
    "test_synthetic": true,
    "source": "worca-webhook-test"
  },
  "payload": <event-specific payload from step 4>
}
```

Mark synthetic events with `pipeline.test_synthetic: true` so receivers can filter them out of dashboards if they want.

## Step 4: Build a sensible payload for the event type

Generate a plausible payload based on the event type. Reference `src/worca/events/types.py` for the payload builder signature.

Examples:
- `pipeline.run.completed` → `{duration_ms: 723000, total_cost_usd: 1.23, total_turns: 47, total_tokens: 152000, stages_completed: ["preflight", "plan", "coordinate", "implement", "test", "review", "pr"]}`
- `pipeline.run.failed` → `{error: "synthetic test error", failed_stage: "implement", error_type: "TestError"}`
- `pipeline.git.pr_merged` → `{pr_number: 999, pr_url: "https://github.com/test/repo/pull/999", merged_by: "test-user"}`
- `pipeline.cost.budget_warning` → `{budget_usd: 100.0, used_usd: 85.0, percent_used: 0.85}`

For unknown event types, use `{test: true, message: "synthetic test payload"}`.

## Step 5: Sign the body

Serialize the envelope as canonical JSON (no whitespace pretty-printing, UTF-8). Sign with HMAC-SHA256 using the resolved secret:

```bash
# Conceptual — actual implementation uses Python's hmac module
BODY='<json-bytes>'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')
```

Header value: `X-Worca-Signature: sha256=$SIG`

Match the implementation in `src/worca/events/webhook.py:_sign_payload()` exactly — receivers will reject anything that doesn't match `sha256=<hex>`.

## Step 6: POST

```bash
curl -sS -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "User-Agent: worca-webhook-test/1.0" \
  -H "X-Worca-Event: <event-type>" \
  -H "X-Worca-Delivery: <event-id>" \
  -H "X-Worca-Signature: sha256=$SIG" \
  --data-raw "$BODY" \
  -w "\n---\nHTTP_STATUS=%{http_code}\nTIME_TOTAL=%{time_total}\n"
```

Use `-sS` (silent but show errors), capture status code and timing.

## Step 7: Verify the response

Report:

| HTTP code | Meaning | Recommendation |
|---|---|---|
| `200`/`204` | success | OK, webhook reachable and accepted the event |
| `401`/`403` | auth failed | check secret matches receiver's expected secret |
| `404` | path not found | URL is wrong |
| `405` | method not allowed | receiver doesn't accept POST on this path |
| `429` | rate-limited | back off; if persistent, check receiver's rate limits |
| `500`-`599` | server error | receiver-side bug; check receiver logs |
| network error | DNS/connection failure | URL unreachable from this machine |

If `--control` was passed, verify the response body matches:

```json
{ "control": { "action": "pause" | "abort" | "continue" } }
```

A response without this shape (or with an invalid action value) on a control webhook = `critical` finding — the receiver will not be able to control the pipeline. Match the parser in `src/worca/events/webhook.py:_check_control_response()`.

## Step 8: Print summary

```
Webhook test result:
  URL:           <url>
  Event type:    <event-type>
  Event ID:      <uuid>
  Signed:        yes (sha256=<first-8-chars>...)  |  no
  HTTP:          <code> <reason>
  Round trip:    <ms>
  Body size:     <bytes>

Response (truncated to 500 chars):
  <body>

Control parse:  <skipped | success: action=<action> | failed: <reason>>

Verdict: <ok | needs attention — see above>
```

If `--save-response`, also write the raw response to `/tmp/worca-webhook-test-<event-id>.json` for inspection.

## Common pitfalls

- **JSON serialization differs:** receivers that re-serialize and re-sign will get a different hash. The signature must be over the **exact bytes received**, not a re-serialized canonical form.
- **Secret encoding:** worca uses the raw secret bytes; some receivers expect base64-decoded secrets. Match formats with the receiver's verification code.
- **Trailing newline:** `curl --data-raw` sends bytes as-is; `--data` may add a newline. Use `--data-raw` to match the Python emitter's behavior (which sends `body = json.dumps(event, ensure_ascii=False).encode()` — no trailing newline).
- **TLS verification:** for self-signed receivers in dev, you may need `curl -k`. Note this is insecure — only use for local testing.
- **Localhost vs Docker:** if the receiver runs in Docker, `localhost` from this machine doesn't reach it. Use the Docker host IP.

## What this skill does NOT do

- Does not configure webhooks in `settings.json` — that's a manual edit.
- Does not run the full pipeline — use `python .claude/scripts/run_pipeline.py` for that.
- Does not test receiver retry behavior — only sends one POST.
- Does not enumerate all event types — for that, see `docs/events.md`.
