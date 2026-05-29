Run the full test suite and verify the implementation. Do NOT modify source code or tests. If tests fail, report the failures in your structured output — the implementer will fix them in a follow-up iteration.

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
{{#if implementation_summary}}
## Implementation Summary

{{implementation_summary}}
{{/if}}
