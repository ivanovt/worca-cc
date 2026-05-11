"""Integration test: work_request haiku resolver routing (decision #2)."""
from worca.orchestrator.work_request import generate_smart_title


def test_generate_smart_title_uses_resolver_for_haiku(monkeypatch, tmp_path):
    settings = {"worca": {"models": {
        "haiku": {"id": "custom-haiku-id",
                  "env": {"ANTHROPIC_BASE_URL": "http://custom"}}}}}
    captured = {}

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        captured["env"] = kw["env"]

        class R:
            returncode = 0
            stdout = "Title"
            stderr = ""
        return R()

    monkeypatch.setattr("worca.orchestrator.work_request.subprocess.run", fake_run)
    monkeypatch.setattr(
        "worca.orchestrator.work_request.load_settings", lambda *a, **kw: settings
    )

    generate_smart_title("Some content to title")

    assert "--model" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--model") + 1] == "custom-haiku-id"
    assert captured["env"]["ANTHROPIC_BASE_URL"] == "http://custom"
