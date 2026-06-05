"""Tests for worca.orchestrator.prompt_builder — stage-specific prompt generation."""


from worca.orchestrator.prompt_builder import PromptBuilder


# --- T10: build() shim removal ---

def test_build_method_removed():
    """build() shim has been removed from PromptBuilder after T10 refactor."""
    pb = PromptBuilder("Add auth", "Desc")
    assert not hasattr(pb, "build"), "build() shim should be removed from PromptBuilder"


def test_update_and_get_context():
    pb = PromptBuilder("title", "desc")
    pb.update_context("key1", "value1")
    assert pb.get_context("key1") == "value1"
    assert pb.get_context("missing") is None
    assert pb.get_context("missing", "default") == "default"


def test_pop_context_removes_key_and_returns_value():
    pb = PromptBuilder("title", "desc")
    pb.update_context("k", "v")
    result = pb.pop_context("k")
    assert result == "v"
    assert pb.get_context("k") is None


def test_pop_context_missing_key_returns_none():
    pb = PromptBuilder("title", "desc")
    assert pb.pop_context("nonexistent") is None


def test_pop_context_does_not_persist_key():
    pb = PromptBuilder("title", "desc")
    pb.update_context("x", 123)
    pb.pop_context("x")
    assert "x" not in pb._context


# --- _build_plan_review ---

def test_read_master_plan_uses_plan_file_context(tmp_path):
    """_read_master_plan() should find content via plan_file context key when MASTER_PLAN.md absent."""
    plan_file = tmp_path / "plan-001.md"
    plan_file.write_text("# Plan from plan_file context")
    pb = PromptBuilder("Add auth", "Desc", master_plan_path=str(tmp_path / "MASTER_PLAN.md"))
    pb.update_context("plan_file", str(plan_file))
    content = pb._read_master_plan()
    assert "Plan from plan_file context" in content


def test_format_test_failures_returns_numbered_markdown():
    pb = PromptBuilder("T", "D")
    result = pb._format_test_failures([
        {"test_name": "test_login_valid", "error": "AssertionError: 401 != 200"},
        {"test_name": "test_token_refresh", "error": "KeyError: 'refresh_token'"},
    ])
    assert "1. **test_login_valid**" in result
    assert "AssertionError: 401 != 200" in result
    assert "2. **test_token_refresh**" in result
    assert "KeyError: 'refresh_token'" in result


def test_format_test_failures_empty_list_returns_empty_string():
    pb = PromptBuilder("T", "D")
    assert pb._format_test_failures([]) == ""


def test_format_test_failures_missing_fields_uses_defaults():
    pb = PromptBuilder("T", "D")
    result = pb._format_test_failures([{}])
    assert "1. **unknown**" in result
    assert "no details" in result


def test_format_review_issues_returns_severity_file_line_markdown():
    pb = PromptBuilder("T", "D")
    result = pb._format_review_issues([
        {"file": "auth.py", "line": 42, "severity": "critical", "description": "SQL injection"},
        {"file": "middleware.py", "line": 15, "severity": "major", "description": "Missing validation"},
    ])
    assert "1. [critical] `auth.py:42`" in result
    assert "SQL injection" in result
    assert "2. [major] `middleware.py:15`" in result
    assert "Missing validation" in result


def test_format_review_issues_empty_list_returns_empty_string():
    pb = PromptBuilder("T", "D")
    assert pb._format_review_issues([]) == ""


def test_format_review_issues_missing_fields_uses_defaults():
    pb = PromptBuilder("T", "D")
    result = pb._format_review_issues([{}])
    assert "[?] `?:?`" in result


def test_format_review_history_returns_attempt_bullets():
    pb = PromptBuilder("T", "D")
    result = pb._format_review_history([
        {"attempt": 1, "issues": [{"file": "a.py", "line": 10, "severity": "major"}]},
        {"attempt": 2, "issues": [{"file": "b.py", "line": 5, "severity": "critical"}]},
    ])
    assert "- Attempt 1:" in result
    assert "[major] a.py:10" in result
    assert "- Attempt 2:" in result
    assert "[critical] b.py:5" in result


def test_format_review_history_empty_list_returns_empty_string():
    pb = PromptBuilder("T", "D")
    assert pb._format_review_history([]) == ""


def test_format_review_history_missing_fields_uses_defaults():
    pb = PromptBuilder("T", "D")
    result = pb._format_review_history([{"attempt": 1, "issues": [{}]}])
    assert "- Attempt 1:" in result
    assert "[?] ?:?" in result


def test_format_test_failure_history_returns_attempt_bullets():
    pb = PromptBuilder("T", "D")
    result = pb._format_test_failure_history([
        {"attempt": 1, "failures": [{"test_name": "test_a"}, {"test_name": "test_b"}]},
        {"attempt": 2, "failures": [{"test_name": "test_c"}]},
    ])
    assert "- Attempt 1: test_a; test_b" in result
    assert "- Attempt 2: test_c" in result


def test_format_test_failure_history_empty_list_returns_empty_string():
    pb = PromptBuilder("T", "D")
    assert pb._format_test_failure_history([]) == ""


def test_format_test_failure_history_missing_fields_uses_defaults():
    pb = PromptBuilder("T", "D")
    result = pb._format_test_failure_history([{"attempt": "?", "failures": [{}]}])
    assert "- Attempt ?: unknown" in result


def test_format_plan_review_issues_returns_numbered_markdown():
    pb = PromptBuilder("T", "D")
    result = pb._format_plan_review_issues([
        {
            "category": "feasibility",
            "severity": "major",
            "description": "Unrealistic timeline",
            "suggestion": "Add buffer",
            "evidence": "Similar project took 4 weeks",
        },
        {
            "category": "completeness",
            "severity": "critical",
            "description": "Missing error handling",
        },
    ])
    assert "1. [major] (feasibility) Unrealistic timeline" in result
    assert "Suggestion: Add buffer" in result
    assert "Evidence: Similar project took 4 weeks" in result
    assert "2. [critical] (completeness) Missing error handling" in result


def test_format_plan_review_issues_omits_missing_suggestion_evidence():
    pb = PromptBuilder("T", "D")
    result = pb._format_plan_review_issues([
        {"category": "risk", "severity": "minor", "description": "Low risk"},
    ])
    assert "Suggestion" not in result
    assert "Evidence" not in result


def test_format_plan_review_issues_empty_list_returns_empty_string():
    pb = PromptBuilder("T", "D")
    assert pb._format_plan_review_issues([]) == ""


def test_format_plan_review_issues_missing_fields_uses_defaults():
    pb = PromptBuilder("T", "D")
    result = pb._format_plan_review_issues([{}])
    assert "1. [?] (?) " in result


def test_format_plan_review_history_returns_attempt_bullets():
    pb = PromptBuilder("T", "D")
    result = pb._format_plan_review_history([
        {"attempt": 1, "issues": [{"severity": "major", "category": "risk", "description": "No rollback"}]},
        {"attempt": 2, "issues": [{"severity": "critical", "category": "completeness", "description": "Missing tests"}]},
    ])
    assert "- Attempt 1: [major] risk: No rollback" in result
    assert "- Attempt 2: [critical] completeness: Missing tests" in result


def test_format_plan_review_history_empty_list_returns_empty_string():
    pb = PromptBuilder("T", "D")
    assert pb._format_plan_review_history([]) == ""


def test_format_plan_review_history_missing_fields_uses_defaults():
    pb = PromptBuilder("T", "D")
    result = pb._format_plan_review_history([{"attempt": 1, "issues": [{}]}])
    assert "- Attempt 1: [?] ?: " in result


def test_format_implementation_summary_returns_files_and_tests():
    pb = PromptBuilder("T", "D")
    result = pb._format_implementation_summary(
        files_changed=["auth.py", "middleware.py"],
        tests_added=["test_auth.py"],
    )
    assert "**Files changed:**" in result
    assert "- auth.py" in result
    assert "- middleware.py" in result
    assert "**Tests added:**" in result
    assert "- test_auth.py" in result


def test_format_implementation_summary_files_only():
    pb = PromptBuilder("T", "D")
    result = pb._format_implementation_summary(
        files_changed=["main.py"],
        tests_added=[],
    )
    assert "**Files changed:**" in result
    assert "**Tests added:**" not in result


def test_format_implementation_summary_empty_returns_empty_string():
    pb = PromptBuilder("T", "D")
    assert pb._format_implementation_summary([], []) == ""


def test_format_test_results_passed_with_coverage():
    pb = PromptBuilder("T", "D")
    result = pb._format_test_results(
        test_passed=True,
        coverage=87.5,
        proof_artifacts=[".worca/test-output.txt"],
    )
    assert "**Status:** PASSED" in result
    assert "**Coverage:** 87.5%" in result
    assert "**Proof artifacts:**" in result
    assert "- .worca/test-output.txt" in result


def test_format_test_results_failed_no_coverage():
    pb = PromptBuilder("T", "D")
    result = pb._format_test_results(test_passed=False, coverage=None, proof_artifacts=[])
    assert "**Status:** FAILED" in result
    assert "Coverage" not in result
    assert "Proof artifacts" not in result


def test_format_test_results_no_artifacts():
    pb = PromptBuilder("T", "D")
    result = pb._format_test_results(test_passed=True, coverage=None, proof_artifacts=None)
    assert "**Status:** PASSED" in result
    assert "Proof artifacts" not in result


# --- build_context() ---

def test_build_context_returns_dict():
    pb = PromptBuilder("Add auth", "Implement authentication")
    ctx = pb.build_context("plan")
    assert isinstance(ctx, dict)


def test_build_context_plan_contains_work_request():
    pb = PromptBuilder("Add auth", "Implement authentication")
    ctx = pb.build_context("plan")
    assert "work_request" in ctx
    assert "Add auth" in ctx["work_request"]
    assert "Implement authentication" in ctx["work_request"]


def test_build_context_plan_contains_claude_md(tmp_path):
    claude_md = tmp_path / "CLAUDE.md"
    claude_md.write_text("# My Project\n\nUses Python + pytest")
    pb = PromptBuilder("Add auth", "Desc", claude_md_path=str(claude_md))
    ctx = pb.build_context("plan")
    assert ctx.get("claude_md") == "# My Project\n\nUses Python + pytest"


def test_build_context_plan_no_claude_md(tmp_path):
    pb = PromptBuilder("Add auth", "Desc", claude_md_path=str(tmp_path / "nonexistent.md"))
    ctx = pb.build_context("plan")
    assert ctx.get("claude_md") == ""


def test_build_context_plan_revision_mode_sets_plan_content(tmp_path):
    plan_file = tmp_path / "MASTER_PLAN.md"
    plan_file.write_text("# Plan Content")
    pb = PromptBuilder("Add auth", "Desc", master_plan_path=str(plan_file))
    pb.update_context("plan_revision_mode", True)
    ctx = pb.build_context("plan")
    assert "Plan Content" in ctx.get("plan_content", "")


def test_build_context_plan_revision_mode_formats_issues():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("plan_revision_mode", True)
    pb.update_context("plan_review_issues", [
        {"category": "completeness", "severity": "critical", "description": "Missing edge cases"},
    ])
    ctx = pb.build_context("plan")
    assert "Missing edge cases" in ctx.get("plan_review_issues_formatted", "")


def test_build_context_plan_revision_mode_formats_history():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("plan_revision_mode", True)
    pb.update_context("plan_review_history", [
        {"attempt": 1, "issues": [{"severity": "major", "category": "risk", "description": "No rollback"}]},
    ])
    ctx = pb.build_context("plan")
    assert "No rollback" in ctx.get("plan_review_history_formatted", "")


def test_build_context_plan_review_sets_plan_content(tmp_path):
    plan_file = tmp_path / "MASTER_PLAN.md"
    plan_file.write_text("# Implementation Plan\n\nPhase 1: Setup")
    pb = PromptBuilder("Add auth", "Desc", master_plan_path=str(plan_file))
    ctx = pb.build_context("plan_review")
    assert "Phase 1: Setup" in ctx.get("plan_content", "")


def test_build_context_plan_review_history_empty_on_iteration_0():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("plan_review_history", [
        {"attempt": 1, "issues": [{"category": "risk", "severity": "major", "description": "No rollback"}]}
    ])
    ctx = pb.build_context("plan_review", iteration=0)
    assert not ctx.get("plan_review_history_formatted")


def test_build_context_plan_review_history_set_on_iteration_1():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("plan_review_history", [
        {"attempt": 1, "issues": [{"category": "risk", "severity": "major", "description": "No rollback"}]}
    ])
    ctx = pb.build_context("plan_review", iteration=1)
    assert "No rollback" in ctx.get("plan_review_history_formatted", "")


def test_build_context_coordinate_current_plan_from_plan_file_content():
    # W-061: coordinate consumes the FULL current plan, not a delta summary built
    # from approach + tasks_outline (which collapses to the revision changelog
    # after a plan_review revise).
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("plan_file_content", "# Plan\n\n## Phase 1\nDo X\n\n## Phase 2\nDo Y")
    # A delta-scoped outline must NOT leak into the coordinator input.
    pb.update_context("plan_approach", "Targeted revision: fixed one typo")
    pb.update_context("plan_tasks_outline", [{"title": "Fix typo", "description": ""}])
    ctx = pb.build_context("coordinate")
    assert "Phase 1" in ctx.get("current_plan", "")
    assert "Phase 2" in ctx.get("current_plan", "")
    assert "Fix typo" not in ctx.get("current_plan", "")


def test_build_context_coordinate_empty_current_plan_without_plan_content():
    pb = PromptBuilder("Add auth", "Desc")
    ctx = pb.build_context("coordinate")
    assert not ctx.get("current_plan")


def test_build_context_plan_revision_prefers_threaded_plan_content():
    # W-061: under append-only numbering, plan_file points at the next (empty)
    # numbered file at revision time, so the runner threads the current plan into
    # plan_file_content; the revision Planner must read THAT, not the empty file.
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("plan_revision_mode", True)
    pb.update_context("plan_file", "/nonexistent/plan-002.md")
    pb.update_context("plan_file_content", "# Current plan\n\n## Phase 1\nExisting work")
    ctx = pb.build_context("plan", iteration=1)
    assert "Existing work" in ctx.get("plan_content", "")


def test_build_context_coordinate_formats_unresolved_plan_issues():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("unresolved_plan_issues", [
        {"category": "completeness", "severity": "critical", "description": "Missing error handling"},
        {"category": "risk", "severity": "major", "description": "No rollback strategy"},
    ])
    ctx = pb.build_context("coordinate")
    formatted = ctx.get("unresolved_plan_issues_formatted", "")
    assert "[critical] (completeness) Missing error handling" in formatted
    assert "[major] (risk) No rollback strategy" in formatted


def test_build_context_coordinate_empty_string_when_unresolved_plan_issues_absent():
    pb = PromptBuilder("Add auth", "Desc")
    ctx = pb.build_context("coordinate")
    assert ctx.get("unresolved_plan_issues_formatted") == ""


def test_build_context_implement_initial_is_retry_false():
    pb = PromptBuilder("Add auth", "Desc")
    ctx = pb.build_context("implement", iteration=0)
    assert ctx.get("is_retry") is False


def test_build_context_implement_retry_is_retry_true():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("test_failures", [{"test_name": "test_a", "error": "fail"}])
    ctx = pb.build_context("implement", iteration=1)
    assert ctx.get("is_retry") is True


def test_build_context_implement_retry_issue_type_test_failures():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("test_failures", [{"test_name": "test_a", "error": "fail"}])
    ctx = pb.build_context("implement", iteration=1)
    assert ctx.get("issue_type") == "Test Failures"


def test_build_context_implement_retry_issue_type_review_issues():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("review_issues", [
        {"file": "a.py", "line": 1, "severity": "major", "description": "bug"},
    ])
    ctx = pb.build_context("implement", iteration=1)
    assert ctx.get("issue_type") == "Review Issues"


def test_build_context_implement_retry_formats_test_failures():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("test_failures", [
        {"test_name": "test_login", "error": "AssertionError: 401 != 200"},
    ])
    ctx = pb.build_context("implement", iteration=1)
    assert "test_login" in ctx.get("test_failures_formatted", "")
    assert "401 != 200" in ctx.get("test_failures_formatted", "")


def test_build_context_implement_retry_formats_review_issues():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("review_issues", [
        {"file": "auth.py", "line": 42, "severity": "critical", "description": "SQL injection"},
    ])
    ctx = pb.build_context("implement", iteration=1)
    assert "auth.py" in ctx.get("review_issues_formatted", "")
    assert "SQL injection" in ctx.get("review_issues_formatted", "")


def test_build_context_implement_retry_previous_attempts_from_review_history():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("review_history", [
        {"attempt": 1, "issues": [{"file": "a.py", "line": 10, "severity": "major", "description": "bug1"}]},
        {"attempt": 2, "issues": [{"file": "a.py", "line": 10, "severity": "major", "description": "bug2"}]},
    ])
    pb.update_context("review_issues", [
        {"file": "a.py", "line": 10, "severity": "major", "description": "bug2"},
    ])
    ctx = pb.build_context("implement", iteration=2)
    assert "Attempt 1" in ctx.get("previous_attempts", "")


def test_build_context_implement_assigned_task_body_with_bead():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("assigned_bead_id", "bd-abc123")
    pb.update_context("assigned_bead_title", "Create auth middleware")
    ctx = pb.build_context("implement", iteration=0)
    assert "bd-abc123" in ctx.get("assigned_task", "")
    assert "Create auth middleware" in ctx.get("assigned_task", "")


def test_build_context_implement_no_assigned_task_when_no_bead():
    pb = PromptBuilder("Add auth", "Desc")
    ctx = pb.build_context("implement")
    assert not ctx.get("assigned_task")


def test_build_context_test_formats_implementation_summary():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("files_changed", ["auth.py", "middleware.py"])
    pb.update_context("tests_added", ["test_auth.py"])
    ctx = pb.build_context("test")
    assert "auth.py" in ctx.get("implementation_summary", "")
    assert "test_auth.py" in ctx.get("implementation_summary", "")


def test_build_context_test_no_implementation_summary_when_empty():
    pb = PromptBuilder("Add auth", "Desc")
    ctx = pb.build_context("test")
    assert not ctx.get("implementation_summary")


def test_build_context_review_formats_test_results():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("test_passed", True)
    pb.update_context("test_coverage", 87.5)
    pb.update_context("proof_artifacts", [".worca/test-output.txt"])
    ctx = pb.build_context("review")
    assert "PASSED" in ctx.get("test_results", "")
    assert "87.5%" in ctx.get("test_results", "")


def test_build_context_review_no_test_results_when_not_set():
    pb = PromptBuilder("Add auth", "Desc")
    ctx = pb.build_context("review")
    assert not ctx.get("test_results")


def test_build_context_review_formats_files_changed():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("files_changed", ["auth.py", "middleware.py"])
    ctx = pb.build_context("review")
    assert "auth.py" in ctx.get("files_changed_formatted", "")
    assert "middleware.py" in ctx.get("files_changed_formatted", "")


def test_build_context_pr_includes_plan_approach():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("plan_approach", "JWT with refresh tokens")
    ctx = pb.build_context("pr")
    assert ctx.get("plan_approach") == "JWT with refresh tokens"


def test_build_context_learn_termination_type_default():
    pb = PromptBuilder("Add auth", "Desc")
    ctx = pb.build_context("learn")
    assert ctx.get("termination_type") == "unknown"


def test_build_context_learn_termination_type_from_context():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("termination_type", "success")
    ctx = pb.build_context("learn")
    assert ctx.get("termination_type") == "success"


def test_build_context_learn_contains_run_data():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", {"run_id": "run-abc123"})
    ctx = pb.build_context("learn")
    assert "run-abc123" in ctx.get("run_data", "")


def test_build_context_learn_contains_run_id():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("full_status", {"run_id": "run-xyz"})
    ctx = pb.build_context("learn")
    assert ctx.get("run_id") == "run-xyz"


def test_build_context_learn_plan_content_from_plan_file_content():
    pb = PromptBuilder("Add auth", "Desc")
    pb.update_context("plan_file_content", "# My Plan")
    ctx = pb.build_context("learn")
    assert ctx.get("plan_content") == "# My Plan"


# --- _load_agent_template ---

def test_load_agent_template_returns_empty_when_run_dir_none():
    pb = PromptBuilder("Add auth", "Desc")
    result = pb._load_agent_template("plan")
    assert result == ""


def test_load_agent_template_reads_from_run_dir(tmp_path):
    agents_dir = tmp_path / "agents"
    agents_dir.mkdir()
    planner_md = agents_dir / "planner.md"
    planner_md.write_text("# Planner Agent\n\n{{block:plan}}")
    pb = PromptBuilder("Add auth", "Desc", run_dir=str(tmp_path))
    result = pb._load_agent_template("plan")
    assert "# Planner Agent" in result
    assert "{{block:plan}}" in result


def test_load_agent_template_returns_empty_for_unknown_stage(tmp_path):
    agents_dir = tmp_path / "agents"
    agents_dir.mkdir()
    pb = PromptBuilder("Add auth", "Desc", run_dir=str(tmp_path))
    result = pb._load_agent_template("unknown_stage")
    assert result == ""


def test_load_agent_template_returns_empty_when_file_missing(tmp_path):
    agents_dir = tmp_path / "agents"
    agents_dir.mkdir()
    pb = PromptBuilder("Add auth", "Desc", run_dir=str(tmp_path))
    result = pb._load_agent_template("plan")  # planner.md doesn't exist
    assert result == ""


# --- has_graphify (per-run availability note; no content/path in prompt) ---

def test_build_context_has_graphify_false_by_default():
    pb = PromptBuilder("Add auth", "Desc")
    ctx = pb.build_context("plan")
    assert ctx.get("has_graphify") is False
    # No report content / path is ever carried in the prompt context — agents
    # query the graph on demand via the GRAPHIFY_OUT env var.
    assert "graph_context" not in ctx


def test_build_context_has_graphify_true_after_set():
    pb = PromptBuilder("Add auth", "Desc")
    pb.set_graphify_available(True)
    ctx = pb.build_context("plan")
    assert ctx.get("has_graphify") is True
    assert "graph_context" not in ctx


def test_set_graphify_available_coerces_to_bool():
    pb = PromptBuilder("Add auth", "Desc")
    pb.set_graphify_available("ready")  # truthy
    assert pb.build_context("plan")["has_graphify"] is True
    pb.set_graphify_available(0)  # falsy
    assert pb.build_context("plan")["has_graphify"] is False


def test_build_context_graphify_and_guide_independent():
    """has_graphify and has_guide are independent flags."""
    pb = PromptBuilder(
        "Add auth", "Desc",
        work_request_guide_content="guide stuff",
    )
    pb.set_graphify_available(True)
    ctx = pb.build_context("plan")
    assert ctx["has_guide"] is True
    assert ctx["has_graphify"] is True
    assert ctx["guide_content"] == "guide stuff"


def test_build_context_graphify_without_guide():
    pb = PromptBuilder("Add auth", "Desc")
    pb.set_graphify_available(True)
    ctx = pb.build_context("implement")
    assert ctx["has_graphify"] is True
    assert ctx["has_guide"] is False


# --- has_code_review_graph (per-run CRG availability note) ---

def test_build_context_has_crg_false_by_default():
    pb = PromptBuilder("Add auth", "Desc")
    ctx = pb.build_context("plan")
    assert ctx.get("has_code_review_graph") is False
    assert "crg_context" not in ctx


def test_build_context_has_crg_true_after_set():
    pb = PromptBuilder("Add auth", "Desc")
    pb.set_crg_available(True)
    ctx = pb.build_context("review")
    assert ctx.get("has_code_review_graph") is True
    assert "crg_context" not in ctx


def test_set_crg_available_coerces_to_bool():
    pb = PromptBuilder("Add auth", "Desc")
    pb.set_crg_available("ready")
    assert pb.build_context("plan")["has_code_review_graph"] is True
    pb.set_crg_available(0)
    assert pb.build_context("plan")["has_code_review_graph"] is False


def test_build_context_crg_and_graphify_independent():
    """has_code_review_graph and has_graphify are independent flags."""
    pb = PromptBuilder("Add auth", "Desc")
    pb.set_graphify_available(True)
    pb.set_crg_available(True)
    ctx = pb.build_context("implement")
    assert ctx["has_graphify"] is True
    assert ctx["has_code_review_graph"] is True


def test_build_context_crg_without_graphify():
    pb = PromptBuilder("Add auth", "Desc")
    pb.set_crg_available(True)
    ctx = pb.build_context("review")
    assert ctx["has_code_review_graph"] is True
    assert ctx["has_graphify"] is False


def test_build_context_crg_with_guide_independent():
    pb = PromptBuilder(
        "Add auth", "Desc",
        work_request_guide_content="guide stuff",
    )
    pb.set_crg_available(True)
    ctx = pb.build_context("plan")
    assert ctx["has_guide"] is True
    assert ctx["has_code_review_graph"] is True


# --- has_review_comments (planner constrained revision mode, W-067) ---

def test_build_context_has_review_comments_false_by_default():
    pb = PromptBuilder("Fix bug", "Desc")
    ctx = pb.build_context("plan")
    assert ctx.get("has_review_comments") is False


def test_build_context_has_review_comments_true_when_set():
    pb = PromptBuilder("Fix bug", "Desc")
    pb.update_context("review_comments", [{"thread_id": "T1", "body": "fix this"}])
    ctx = pb.build_context("plan")
    assert ctx.get("has_review_comments") is True


def test_build_context_has_review_comments_false_when_empty_list():
    pb = PromptBuilder("Fix bug", "Desc")
    pb.update_context("review_comments", [])
    ctx = pb.build_context("plan")
    assert ctx.get("has_review_comments") is False


def test_has_review_comments_active_in_plan_and_coordinate_stages():
    pb = PromptBuilder("Fix bug", "Desc")
    pb.update_context("review_comments", [{"thread_id": "T1", "body": "fix this"}])
    plan_ctx = pb.build_context("plan")
    coord_ctx = pb.build_context("coordinate")
    assert plan_ctx.get("has_review_comments") is True
    assert coord_ctx.get("has_review_comments") is True


def test_build_context_coordinate_has_review_comments_false_by_default():
    pb = PromptBuilder("Fix bug", "Desc")
    ctx = pb.build_context("coordinate")
    assert ctx.get("has_review_comments") is False


def test_build_context_coordinate_has_review_comments_true_when_set():
    pb = PromptBuilder("Fix bug", "Desc")
    pb.update_context("review_comments", [{"thread_id": "PRRT_1", "path": "src/foo.py", "line": 42, "body": "fix this"}])
    ctx = pb.build_context("coordinate")
    assert ctx.get("has_review_comments") is True


def test_build_context_coordinate_has_review_comments_false_when_empty():
    pb = PromptBuilder("Fix bug", "Desc")
    pb.update_context("review_comments", [])
    ctx = pb.build_context("coordinate")
    assert ctx.get("has_review_comments") is False