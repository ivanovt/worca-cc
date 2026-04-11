"""Tests for template engine: resolve_placeholders, resolve_blocks, resolve_agent.

Tests for T1 and T2 of W-037: template engine functions and resolve_block in overlay.py.
"""

from unittest.mock import MagicMock


from worca.orchestrator.overlay import (
    OverlayResolver,
    resolve_agent,
    resolve_blocks,
    resolve_placeholders,
)


# ---------------------------------------------------------------------------
# resolve_placeholders — simple substitution
# ---------------------------------------------------------------------------


def test_simple_placeholder():
    result = resolve_placeholders("Hello {{name}}!", {"name": "World"})
    assert result == "Hello World!"


def test_placeholder_missing_key():
    result = resolve_placeholders("Value: {{missing}}", {})
    assert result == "Value: "


def test_placeholder_default():
    result = resolve_placeholders("Value: {{name|fallback}}", {})
    assert result == "Value: fallback"


def test_placeholder_default_key_present():
    result = resolve_placeholders("Value: {{name|fallback}}", {"name": "actual"})
    assert result == "Value: actual"


def test_placeholder_default_with_spaces():
    """Default text may contain spaces."""
    result = resolve_placeholders("Value: {{name|some default text}}", {})
    assert result == "Value: some default text"


def test_conditional_truthy():
    result = resolve_placeholders("{{#if show}}body content{{/if}}", {"show": True})
    assert result == "body content"


def test_conditional_falsy():
    result = resolve_placeholders("{{#if show}}body content{{/if}}", {"show": False})
    assert result == ""


def test_conditional_missing_key_is_falsy():
    result = resolve_placeholders("{{#if show}}body content{{/if}}", {})
    assert result == ""


def test_conditional_else_truthy():
    result = resolve_placeholders("{{#if flag}}yes{{else}}no{{/if}}", {"flag": True})
    assert result == "yes"


def test_conditional_else_falsy():
    result = resolve_placeholders("{{#if flag}}yes{{else}}no{{/if}}", {"flag": False})
    assert result == "no"


def test_conditional_multiline():
    content = "{{#if retry}}\n## Retry Context\n\nTest failures here.\n{{/if}}"
    result = resolve_placeholders(content, {"retry": True})
    assert "## Retry Context" in result
    assert "Test failures here" in result


def test_conditional_multiline_falsy():
    content = "before\n{{#if retry}}\n## Retry\n{{/if}}\nafter"
    result = resolve_placeholders(content, {"retry": False})
    assert "## Retry" not in result
    assert "before" in result
    assert "after" in result


def test_nested_conditionals_both_true():
    content = "{{#if a}}outer{{#if b}}inner{{/if}}end{{/if}}"
    result = resolve_placeholders(content, {"a": True, "b": True})
    assert "outer" in result
    assert "inner" in result
    assert "end" in result


def test_nested_conditional_inner_false():
    content = "{{#if a}}outer{{#if b}}inner{{/if}}end{{/if}}"
    result = resolve_placeholders(content, {"a": True, "b": False})
    assert "outer" in result
    assert "inner" not in result
    assert "end" in result


def test_nested_conditional_outer_false():
    content = "{{#if a}}outer{{#if b}}inner{{/if}}end{{/if}}"
    result = resolve_placeholders(content, {"a": False, "b": True})
    assert result == ""


def test_placeholder_truthy_nonempty_string():
    """Non-empty string is truthy in conditionals."""
    result = resolve_placeholders("{{#if val}}present{{/if}}", {"val": "hello"})
    assert result == "present"


def test_placeholder_truthy_zero_is_falsy():
    """0 is falsy in conditionals."""
    result = resolve_placeholders("{{#if val}}present{{/if}}", {"val": 0})
    assert result == ""


# ---------------------------------------------------------------------------
# resolve_blocks — block insertion
# ---------------------------------------------------------------------------


def _mock_resolver(blocks: dict):
    """Return a mock OverlayResolver whose resolve_block returns blocks[name] or None."""
    resolver = MagicMock()
    resolver.resolve_block.side_effect = lambda name, *args, **kwargs: blocks.get(name)
    return resolver


def test_block_insertion():
    content = "Before\n{{block:myblock}}\nAfter"
    resolver = _mock_resolver({"myblock": "Block content here"})
    result = resolve_blocks(content, {}, resolver, "/core")
    assert "Block content here" in result
    assert "Before" in result
    assert "After" in result


def test_block_missing_resolves_to_empty():
    content = "Before\n{{block:nonexistent}}\nAfter"
    resolver = _mock_resolver({})
    result = resolve_blocks(content, {}, resolver, "/core")
    assert "{{block:nonexistent}}" not in result
    assert "Before" in result
    assert "After" in result


def test_block_reference_removed_when_missing():
    """A missing block leaves no token in the output."""
    resolver = _mock_resolver({})
    result = resolve_blocks("{{block:gone}}", {}, resolver, "/core")
    assert "{{block:" not in result


def test_block_recursive():
    """Block A embeds {{block:b}}, which resolves to plain content."""

    def _resolve(name, *args, **kwargs):
        if name == "a":
            return "A start\n{{block:b}}\nA end"
        if name == "b":
            return "B content"
        return None

    resolver = MagicMock()
    resolver.resolve_block.side_effect = _resolve

    result = resolve_blocks("{{block:a}}", {}, resolver, "/core")
    assert "A start" in result
    assert "B content" in result
    assert "A end" in result


def test_block_cycle_detection():
    """A → B → A cycle terminates without infinite recursion."""
    call_count = [0]

    def _resolve(name, *args, **kwargs):
        call_count[0] += 1
        if call_count[0] > 20:
            raise RuntimeError("infinite loop detected in test")
        if name == "a":
            return "A:\n{{block:b}}"
        if name == "b":
            return "B:\n{{block:a}}"
        return None

    resolver = MagicMock()
    resolver.resolve_block.side_effect = _resolve

    result = resolve_blocks("{{block:a}}", {}, resolver, "/core")
    assert "A:" in result
    assert "B:" in result
    # No exception means cycle was handled


def test_block_self_cycle_detection():
    """A block referencing itself is dropped on the second occurrence."""

    def _resolve(name, *args, **kwargs):
        return "self ref\n{{block:self}}\nend"

    resolver = MagicMock()
    resolver.resolve_block.side_effect = _resolve

    result = resolve_blocks("{{block:self}}", {}, resolver, "/core")
    assert "self ref" in result
    # Should not infinite-loop


def test_block_template_agents_dir_forwarded():
    """template_agents_dir is forwarded to resolve_block."""
    resolver = MagicMock()
    resolver.resolve_block.return_value = "block content"

    resolve_blocks("{{block:foo}}", {}, resolver, "/core", "/tpl")

    resolver.resolve_block.assert_called_once_with("foo", "/core", "/tpl")


def test_block_core_dir_forwarded():
    """core_dir is forwarded to resolve_block."""
    resolver = MagicMock()
    resolver.resolve_block.return_value = None

    resolve_blocks("{{block:bar}}", {}, resolver, "/my/core")

    resolver.resolve_block.assert_called_once_with("bar", "/my/core", None)


# ---------------------------------------------------------------------------
# resolve_agent — full pipeline
# ---------------------------------------------------------------------------


def test_resolve_agent_integrates_blocks_and_placeholders():
    """Blocks are resolved first; placeholders inside blocks are then substituted."""

    def _resolve(name, *args, **kwargs):
        if name == "ctx":
            return "Work: {{work_request}}"
        return None

    resolver = MagicMock()
    resolver.resolve_block.side_effect = _resolve

    content = "# Agent\n\n{{block:ctx}}\n\n## Rules\n"
    result = resolve_agent(content, {"work_request": "Fix the bug"}, resolver, "/core")

    assert "Work: Fix the bug" in result
    assert "{{block:ctx}}" not in result
    assert "{{work_request}}" not in result


def test_resolve_agent_cleanup_collapses_blank_lines():
    """3+ consecutive blank lines are collapsed to 2."""
    resolver = MagicMock()
    resolver.resolve_block.return_value = None

    content = "Line 1\n\n\n\n\nLine 2"
    result = resolve_agent(content, {}, resolver, "/core")

    assert "\n\n\n" not in result
    assert "Line 1" in result
    assert "Line 2" in result


def test_resolve_agent_cleanup_after_empty_conditional():
    """Blank lines created by a falsy conditional are collapsed."""
    resolver = MagicMock()
    resolver.resolve_block.return_value = None

    content = "before\n\n{{#if x}}\n\nSection content\n\n{{/if}}\n\n\nafter"
    result = resolve_agent(content, {}, resolver, "/core")

    assert "\n\n\n" not in result
    assert "before" in result
    assert "after" in result
    assert "Section content" not in result


def test_resolve_agent_no_blocks_no_placeholders():
    """Content with no tokens passes through unchanged (modulo blank line cleanup)."""
    resolver = MagicMock()
    resolver.resolve_block.return_value = None

    content = "# Agent\n\n## Role\nYou are the agent.\n"
    result = resolve_agent(content, {}, resolver, "/core")
    assert result == content


def test_resolve_agent_template_agents_dir_forwarded():
    """template_agents_dir is passed through to resolve_blocks."""
    resolver = MagicMock()
    resolver.resolve_block.return_value = None

    resolve_agent("{{block:foo}}", {}, resolver, "/core", "/tpl")

    resolver.resolve_block.assert_called_once_with("foo", "/core", "/tpl")


# ---------------------------------------------------------------------------
# OverlayResolver.resolve_block — three-tier block resolution
# ---------------------------------------------------------------------------


def test_resolve_block_returns_core_content(tmp_path):
    """Core block file is found and returned."""
    core_dir = tmp_path / "core"
    core_dir.mkdir()
    (core_dir / "myblock.block.md").write_text("Core block content")

    resolver = OverlayResolver(overrides_dir=str(tmp_path / "project"))
    result = resolver.resolve_block("myblock", str(core_dir), None)
    assert result == "Core block content"


def test_resolve_block_returns_none_when_no_file(tmp_path):
    """Returns None when no tier has the block."""
    resolver = OverlayResolver(overrides_dir=str(tmp_path / "project"))
    result = resolver.resolve_block("nonexistent", str(tmp_path / "core"), None)
    assert result is None


def test_resolve_block_returns_none_no_template_either(tmp_path):
    """Returns None when neither project nor template tier has the block."""
    tpl_dir = tmp_path / "tpl"
    tpl_dir.mkdir()
    resolver = OverlayResolver(overrides_dir=str(tmp_path / "project"))
    result = resolver.resolve_block("nonexistent", str(tmp_path / "core"), str(tpl_dir))
    assert result is None


def test_resolve_block_project_overlay_replaces_core(tmp_path):
    """Project overlay (replace mode) replaces core block content."""
    core_dir = tmp_path / "core"
    core_dir.mkdir()
    (core_dir / "myblock.block.md").write_text("Core block content")

    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "myblock.block.md").write_text("Project block content")

    resolver = OverlayResolver(overrides_dir=str(project_dir))
    result = resolver.resolve_block("myblock", str(core_dir), None)
    assert result == "Project block content"
    assert "Core" not in result


def test_resolve_block_template_overlay_replaces_project(tmp_path):
    """Template overlay takes final priority over project overlay."""
    core_dir = tmp_path / "core"
    core_dir.mkdir()
    (core_dir / "myblock.block.md").write_text("Core content")

    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "myblock.block.md").write_text("Project content")

    tpl_dir = tmp_path / "template"
    tpl_dir.mkdir()
    (tpl_dir / "myblock.block.md").write_text("Template content")

    resolver = OverlayResolver(overrides_dir=str(project_dir))
    result = resolver.resolve_block("myblock", str(core_dir), str(tpl_dir))
    assert result == "Template content"
    assert "Core" not in result
    assert "Project" not in result


def test_resolve_block_project_only_no_core(tmp_path):
    """Project block file alone (no core) is returned."""
    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "myblock.block.md").write_text("Project only content")

    resolver = OverlayResolver(overrides_dir=str(project_dir))
    result = resolver.resolve_block("myblock", str(tmp_path / "core"), None)
    assert result == "Project only content"


def test_resolve_block_template_only_no_core_no_project(tmp_path):
    """Template-only block (no core, no project) is returned."""
    tpl_dir = tmp_path / "tpl"
    tpl_dir.mkdir()
    (tpl_dir / "myblock.block.md").write_text("Template only content")

    resolver = OverlayResolver(overrides_dir=str(tmp_path / "project"))
    result = resolver.resolve_block("myblock", str(tmp_path / "core"), str(tpl_dir))
    assert result == "Template only content"


def test_resolve_block_project_append_merges_with_core(tmp_path):
    """Project overlay in append mode appends to core block content."""
    core_dir = tmp_path / "core"
    core_dir.mkdir()
    (core_dir / "myblock.block.md").write_text("Core content")

    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "myblock.block.md").write_text("<!-- append -->\nExtra content")

    resolver = OverlayResolver(overrides_dir=str(project_dir))
    result = resolver.resolve_block("myblock", str(core_dir), None)
    assert "Core content" in result
    assert "Extra content" in result


def test_resolve_block_explicit_replace_tag(tmp_path):
    """Project overlay with <!-- replace --> tag still replaces core."""
    core_dir = tmp_path / "core"
    core_dir.mkdir()
    (core_dir / "myblock.block.md").write_text("Core content")

    project_dir = tmp_path / "project"
    project_dir.mkdir()
    (project_dir / "myblock.block.md").write_text("<!-- replace -->\nReplacement content")

    resolver = OverlayResolver(overrides_dir=str(project_dir))
    result = resolver.resolve_block("myblock", str(core_dir), None)
    assert result == "Replacement content"
    assert "Core" not in result


def test_resolve_block_skips_missing_project_tier(tmp_path):
    """If only core exists (no project file), core content is returned."""
    core_dir = tmp_path / "core"
    core_dir.mkdir()
    (core_dir / "myblock.block.md").write_text("Core only")

    resolver = OverlayResolver(overrides_dir=str(tmp_path / "project"))
    result = resolver.resolve_block("myblock", str(core_dir), None)
    assert result == "Core only"


def test_resolve_block_skips_missing_template_tier(tmp_path):
    """If template_agents_dir is set but has no matching file, result unchanged."""
    core_dir = tmp_path / "core"
    core_dir.mkdir()
    (core_dir / "myblock.block.md").write_text("Core only")

    tpl_dir = tmp_path / "tpl"
    tpl_dir.mkdir()

    resolver = OverlayResolver(overrides_dir=str(tmp_path / "project"))
    result = resolver.resolve_block("myblock", str(core_dir), str(tpl_dir))
    assert result == "Core only"
