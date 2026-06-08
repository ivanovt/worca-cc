Review the code changes for correctness, style, security, and adherence to the plan. You are strictly read-only: do NOT modify code, do NOT run tests (the tester already produced proof artifacts). Produce your structured review output.

{{#if has_guide}}
## Reference Guide (normative)

The following guidance is authoritative for this work-request — it outranks the
plan, your assigned task, and the original description. Treat any conflict
between the guide and those lower-authority sources as a defect in the
lower-authority source, and surface it rather than silently resolving it.

{{guide_content}}
{{/if}}

{{#if has_graphify}}
_A code knowledge graph is preloaded — **orient with `graphify query "<question>"` before searching or reading files** (see the Knowledge graph section of your role)._

{{/if}}
{{#if has_code_review_graph}}
_A code-review-graph MCP server is attached — **use its tools to orient (structure, context, impact) before Glob/Grep or file reads** (see the Code graph section of your role)._

{{/if}}
{{#if test_results}}
## Test Results

{{test_results}}
{{/if}}

{{#if files_changed_formatted}}
## Files Changed

{{files_changed_formatted}}
{{/if}}

{{#if review_base}}
> Diff base: {{review_base}} (changes since pipeline start)
{{else}}
> Diff base: `"merge-base HEAD origin/HEAD"` (no review_base available, using fallback)
{{/if}}
