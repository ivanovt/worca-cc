## Work Request

{{work_request}}

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
