"""Tests for CRG CLI detection (detect_code_review_graph)."""

from unittest.mock import patch

from worca.utils.code_review_graph import CrgDetect, detect_code_review_graph
from worca.utils.tool_detect import ToolProbe


class TestDetectCrg:
    def test_detect_crg_missing(self):
        """When code-review-graph is not on PATH, installed=False."""
        with patch(
            "worca.utils.code_review_graph.probe_cli",
            return_value=ToolProbe(
                installed=False,
                version=None,
                compatible=False,
                error="code-review-graph not found on PATH",
            ),
        ):
            result = detect_code_review_graph()

        assert result == CrgDetect(
            installed=False,
            version=None,
            compatible=False,
            fastmcp_ok=False,
            error="code-review-graph not found on PATH",
        )

    def test_detect_crg_version_mismatch(self):
        """CRG installed but outside version_range → compatible=False."""
        with patch(
            "worca.utils.code_review_graph.probe_cli",
            return_value=ToolProbe(
                installed=True,
                version="1.9.0",
                compatible=False,
                error="version 1.9.0 not in >=2,<3",
            ),
        ):
            result = detect_code_review_graph(version_range=">=2,<3")

        assert result.installed is True
        assert result.version == "1.9.0"
        assert result.compatible is False
        assert result.fastmcp_ok is False
        assert "1.9.0" in result.error

    def test_detect_crg_fastmcp_too_old(self):
        """CRG compatible but fastmcp below floor → fastmcp_ok=False."""
        crg_probe = ToolProbe(
            installed=True, version="2.2.3", compatible=True, error=None
        )
        fastmcp_probe = ToolProbe(
            installed=True,
            version="3.1.0",
            compatible=False,
            error="version 3.1.0 not in >=3.2.4",
        )
        with patch(
            "worca.utils.code_review_graph.probe_cli",
            side_effect=[crg_probe, fastmcp_probe],
        ):
            result = detect_code_review_graph(
                version_range=">=2,<3", fastmcp_min="3.2.4"
            )

        assert result.installed is True
        assert result.version == "2.2.3"
        assert result.compatible is True
        assert result.fastmcp_ok is False
        assert "fastmcp" in result.error.lower()

    def test_detect_crg_fastmcp_missing(self):
        """CRG compatible but fastmcp not installed → fastmcp_ok=False."""
        crg_probe = ToolProbe(
            installed=True, version="2.2.3", compatible=True, error=None
        )
        fastmcp_probe = ToolProbe(
            installed=False,
            version=None,
            compatible=False,
            error="fastmcp not found on PATH",
        )
        with patch(
            "worca.utils.code_review_graph.probe_cli",
            side_effect=[crg_probe, fastmcp_probe],
        ):
            result = detect_code_review_graph()

        assert result.installed is True
        assert result.compatible is True
        assert result.fastmcp_ok is False
        assert "fastmcp" in result.error.lower()

    def test_detect_crg_all_ok(self):
        """CRG compatible + fastmcp ok → fully ready."""
        crg_probe = ToolProbe(
            installed=True, version="2.2.3", compatible=True, error=None
        )
        fastmcp_probe = ToolProbe(
            installed=True, version="3.2.4", compatible=True, error=None
        )
        with patch(
            "worca.utils.code_review_graph.probe_cli",
            side_effect=[crg_probe, fastmcp_probe],
        ):
            result = detect_code_review_graph()

        assert result == CrgDetect(
            installed=True,
            version="2.2.3",
            compatible=True,
            fastmcp_ok=True,
            error=None,
        )

    def test_detect_crg_four_part_version(self):
        """CRG uses 4-part versions like 2.2.3.1 — probe must handle them."""
        crg_probe = ToolProbe(
            installed=True, version="2.2.3.1", compatible=True, error=None
        )
        fastmcp_probe = ToolProbe(
            installed=True, version="3.3.0", compatible=True, error=None
        )
        with patch(
            "worca.utils.code_review_graph.probe_cli",
            side_effect=[crg_probe, fastmcp_probe],
        ):
            result = detect_code_review_graph()

        assert result.installed is True
        assert result.version == "2.2.3.1"
        assert result.compatible is True
        assert result.fastmcp_ok is True

    def test_dataclass_is_frozen(self):
        detect = CrgDetect(
            installed=False, version=None, compatible=False,
            fastmcp_ok=False, error=None,
        )
        import dataclasses
        assert dataclasses.fields(detect)
        try:
            detect.installed = True  # type: ignore[misc]
            raise AssertionError("Should have raised FrozenInstanceError")
        except dataclasses.FrozenInstanceError:
            pass
