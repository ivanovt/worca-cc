"""Tests for crg_tools_for_stage() — per-stage CRG tool governance (W-057 §5)."""

from worca.utils.code_review_graph import crg_tools_for_stage, CRG_MUTATING_TOOLS


# Hard-excluded mutating tools that must never appear in any stage's tool list.
MUTATING = set(CRG_MUTATING_TOOLS)


class TestCrgToolsForStageDefaults:
    """Default tool map (stage_tools=None) — built-in per-stage allow-lists."""

    def test_planner_tools(self):
        tools = crg_tools_for_stage("planner")
        assert "get_architecture_overview_tool" in tools
        assert "get_minimal_context_tool" in tools
        assert "query_graph_tool" in tools
        assert "list_communities_tool" in tools

    def test_coordinator_matches_planner(self):
        assert crg_tools_for_stage("coordinator") == crg_tools_for_stage("planner")

    def test_implementer_tools(self):
        tools = crg_tools_for_stage("implementer")
        assert "get_minimal_context_tool" in tools
        assert "get_impact_radius_tool" in tools
        assert "query_graph_tool" in tools

    def test_tester_tools(self):
        tools = crg_tools_for_stage("tester")
        assert "get_impact_radius_tool" in tools
        assert "detect_changes_tool" in tools
        assert "get_affected_flows_tool" in tools

    def test_reviewer_tools(self):
        tools = crg_tools_for_stage("reviewer")
        assert "detect_changes_tool" in tools
        assert "get_review_context_tool" in tools
        assert "get_impact_radius_tool" in tools
        assert "query_graph_tool" in tools

    def test_guardian_tools(self):
        tools = crg_tools_for_stage("guardian")
        assert tools == ["detect_changes_tool"]

    def test_mutating_tools_never_present_in_any_default_stage(self):
        """Hard-excluded mutating tools must never appear for any stage."""
        for role in ("planner", "coordinator", "implementer", "tester", "reviewer", "guardian"):
            tools = crg_tools_for_stage(role)
            overlap = MUTATING & set(tools)
            assert not overlap, f"mutating tools {overlap} found for {role}"

    def test_unknown_stage_returns_empty(self):
        assert crg_tools_for_stage("unknown_agent") == []

    def test_plan_reviewer_returns_empty(self):
        """plan_reviewer has no default CRG tools."""
        assert crg_tools_for_stage("plan_reviewer") == []

    def test_learner_returns_empty(self):
        assert crg_tools_for_stage("learner") == []


class TestCrgToolsForStageOverrides:
    """stage_tools config override support."""

    def test_override_replaces_defaults(self):
        overrides = {"implementer": ["query_graph_tool"]}
        tools = crg_tools_for_stage("implementer", stage_tools=overrides)
        assert tools == ["query_graph_tool"]

    def test_override_does_not_affect_other_stages(self):
        overrides = {"implementer": ["query_graph_tool"]}
        tools = crg_tools_for_stage("planner", stage_tools=overrides)
        # planner should still get defaults
        assert "get_architecture_overview_tool" in tools

    def test_override_strips_mutating_tools(self):
        """Even explicit overrides cannot include mutating tools."""
        overrides = {"implementer": ["query_graph_tool", "apply_refactor_tool", "build_or_update_graph_tool"]}
        tools = crg_tools_for_stage("implementer", stage_tools=overrides)
        overlap = MUTATING & set(tools)
        assert not overlap
        assert "query_graph_tool" in tools

    def test_override_empty_list(self):
        overrides = {"implementer": []}
        tools = crg_tools_for_stage("implementer", stage_tools=overrides)
        assert tools == []

    def test_override_for_unknown_stage(self):
        overrides = {"custom_agent": ["query_graph_tool"]}
        tools = crg_tools_for_stage("custom_agent", stage_tools=overrides)
        assert tools == ["query_graph_tool"]


class TestCrgMutatingToolsConstant:
    """CRG_MUTATING_TOOLS is a well-known constant."""

    def test_contains_apply_refactor(self):
        assert "apply_refactor_tool" in CRG_MUTATING_TOOLS

    def test_contains_refactor(self):
        assert "refactor_tool" in CRG_MUTATING_TOOLS

    def test_contains_build_or_update(self):
        assert "build_or_update_graph_tool" in CRG_MUTATING_TOOLS

    def test_contains_run_postprocess(self):
        assert "run_postprocess_tool" in CRG_MUTATING_TOOLS

    def test_contains_embed_graph(self):
        assert "embed_graph_tool" in CRG_MUTATING_TOOLS

    def test_contains_generate_wiki(self):
        assert "generate_wiki_tool" in CRG_MUTATING_TOOLS

    def test_contains_list_repos(self):
        assert "list_repos_tool" in CRG_MUTATING_TOOLS

    def test_contains_cross_repo_search(self):
        assert "cross_repo_search_tool" in CRG_MUTATING_TOOLS

    def test_contains_semantic_search(self):
        assert "semantic_search_nodes_tool" in CRG_MUTATING_TOOLS

    def test_contains_get_docs_section(self):
        assert "get_docs_section_tool" in CRG_MUTATING_TOOLS

    def test_is_frozenset(self):
        assert isinstance(CRG_MUTATING_TOOLS, frozenset)
