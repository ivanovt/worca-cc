{{#if plan_revision_mode}}
## Revision Required

The plan reviewer has identified issues that must be addressed.
Revise the existing plan — do NOT start from scratch.

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

{{#if plan_content}}
## Current Plan

{{plan_content}}
{{/if}}

{{#if has_graphify}}
_A code knowledge graph is preloaded for this repo — explore it on demand with `graphify query "<question>"` (see the Knowledge graph section of your role)._

{{/if}}
{{#if has_code_review_graph}}
_A code-review-graph MCP server is attached — CRG tools are available as MCP tools (see the Code graph section of your role)._

{{/if}}
{{#if plan_review_issues_formatted}}
## Issues to Address

{{plan_review_issues_formatted}}
{{/if}}

{{#if plan_review_history_formatted}}
## Review History

{{plan_review_history_formatted}}
{{/if}}

Address each issue above. Preserve all parts of the plan that were not flagged.
Write the updated plan.
{{else}}
Create a detailed implementation plan for the following work request.
Start by reading CLAUDE.md for project context (tech stack, build/test commands, conventions).
Then explore the codebase to understand existing architecture.
Write the plan to `{{plan_file|MASTER_PLAN.md}}`.

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
{{#if claude_md}}
## Project Context (from CLAUDE.md)

{{claude_md}}
{{/if}}
{{/if}}
