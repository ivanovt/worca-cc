{{#if is_retry}}
## PRIORITY: Fix {{issue_type}} (attempt {{attempt_count}})

{{#if test_failures_formatted}}
### Failures to Fix

{{test_failures_formatted}}
{{/if}}

{{#if review_issues_formatted}}
### Issues to Fix

{{review_issues_formatted}}
{{/if}}

{{#if previous_attempts}}
### Previous Attempts (all failed to resolve)

{{previous_attempts}}
{{/if}}

---

### Reference: Task & Plan (already implemented)

{{#if assigned_task}}
{{assigned_task}}

{{/if}}
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

{{#if has_design_notes}}
## Accumulated design notes (advisory)

Sibling beads recorded these design decisions during this run. They are
advisory — lowest authority after guide, plan, graph, and description.

{{accumulated_design_notes}}

{{/if}}
{{#if has_graphify}}
_A code knowledge graph is preloaded for this repo — explore it on demand with `graphify query "<question>"` (see the Knowledge graph section of your role)._

{{/if}}
{{#if has_code_review_graph}}
_A code-review-graph MCP server is attached — CRG tools are available as MCP tools (see the Code graph section of your role)._

{{/if}}
{{else}}
Implement the code changes for the assigned task. Follow TDD: write a failing test first, then implement. When the assigned bead is complete, run `bd close <id>` and STOP — do not attempt `git commit` / `git push` / `git stash`. The guardian handles all git state changes.

{{#if assigned_task}}
## Assigned Task

{{assigned_task}}
{{/if}}

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

{{#if has_design_notes}}
## Accumulated design notes (advisory)

Sibling beads recorded these design decisions during this run. They are
advisory — lowest authority after guide, plan, graph, and description.

{{accumulated_design_notes}}

{{/if}}
{{#if has_graphify}}
_A code knowledge graph is preloaded for this repo — explore it on demand with `graphify query "<question>"` (see the Knowledge graph section of your role)._

{{/if}}
{{#if has_code_review_graph}}
_A code-review-graph MCP server is attached — CRG tools are available as MCP tools (see the Code graph section of your role)._

{{/if}}
{{/if}}
