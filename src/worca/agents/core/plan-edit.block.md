Review the implementation plan below for completeness, feasibility, and quality.

**Sequence (required):** if you find ANY critical or major issues, your FIRST action MUST be to Edit `{{plan_file}}` to fix them in place. Only after the file is updated may you produce your structured `plan_review.json` output. There is no loopback to fall back on — returning a verdict without editing leaves the issues unresolved. The pipeline compares the file's content to the pre-edit original after you finish: if it is byte-identical, a self-reported `approve_with_edits` is automatically downgraded to `approve` and your verdict is discarded, so claiming edits without making them gains nothing.

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
{{#if plan_content}}
## Implementation Plan

{{plan_content}}
{{else}}
## Implementation Plan

*Plan file not found or empty — this is itself a critical issue to report.*
{{/if}}
