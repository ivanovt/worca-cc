# /// script
# requires-python = ">=3.8"
# ///
"""Run a single work request through the worca-cc pipeline."""
import argparse
import json
import sys
import os
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from worca.orchestrator.work_request import normalize, WorkRequest
from worca.orchestrator.runner import run_pipeline, LoopExhaustedError, PipelineError, _find_active_runs
from worca.state.status import load_status
from worca.utils.gh_issues import gh_issue_fail


def create_parser():
    """Create the argument parser for the pipeline CLI."""
    parser = argparse.ArgumentParser(description="Run worca-cc pipeline")
    parser.add_argument("--prompt", help="Text prompt for work request")
    parser.add_argument("--source", help="Source reference (gh:issue:42, bd:bd-abc)")
    parser.add_argument("--spec", help="Path to spec file")
    parser.add_argument("--settings", default=".claude/settings.json",
                        help="Path to settings.json")
    parser.add_argument("--status-dir", default=".worca",
                        help="Directory for pipeline status files")
    parser.add_argument("--msize", type=int, default=1, choices=range(1, 11),
                        metavar="[1-10]",
                        help="Task size multiplier for max_turns per stage (default: 1)")
    parser.add_argument("--mloops", type=int, default=1, choices=range(1, 11),
                        metavar="[1-10]",
                        help="Loop multiplier for max loop iterations (default: 1)")
    parser.add_argument("--plan", help="Path to pre-made plan file (skips PLAN stage)")
    parser.add_argument("--resume", action="store_true",
                        help="Resume a previous run from status.json instead of starting fresh")
    parser.add_argument("--branch", help="Use an existing branch instead of creating a new one")
    parser.add_argument("--skip-preflight", action="store_true",
                        help="Skip the PREFLIGHT stage (useful when environment is known-good)")
    parser.add_argument("--prompt-file",
                        help="Read prompt from file instead of --prompt (for large prompts "
                             "that would exceed ARG_MAX). The file is deleted after reading.")
    parser.add_argument("--worktree", action="store_true",
                        help="Worktree mode: skip branch creation and register in multi-pipeline registry")
    parser.add_argument("--template", help="Template ID to apply before running")
    parser.add_argument("--param", action="append", metavar="KEY=VALUE",
                        help="Template parameter override (repeatable)")
    parser.add_argument("--guide", action="append", metavar="PATH",
                        help="Path to a reference guide (repeatable); passed from run_worktree.py")
    parser.add_argument("--registry-base",
                        help="Absolute path to the parent project's .worca/ directory; "
                             "required in --worktree mode so pipelines.d/ updates land "
                             "in the parent project, not inside the worktree.")
    return parser


def _parse_params(param_list):
    """Parse a list of KEY=VALUE strings into a dict.

    Raises SystemExit(2) if any item lacks an '=' separator.
    Returns {} when param_list is None or empty.
    """
    if not param_list:
        return {}
    result = {}
    for item in param_list:
        if "=" not in item:
            print(f"error: --param must be KEY=VALUE format, got: {item!r}", file=sys.stderr)
            raise SystemExit(2)
        key, _, value = item.partition("=")
        result[key] = value
    return result


def _make_template_resolver(settings_path: str):
    """Create a TemplateResolver with standard tier dirs relative to settings_path."""
    from worca.orchestrator.templates import TemplateResolver
    builtin_dir = Path(__file__).parent.parent / "templates"
    # settings_path is typically .claude/settings.json; project root is two levels up
    project_root = Path(settings_path).resolve().parent.parent
    project_dir = project_root / ".claude" / "templates"
    user_dir = Path.home() / ".worca" / "templates"
    return TemplateResolver(builtin_dir, project_dir, user_dir)


def build_work_request(args):
    """Validate args and build a WorkRequest with prompt merging.

    Validation:
    - --source and --spec are mutually exclusive
    - At least one of --prompt/--source/--spec/--plan is required

    Prompt merging: when --prompt accompanies a source/spec/plan,
    it is appended as '## Additional Instructions' to the description.
    """
    # Validation: --source and --spec are mutually exclusive
    if args.source and args.spec:
        print("error: --source and --spec are mutually exclusive", file=sys.stderr)
        raise SystemExit(2)

    # Validation: at least one arg required
    if not any([args.prompt, args.source, args.spec, args.plan]):
        print("error: at least one of --prompt, --source, --spec, or --plan is required",
              file=sys.stderr)
        raise SystemExit(2)

    # Normalize: source/spec/plan take priority, prompt-only is fallback
    has_primary = args.source or args.spec or args.plan
    if args.source:
        work_request = normalize("source", args.source)
    elif args.spec:
        work_request = normalize("spec", args.spec)
    elif args.plan:
        work_request = normalize("plan", args.plan)
    else:
        work_request = normalize("prompt", args.prompt)

    # Prompt merging: append as Additional Instructions when prompt
    # accompanies a primary source
    if args.prompt and has_primary:
        if work_request.description:
            work_request.description += f"\n\n## Additional Instructions\n\n{args.prompt}"
        else:
            work_request.description = f"## Additional Instructions\n\n{args.prompt}"

    return work_request


def main():
    parser = create_parser()
    args = parser.parse_args()

    # --prompt-file: read prompt from file and delete it
    if args.prompt_file:
        if args.prompt:
            print("error: --prompt and --prompt-file are mutually exclusive", file=sys.stderr)
            raise SystemExit(2)
        # Validate path is inside the system temp directory
        import tempfile
        real_path = os.path.realpath(args.prompt_file)
        temp_dir = os.path.realpath(tempfile.gettempdir())
        if not real_path.startswith(temp_dir + os.sep):
            print(f"error: --prompt-file must be inside {temp_dir}", file=sys.stderr)
            raise SystemExit(2)
        try:
            with open(args.prompt_file) as f:
                args.prompt = f.read()
        except FileNotFoundError:
            print(f"error: prompt file not found: {args.prompt_file}", file=sys.stderr)
            raise SystemExit(2)
        try:
            os.unlink(args.prompt_file)
        except OSError:
            pass

    if args.resume:
        # Resume: load work_request from existing status.json instead of building from args
        # Scan runs/ for non-terminal runs; error if multiple are found.
        active_runs = _find_active_runs(args.status_dir)
        if len(active_runs) > 1:
            print(
                f"error: multiple active runs found in {args.status_dir} — "
                "specify --status-dir to select one",
                file=sys.stderr,
            )
            raise SystemExit(2)
        elif len(active_runs) == 1:
            _, status_file = active_runs[0]
        else:
            status_file = os.path.join(args.status_dir, "status.json")
        if os.path.exists(status_file):
            existing = load_status(status_file)
            wr = existing.get("work_request", {})
            work_request = WorkRequest(
                source_type=wr.get("source_type", "prompt"),
                title=wr.get("title", "Resumed pipeline"),
                description=wr.get("description", ""),
                source_ref=wr.get("source_ref"),
                priority=wr.get("priority", 2),
                plan_path=wr.get("plan_path"),
            )
        else:
            print(f"error: cannot resume — status file not found: {status_file}", file=sys.stderr)
            raise SystemExit(2)
        plan_file = args.plan
        print(f"Resuming pipeline: {work_request.title}")
    else:
        work_request = build_work_request(args)

        if args.guide:
            try:
                from worca.orchestrator.work_request import attach_guide
            except ImportError:
                raise argparse.ArgumentError(
                    None,
                    "--guide requires worca-cc with attach_guide() (W-040 / #101). "
                    "The flag was accepted by W-048 plumbing but content injection is "
                    "not yet implemented in this version. Upgrade worca-cc to a version "
                    "that ships W-040, or remove --guide from your invocation.",
                )
            work_request = attach_guide(work_request, args.guide)

        # Resolve plan: explicit --plan wins, then auto-detected from issue body
        plan_file = args.plan or work_request.plan_path

        print(f"Starting pipeline: {work_request.title}")
    if plan_file and args.plan:
        print(f"  Pre-made plan: {plan_file} (skipping PLAN stage)")
    elif plan_file:
        print(f"  Auto-detected plan from issue: {plan_file} (skipping PLAN stage)")
    if args.msize > 1:
        print(f"  Size multiplier: {args.msize}x turns")
    if args.mloops > 1:
        print(f"  Loop multiplier: {args.mloops}x loops")
    if args.branch:
        print(f"  Using existing branch: {args.branch}")
    if args.worktree:
        print("  Worktree mode: skipping branch creation, registering in multi-pipeline registry")
    if args.skip_preflight:
        print("  Skipping preflight checks")

    # Template application: resolve, deep-merge config, prepare temp settings file
    _template_id = args.template
    _params = {}
    _merged_settings = None
    _temp_settings_path = None
    _resolver = None
    _pipeline_template = None

    if _template_id:
        import tempfile
        from worca.orchestrator.templates import TemplateError

        _params = _parse_params(args.param or [])

        try:
            from worca.utils.settings import load_settings as _load_settings
            _current_settings = _load_settings(args.settings)
        except Exception:
            _current_settings = {}

        _current_worca = _current_settings.get("worca", {})
        _resolver = _make_template_resolver(args.settings)

        try:
            _merged_worca = _resolver.apply(_template_id, _current_worca, _params)
        except TemplateError as e:
            print(f"error: template '{_template_id}': {e}", file=sys.stderr)
            raise SystemExit(2)

        # If template has an agents/ dir, store it in settings for overlay use
        _tmpl = _resolver.get(_template_id)
        if _tmpl and _tmpl.agents_dir:
            _merged_worca["_template_agents_dir"] = _tmpl.agents_dir

        # Format pipeline_template as "tier:id" for storage in status.json
        if _tmpl:
            _tier_display = "worca" if _tmpl.tier == "builtin" else _tmpl.tier
            _pipeline_template = f"{_tier_display}:{_template_id}"

        _merged_settings = {**_current_settings, "worca": _merged_worca}
        _tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False)
        json.dump(_merged_settings, _tmp, indent=2)
        _tmp.close()
        _temp_settings_path = _tmp.name

        print(f"  Template: {_template_id}")

    effective_settings_path = _temp_settings_path if _template_id else args.settings

    try:
        effective_status_path = os.path.join(args.status_dir, "status.json")
        status = run_pipeline(
            work_request,
            plan_file=plan_file,
            resume=args.resume,
            settings_path=effective_settings_path,
            status_path=effective_status_path,
            msize=args.msize,
            mloops=args.mloops,
            branch=args.branch,
            skip_preflight=args.skip_preflight,
            worktree=args.worktree,
            pipeline_template=_pipeline_template,
            registry_base=args.registry_base,
        )

        # Snapshot template to run dir and write merged settings for traceability
        if _template_id and _resolver and status.get("run_id"):
            run_dir = os.path.join(args.status_dir, "runs", status["run_id"])
            try:
                _resolver.snapshot_to_run(_template_id, run_dir, _params)
            except Exception as snap_err:
                print(f"warning: template snapshot failed: {snap_err}", file=sys.stderr)
            if _merged_settings:
                try:
                    Path(run_dir, "settings.json").write_text(
                        json.dumps(_merged_settings, indent=2)
                    )
                except OSError:
                    pass

        print(json.dumps(status, indent=2))
    except LoopExhaustedError as e:
        print(f"Loop exhausted: {e}", file=sys.stderr)
        try:
            status = load_status(os.path.join(args.status_dir, "status.json"))
            gh_issue_fail(status, error=str(e))
        except Exception:
            pass
        sys.exit(1)
    except PipelineError as e:
        print(f"Pipeline error: {e}", file=sys.stderr)
        try:
            status = load_status(os.path.join(args.status_dir, "status.json"))
            gh_issue_fail(status, error=str(e))
        except Exception:
            pass
        sys.exit(2)
    finally:
        if _temp_settings_path:
            try:
                os.unlink(_temp_settings_path)
            except OSError:
                pass


if __name__ == "__main__":
    main()
