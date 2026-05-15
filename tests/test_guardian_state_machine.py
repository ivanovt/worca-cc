"""Tests for guardian.md combined state machine (W-047 §6.5).

Validates the six-step decision flow documented in §6.5:
  1. Commit gate (unchanged)
  2. Push gate (unchanged)
  3. WORCA_DEFER_PR=1 short-circuits PR creation
  4. PR title prefix: [fleet:<short>] or [workspace:<short>]
  5. target_branch used as --base
  6. PR body augmentation (workspace name + repo role)

All six steps must coexist — §6.5 cites this.
"""
import pathlib


GUARDIAN_PATH = (
    pathlib.Path(__file__).parent.parent
    / "src"
    / "worca"
    / "agents"
    / "core"
    / "guardian.md"
)


def _read():
    return GUARDIAN_PATH.read_text()


# ---------------------------------------------------------------------------
# Step 3: WORCA_DEFER_PR=1 short-circuits PR creation
# ---------------------------------------------------------------------------


def test_defer_pr_short_circuits():
    """WORCA_DEFER_PR=1 → guardian commits and pushes but does NOT call
    gh pr create (per §6.5 step 3)."""
    content = _read()
    assert "WORCA_DEFER_PR" in content
    lower = content.lower()
    assert "defer" in lower
    assert "short-circuit" in lower or "skip" in lower or "do not" in lower
    assert "gh pr create" in content.lower() or "pr create" in content.lower()


# ---------------------------------------------------------------------------
# Step 4: Fleet title prefix (W-040 §11 — must be preserved)
# ---------------------------------------------------------------------------


def test_fleet_title_prefix():
    """WORCA_FLEET_ID set → PR title prepends [fleet:<short>]
    (W-040 §11 + §6.5 step 4)."""
    content = _read()
    assert "WORCA_FLEET_ID" in content
    assert "[fleet:" in content
    assert "fleet_id_short" in content


# ---------------------------------------------------------------------------
# Step 4: Workspace title prefix (W-047 §6)
# ---------------------------------------------------------------------------


def test_workspace_title_prefix():
    """WORCA_WORKSPACE_ID set → PR title prepends [workspace:<short>]
    (§6.5 step 4)."""
    content = _read()
    assert "WORCA_WORKSPACE_ID" in content
    assert "[workspace:" in content


# ---------------------------------------------------------------------------
# Step 5: target_branch used as --base (W-048 §10 — must be preserved)
# ---------------------------------------------------------------------------


def test_target_branch_used_in_base():
    """status.target_branch = "dev" → gh pr create --base dev
    (W-048 §10 + §6.5 step 5)."""
    content = _read()
    assert "target_branch" in content
    assert "--base" in content


# ---------------------------------------------------------------------------
# Step 6 + combined: all clauses coexist
# ---------------------------------------------------------------------------


def test_combined_workspace_run():
    """All six steps fire together: defer-respect, workspace title,
    target_branch base, workspace body line, repo role line."""
    content = _read()
    lower = content.lower()

    # Step 3: defer gate present
    assert "WORCA_DEFER_PR" in content

    # Step 4: both fleet and workspace title prefix present
    assert "[fleet:" in content
    assert "[workspace:" in content

    # Step 4: mutual exclusivity documented
    assert "WORCA_FLEET_ID" in content
    assert "WORCA_WORKSPACE_ID" in content

    # Step 5: target_branch → --base
    assert "target_branch" in content
    assert "--base" in content

    # Step 6: workspace body augmentation
    assert "workspace" in lower and ("name" in lower or "workspace_name" in lower)
    assert "repo role" in lower or "repo_role" in lower or "WORCA_REPO_ROLE" in content
