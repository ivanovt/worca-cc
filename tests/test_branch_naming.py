"""Tests for worca.utils.branch_naming."""
import re
import pytest
from datetime import datetime, timezone

from worca.utils.branch_naming import (
    slugify,
    resolve_branch_template,
    check_head_branch_collision,
)


# ---------------------------------------------------------------------------
# slugify
# ---------------------------------------------------------------------------

class TestSlugify:
    def test_basic(self):
        assert slugify("Add user auth") == "add-user-auth"

    def test_special_chars(self):
        assert slugify("Fix bug #42!") == "fix-bug-42"

    def test_collapses_multiple_dashes(self):
        assert slugify("too   many   spaces") == "too-many-spaces"

    def test_strips_leading_trailing_dashes(self):
        assert slugify("  --hello--  ") == "hello"

    def test_truncates_to_30(self):
        result = slugify("a" * 50)
        assert len(result) <= 30

    def test_only_alphanumeric_and_dash(self):
        result = slugify("Hello@World#2024!")
        assert re.match(r'^[a-z0-9\-]+$', result)

    def test_empty_string(self):
        assert slugify("") == ""

    def test_unicode_becomes_dashes(self):
        result = slugify("café au lait")
        assert re.match(r'^[a-z0-9\-]+$', result)


# ---------------------------------------------------------------------------
# resolve_branch_template
# ---------------------------------------------------------------------------

_FIXED_NOW = datetime(2026, 5, 12, 10, 30, 0, tzinfo=timezone.utc)


class TestResolveBranchTemplate:
    def test_project_placeholder(self):
        result = resolve_branch_template(
            "migration/{project}", {"project": "my-repo"}
        )
        assert result == "migration/my-repo"

    def test_fleet_id_placeholder(self):
        result = resolve_branch_template(
            "fleet-{fleet_id}", {"fleet_id": "f123", "project": "repo"}
        )
        assert result == "fleet-f123"

    def test_slug_placeholder(self):
        result = resolve_branch_template(
            "worca/{slug}", {"slug": "add-auth", "project": "repo"}
        )
        assert result == "worca/add-auth"

    def test_yyyymmdd_auto_computed(self):
        result = resolve_branch_template(
            "release/{yyyymmdd}", {"project": "repo"}, now=_FIXED_NOW
        )
        assert result == "release/20260512"

    def test_yyyymmddhhmm_auto_computed(self):
        result = resolve_branch_template(
            "release/{yyyymmddhhmm}", {"project": "repo"}, now=_FIXED_NOW
        )
        assert result == "release/202605121030"

    def test_no_placeholder_appends_project(self):
        result = resolve_branch_template(
            "migration", {"project": "my-repo"}
        )
        assert result == "migration/my-repo"

    def test_multiple_placeholders(self):
        result = resolve_branch_template(
            "{fleet_id}/{project}/{slug}",
            {"fleet_id": "f123", "project": "my-repo", "slug": "add-auth"},
        )
        assert result == "f123/my-repo/add-auth"

    def test_default_now_is_utc(self):
        # Just verify no exception when now is not supplied.
        result = resolve_branch_template("x/{yyyymmdd}", {"project": "r"})
        assert re.match(r'^x/\d{8}$', result)

    def test_project_appended_once_when_no_placeholder(self):
        # Should not double-append if called twice.
        r1 = resolve_branch_template("base", {"project": "p"})
        r2 = resolve_branch_template("base", {"project": "p"})
        assert r1 == r2 == "base/p"

    def test_mixed_explicit_and_auto_placeholders(self):
        result = resolve_branch_template(
            "{slug}/{yyyymmdd}",
            {"slug": "fix-auth", "project": "repo"},
            now=_FIXED_NOW,
        )
        assert result == "fix-auth/20260512"


# ---------------------------------------------------------------------------
# check_head_branch_collision
# ---------------------------------------------------------------------------

class TestCheckHeadBranchCollision:
    def test_no_collision_is_fine(self):
        check_head_branch_collision(["branch-a", "branch-b", "branch-c"])

    def test_empty_list_is_fine(self):
        check_head_branch_collision([])

    def test_single_branch_is_fine(self):
        check_head_branch_collision(["branch-a"])

    def test_duplicate_raises_value_error(self):
        with pytest.raises(ValueError):
            check_head_branch_collision(["branch-a", "branch-b", "branch-a"])

    def test_error_names_the_colliding_branch(self):
        with pytest.raises(ValueError, match="branch-a"):
            check_head_branch_collision(["branch-a", "branch-b", "branch-a"])

    def test_error_message_contains_collision_keyword(self):
        with pytest.raises(ValueError, match="(?i)collision"):
            check_head_branch_collision(["x", "x"])

    def test_first_collision_reported_on_multiple_dupes(self):
        # "x" collides before "y" collides — first duplicate pair reported.
        with pytest.raises(ValueError, match="x"):
            check_head_branch_collision(["x", "y", "x", "y"])

    def test_all_same_raises(self):
        with pytest.raises(ValueError):
            check_head_branch_collision(["same", "same", "same"])
