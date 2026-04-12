"""OverlayResolver: merge per-project agent prompt overlays into rendered core prompts.

Override behavior (replace by default):
- No tag or <!-- replace -->: replace the base prompt entirely
- <!-- append -->: merge sections into base using section merge

Template engine (resolve_placeholders, resolve_blocks, resolve_agent):
- {{name}} / {{name|default}} — simple placeholder substitution
- {{#if name}}...{{/if}} / {{#if name}}...{{else}}...{{/if}} — conditionals
- {{block:name}} — block insertion via three-tier overlay chain
"""

import os
import re
import sys


def _parse_sections(content: str) -> list:
    """Split content into sections at ## headings.

    Returns a list of dicts:
      { "heading": str | None, "body": str, "governance": bool }

    heading is None for the preamble before the first ## heading.
    governance is True if "<!-- governance -->" appears anywhere in body.
    """
    parts = re.split(r"^(## .+)$", content, flags=re.MULTILINE)
    # parts[0] is preamble text (may be empty)
    # then alternating: heading_line, body_text, heading_line, body_text, ...
    sections = []

    preamble_body = parts[0]
    if preamble_body.strip():
        sections.append({
            "heading": None,
            "body": preamble_body,
            "governance": "<!-- governance -->" in preamble_body,
        })

    i = 1
    while i < len(parts) - 1:
        heading_line = parts[i]          # e.g. "## Rules"
        body = parts[i + 1]
        heading = heading_line[3:].strip()  # strip "## " prefix
        sections.append({
            "heading": heading,
            "body": body,
            "governance": "<!-- governance -->" in body,
        })
        i += 2

    return sections


def _parse_overrides(content: str) -> list:
    """Split overlay content into override blocks.

    Returns a list of dicts:
      { "section_name": str, "body": str, "replace": bool }

    replace is True if the first non-blank line of body is "<!-- replace -->".
    The <!-- replace --> line is stripped from body before returning.
    """
    parts = re.split(r"^(## Override:\s*.+)$", content, flags=re.MULTILINE)
    overrides = []

    # parts[0] is text before the first ## Override: (ignored)
    i = 1
    while i < len(parts) - 1:
        heading_line = parts[i]   # e.g. "## Override: Rules"
        body = parts[i + 1]
        section_name = re.sub(r"^##\s*Override:\s*", "", heading_line).strip()

        # Determine replace mode: first non-blank line is "<!-- replace -->"
        replace = False
        lines = body.split("\n")
        new_lines = []
        found_replace = False
        for line in lines:
            if not found_replace and line.strip() == "<!-- replace -->":
                replace = True
                found_replace = True
                continue  # strip this line
            new_lines.append(line)
        body = "\n".join(new_lines)

        overrides.append({
            "section_name": section_name,
            "body": body,
            "replace": replace,
        })
        i += 2

    return overrides


def _heading_matches(core_heading: str, override_name: str) -> bool:
    """Case-insensitive, whitespace-trimmed heading comparison."""
    return core_heading.strip().lower() == override_name.strip().lower()


def _reassemble(sections: list) -> str:
    """Rebuild a Markdown document from a list of section dicts."""
    parts = []
    for section in sections:
        if section["heading"] is None:
            parts.append(section["body"])
        else:
            parts.append(f"## {section['heading']}{section['body']}")
    return "".join(parts)


class OverlayResolver:
    def __init__(self, overrides_dir: str = ".claude/agents"):
        self.overrides_dir = overrides_dir

    def resolve(
        self,
        agent_name: str,
        rendered_core: str,
        template_agents_dir: str | None = None,
    ) -> str:
        """Merge overlay for agent_name into rendered_core.

        Resolution chain:
        1. core prompt (rendered_core)
        2. project overlay (overrides_dir/{agent_name}.md)
        3. template overlay (template_agents_dir/{agent_name}.md) — if provided

        Override behavior (replace by default):
        - No tag or <!-- replace -->: replace the base prompt entirely
        - <!-- append -->: merge sections into base using section merge

        Returns the merged prompt string. If no overlay file exists for
        agent_name at a given tier, that tier is skipped.
        """
        result = self._apply_overlay(agent_name, rendered_core, self.overrides_dir)

        if template_agents_dir is not None:
            result = self._apply_overlay(agent_name, result, template_agents_dir)

        return result

    def resolve_block(
        self,
        block_name: str,
        core_dir: str,
        template_agents_dir: str | None = None,
    ) -> str | None:
        """Resolve a block file through the three-tier overlay chain.

        Resolution order:
        1. core block:    core_dir/{block_name}.block.md
        2. project overlay: overrides_dir/{block_name}.block.md
        3. template overlay: template_agents_dir/{block_name}.block.md

        Returns None if no tier provides the block file.
        Uses the same replace/append overlay logic as agent .md resolution.
        """
        core_path = os.path.join(core_dir, f"{block_name}.block.md")
        project_path = os.path.join(self.overrides_dir, f"{block_name}.block.md")
        tpl_path = (
            os.path.join(template_agents_dir, f"{block_name}.block.md")
            if template_agents_dir
            else None
        )

        any_exists = (
            os.path.exists(core_path)
            or os.path.exists(project_path)
            or (tpl_path is not None and os.path.exists(tpl_path))
        )
        if not any_exists:
            return None

        # Load core content as the base
        result = ""
        if os.path.exists(core_path):
            try:
                with open(core_path) as f:
                    result = f.read().strip()
            except (OSError, PermissionError) as exc:
                print(
                    f"[overlay] Warning: cannot read block '{core_path}': {exc}",
                    file=sys.stderr,
                )

        # Apply project overlay
        result = self._apply_block_overlay(block_name, result, self.overrides_dir)

        # Apply template overlay
        if template_agents_dir is not None:
            result = self._apply_block_overlay(block_name, result, template_agents_dir)

        return result

    def _apply_block_overlay(self, block_name: str, base: str, agents_dir: str) -> str:
        """Apply a single block overlay tier from agents_dir onto base.

        Looks for {block_name}.block.md in agents_dir and applies the same
        replace/append logic as _apply_overlay.
        """
        overlay_path = os.path.join(agents_dir, f"{block_name}.block.md")

        if not os.path.exists(overlay_path):
            return base

        try:
            with open(overlay_path) as f:
                overlay_content = f.read()
        except (OSError, PermissionError) as exc:
            print(
                f"[overlay] Warning: cannot read block overlay '{overlay_path}': {exc}",
                file=sys.stderr,
            )
            return base

        stripped = overlay_content.lstrip()

        if stripped.startswith("<!-- append -->"):
            overlay_body = stripped[len("<!-- append -->"):]
            return self._apply_append_mode(block_name, base, overlay_body)

        if stripped.startswith("<!-- replace -->"):
            content = stripped[len("<!-- replace -->"):]
        else:
            content = overlay_content

        return content.strip()

    def _apply_overlay(self, agent_name: str, base: str, agents_dir: str) -> str:
        """Apply a single overlay tier from agents_dir onto base."""
        overlay_path = os.path.join(agents_dir, f"{agent_name}.md")

        if not os.path.exists(overlay_path):
            return base

        try:
            with open(overlay_path) as f:
                overlay_content = f.read()
        except (OSError, PermissionError) as exc:
            print(
                f"[overlay] Warning: cannot read overlay '{overlay_path}': {exc}",
                file=sys.stderr,
            )
            return base

        stripped = overlay_content.lstrip()

        # Append mode: merge sections into base
        if stripped.startswith("<!-- append -->"):
            overlay_body = stripped[len("<!-- append -->"):]
            return self._apply_append_mode(agent_name, base, overlay_body)

        # Replace mode (default): strip optional tag, use as-is
        if stripped.startswith("<!-- replace -->"):
            content = stripped[len("<!-- replace -->"):]
        else:
            content = overlay_content

        return content.strip()

    def _apply_append_mode(self, agent_name: str, rendered_core: str, overlay_body: str) -> str:
        """Apply append-mode overlay using section merge."""
        overrides = _parse_overrides(overlay_body)
        if not overrides:
            # No ## Override: blocks — just append the raw content
            return rendered_core.rstrip() + "\n\n" + overlay_body.strip()

        sections = _parse_sections(rendered_core)

        for override in overrides:
            matched = False
            for section in sections:
                if section["heading"] is not None and _heading_matches(
                    section["heading"], override["section_name"]
                ):
                    matched = True
                    if override["replace"] and section["governance"]:
                        print(
                            f"[overlay] Warning: overlay for '{override['section_name']}' in "
                            f"'{agent_name}.md' requests replace but section is "
                            f"governance-protected; demoting to append.",
                            file=sys.stderr,
                        )
                        _apply_append(section, override["body"])
                    elif override["replace"]:
                        orig_body = section["body"]
                        leading = orig_body[: len(orig_body) - len(orig_body.lstrip("\n"))]
                        section["body"] = leading + override["body"]
                    else:
                        _apply_append(section, override["body"])
                    break

            if not matched:
                new_body = f"\n\n{override['body']}"
                sections.append({
                    "heading": override["section_name"],
                    "body": new_body,
                    "governance": False,
                })

        return _reassemble(sections)


def _apply_append(section: dict, override_body: str) -> None:
    """Append override_body to section['body'], ensuring a blank-line separator."""
    body = section["body"]
    if not body.endswith("\n"):
        body += "\n"
    section["body"] = body + "\n" + override_body


# ---------------------------------------------------------------------------
# Template engine — placeholder and block resolution
# ---------------------------------------------------------------------------

# Matches the innermost {{#if name}}...{{/if}} block (no nested {{#if inside).
# Uses a tempered greedy token to avoid matching across nested conditionals.
_INNER_COND_RE = re.compile(
    r"\{\{#if (\w+)\}\}"
    r"((?:(?!\{\{#if )[\s\S])*?)"
    r"\{\{/if\}\}",
    re.DOTALL,
)

# Matches {{name}} or {{name|default text}} but not {{block:...}}, {{#...}}, {{/...}}.
_PLACEHOLDER_RE = re.compile(
    r"\{\{(?!block:|#|/)([a-zA-Z_][a-zA-Z0-9_]*)(?:\|([^}]*))?\}\}"
)

# Matches {{block:name}} on its own line (block references must be line-isolated).
_BLOCK_RE = re.compile(r"^\{\{block:(\S+)\}\}\s*$", re.MULTILINE)


def resolve_placeholders(content: str, context: dict) -> str:
    """Resolve {{name}}, {{name|default}}, and {{#if}}...{{/if}} in content.

    Processing order:
    1. Conditionals — resolved innermost-first to support nesting.
    2. Simple placeholders — {{name}} and {{name|default}}.
    """
    # Step 1: resolve conditionals (inside-out for nesting support)
    prev = None
    while content != prev:
        prev = content

        def _replace_cond(m: re.Match) -> str:
            key = m.group(1)
            body = m.group(2)
            parts = body.split("{{else}}", 1)
            if_body = parts[0]
            else_body = parts[1] if len(parts) > 1 else ""
            return if_body if context.get(key) else else_body

        content = _INNER_COND_RE.sub(_replace_cond, content)

    # Step 2: resolve simple placeholders
    def _replace_ph(m: re.Match) -> str:
        key = m.group(1)
        default = m.group(2)
        if default is not None:
            return str(context.get(key, default))
        return str(context.get(key, ""))

    return _PLACEHOLDER_RE.sub(_replace_ph, content)


def resolve_blocks(
    content: str,
    context: dict,
    resolver: "OverlayResolver",
    core_dir: str,
    template_agents_dir: str | None = None,
    _seen: set | None = None,
) -> str:
    """Replace {{block:name}} references with resolved block content.

    Each block is loaded via resolver.resolve_block() through the three-tier
    overlay chain. Blocks may embed other blocks (recursive). Cycle detection
    prevents infinite loops — a block that would recurse into itself is skipped
    (resolved to empty string at the recursive call site).

    Block references must appear on their own line: ``{{block:name}}``.
    """
    if _seen is None:
        _seen = set()

    def _replace_block(m: re.Match) -> str:
        block_name = m.group(1)
        if block_name in _seen:
            return ""  # cycle detected — skip this reference
        block_content = resolver.resolve_block(block_name, core_dir, template_agents_dir)
        if block_content is None:
            return ""  # block doesn't exist at any tier
        _seen.add(block_name)
        resolved = resolve_blocks(
            block_content, context, resolver, core_dir, template_agents_dir, _seen
        )
        _seen.discard(block_name)
        return resolved.strip()

    return _BLOCK_RE.sub(_replace_block, content)


def resolve_agent(
    content: str,
    context: dict,
    resolver: "OverlayResolver",
    core_dir: str,
    template_agents_dir: str | None = None,
) -> str:
    """Full agent .md resolution pipeline: blocks → conditionals → placeholders → cleanup.

    Steps:
    1. Resolve {{block:name}} references (recursive, with cycle detection).
    2. Resolve {{#if}}...{{/if}} conditionals.
    3. Resolve {{name}} and {{name|default}} placeholders.
    4. Collapse 3+ consecutive blank lines to 2.
    """
    result = resolve_blocks(content, context, resolver, core_dir, template_agents_dir)
    result = resolve_placeholders(result, context)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result
