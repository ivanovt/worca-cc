"""Tests for worca.scripts.run_parallel helper functions."""

import os
import re
import sys
from unittest.mock import patch, MagicMock

import pytest

from worca.scripts.run_parallel import _slugify, _run_pipeline_in_worktree
from worca.utils.claude_cli import _ARG_INLINE_LIMIT


# --- _slugify ---

def test_slugify_basic():
    assert _slugify("Add user auth") == "add-user-auth"


def test_slugify_special_chars():
    assert _slugify("Fix bug #42!") == "fix-bug-42"


def test_slugify_collapses_dashes():
    assert _slugify("too   many   spaces") == "too-many-spaces"


def test_slugify_strips_leading_trailing():
    assert _slugify("  --hello--  ") == "hello"


def test_slugify_truncates_to_30():
    long_title = "a" * 50
    result = _slugify(long_title)
    assert len(result) <= 30


def test_slugify_only_alphanumeric_and_dash():
    result = _slugify("Hello@World#2024!")
    assert re.match(r'^[a-z0-9\-]+$', result)


# --- _run_pipeline_in_worktree large prompt offloading ---

class TestRunPipelineLargePrompt:
    @patch("worca.scripts.run_parallel.subprocess.run")
    def test_small_prompt_uses_inline_arg(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="ok", stderr="")
        _run_pipeline_in_worktree("/tmp/wt", "small prompt", 1, 1, "settings.json")
        cmd = mock_run.call_args[0][0]
        assert "--prompt" in cmd
        assert "--prompt-file" not in cmd
        idx = cmd.index("--prompt")
        assert cmd[idx + 1] == "small prompt"

    @patch("worca.scripts.run_parallel.subprocess.run")
    def test_large_prompt_uses_prompt_file(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0, stdout="ok", stderr="")
        large_prompt = "x" * (_ARG_INLINE_LIMIT + 1)
        _run_pipeline_in_worktree("/tmp/wt", large_prompt, 1, 1, "settings.json")
        cmd = mock_run.call_args[0][0]
        assert "--prompt-file" in cmd
        assert "--prompt" not in cmd
        # The temp file should have been cleaned up
        idx = cmd.index("--prompt-file")
        prompt_file = cmd[idx + 1]
        assert not os.path.exists(prompt_file)

    @patch("worca.scripts.run_parallel.subprocess.run")
    def test_large_prompt_file_contains_full_content(self, mock_run):
        """Verify the temp file contains the full prompt before subprocess runs."""
        large_prompt = "y" * (_ARG_INLINE_LIMIT + 100)
        written_content = None

        def capture_run(cmd, **kwargs):
            nonlocal written_content
            idx = cmd.index("--prompt-file")
            path = cmd[idx + 1]
            if os.path.exists(path):
                with open(path) as f:
                    written_content = f.read()
            return MagicMock(returncode=0, stdout="", stderr="")

        mock_run.side_effect = capture_run
        _run_pipeline_in_worktree("/tmp/wt", large_prompt, 1, 1, "settings.json")
        assert written_content == large_prompt


# --- main() — validate_runtime and copy_claude_config integration ---

class TestMainValidateRuntime:
    """main() must call validate_runtime() before creating any worktrees."""

    def test_validate_runtime_called_before_worktrees(self, monkeypatch, tmp_path):
        # Use ThreadPoolExecutor so mock functions can be called without cross-process serialization.
        from concurrent.futures import ThreadPoolExecutor
        wt_dir = tmp_path / "worktrees"
        wt_dir.mkdir()
        wt_path = str(wt_dir / "add-auth")
        monkeypatch.setattr(sys, "argv", [
            "run_parallel.py", "--prompts", "Add auth",
            "--worktree-dir", str(wt_dir),
        ])
        call_order = []

        def fake_validate():
            call_order.append("validate")

        def fake_create(base_dir, slug, branch):
            call_order.append("create")
            return wt_path

        def fake_run(worktree_path, prompt, msize, mloops, settings):
            return {"worktree": worktree_path, "prompt": prompt,
                    "returncode": 0, "stdout": "", "stderr": ""}

        with patch("worca.scripts.run_parallel.validate_runtime", side_effect=fake_validate), \
             patch("worca.scripts.run_parallel.copy_claude_config"), \
             patch("worca.scripts.run_parallel._create_worktree", side_effect=fake_create), \
             patch("worca.scripts.run_parallel._run_pipeline_in_worktree", side_effect=fake_run), \
             patch("worca.scripts.run_parallel.ProcessPoolExecutor", ThreadPoolExecutor), \
             pytest.raises(SystemExit):
            from worca.scripts.run_parallel import main
            main()

        assert call_order.index("validate") < call_order.index("create")

    def test_validate_runtime_failure_exits_before_worktree_creation(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["run_parallel.py", "--prompts", "Add auth"])
        create_called = []

        def fake_validate():
            raise SystemExit(1)

        def fake_create(*args, **kwargs):
            create_called.append(True)
            return "/tmp/wt/add-auth"

        with patch("worca.scripts.run_parallel.validate_runtime", side_effect=fake_validate), \
             patch("worca.scripts.run_parallel._create_worktree", side_effect=fake_create), \
             pytest.raises(SystemExit) as exc_info:
            from worca.scripts.run_parallel import main
            main()

        assert exc_info.value.code == 1
        assert create_called == [], "worktree creation must not run when validation fails"


class TestMainCopyClaudeConfig:
    """main() must call copy_claude_config after each worktree is created."""

    def test_copy_called_for_each_worktree(self, monkeypatch, tmp_path):
        from concurrent.futures import ThreadPoolExecutor
        wt_dir = tmp_path / "worktrees"
        wt_dir.mkdir()
        wt_paths = [str(wt_dir / "add-auth"), str(wt_dir / "fix-bug")]
        monkeypatch.setattr(sys, "argv", [
            "run_parallel.py", "--prompts", "Add auth", "Fix bug",
            "--worktree-dir", str(wt_dir),
        ])
        create_iter = iter(wt_paths)
        copy_calls = []

        def fake_create(base_dir, slug, branch):
            return next(create_iter)

        def fake_copy(src, dst):
            copy_calls.append((src, dst))

        result_map = {p: {"worktree": p, "prompt": p, "returncode": 0, "stdout": "", "stderr": ""}
                      for p in wt_paths}

        def fake_run(worktree_path, prompt, msize, mloops, settings):
            return result_map[worktree_path]

        with patch("worca.scripts.run_parallel.validate_runtime"), \
             patch("worca.scripts.run_parallel.copy_claude_config", side_effect=fake_copy), \
             patch("worca.scripts.run_parallel._create_worktree", side_effect=fake_create), \
             patch("worca.scripts.run_parallel._run_pipeline_in_worktree", side_effect=fake_run), \
             patch("worca.scripts.run_parallel.ProcessPoolExecutor", ThreadPoolExecutor), \
             pytest.raises(SystemExit):
            from worca.scripts.run_parallel import main
            main()

        assert len(copy_calls) == 2
        assert copy_calls[0] == (".claude", os.path.join(wt_paths[0], ".claude"))
        assert copy_calls[1] == (".claude", os.path.join(wt_paths[1], ".claude"))

    def test_copy_dst_is_dot_claude_inside_worktree(self, monkeypatch, tmp_path):
        from concurrent.futures import ThreadPoolExecutor
        wt_dir = tmp_path / "worktrees"
        wt_dir.mkdir()
        wt_path = str(wt_dir / "my-worktree")
        monkeypatch.setattr(sys, "argv", [
            "run_parallel.py", "--prompts", "Do work",
            "--worktree-dir", str(wt_dir),
        ])
        copy_calls = []

        def fake_run(worktree_path, prompt, msize, mloops, settings):
            return {"worktree": worktree_path, "prompt": prompt,
                    "returncode": 0, "stdout": "", "stderr": ""}

        with patch("worca.scripts.run_parallel.validate_runtime"), \
             patch("worca.scripts.run_parallel.copy_claude_config",
                   side_effect=lambda src, dst: copy_calls.append((src, dst))), \
             patch("worca.scripts.run_parallel._create_worktree", return_value=wt_path), \
             patch("worca.scripts.run_parallel._run_pipeline_in_worktree", side_effect=fake_run), \
             patch("worca.scripts.run_parallel.ProcessPoolExecutor", ThreadPoolExecutor), \
             pytest.raises(SystemExit):
            from worca.scripts.run_parallel import main
            main()

        assert len(copy_calls) == 1
        src, dst = copy_calls[0]
        assert src == ".claude"
        assert dst == os.path.join(wt_path, ".claude")


# --- --guide flag ---

class TestGuideFlag:
    """main() accepts --guide PATH (repeatable) and calls attach_guide on each WorkRequest."""

    def test_guide_flag_accepted_by_parser(self, monkeypatch, tmp_path):
        """--guide PATH should be accepted without error."""
        guide = tmp_path / "guide.md"
        guide.write_text("# Guide\nSome content")
        from concurrent.futures import ThreadPoolExecutor
        wt_dir = tmp_path / "worktrees"
        wt_dir.mkdir()
        wt_path = str(wt_dir / "add-auth")
        monkeypatch.setattr(sys, "argv", [
            "run_parallel.py", "--prompts", "Add auth",
            "--guide", str(guide),
            "--worktree-dir", str(wt_dir),
        ])

        def fake_run(worktree_path, prompt, msize, mloops, settings):
            return {"worktree": worktree_path, "prompt": prompt,
                    "returncode": 0, "stdout": "", "stderr": ""}

        with patch("worca.scripts.run_parallel.validate_runtime"), \
             patch("worca.scripts.run_parallel.copy_claude_config"), \
             patch("worca.scripts.run_parallel._create_worktree", return_value=wt_path), \
             patch("worca.scripts.run_parallel._run_pipeline_in_worktree", side_effect=fake_run), \
             patch("worca.scripts.run_parallel.ProcessPoolExecutor", ThreadPoolExecutor), \
             pytest.raises(SystemExit):
            from worca.scripts.run_parallel import main
            main()

    def test_guide_calls_attach_guide(self, monkeypatch, tmp_path):
        """When --guide is provided, attach_guide is called for each work request."""
        guide = tmp_path / "guide.md"
        guide.write_text("# Guide\nSome content")
        from concurrent.futures import ThreadPoolExecutor
        wt_dir = tmp_path / "worktrees"
        wt_dir.mkdir()
        wt_path = str(wt_dir / "add-auth")
        monkeypatch.setattr(sys, "argv", [
            "run_parallel.py", "--prompts", "Add auth",
            "--guide", str(guide),
            "--worktree-dir", str(wt_dir),
        ])
        attach_calls = []

        def fake_attach(wr, paths, *, max_bytes=None):
            attach_calls.append(paths)
            return wr

        def fake_run(worktree_path, prompt, msize, mloops, settings):
            return {"worktree": worktree_path, "prompt": prompt,
                    "returncode": 0, "stdout": "", "stderr": ""}

        with patch("worca.scripts.run_parallel.validate_runtime"), \
             patch("worca.scripts.run_parallel.copy_claude_config"), \
             patch("worca.scripts.run_parallel._create_worktree", return_value=wt_path), \
             patch("worca.scripts.run_parallel._run_pipeline_in_worktree", side_effect=fake_run), \
             patch("worca.scripts.run_parallel.ProcessPoolExecutor", ThreadPoolExecutor), \
             patch("worca.scripts.run_parallel.attach_guide", side_effect=fake_attach), \
             pytest.raises(SystemExit):
            from worca.scripts.run_parallel import main
            main()

        assert len(attach_calls) == 1
        assert attach_calls[0] == [str(guide)]

    def test_guide_not_called_when_omitted(self, monkeypatch, tmp_path):
        """When --guide is not provided, attach_guide is not called."""
        from concurrent.futures import ThreadPoolExecutor
        wt_dir = tmp_path / "worktrees"
        wt_dir.mkdir()
        wt_path = str(wt_dir / "add-auth")
        monkeypatch.setattr(sys, "argv", [
            "run_parallel.py", "--prompts", "Add auth",
            "--worktree-dir", str(wt_dir),
        ])
        attach_calls = []

        def fake_run(worktree_path, prompt, msize, mloops, settings):
            return {"worktree": worktree_path, "prompt": prompt,
                    "returncode": 0, "stdout": "", "stderr": ""}

        with patch("worca.scripts.run_parallel.validate_runtime"), \
             patch("worca.scripts.run_parallel.copy_claude_config"), \
             patch("worca.scripts.run_parallel._create_worktree", return_value=wt_path), \
             patch("worca.scripts.run_parallel._run_pipeline_in_worktree", side_effect=fake_run), \
             patch("worca.scripts.run_parallel.ProcessPoolExecutor", ThreadPoolExecutor), \
             patch("worca.scripts.run_parallel.attach_guide",
                   side_effect=lambda wr, paths, **_: attach_calls.append(paths) or wr), \
             pytest.raises(SystemExit):
            from worca.scripts.run_parallel import main
            main()

        assert attach_calls == []

    def test_multiple_guides_passed_through(self, monkeypatch, tmp_path):
        """Multiple --guide flags are all passed to attach_guide."""
        guide_a = tmp_path / "guide_a.md"
        guide_b = tmp_path / "guide_b.md"
        guide_a.write_text("# Guide A")
        guide_b.write_text("# Guide B")
        from concurrent.futures import ThreadPoolExecutor
        wt_dir = tmp_path / "worktrees"
        wt_dir.mkdir()
        wt_path = str(wt_dir / "add-auth")
        monkeypatch.setattr(sys, "argv", [
            "run_parallel.py", "--prompts", "Add auth",
            "--guide", str(guide_a),
            "--guide", str(guide_b),
            "--worktree-dir", str(wt_dir),
        ])
        attach_calls = []

        def fake_run(worktree_path, prompt, msize, mloops, settings):
            return {"worktree": worktree_path, "prompt": prompt,
                    "returncode": 0, "stdout": "", "stderr": ""}

        with patch("worca.scripts.run_parallel.validate_runtime"), \
             patch("worca.scripts.run_parallel.copy_claude_config"), \
             patch("worca.scripts.run_parallel._create_worktree", return_value=wt_path), \
             patch("worca.scripts.run_parallel._run_pipeline_in_worktree", side_effect=fake_run), \
             patch("worca.scripts.run_parallel.ProcessPoolExecutor", ThreadPoolExecutor), \
             patch("worca.scripts.run_parallel.attach_guide",
                   side_effect=lambda wr, paths, **_: attach_calls.append(paths) or wr), \
             pytest.raises(SystemExit):
            from worca.scripts.run_parallel import main
            main()

        assert len(attach_calls) == 1
        assert attach_calls[0] == [str(guide_a), str(guide_b)]

    def test_guide_applied_to_all_prompts(self, monkeypatch, tmp_path):
        """When multiple prompts, attach_guide is called for each."""
        guide = tmp_path / "guide.md"
        guide.write_text("# Guide")
        from concurrent.futures import ThreadPoolExecutor
        wt_dir = tmp_path / "worktrees"
        wt_dir.mkdir()
        wt_paths = [str(wt_dir / "add-auth"), str(wt_dir / "fix-bug")]
        monkeypatch.setattr(sys, "argv", [
            "run_parallel.py", "--prompts", "Add auth", "Fix bug",
            "--guide", str(guide),
            "--worktree-dir", str(wt_dir),
        ])
        attach_calls = []
        create_iter = iter(wt_paths)

        def fake_create(base_dir, slug, branch):
            return next(create_iter)

        def fake_run(worktree_path, prompt, msize, mloops, settings):
            return {"worktree": worktree_path, "prompt": prompt,
                    "returncode": 0, "stdout": "", "stderr": ""}

        with patch("worca.scripts.run_parallel.validate_runtime"), \
             patch("worca.scripts.run_parallel.copy_claude_config"), \
             patch("worca.scripts.run_parallel._create_worktree", side_effect=fake_create), \
             patch("worca.scripts.run_parallel._run_pipeline_in_worktree", side_effect=fake_run), \
             patch("worca.scripts.run_parallel.ProcessPoolExecutor", ThreadPoolExecutor), \
             patch("worca.scripts.run_parallel.attach_guide",
                   side_effect=lambda wr, paths, **_: attach_calls.append(paths) or wr), \
             pytest.raises(SystemExit):
            from worca.scripts.run_parallel import main
            main()

        assert len(attach_calls) == 2
        assert all(paths == [str(guide)] for paths in attach_calls)
