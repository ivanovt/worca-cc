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

{{#if has_graph}}
## Codebase Structure (advisory)

{{graph_context}}

{{/if}}
{{#if plan_approach}}
## Approach

{{plan_approach}}
{{/if}}
