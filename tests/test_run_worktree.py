"""Tests for worca.scripts.run_worktree."""
import os
import subprocess
from unittest.mock import patch


from worca.orchestrator.work_request import WorkRequest


def _wr(title="Add auth", source_type="prompt"):
    return WorkRequest(source_type=source_type, title=title)


class TestCreateParser:
    def test_prompt_flag(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "Add auth"])
        assert args.prompt == "Add auth"
        assert args.source is None

    def test_source_flag(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--source", "gh:issue:42"])
        assert args.source == "gh:issue:42"
        assert args.prompt is None

    def test_branch_flag(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "x", "--branch", "feature/auth"])
        assert args.branch == "feature/auth"

    def test_fleet_id_flag(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "x", "--fleet-id", "fleet-123"])
        assert args.fleet_id == "fleet-123"

    def test_guide_flag_single(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "x", "--guide", "docs/spec.md"])
        assert args.guide == ["docs/spec.md"]

    def test_guide_flag_multiple(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "x", "--guide", "a.md", "--guide", "b.md"])
        assert args.guide == ["a.md", "b.md"]

    def test_guide_absent_by_default(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "x"])
        assert args.guide is None

    def test_skip_preflight_flag(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "x", "--skip-preflight"])
        assert args.skip_preflight is True

    def test_msize_mloops_flags(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "x", "--msize", "3", "--mloops", "2"])
        assert args.msize == 3
        assert args.mloops == 2

    def test_template_and_param_flags(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "x", "--template", "bugfix", "--param", "k=v"])
        assert args.template == "bugfix"
        assert args.param == ["k=v"]

    def test_plan_flag(self):
        from worca.scripts.run_worktree import create_parser
        args = create_parser().parse_args(["--prompt", "x", "--plan", "docs/plans/W-048.md"])
        assert args.plan == "docs/plans/W-048.md"


class TestBuildPipelineCmd:
    """Direct tests for _build_pipeline_cmd — pure-function, no Popen mock."""

    def _parse(self, argv):
        from worca.scripts.run_worktree import create_parser
        return create_parser().parse_args(argv)

    def test_minimal_prompt_shape(self):
        from worca.scripts.run_worktree import _build_pipeline_cmd
        cmd = _build_pipeline_cmd(self._parse(["--prompt", "Add auth"]))
        assert cmd[1].endswith("run_pipeline.py")
        assert "--worktree" in cmd
        assert "--prompt" in cmd and "Add auth" in cmd

    def test_source_replaces_prompt(self):
        from worca.scripts.run_worktree import _build_pipeline_cmd
        cmd = _build_pipeline_cmd(self._parse(["--source", "gh:issue:42"]))
        assert "--source" in cmd and "gh:issue:42" in cmd
        assert "--prompt" not in cmd

    def test_msize_mloops_only_when_non_default(self):
        from worca.scripts.run_worktree import _build_pipeline_cmd
        cmd = _build_pipeline_cmd(self._parse(["--prompt", "x"]))
        assert "--msize" not in cmd and "--mloops" not in cmd
        cmd2 = _build_pipeline_cmd(
            self._parse(["--prompt", "x", "--msize", "3", "--mloops", "2"])
        )
        assert ["--msize", "3"] == cmd2[cmd2.index("--msize"):cmd2.index("--msize") + 2]
        assert ["--mloops", "2"] == cmd2[cmd2.index("--mloops"):cmd2.index("--mloops") + 2]

    def test_passes_registry_base_to_run_pipeline(self):
        """run_worktree must pass --registry-base so run_pipeline updates the
        parent project's pipelines.d/ instead of the worktree's empty one."""
        import os
        from worca.scripts.run_worktree import _build_pipeline_cmd
        cmd = _build_pipeline_cmd(self._parse(["--prompt", "x"]))
        idx = cmd.index("--registry-base")
        assert cmd[idx + 1] == os.path.abspath(".worca")
        assert os.path.isabs(cmd[idx + 1])


class TestHelpers:
    def test_generate_run_id_format(self):
        from worca.scripts.run_worktree import _generate_run_id
        rid = _generate_run_id()
        parts = rid.split("-")
        assert len(parts) == 4
        assert len(parts[0]) == 8   # YYYYMMDD
        assert len(parts[1]) == 6   # HHMMSS
        assert len(parts[2]) == 3   # mmm
        assert len(parts[3]) == 4   # xxxx hex

    def test_generate_run_id_unique(self):
        from worca.scripts.run_worktree import _generate_run_id
        ids = {_generate_run_id() for _ in range(10)}
        assert len(ids) == 10

    def test_slugify_basic(self):
        from worca.scripts.run_worktree import _slugify
        assert _slugify("Add auth") == "add-auth"

    def test_slugify_special_chars(self):
        from worca.scripts.run_worktree import _slugify
        assert _slugify("Add auth & search!") == "add-auth-search"

    def test_slugify_truncates(self):
        from worca.scripts.run_worktree import _slugify
        long_title = "a" * 50
        assert len(_slugify(long_title)) <= 30


# ---------------------------------------------------------------------------
# Shared mock setup for main() integration tests
# ---------------------------------------------------------------------------

_WORKTREE_PATH = "/tmp/wt/pipeline-abc"
_RUN_ID = "20260426-120000-000-abcd"


def _patches(worktree_path=_WORKTREE_PATH):
    """Return a list of active patch context managers for main() calls."""
    return [
        patch("worca.scripts.run_worktree._generate_run_id", return_value=_RUN_ID),
        patch("worca.scripts.run_worktree.normalize"),
        patch("worca.scripts.run_worktree.create_pipeline_worktree", return_value=worktree_path),
        patch("worca.scripts.run_worktree.init_worktree_beads", return_value=True),
        patch("worca.scripts.run_worktree.register_pipeline"),
        patch("worca.scripts.run_worktree.os.path.isdir", return_value=True),
        patch("worca.scripts.run_worktree.subprocess.Popen"),
        patch("worca.scripts.run_worktree.shutil.copytree"),
    ]


class TestCreatesWorktree:
    def test_creates_worktree(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2] as mock_create, \
             plist[3], plist[4], plist[5], plist[6], plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 0
        mock_create.assert_called_once_with(
            _RUN_ID, "add-auth", "HEAD", ".worktrees"
        )

    def test_creates_worktree_with_base_branch(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2] as mock_create, \
             plist[3], plist[4], plist[5], plist[6], plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth", "--branch", "feature/auth"])
        assert rc == 0
        mock_create.assert_called_once_with(
            _RUN_ID, "add-auth", "feature/auth", ".worktrees"
        )

    def test_passes_configured_worktree_base_dir(self, tmp_path):
        """When worca.parallel.worktree_base_dir is set, run_worktree forwards
        the value to create_pipeline_worktree instead of hardcoding .worktrees."""
        import json
        from unittest.mock import patch as _patch
        from worca.scripts.run_worktree import main

        settings_file = tmp_path / "settings.json"
        settings_file.write_text(
            json.dumps({"worca": {"parallel": {"worktree_base_dir": "~/wt-foo"}}})
        )
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2] as mock_create, \
             plist[3], plist[4], plist[5], plist[6], plist[7], \
             _patch("worca.utils.settings.load_settings",
                    return_value={"worca": {"parallel": {"worktree_base_dir": "~/wt-foo"}}}):
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth", "--settings", str(settings_file)])
        assert rc == 0
        mock_create.assert_called_once_with(_RUN_ID, "add-auth", "HEAD", "~/wt-foo")

    def test_returns_error_when_worktree_creation_fails(self, capsys):
        from worca.scripts.run_worktree import main
        plist = _patches(worktree_path="")
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4] as mock_reg, plist[5], plist[6] as mock_popen, plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 1
        mock_reg.assert_not_called()
        mock_popen.assert_not_called()


class TestRegistersInPipelinesD:
    def test_registers_in_pipelines_d(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4] as mock_reg, plist[5], plist[6], plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 0
        mock_reg.assert_called_once()
        kwargs = mock_reg.call_args[1]
        assert kwargs["run_id"] == _RUN_ID
        assert kwargs["worktree_path"] == _WORKTREE_PATH
        assert kwargs["title"] == "Add auth"
        assert kwargs["pid"] == os.getpid()


class TestFleetIdPassthrough:
    def test_fleet_id_passthrough(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4] as mock_reg, plist[5], plist[6], plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth", "--fleet-id", "fleet-xyz"])
        assert rc == 0
        kwargs = mock_reg.call_args[1]
        assert kwargs["fleet_id"] == "fleet-xyz"

    def test_fleet_id_none_when_absent(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4] as mock_reg, plist[5], plist[6], plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 0
        kwargs = mock_reg.call_args[1]
        assert kwargs["fleet_id"] is None


class TestTargetBranchPassthrough:
    def test_target_branch_passthrough(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4] as mock_reg, plist[5], plist[6], plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth", "--branch", "feature/auth"])
        assert rc == 0
        kwargs = mock_reg.call_args[1]
        assert kwargs["target_branch"] == "feature/auth"

    def test_target_branch_none_when_absent(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4] as mock_reg, plist[5], plist[6], plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 0
        kwargs = mock_reg.call_args[1]
        assert kwargs["target_branch"] is None


class TestGuidePassthrough:
    def test_guide_passthrough(self, tmp_path):
        from worca.scripts.run_worktree import main
        guide = str(tmp_path / "spec.md")
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4], plist[5], plist[6] as mock_popen, plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth", "--guide", guide])
        assert rc == 0
        cmd = mock_popen.call_args[0][0]
        assert "--guide" in cmd
        idx = cmd.index("--guide")
        assert cmd[idx + 1] == os.path.abspath(guide)

    def test_multiple_guides_all_passed(self, tmp_path):
        from worca.scripts.run_worktree import main
        g1 = str(tmp_path / "spec1.md")
        g2 = str(tmp_path / "spec2.md")
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4], plist[5], plist[6] as mock_popen, plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth", "--guide", g1, "--guide", g2])
        assert rc == 0
        cmd = mock_popen.call_args[0][0]
        assert cmd.count("--guide") == 2


class TestSpawnsDetached:
    def test_spawns_detached(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4], plist[5], plist[6] as mock_popen, plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 0
        mock_popen.assert_called_once()
        kwargs = mock_popen.call_args[1]
        assert kwargs.get("start_new_session") is True
        assert kwargs.get("stdin") == subprocess.DEVNULL
        assert kwargs.get("stdout") == subprocess.DEVNULL
        assert kwargs.get("stderr") == subprocess.DEVNULL

    def test_spawned_in_worktree_cwd(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4], plist[5], plist[6] as mock_popen, plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 0
        kwargs = mock_popen.call_args[1]
        assert kwargs.get("cwd") == _WORKTREE_PATH

    def test_command_includes_worktree_flag(self):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4], plist[5], plist[6] as mock_popen, plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 0
        cmd = mock_popen.call_args[0][0]
        assert "--worktree" in cmd

    def test_prints_run_id_and_path(self, capsys):
        from worca.scripts.run_worktree import main
        plist = _patches()
        with plist[0], plist[1] as mock_norm, plist[2], \
             plist[3], plist[4], plist[5], plist[6], plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 0
        out = capsys.readouterr().out
        assert _RUN_ID in out
        assert _WORKTREE_PATH in out


class TestNoPromptNoSource:
    def test_no_prompt_no_source_exits_2(self, capsys):
        from worca.scripts.run_worktree import main
        rc = main([])
        assert rc == 2
        assert capsys.readouterr().err != ""


class TestMissingWorcaRuntime:
    def test_fails_fast_when_runtime_missing(self, capsys):
        from worca.scripts.run_worktree import main
        plist = _patches()
        # Override isdir to return False — simulates missing .claude/worca/.
        with plist[0], plist[1] as mock_norm, plist[2] as mock_create, \
             plist[3], plist[4] as mock_reg, \
             patch("worca.scripts.run_worktree.os.path.isdir", return_value=False), \
             plist[6] as mock_popen, plist[7]:
            mock_norm.return_value = _wr("Add auth")
            rc = main(["--prompt", "Add auth"])
        assert rc == 1
        err = capsys.readouterr().err
        assert "worca runtime not found" in err
        # Validation must run before any side effects.
        mock_create.assert_not_called()
        mock_reg.assert_not_called()
        mock_popen.assert_not_called()
