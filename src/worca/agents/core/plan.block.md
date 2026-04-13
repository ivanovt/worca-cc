{{#if plan_revision_mode}}
## Revision Required

The plan reviewer has identified issues that must be addressed.
Revise the existing plan — do NOT start from scratch.

## Work Request

{{work_request}}

{{#if plan_content}}
## Current Plan

{{plan_content}}
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
Write the updated plan. In your JSON output, set `approved: true` to signal
that the revised plan is ready for review.
{{else}}
Create a detailed implementation plan for the following work request.
Start by reading CLAUDE.md for project context (tech stack, build/test commands, conventions).
Then explore the codebase to understand existing architecture.
Write the plan to `{{plan_file|MASTER_PLAN.md}}`.

## Work Request

{{work_request}}

{{#if claude_md}}
## Project Context (from CLAUDE.md)

{{claude_md}}
{{/if}}
{{/if}}
