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
{{work_request}}
{{else}}
Implement the code changes for the assigned task. Follow TDD: write a failing test first, then implement. When the assigned bead is complete, run `bd close <id>` and STOP — do not attempt `git commit` / `git push` / `git stash`. The guardian handles all git state changes.

{{#if assigned_task}}
## Assigned Task

{{assigned_task}}
{{/if}}

## Work Request

{{work_request}}
{{/if}}
