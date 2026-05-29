Review the implementation plan below for completeness, feasibility, and quality.
If you find critical or major issues, rewrite the plan file to resolve them in place.

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

{{#if has_graphify}}
_A code knowledge graph is preloaded — **orient with `graphify query "<question>"` before searching or reading files** (see the Knowledge graph section of your role)._

{{/if}}
{{#if has_code_review_graph}}
_A code-review-graph MCP server is attached — **use its tools to orient (structure, context, impact) before Glob/Grep or file reads** (see the Code graph section of your role)._

{{/if}}
{{#if plan_content}}
## Implementation Plan

{{plan_content}}
{{else}}
## Implementation Plan

*Plan file not found or empty — this is itself a critical issue to report.*
{{/if}}
