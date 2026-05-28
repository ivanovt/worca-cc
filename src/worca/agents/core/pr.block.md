Ship this work: stage, commit, push, and open the PR. Use the host CLI documented in CLAUDE.md.

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
_A code knowledge graph is preloaded for this repo — explore it on demand with `graphify query "<question>"` (see the Knowledge graph section of your role)._

{{/if}}
{{#if has_code_review_graph}}
_A code-review-graph MCP server is attached — CRG tools are available as MCP tools (see the Code graph section of your role)._

{{/if}}
{{#if plan_approach}}
## Approach

{{plan_approach}}
{{/if}}
