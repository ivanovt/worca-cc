"""Tests for the file access recorder in post_tool_use.py."""

import json
import os
from unittest import mock


from worca.claude_hooks import post_tool_use


def test_recorder_writes_read_operation(tmp_path, monkeypatch):
    """A Read tool call should record as op=read with the file_path."""
    monkeypatch.setenv("WORCA_RUN_ID", "test-run-123")
    monkeypatch.setenv("WORCA_STAGE", "implement")
    monkeypatch.setenv("WORCA_ITERATION", "1")
    monkeypatch.delenv("WORCA_BEAD_ID", raising=False)

    # Mock the access dir to use our temp path
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="Read",
                tool_input={"file_path": "/repo/src/main.py"},
                tool_response={},
            )

    # Check that the JSONL file was created and contains the record
    jsonl_file = access_dir / "implement-1.jsonl"
    assert jsonl_file.exists()

    lines = jsonl_file.read_text().strip().split("\n")
    assert len(lines) == 1

    record = json.loads(lines[0])
    assert record["op"] == "read"
    assert record["tool"] == "Read"
    assert record["path"] == "/repo/src/main.py"
    assert "ts" in record


def test_recorder_writes_write_operation_for_write(tmp_path):
    """Write tool should record as op=write."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="Write",
                tool_input={"file_path": "/repo/src/main.py", "content": "code"},
                tool_response={},
            )

    jsonl_file = access_dir / "implement-1.jsonl"
    record = json.loads(jsonl_file.read_text().strip())
    assert record["op"] == "write"
    assert record["tool"] == "Write"
    assert record["path"] == "/repo/src/main.py"


def test_recorder_writes_write_operation_for_edit(tmp_path):
    """Edit tool should record as op=write."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "2",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="Edit",
                tool_input={"file_path": "/repo/src/main.py", "old_string": "x", "new_string": "y"},
                tool_response={},
            )

    jsonl_file = access_dir / "implement-2.jsonl"
    record = json.loads(jsonl_file.read_text().strip())
    assert record["op"] == "write"
    assert record["tool"] == "Edit"


def test_recorder_multieedit_counts_as_one_write(tmp_path):
    """MultiEdit should count as exactly 1 write operation."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="MultiEdit",
                tool_input={
                    "file_path": "/repo/src/main.py",
                    "edits": [{"old": "a", "new": "b"}, {"old": "c", "new": "d"}],
                },
                tool_response={},
            )

    jsonl_file = access_dir / "implement-1.jsonl"
    lines = jsonl_file.read_text().strip().split("\n")
    # Should be exactly 1 line for MultiEdit (not 2)
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["op"] == "write"
    assert record["tool"] == "MultiEdit"


def test_recorder_notebookedit_uses_notebook_path(tmp_path):
    """NotebookEdit should record the notebook_path, not file_path."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="NotebookEdit",
                tool_input={
                    "notebook_path": "/repo/notebook.ipynb",
                    "cell_index": 0,
                    "new_content": "code",
                },
                tool_response={},
            )

    jsonl_file = access_dir / "implement-1.jsonl"
    record = json.loads(jsonl_file.read_text().strip())
    assert record["op"] == "write"
    assert record["tool"] == "NotebookEdit"
    assert record["path"] == "/repo/notebook.ipynb"


def test_recorder_grep_records_as_search(tmp_path):
    """Grep should record as op=search with pattern, scope, and result_count."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="Grep",
                tool_input={"pattern": "def main", "path": "/repo/src"},
                tool_response={"output": "file1.py:5:def main\nfile2.py:10:def main\n"},
            )

    jsonl_file = access_dir / "implement-1.jsonl"
    record = json.loads(jsonl_file.read_text().strip())
    assert record["op"] == "search"
    assert record["tool"] == "Grep"
    assert record["pattern"] == "def main"
    assert record["scope"] == "/repo/src"
    assert record["result_count"] == 2


def test_recorder_glob_records_as_search(tmp_path):
    """Glob should record as op=search with pattern and result_count."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="Glob",
                tool_input={"pattern": "**/*.py", "path": "/repo"},
                tool_response={"output_mode": "files_with_matches", "head_limit": 250},
            )

    jsonl_file = access_dir / "implement-1.jsonl"
    record = json.loads(jsonl_file.read_text().strip())
    assert record["op"] == "search"
    assert record["tool"] == "Glob"
    assert record["pattern"] == "**/*.py"


def test_recorder_includes_bead_id_in_filename(tmp_path):
    """When WORCA_BEAD_ID is set, it should appear in the filename."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
        "WORCA_BEAD_ID": "beads-123",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="Read",
                tool_input={"file_path": "/repo/src/main.py"},
                tool_response={},
            )

    # Should create implement-1-beads-123.jsonl
    jsonl_file = access_dir / "implement-1-beads-123.jsonl"
    assert jsonl_file.exists()


def test_recorder_ignores_unknown_tools(tmp_path):
    """Unknown tools should not be recorded."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="Bash",
                tool_input={"command": "ls -la"},
                tool_response={},
            )

    # No file should be created
    assert not (access_dir / "implement-1.jsonl").exists()


def test_recorder_gracefully_handles_missing_env_vars(tmp_path):
    """If WORCA_RUN_ID is missing, the recorder should do nothing."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }, clear=False):
        os.environ.pop("WORCA_RUN_ID", None)
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="Read",
                tool_input={"file_path": "/repo/src/main.py"},
                tool_response={},
            )

    # No file should be created
    assert not (access_dir / "implement-1.jsonl").exists()


def test_recorder_appends_to_existing_file(tmp_path):
    """Multiple calls should append to the same file."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            # First call
            post_tool_use._record_file_access(
                tool_name="Read",
                tool_input={"file_path": "/repo/src/main.py"},
                tool_response={},
            )
            # Second call
            post_tool_use._record_file_access(
                tool_name="Read",
                tool_input={"file_path": "/repo/src/utils.py"},
                tool_response={},
            )

    jsonl_file = access_dir / "implement-1.jsonl"
    lines = jsonl_file.read_text().strip().split("\n")
    assert len(lines) == 2

    record1 = json.loads(lines[0])
    record2 = json.loads(lines[1])
    assert record1["path"] == "/repo/src/main.py"
    assert record2["path"] == "/repo/src/utils.py"


def test_recorder_counts_grep_results(tmp_path):
    """Grep should count the number of matching lines in the output."""
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(
                tool_name="Grep",
                tool_input={"pattern": "import os", "path": "."},
                tool_response={"output": "file1.py:1:import os\nfile2.py:2:import os\nfile3.py:1:import os\n"},
            )

    jsonl_file = access_dir / "implement-1.jsonl"
    record = json.loads(jsonl_file.read_text().strip())
    assert record["result_count"] == 3


def test_recorder_categories_and_counts(tmp_path):
    """Test that the three operation categories are recorded correctly.

    Validates:
    - MultiEdit counts as 1 write (atomic operation)
    - NotebookEdit uses notebook_path key, not file_path
    - Grep/Glob are classified as search, not read operations
    """
    access_dir = tmp_path / "access"
    access_dir.mkdir()

    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "implement",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            # Record a MultiEdit (should count as 1 write despite multiple edits)
            post_tool_use._record_file_access(
                tool_name="MultiEdit",
                tool_input={
                    "file_path": "/repo/src/main.py",
                    "edits": [{"old": "a", "new": "b"}, {"old": "c", "new": "d"}],
                },
                tool_response={},
            )

            # Record a NotebookEdit (should use notebook_path key)
            post_tool_use._record_file_access(
                tool_name="NotebookEdit",
                tool_input={"notebook_path": "/repo/notebook.ipynb", "cell_index": 0, "new_content": "code"},
                tool_response={},
            )

            # Record a Grep (should be search, not read)
            post_tool_use._record_file_access(
                tool_name="Grep",
                tool_input={"pattern": "def main", "path": "/repo/src"},
                tool_response={"output": "file1.py:5:def main\nfile2.py:10:def main\n"},
            )

    jsonl_file = access_dir / "implement-1.jsonl"
    lines = jsonl_file.read_text().strip().split("\n")
    assert len(lines) == 3

    # First record: MultiEdit counts as exactly 1 write
    record1 = json.loads(lines[0])
    assert record1["op"] == "write"
    assert record1["tool"] == "MultiEdit"
    assert record1["path"] == "/repo/src/main.py"

    # Second record: NotebookEdit uses notebook_path, not file_path
    record2 = json.loads(lines[1])
    assert record2["op"] == "write"
    assert record2["tool"] == "NotebookEdit"
    assert record2["path"] == "/repo/notebook.ipynb"

    # Third record: Grep is a search operation, not a read
    record3 = json.loads(lines[2])
    assert record3["op"] == "search"
    assert record3["tool"] == "Grep"
    assert "pattern" in record3
    assert "scope" in record3
    assert record3["result_count"] == 2


def test_event_payload_pipeline_iteration_access(tmp_path):
    """Test that pipeline.iteration.access event payload is correctly structured.

    Validates:
    - Payload contains all required fields (run_id, stage, agent, iteration, bead_id, file_access)
    - Event is not chat-notifiable (Tier 2/3 event)
    - file_access dict has the correct structure (reads, writes, searches, totals, capture)
    """
    from worca.events import types

    # Verify the constant exists and has the right value
    assert types.ITERATION_ACCESS == "pipeline.iteration.access"

    # Build a sample file_access dict matching the aggregation output
    file_access = {
        "reads": {"src/main.py": 3, "src/utils.py": 1},
        "writes": {"src/main.py": 2},
        "searches": [
            {"tool": "Grep", "pattern": "def authenticate", "scope": "src/api", "result_count": 3},
            {"tool": "Glob", "pattern": "**/*.py", "scope": ".", "result_count": 42},
        ],
        "totals": {
            "distinct_read": 2,
            "total_read": 4,
            "distinct_write": 1,
            "total_write": 2,
            "grep": 1,
            "glob": 1,
            "zero_result": 0,
            "root_scoped": 1,
        },
        "capture": {
            "hook_writes": 2,
            "git_writes": 2,
            "leakage_pct": 0.0,
            "oracle": "ok",
        },
    }

    # Build the payload
    payload = types.iteration_access_payload(
        run_id="run-20260604-123",
        stage="implement",
        agent="implementer",
        iteration=1,
        bead_id="worca-cc-77-e0vk",
        file_access=file_access,
    )

    # Verify all required fields are present
    assert payload["run_id"] == "run-20260604-123"
    assert payload["stage"] == "implement"
    assert payload["agent"] == "implementer"
    assert payload["iteration"] == 1
    assert payload["bead_id"] == "worca-cc-77-e0vk"
    assert payload["file_access"] == file_access

    # Verify file_access structure
    assert "reads" in payload["file_access"]
    assert "writes" in payload["file_access"]
    assert "searches" in payload["file_access"]
    assert "totals" in payload["file_access"]
    assert "capture" in payload["file_access"]

    # Verify totals have all required fields
    totals = payload["file_access"]["totals"]
    assert "distinct_read" in totals
    assert "total_read" in totals
    assert "distinct_write" in totals
    assert "total_write" in totals
    assert "grep" in totals
    assert "glob" in totals
    assert "zero_result" in totals
    assert "root_scoped" in totals

    # Verify capture has all required fields
    capture = payload["file_access"]["capture"]
    assert "hook_writes" in capture
    assert "git_writes" in capture
    assert "leakage_pct" in capture
    assert "oracle" in capture

    # Verify the event is properly defined (not testing chat_notifiable directly
    # as that's defined elsewhere in the system, but we document the expectation)
    assert types.ITERATION_ACCESS == "pipeline.iteration.access"


# ---------------------------------------------------------------------------
# Graph-query capture (graphify CLI over Bash, CRG MCP tools)
# ---------------------------------------------------------------------------


def _record_graph(tmp_path, tool_name, tool_input):
    """Run _record_file_access for a graph tool and return the parsed record(s)."""
    access_dir = tmp_path / "access"
    access_dir.mkdir(exist_ok=True)
    with mock.patch.dict(os.environ, {
        "WORCA_RUN_ID": "test-run-123",
        "WORCA_STAGE": "plan",
        "WORCA_ITERATION": "1",
    }):
        with mock.patch.object(post_tool_use, "_get_access_dir", return_value=str(access_dir)):
            post_tool_use._record_file_access(tool_name, tool_input, {})
    jsonl_file = access_dir / "plan-1.jsonl"
    if not jsonl_file.exists():
        return []
    return [json.loads(line) for line in jsonl_file.read_text().splitlines() if line.strip()]


def test_parse_graphify_query():
    out = post_tool_use._parse_graphify_command('graphify query "what depends on TaskService?"')
    assert out == {
        "engine": "graphify",
        "op": "query",
        "query": "what depends on TaskService?",
    }


def test_parse_graphify_path_multiple_args():
    out = post_tool_use._parse_graphify_command("graphify path TaskCLI TaskRepository")
    assert out["engine"] == "graphify"
    assert out["op"] == "path"
    assert out["query"] == "TaskCLI TaskRepository"


def test_parse_graphify_strips_graph_flag_and_value():
    out = post_tool_use._parse_graphify_command(
        'graphify query "callers of charge" --graph /tmp/g/graph.json'
    )
    assert out["op"] == "query"
    assert out["query"] == "callers of charge"


def test_parse_graphify_handles_compound_command():
    out = post_tool_use._parse_graphify_command('cd /repo && graphify explain TaskService.create')
    assert out["op"] == "explain"
    assert out["query"] == "TaskService.create"


def test_parse_graphify_ignores_mutating_subcommand():
    assert post_tool_use._parse_graphify_command("graphify update") is None
    assert post_tool_use._parse_graphify_command("graphify install") is None


def test_parse_graphify_ignores_non_graphify_bash():
    assert post_tool_use._parse_graphify_command("pytest tests/") is None
    assert post_tool_use._parse_graphify_command("git status") is None


def test_graph_query_from_crg_mcp_tool():
    out = post_tool_use._graph_query_from_tool(
        "mcp__code-review-graph__get_impact_radius", {"symbol": "TaskService.create", "depth": 2}
    )
    assert out["engine"] == "crg"
    assert out["op"] == "get_impact_radius"
    assert "TaskService.create" in out["query"]


def test_recorder_writes_graphify_query(tmp_path):
    records = _record_graph(tmp_path, "Bash", {"command": 'graphify query "what depends on X?"'})
    assert len(records) == 1
    r = records[0]
    assert r["op"] == "graph_query"
    assert r["engine"] == "graphify"
    assert r["graph_op"] == "query"
    assert r["query"] == "what depends on X?"


def test_recorder_writes_crg_mcp_query(tmp_path):
    records = _record_graph(
        tmp_path, "mcp__code-review-graph__get_review_context", {"file": "src/svc.py"}
    )
    assert len(records) == 1
    assert records[0]["op"] == "graph_query"
    assert records[0]["engine"] == "crg"
    assert records[0]["graph_op"] == "get_review_context"


def test_recorder_skips_mutating_graphify(tmp_path):
    records = _record_graph(tmp_path, "Bash", {"command": "graphify update"})
    assert records == []


def test_recorder_skips_plain_bash(tmp_path):
    records = _record_graph(tmp_path, "Bash", {"command": "pytest tests/"})
    assert records == []
