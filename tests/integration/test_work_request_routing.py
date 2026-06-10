"""Integration test: work_request haiku resolver routing.

Originally written for W-051 decision #2 (haiku alias resolved through the
model resolver, so a user-tier shadow won the env+id of the call).

#312 (D5) explicitly inverted that: title generation now hard-pins to
`builtin:haiku` so internal pipeline mechanics no longer depend on user/project
shadowing. This test now guards the new contract: user shadows of `haiku` MUST
be ignored — id resolves to the package default and the shadow env is NOT
inherited.
"""
from worca.orchestrator.work_request import generate_smart_title


def test_generate_smart_title_ignores_haiku_shadow(monkeypatch, tmp_path):
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
    # D5: builtin:haiku pin — user shadow's id is bypassed.
    assert captured["cmd"][captured["cmd"].index("--model") + 1] == "claude-haiku-4-5-20251001"
    # And the shadow's env must NOT leak into the call.
    assert "ANTHROPIC_BASE_URL" not in captured["env"]
