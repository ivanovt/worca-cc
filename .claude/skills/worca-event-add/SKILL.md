---
name: worca-event-add
description: Scaffold a new worca event type across every required file — `src/worca/events/types.py` constant + payload builder, `tests/test_event_types.py` coverage, and (for chat-notifiable events) a renderer entry in `worca-ui/server/integrations/renderers.js`. Adding an event manually touches 3-4 files and missing the renderer means the event fires but never reaches chat. Triggers on "new event", "add event", "add webhook event", "event type", "worca-event-add", or any request to add a new pipeline/fleet/workspace event.
---

# Add a new worca event type

The event system has 80+ event types across `pipeline.*`, `control.*`, `fleet.*`, and `workspace.*` domains. Adding a new one is a multi-file edit with no scaffold; missing a step causes silent failures (the event emits but no subscriber sees it, or the payload-builder test is missing so future regressions slip through).

This skill scaffolds all required files together and reminds you what to verify before committing.

## Step 0: No-args mode

If invoked with no arguments, print this usage:

```
/worca-event-add --type:<dotted.event.type> --constant:<PYTHON_CONSTANT> --domain:<pipeline|fleet|workspace|control> [--tier-1] [--payload-fields:field1,field2,...]

Examples:
  /worca-event-add --type:pipeline.deploy.started --constant:DEPLOY_STARTED \
    --domain:pipeline --payload-fields:environment,target_url

  /worca-event-add --type:pipeline.run.notified --constant:RUN_NOTIFIED \
    --domain:pipeline --tier-1 --payload-fields:channel,recipient
```

Stop if no arguments given.

## Step 1: Validate the type name

```bash
grep -n "\"<type>\"" src/worca/events/types.py
```

Must NOT exist. If a constant with the same string already exists, stop and ask the user for a different name.

Also verify the dotted name follows convention:
- Domain prefix: `pipeline.`, `control.`, `fleet.`, or `workspace.`
- Lowercase, dot-separated, underscores within a segment if needed
- Naming pattern: `<domain>.<category>.<action>` (e.g. `pipeline.git.pr_created`, `workspace.tier.completed`)

Convention violation = stop and ask user to confirm.

## Step 2: Add the constant in `types.py`

Find the appropriate section in `src/worca/events/types.py` based on `--domain`:

| Domain | Section header to look for |
|---|---|
| `pipeline` | The category section (e.g. `# Pipeline lifecycle`, `# Stage events`, `# Git events`) |
| `control` | `# Control events` |
| `fleet` | `# Fleet events` |
| `workspace` | `# Workspace events` |

Add the constant in the right category. If no existing category fits, create a new one with a comment header. Example:

```python
# ── Deploy events (NEW) ──────────────────────────────────────────────
DEPLOY_STARTED   = "pipeline.deploy.started"
DEPLOY_COMPLETED = "pipeline.deploy.completed"
DEPLOY_FAILED    = "pipeline.deploy.failed"
```

Align the `=` for readability with neighbors.

## Step 3: Add the payload builder

Below the existing builders in `types.py`, append:

```python
def <constant_lowercase>_payload(
    <field1>: <type>,
    <field2>: <type>,
    optional_field: <type> = None,
) -> dict:
    """Payload for `<dotted.event.type>`."""
    p: dict = {
        "<field1>": <field1>,
        "<field2>": <field2>,
    }
    if optional_field is not None:
        p["optional_field"] = optional_field
    return p
```

Naming: `<lowercase_constant>_payload` (e.g. `RUN_COMPLETED` → `run_completed_payload`). Match exactly — this convention is grepped by the payload reviewer.

If `--payload-fields` was passed, use those field names. Otherwise leave a placeholder and remind the user to fill it in.

**Type hints are required.** Don't use `dict` for the parameter types — be specific (`str`, `int`, `float`, `list`, `dict`).

## Step 4: Add a test in `tests/test_event_types.py`

Find a sibling test for an event in the same category. Append a test following the same pattern:

```python
def test_<constant_lowercase>_payload_required_fields():
    """<constant_lowercase>_payload includes all required fields."""
    p = <constant_lowercase>_payload(
        <field1>=<sample-value>,
        <field2>=<sample-value>,
    )
    assert p == {
        "<field1>": <sample-value>,
        "<field2>": <sample-value>,
    }


def test_<constant_lowercase>_payload_optional_field():
    """<constant_lowercase>_payload includes optional fields when provided."""
    p = <constant_lowercase>_payload(
        <field1>=<sample>,
        <field2>=<sample>,
        optional_field="x",
    )
    assert p["optional_field"] == "x"
```

Import the new payload builder at the top of the test file (find the existing import block).

## Step 5: Add the renderer (only if `--tier-1`)

If the event should produce chat messages, add a renderer in `worca-ui/server/integrations/renderers.js`. Find the existing event → renderer mapping (search the file for an existing Tier 1 event type as a string literal). Add an entry following the same shape:

```javascript
// Map from event_type to a function that returns a NormalizedMessage:
//   { title, body: [{kind: 'markdown'|'bold'|'code'|'code_block'|'link', value}],
//     severity: 'info'|'success'|'warning'|'error' }
case '<dotted.event.type>': {
  return {
    title: '<icon> <short title>',
    body: [
      { kind: 'markdown', value: `Run \`${envelope.run_id}\`` },
      { kind: 'code', value: envelope.payload.<field1> },
    ],
    severity: 'info',  // or success/warning/error depending on event semantics
  };
}
```

Severity guide:
- `success` — completion, PR merged, suite passed
- `error` — failed, aborted, circuit breaker tripped
- `warning` — interrupted, budget warning, retry needed
- `info` — started, milestone, paused/resumed

If the event is NOT Tier 1, skip this step but note it in the summary so the user knows to add it later if needed.

## Step 6: Update the events reference

Add the new event to the appropriate table in `docs/events.md`. The doc is hand-maintained — this skill must update it. Find the matching `### <domain> events` section and append the new row to the table.

## Step 7: Lint, build, test

```bash
ruff check src/worca/events/ tests/test_event_types.py
pytest tests/test_event_types.py -v
cd worca-ui && npm run lint:fix && npx vitest run server/integrations/renderers.test.js
```

If `--tier-1` was used, also add a test in `worca-ui/server/integrations/renderers.test.js` for the new renderer entry — find an existing renderer test as a reference.

## Step 8: Print summary

```
New event scaffolded:
  Type:               <dotted.event.type>
  Python constant:    <CONSTANT> at src/worca/events/types.py:<line>
  Payload builder:    <constant_lowercase>_payload at src/worca/events/types.py:<line>
  Test:               tests/test_event_types.py:<line>
  Reference doc:      docs/events.md updated (table: <section>)
  Renderer:           <added at renderers.js:<line> | skipped (not Tier 1)>
  Renderer test:      <added | skipped>

Where to call emit_event() with the new payload:
  <suggestion based on category — e.g. "in src/worca/orchestrator/stages/<x>.py">

Next:
  1. Wire emit_event() at the call site that triggers this event.
  2. Dispatch worca-event-payload-reviewer to audit consistency.
  3. If Tier 1, manually verify the renderer with /worca-webhook-test.
```
