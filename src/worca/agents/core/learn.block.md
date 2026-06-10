Produce a post-mortem for the terminated pipeline run described below.

## Work Request

{{#if has_guide}}
## Reference Guide (normative)

The following guidance is authoritative for this work-request. Treat any
conflict between the guide and the task description as a bug in the task
description, and surface it rather than silently resolving it.

{{guide_content}}

---

## Task

{{/if}}
{{work_request}}

{{block:graphify-reminder}}
{{block:crg-reminder}}
## Termination

**Type:** {{termination_type|unknown}}
{{#if termination_reason}}
**Reason:** {{termination_reason}}
{{/if}}

{{#if plan_content}}
## Plan File

{{plan_content}}
{{/if}}

## Run Reference

**Run ID:** `{{run_id}}`
**Run directory:** `.worca/runs/{{run_id}}/`
**Logs directory:** `.worca/runs/{{run_id}}/logs/`

## Run Data

```json
{{run_data}}
```

{{#if files_changed_since_git_head}}
## Files Changed Since `git_head`

The diff below is the ground truth for what this pipeline produced. If a file is
listed here, the pipeline modified it — do not claim such work was "pre-existing"
regardless of what iteration logs say.

```
{{files_changed_since_git_head}}
```
{{/if}}
