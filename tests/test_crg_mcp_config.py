"""Tests for crg_mcp_config() helper shape (W-057 §4)."""

import json

from worca.utils.code_review_graph import crg_mcp_config


class TestCrgMcpConfigShape:
    def test_returns_valid_json(self):
        result = crg_mcp_config("/repo", "/data/crg", ["tool_a", "tool_b"])
        parsed = json.loads(result)
        assert isinstance(parsed, dict)

    def test_top_level_mcpServers_key(self):
        result = crg_mcp_config("/repo", "/data/crg", ["tool_a"])
        parsed = json.loads(result)
        assert "mcpServers" in parsed

    def test_server_name_is_code_review_graph(self):
        parsed = json.loads(crg_mcp_config("/repo", "/data", ["t"]))
        assert "code-review-graph" in parsed["mcpServers"]

    def test_server_type_is_stdio(self):
        parsed = json.loads(crg_mcp_config("/repo", "/data", ["t"]))
        server = parsed["mcpServers"]["code-review-graph"]
        assert server["type"] == "stdio"

    def test_command_is_code_review_graph(self):
        parsed = json.loads(crg_mcp_config("/repo", "/data", ["t"]))
        server = parsed["mcpServers"]["code-review-graph"]
        assert server["command"] == "code-review-graph"

    def test_args_contain_serve(self):
        parsed = json.loads(crg_mcp_config("/repo", "/data", ["t"]))
        server = parsed["mcpServers"]["code-review-graph"]
        assert server["args"] == ["serve"]

    def test_env_contains_repo_root(self):
        parsed = json.loads(crg_mcp_config("/my/repo", "/data", ["t"]))
        env = parsed["mcpServers"]["code-review-graph"]["env"]
        assert env["CRG_REPO_ROOT"] == "/my/repo"

    def test_env_contains_data_dir(self):
        parsed = json.loads(crg_mcp_config("/repo", "/my/data", ["t"]))
        env = parsed["mcpServers"]["code-review-graph"]["env"]
        assert env["CRG_DATA_DIR"] == "/my/data"

    def test_env_contains_crg_tools_csv(self):
        parsed = json.loads(crg_mcp_config("/repo", "/data", ["tool_a", "tool_b"]))
        env = parsed["mcpServers"]["code-review-graph"]["env"]
        assert env["CRG_TOOLS"] == "tool_a,tool_b"

    def test_single_tool(self):
        parsed = json.loads(crg_mcp_config("/repo", "/data", ["only_tool"]))
        env = parsed["mcpServers"]["code-review-graph"]["env"]
        assert env["CRG_TOOLS"] == "only_tool"

    def test_empty_tools_list(self):
        parsed = json.loads(crg_mcp_config("/repo", "/data", []))
        env = parsed["mcpServers"]["code-review-graph"]["env"]
        assert env["CRG_TOOLS"] == ""
