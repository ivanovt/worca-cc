"""Tests for guard.py - PreToolUse safety gates."""
import os

import pytest

from worca.hooks.guard import check_guard


# --- Block rm -rf ---

class TestBlockRmRf:
    def test_blocks_rm_rf_slash(self):
        code, reason = check_guard("Bash", {"command": "rm -rf /"})
        assert code == 2
        assert "rm" in reason.lower()

    def test_blocks_rm_rf_directory(self):
        code, reason = check_guard("Bash", {"command": "rm -rf /some/dir"})
        assert code == 2

    def test_blocks_rm_with_separate_r_f_flags(self):
        code, reason = check_guard("Bash", {"command": "rm -r -f /some/dir"})
        assert code == 2

    def test_blocks_rm_fr(self):
        code, reason = check_guard("Bash", {"command": "rm -fr /tmp/stuff"})
        assert code == 2

    def test_allows_simple_rm(self):
        code, reason = check_guard("Bash", {"command": "rm file.txt"})
        assert code == 0

    def test_allows_rm_single_r_flag(self):
        code, reason = check_guard("Bash", {"command": "rm -r dir/"})
        assert code == 0

    def test_allows_rm_single_f_flag(self):
        code, reason = check_guard("Bash", {"command": "rm -f file.txt"})
        assert code == 0


# --- Block .env access ---

class TestBlockEnvAccess:
    def test_blocks_write_to_dotenv(self):
        code, reason = check_guard("Write", {"file_path": "/project/.env"})
        assert code == 2
        assert ".env" in reason

    def test_blocks_edit_to_dotenv(self):
        code, reason = check_guard("Edit", {"file_path": "/project/.env"})
        assert code == 2

    def test_allows_env_sample(self):
        os.environ.pop("WORCA_AGENT", None)
        code, reason = check_guard("Write", {"file_path": "/project/.env.sample"})
        assert code == 0

    def test_allows_env_example(self):
        os.environ.pop("WORCA_AGENT", None)
        code, reason = check_guard("Edit", {"file_path": "/project/.env.example"})
        assert code == 0

    def test_allows_read_dotenv(self):
        code, reason = check_guard("Read", {"file_path": "/project/.env"})
        assert code == 0


# --- Block commits when not Guardian ---

class TestBlockNonGuardianCommits:
    def test_blocks_commit_when_agent_is_implementer(self):
        os.environ["WORCA_AGENT"] = "implementer"
        try:
            code, reason = check_guard("Bash", {"command": "git commit -m 'fix'"})
            assert code == 2
            assert "commit" in reason.lower() or "guardian" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_commit_when_agent_is_guardian(self):
        os.environ["WORCA_AGENT"] = "guardian"
        try:
            code, reason = check_guard("Bash", {"command": "git commit -m 'fix'"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_commit_when_no_agent_env(self):
        os.environ.pop("WORCA_AGENT", None)
        code, reason = check_guard("Bash", {"command": "git commit -m 'fix'"})
        assert code == 0

    def test_blocks_commit_amend_when_not_guardian(self):
        os.environ["WORCA_AGENT"] = "planner"
        try:
            code, reason = check_guard("Bash", {"command": "git commit --amend"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]


# --- Block force push ---

class TestBlockForcePush:
    def test_blocks_git_push_force(self):
        code, reason = check_guard("Bash", {"command": "git push --force"})
        assert code == 2
        assert "force" in reason.lower() or "push" in reason.lower()

    def test_blocks_git_push_dash_f(self):
        code, reason = check_guard("Bash", {"command": "git push -f origin main"})
        assert code == 2

    def test_blocks_git_push_force_with_lease(self):
        # --force-with-lease still contains --force pattern; should block
        code, reason = check_guard("Bash", {"command": "git push --force-with-lease"})
        assert code == 2

    def test_allows_normal_git_push(self):
        code, reason = check_guard("Bash", {"command": "git push origin main"})
        assert code == 0


# --- Allow everything else ---

class TestAllowDefault:
    def test_allows_read(self):
        code, reason = check_guard("Read", {"file_path": "/some/file.py"})
        assert code == 0

    def test_allows_glob(self):
        code, reason = check_guard("Glob", {"pattern": "**/*.py"})
        assert code == 0

    def test_allows_safe_bash(self):
        code, reason = check_guard("Bash", {"command": "ls -la"})
        assert code == 0

    def test_allows_write_to_normal_file(self):
        code, reason = check_guard("Write", {"file_path": "/project/app.py"})
        assert code == 0


# --- Block Planner writes ---

class TestBlockPlannerWrites:
    def test_blocks_planner_write_to_py_file(self):
        os.environ["WORCA_AGENT"] = "planner"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 2
            assert "planner" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_planner_edit_to_source_file(self):
        os.environ["WORCA_AGENT"] = "planner"
        try:
            code, reason = check_guard("Edit", {"file_path": "/project/utils.js"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_planner_write_master_plan(self):
        saved_plan_file = os.environ.pop("WORCA_PLAN_FILE", None)
        os.environ["WORCA_AGENT"] = "planner"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]
            if saved_plan_file is not None:
                os.environ["WORCA_PLAN_FILE"] = saved_plan_file

    def test_allows_implementer_write_source(self):
        os.environ["WORCA_AGENT"] = "implementer"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- Block Planner/Coordinator tests ---

class TestBlockPlannerTests:
    def test_blocks_planner_pytest(self):
        os.environ["WORCA_AGENT"] = "planner"
        try:
            code, reason = check_guard("Bash", {"command": "pytest tests/ -v"})
            assert code == 2
            assert "planner" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_coordinator_pytest(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "python -m pytest"})
            assert code == 2
            assert "coordinator" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_implementer_pytest(self):
        os.environ["WORCA_AGENT"] = "implementer"
        try:
            code, reason = check_guard("Bash", {"command": "pytest tests/ -v"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_planner_safe_bash(self):
        os.environ["WORCA_AGENT"] = "planner"
        try:
            code, reason = check_guard("Bash", {"command": "ls -la"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- Block Coordinator writes ---

class TestBlockCoordinatorWrites:
    def test_blocks_coordinator_write(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 2
            assert "coordinator" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_coordinator_edit(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Edit", {"file_path": "/project/app.py"})
            assert code == 2
            assert "coordinator" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_coordinator_read(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Read", {"file_path": "/project/app.py"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- Block Tester writes ---

class TestBlockTesterWrites:
    def test_blocks_tester_write(self):
        os.environ["WORCA_AGENT"] = "tester"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 2
            assert "tester" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_tester_edit(self):
        os.environ["WORCA_AGENT"] = "tester"
        try:
            code, reason = check_guard("Edit", {"file_path": "/project/config.json"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_tester_read(self):
        os.environ["WORCA_AGENT"] = "tester"
        try:
            code, reason = check_guard("Read", {"file_path": "/project/app.py"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- Planner with WORCA_PLAN_FILE env var ---

class TestPlannerPlanFileEnv:
    def test_allows_planner_write_to_plan_file_from_env(self):
        os.environ["WORCA_AGENT"] = "planner"
        os.environ["WORCA_PLAN_FILE"] = "/project/docs/plans/my-plan.md"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/docs/plans/my-plan.md"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]
            del os.environ["WORCA_PLAN_FILE"]

    def test_blocks_planner_write_wrong_file_with_env(self):
        os.environ["WORCA_AGENT"] = "planner"
        os.environ["WORCA_PLAN_FILE"] = "/project/docs/plans/my-plan.md"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 2
            assert "planner" in reason.lower() or "may only write" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]
            del os.environ["WORCA_PLAN_FILE"]

    def test_allows_planner_write_master_plan_without_env(self):
        """Backward compat: without WORCA_PLAN_FILE, MASTER_PLAN.md is still allowed."""
        os.environ["WORCA_AGENT"] = "planner"
        os.environ.pop("WORCA_PLAN_FILE", None)
        try:
            code, reason = check_guard("Write", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- Block Bash file writes for read-only agents ---

class TestBlockBashFileWrites:
    """Coordinator and tester must not bypass Write/Edit guards via Bash."""

    def test_blocks_coordinator_cat_redirect(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "cat > /project/app.py << 'EOF'\nprint('hello')\nEOF"})
            assert code == 2
            assert "coordinator" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_coordinator_echo_redirect(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": 'echo "hello" > /project/file.txt'})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_coordinator_tee(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "echo 'data' | tee /project/file.txt"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_coordinator_python_file_write(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": """python3 -c "open('file.py','w').write('code')" """})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_coordinator_python_heredoc_write(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "python3 << 'PYSCRIPT'\nopen('file.py','w').write('x')\nPYSCRIPT"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_coordinator_sed_inplace(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "sed -i 's/old/new/g' file.py"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_coordinator_cp(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "cp source.py dest.py"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_tester_cat_redirect(self):
        os.environ["WORCA_AGENT"] = "tester"
        try:
            code, reason = check_guard("Bash", {"command": "cat > /project/app.py << 'EOF'\ncode\nEOF"})
            assert code == 2
            assert "tester" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_coordinator_bd_commands(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "bd create --title='task' --type=task"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_coordinator_bd_list(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "bd list --status=open"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_coordinator_ls(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "ls -la /project/"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_coordinator_grep(self):
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, reason = check_guard("Bash", {"command": "grep -r 'pattern' /project/"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_implementer_cat_redirect(self):
        """Implementer is not read-only, should be allowed."""
        os.environ["WORCA_AGENT"] = "implementer"
        try:
            code, reason = check_guard("Bash", {"command": "cat > /project/app.py << 'EOF'\ncode\nEOF"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_no_agent_cat_redirect(self):
        """No WORCA_AGENT set — no restrictions."""
        os.environ.pop("WORCA_AGENT", None)
        code, reason = check_guard("Bash", {"command": "cat > /project/app.py << 'EOF'\ncode\nEOF"})
        assert code == 0


# --- Safe command bypass (bd commands with triggering content) ---

class TestSafeCommandBypass:
    """bd commands must never be blocked by content-scanning guards."""

    def test_bd_create_with_pytest_in_title(self):
        """Issue A: 'pytest' in bd title must not trigger test-command guard."""
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, _ = check_guard("Bash", {
                "command": 'bd create --title="Write pytest cases for overlay" --type=task'
            })
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_bd_create_with_npm_test_in_description(self):
        """Issue A: 'npm test' in bd args must not trigger test-command guard."""
        os.environ["WORCA_AGENT"] = "planner"
        try:
            code, _ = check_guard("Bash", {
                "command": 'bd create --title="Add npm test script" --type=task'
            })
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_bd_create_with_cp_in_title(self):
        """Issue B/7f: 'cp' in bd title must not trigger file-write guard."""
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, _ = check_guard("Bash", {
                "command": 'bd create --title="cp overlay files to target" --type=task'
            })
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_bd_create_with_redirect_in_title(self):
        """Issue B/7a: '>' in bd title must not trigger redirect guard."""
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, _ = check_guard("Bash", {
                "command": 'bd create --title="version>=2.0 migration" --type=task'
            })
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_bd_create_with_git_commit_in_title(self):
        """Issue C: 'git commit' in bd title must not trigger commit guard."""
        os.environ["WORCA_AGENT"] = "implementer"
        try:
            code, _ = check_guard("Bash", {
                "command": 'bd create --title="Restrict git commit to guardian" --type=task'
            })
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_bd_create_with_python_write_in_description(self):
        """Issue B/7e: 'python3 .write()' in bd args must not trigger."""
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, _ = check_guard("Bash", {
                "command": 'bd create --title="Script uses file.write()" --description="python3 writes output" --type=task'
            })
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_bd_create_with_rm_rf_in_title(self):
        """Consistency: 'rm -rf' in bd title must not trigger."""
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, _ = check_guard("Bash", {
                "command": 'bd create --title="Block rm -rf in guard hook" --type=task'
            })
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- Block PlanReviewer writes ---

class TestBlockPlanReviewerWrites:
    """plan_reviewer is read-only: Write/Edit and file writes via Bash must be blocked."""

    def test_blocks_plan_reviewer_write(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 2
            assert "plan_reviewer" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_plan_reviewer_edit(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("Edit", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 2
            assert "plan_reviewer" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_plan_reviewer_bash_file_write(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("Bash", {"command": "cat > /project/out.txt << 'EOF'\ndata\nEOF"})
            assert code == 2
            assert "plan_reviewer" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_plan_reviewer_read(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("Read", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_plan_reviewer_safe_bash(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("Bash", {"command": "ls -la /project/"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- Block PlanReviewer test execution ---

class TestBlockPlanReviewerTests:
    """plan_reviewer may not run tests — blocked independently of read_only_agents tuple."""

    def test_blocks_plan_reviewer_pytest(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("Bash", {"command": "pytest tests/ -v"})
            assert code == 2
            assert "plan_reviewer" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_plan_reviewer_python_m_pytest(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("Bash", {"command": "python -m pytest"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_plan_reviewer_npm_test(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("Bash", {"command": "npm test"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_plan_reviewer_grep(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("Bash", {"command": "grep -r 'pattern' /project/"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- MCP tools permitted for plan_reviewer ---

class TestPlanReviewerMcpToolsPermitted:
    """MCP tools (context7, WebSearch, WebFetch) must not be blocked for plan_reviewer.

    The PreToolUse hook matcher is 'Bash|Write|Edit', so MCP tool names never
    reach check_guard at runtime. This test confirms that if guard.py ever
    receives an MCP tool call, it still allows it — no inadvertent blocking.
    """

    def test_context7_allowed_for_plan_reviewer(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("mcp__context7__resolve-library-id", {"query": "requests"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_websearch_allowed_for_plan_reviewer(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("WebSearch", {"query": "python requests docs"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_webfetch_allowed_for_plan_reviewer(self):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        try:
            code, reason = check_guard("WebFetch", {"url": "https://docs.python.org"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- PlanReviewer edit-mode carve-out ---

class TestPlanReviewerEditMode:
    """When WORCA_PLAN_REVIEWER_CAN_EDIT=1, plan_reviewer may write the plan file only."""

    def _set_env(self, plan_file="/project/MASTER_PLAN.md", can_edit="1"):
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        os.environ["WORCA_PLAN_REVIEWER_CAN_EDIT"] = can_edit
        if plan_file is not None:
            os.environ["WORCA_PLAN_FILE"] = plan_file

    def _clear_env(self):
        for key in ("WORCA_AGENT", "WORCA_PLAN_REVIEWER_CAN_EDIT", "WORCA_PLAN_FILE"):
            os.environ.pop(key, None)

    def test_allows_write_to_plan_file(self):
        self._set_env()
        try:
            code, reason = check_guard("Write", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 0
        finally:
            self._clear_env()

    def test_allows_edit_to_plan_file(self):
        self._set_env()
        try:
            code, reason = check_guard("Edit", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 0
        finally:
            self._clear_env()

    def test_blocks_write_to_other_file(self):
        self._set_env()
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 2
            assert "plan_reviewer" in reason.lower()
            assert "edit mode" in reason.lower()
        finally:
            self._clear_env()

    def test_blocks_edit_to_other_file(self):
        self._set_env()
        try:
            code, reason = check_guard("Edit", {"file_path": "/project/src/main.py"})
            assert code == 2
        finally:
            self._clear_env()

    def test_blocks_bash_file_write_even_in_edit_mode(self):
        self._set_env()
        try:
            code, reason = check_guard("Bash", {"command": "cat > /project/MASTER_PLAN.md << 'EOF'\ndata\nEOF"})
            assert code == 2
            assert "plan_reviewer" in reason.lower()
        finally:
            self._clear_env()

    def test_blocks_test_execution_even_in_edit_mode(self):
        self._set_env()
        try:
            code, reason = check_guard("Bash", {"command": "pytest tests/ -v"})
            assert code == 2
            assert "plan_reviewer" in reason.lower()
        finally:
            self._clear_env()

    def test_read_only_when_flag_not_set(self):
        """Without WORCA_PLAN_REVIEWER_CAN_EDIT, plan_reviewer stays read-only."""
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        os.environ["WORCA_PLAN_FILE"] = "/project/MASTER_PLAN.md"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 2
            assert "read-only" in reason.lower()
        finally:
            os.environ.pop("WORCA_AGENT", None)
            os.environ.pop("WORCA_PLAN_FILE", None)

    def test_read_only_when_flag_is_zero(self):
        """WORCA_PLAN_REVIEWER_CAN_EDIT=0 means read-only."""
        self._set_env(can_edit="0")
        try:
            code, reason = check_guard("Write", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 2
            assert "read-only" in reason.lower()
        finally:
            self._clear_env()

    def test_path_normalization(self):
        """Paths with trailing slashes or symlink-like differences are normalized."""
        self._set_env(plan_file="/project/./plans/../MASTER_PLAN.md")
        try:
            code, reason = check_guard("Write", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 0
        finally:
            self._clear_env()

    def test_iterated_agent_name(self):
        """Works with the full WORCA_AGENT format: plan_review-plan_reviewer-iter-1."""
        os.environ["WORCA_AGENT"] = "plan_review-plan_reviewer-iter-1"
        os.environ["WORCA_PLAN_REVIEWER_CAN_EDIT"] = "1"
        os.environ["WORCA_PLAN_FILE"] = "/project/MASTER_PLAN.md"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 0
        finally:
            self._clear_env()

    def test_iterated_agent_blocks_other_file(self):
        os.environ["WORCA_AGENT"] = "plan_review-plan_reviewer-iter-1"
        os.environ["WORCA_PLAN_REVIEWER_CAN_EDIT"] = "1"
        os.environ["WORCA_PLAN_FILE"] = "/project/MASTER_PLAN.md"
        try:
            code, reason = check_guard("Edit", {"file_path": "/project/config.json"})
            assert code == 2
        finally:
            self._clear_env()

    def test_no_plan_file_env_blocks_write(self):
        """If WORCA_PLAN_FILE is not set, edit-mode blocks all writes."""
        os.environ["WORCA_AGENT"] = "plan_reviewer"
        os.environ["WORCA_PLAN_REVIEWER_CAN_EDIT"] = "1"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/MASTER_PLAN.md"})
            assert code == 2
        finally:
            os.environ.pop("WORCA_AGENT", None)
            os.environ.pop("WORCA_PLAN_REVIEWER_CAN_EDIT", None)


# --- Block Reviewer writes ---

class TestBlockReviewerWrites:
    """reviewer is read-only: Write/Edit and file writes via Bash must be blocked."""

    def test_blocks_reviewer_write(self):
        os.environ["WORCA_AGENT"] = "reviewer"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 2
            assert "reviewer" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_reviewer_edit(self):
        os.environ["WORCA_AGENT"] = "reviewer"
        try:
            code, reason = check_guard("Edit", {"file_path": "/project/app.py"})
            assert code == 2
            assert "reviewer" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_reviewer_bash_file_write(self):
        os.environ["WORCA_AGENT"] = "reviewer"
        try:
            code, reason = check_guard("Bash", {"command": "cat > /project/out.txt << 'EOF'\ndata\nEOF"})
            assert code == 2
            assert "reviewer" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_reviewer_read(self):
        os.environ["WORCA_AGENT"] = "reviewer"
        try:
            code, reason = check_guard("Read", {"file_path": "/project/app.py"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_allows_reviewer_safe_bash(self):
        os.environ["WORCA_AGENT"] = "reviewer"
        try:
            code, reason = check_guard("Bash", {"command": "git diff HEAD~1"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- cd prefix handling ---

class TestCdPrefixHandling:
    """Commands prefixed with 'cd /project &&' by hooks must work correctly."""

    def test_cd_prefix_bd_create_not_blocked(self):
        """The cd prefix broke the old startswith('bd ') exemption."""
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, _ = check_guard("Bash", {
                "command": 'cd /Volumes/project && bd create --title="Write pytest tests" --type=task'
            })
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_cd_prefix_real_pytest_still_blocked(self):
        """cd prefix on a real test command must still be blocked."""
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, _ = check_guard("Bash", {
                "command": "cd /Volumes/project && pytest tests/ -v"
            })
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_cd_prefix_real_cp_still_blocked(self):
        """cd prefix on a real cp command must still be blocked for read-only agents."""
        os.environ["WORCA_AGENT"] = "coordinator"
        try:
            code, _ = check_guard("Bash", {
                "command": "cd /Volumes/project && cp src.py dst.py"
            })
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_cd_prefix_real_git_commit_still_blocked(self):
        """cd prefix on a real git commit must still be blocked for non-guardian."""
        os.environ["WORCA_AGENT"] = "implementer"
        try:
            code, _ = check_guard("Bash", {
                "command": "cd /Volumes/project && git commit -m 'fix'"
            })
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]


# --- Role extraction from real WORCA_AGENT format ---
# WORCA_AGENT is set from the resolved prompt filename as
# "{stage}-{agent}-iter-{N}" (see utils/claude_cli.py). Prior to the
# 2026-04-13 fix, role checks compared the full env value against bare
# agent names and silently never matched, letting tester/reviewer edit
# files freely.


class TestRoleExtractionIterFormat:
    def test_tester_iter_blocks_write(self):
        os.environ["WORCA_AGENT"] = "test-tester-iter-5"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.js"})
            assert code == 2
            assert "tester" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_tester_iter_blocks_edit(self):
        os.environ["WORCA_AGENT"] = "test-tester-iter-5"
        try:
            code, _ = check_guard("Edit", {"file_path": "/project/routes.js"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_reviewer_iter_blocks_write(self):
        os.environ["WORCA_AGENT"] = "review-reviewer-iter-2"
        try:
            code, reason = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 2
            assert "reviewer" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_reviewer_iter_blocks_pytest(self):
        os.environ["WORCA_AGENT"] = "review-reviewer-iter-2"
        try:
            code, reason = check_guard("Bash", {"command": "pytest tests/"})
            assert code == 2
            assert "reviewer" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_coordinator_iter_blocks_pytest(self):
        os.environ["WORCA_AGENT"] = "coordinate-coordinator-iter-1"
        try:
            code, _ = check_guard("Bash", {"command": "pytest tests/"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_plan_reviewer_iter_blocks_write(self):
        # Note: plan_review stage with plan_reviewer agent →
        # "plan_review-plan_reviewer-iter-1"
        os.environ["WORCA_AGENT"] = "plan_review-plan_reviewer-iter-1"
        try:
            code, _ = check_guard("Write", {"file_path": "/project/config.json"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_implementer_iter_blocks_git_commit(self):
        os.environ["WORCA_AGENT"] = "implement-implementer-iter-7"
        try:
            code, reason = check_guard("Bash", {"command": "git commit -m 'fix'"})
            assert code == 2
            assert "guardian" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_guardian_iter_allowed_to_commit(self):
        os.environ["WORCA_AGENT"] = "pr-guardian-iter-1"
        try:
            code, _ = check_guard("Bash", {"command": "git commit -m 'release'"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_bare_agent_name_still_works(self):
        # Legacy/direct invocation: WORCA_AGENT set to bare role name
        os.environ["WORCA_AGENT"] = "tester"
        try:
            code, _ = check_guard("Write", {"file_path": "/project/app.py"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]


# --- WORCA_AGENT evasion detection ---
# The 2026-04-12 W-039 run had a tester try `unset WORCA_AGENT && git commit`
# to bypass governance. The attempt was saved only by a Bash-subshell quirk.
# These patterns must now be explicitly blocked.


class TestBlockWorcaAgentEvasion:
    def test_blocks_unset_worca_agent(self):
        os.environ["WORCA_AGENT"] = "test-tester-iter-5"
        try:
            code, reason = check_guard("Bash", {
                "command": "unset WORCA_AGENT && git commit -m 'x'"
            })
            assert code == 2
            assert "bypass" in reason.lower() or "governance" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_env_u_worca_agent(self):
        os.environ["WORCA_AGENT"] = "implement-implementer-iter-3"
        try:
            code, reason = check_guard("Bash", {
                "command": "env -u WORCA_AGENT git commit -m 'sneak'"
            })
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_env_override_worca_agent(self):
        os.environ["WORCA_AGENT"] = "test-tester-iter-2"
        try:
            code, _ = check_guard("Bash", {
                "command": "env WORCA_AGENT=guardian git commit -m 'lie'"
            })
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_inline_worca_agent_assignment(self):
        os.environ["WORCA_AGENT"] = "test-tester-iter-2"
        try:
            code, _ = check_guard("Bash", {
                "command": "WORCA_AGENT=guardian git commit -m 'lie'"
            })
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_blocks_export_worca_agent(self):
        os.environ["WORCA_AGENT"] = "test-tester-iter-2"
        try:
            code, _ = check_guard("Bash", {
                "command": "export WORCA_AGENT=guardian"
            })
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]


# --- Guardian source-write restriction ---


class TestGuardianWriteScope:
    def test_guardian_blocked_from_editing_python_source(self):
        os.environ["WORCA_AGENT"] = "pr-guardian-iter-1"
        try:
            code, reason = check_guard("Edit", {"file_path": "/project/src/app.py"})
            assert code == 2
            assert "guardian" in reason.lower() and "source" in reason.lower()
        finally:
            del os.environ["WORCA_AGENT"]

    def test_guardian_blocked_from_editing_tests(self):
        os.environ["WORCA_AGENT"] = "pr-guardian-iter-1"
        try:
            code, _ = check_guard("Edit", {"file_path": "/project/tests/test_foo.py"})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_guardian_allowed_markdown_write(self):
        os.environ["WORCA_AGENT"] = "pr-guardian-iter-1"
        try:
            code, _ = check_guard("Write", {"file_path": "/project/PR_BODY.md"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]

    def test_guardian_allowed_txt_write(self):
        os.environ["WORCA_AGENT"] = "pr-guardian-iter-1"
        try:
            code, _ = check_guard("Write", {"file_path": "/project/release-notes.txt"})
            assert code == 0
        finally:
            del os.environ["WORCA_AGENT"]


# --- Read-only graphify guard (W-053 query pivot) ---
# Agents reach the cached graph through on-demand `graphify query` (the runner
# injects GRAPHIFY_OUT). The worca pipeline owns graph builds, so mutating
# subcommands are blocked. Role-independent, like rm -rf / force-push.


class TestGraphifyMutationGuard:
    @pytest.mark.parametrize("verb", [
        "update", "install", "uninstall", "add", "hook",
        "merge-driver", "watch", "clone",
    ])
    def test_blocks_mutating_verbs(self, verb):
        os.environ.pop("WORCA_AGENT", None)
        code, reason = check_guard("Bash", {"command": f"graphify {verb} ."})
        assert code == 2
        assert "graphify" in reason.lower()

    @pytest.mark.parametrize("verb", [
        "query", "explain", "path", "affected", "diagnose",
    ])
    def test_allows_read_verbs(self, verb):
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard("Bash", {"command": f'graphify {verb} "where is X"'})
        assert code == 0

    def test_blocks_update_even_for_implementer(self):
        os.environ["WORCA_AGENT"] = "implement-implementer-iter-1"
        try:
            code, _ = check_guard("Bash", {"command": "graphify update ."})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_respects_cd_prefix(self):
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard(
            "Bash", {"command": "cd /project && graphify update /project"}
        )
        assert code == 2

    def test_query_mentioning_update_in_quotes_allowed(self):
        """A read query whose text mentions a mutation verb (a later, quoted
        token) must not be falsely flagged."""
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard(
            "Bash", {"command": 'graphify query "how do I update the install hook"'}
        )
        assert code == 0

    def test_env_prefixed_mutation_blocked(self):
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard("Bash", {"command": "GRAPHIFY_OUT=/c graphify install"})
        assert code == 2

    def test_non_graphify_command_unaffected(self):
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard("Bash", {"command": "git update-index --refresh"})
        assert code == 0

    def test_disabled_via_governance_flag(self, monkeypatch):
        """With block_graphify_mutation disabled, mutations are allowed."""
        os.environ.pop("WORCA_AGENT", None)
        monkeypatch.setattr(
            "worca.hooks.guard._graphify_mutation_guard_enabled", lambda: False
        )
        code, _ = check_guard("Bash", {"command": "graphify update ."})
        assert code == 0


# --- CRG (code-review-graph) Bash mutation guard (W-057) ---
# Defense-in-depth: blocks mutating CLI verbs even if an agent shells out
# to the `code-review-graph` binary directly. Mirrors the graphify guard.


class TestCrgMutationGuard:
    @pytest.mark.parametrize("verb", [
        "build", "update", "install", "serve",
        "register", "unregister", "watch", "daemon",
    ])
    def test_blocks_mutating_verbs(self, verb):
        os.environ.pop("WORCA_AGENT", None)
        code, reason = check_guard("Bash", {"command": f"code-review-graph {verb} ."})
        assert code == 2
        assert "code-review-graph" in reason.lower()

    @pytest.mark.parametrize("verb", [
        "query", "get_minimal_context", "get_impact_radius",
        "detect_changes", "get_review_context",
    ])
    def test_allows_read_verbs(self, verb):
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard("Bash", {"command": f'code-review-graph {verb} "some arg"'})
        assert code == 0

    def test_blocks_mutation_even_for_implementer(self):
        os.environ["WORCA_AGENT"] = "implement-implementer-iter-1"
        try:
            code, _ = check_guard("Bash", {"command": "code-review-graph build ."})
            assert code == 2
        finally:
            del os.environ["WORCA_AGENT"]

    def test_respects_cd_prefix(self):
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard(
            "Bash", {"command": "cd /project && code-review-graph build /project"}
        )
        assert code == 2

    def test_query_mentioning_build_in_quotes_allowed(self):
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard(
            "Bash", {"command": 'code-review-graph query "how to build the graph"'}
        )
        assert code == 0

    def test_env_prefixed_mutation_blocked(self):
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard(
            "Bash", {"command": "CRG_DATA_DIR=/tmp code-review-graph install"}
        )
        assert code == 2

    def test_non_crg_command_unaffected(self):
        os.environ.pop("WORCA_AGENT", None)
        code, _ = check_guard("Bash", {"command": "npm install code-review-graph"})
        assert code == 0

    def test_disabled_via_governance_flag(self, monkeypatch):
        """With block_crg_mutation disabled, mutations are allowed."""
        os.environ.pop("WORCA_AGENT", None)
        monkeypatch.setattr(
            "worca.hooks.guard._crg_mutation_guard_enabled", lambda: False
        )
        code, _ = check_guard("Bash", {"command": "code-review-graph build ."})
        assert code == 0
