Review the implementation plan below for completeness, feasibility, and quality.
You are a read-only analyst — do NOT modify files, run tests, or execute commands.

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

{{#if has_graph}}
## Codebase Structure (advisory)

{{graph_context}}

{{/if}}
{{#if plan_content}}
## Implementation Plan

{{plan_content}}
{{else}}
## Implementation Plan

*Plan file not found or empty — this is itself a critical issue to report.*
{{/if}}

{{#if plan_review_history_formatted}}
## Previous Review Attempts

{{plan_review_history_formatted}}

Check whether the issues from previous review attempts have been addressed
in the revised plan above.
{{/if}}
