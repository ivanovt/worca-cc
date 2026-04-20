"""Smoke tests for the integration test fixture infrastructure (Phase 2).

These tests verify that pipeline_env and webhook_server fixtures
are properly set up and usable by Phase 3+ integration tests.
"""
from tests.integration.helpers import PipelineEnv, WebhookCapture


def test_pipeline_env_project_exists(pipeline_env):
    assert pipeline_env.project.exists()


def test_pipeline_env_worca_runtime_installed(pipeline_env):
    assert (pipeline_env.project / ".claude" / "worca").exists()


def test_pipeline_env_git_repo_initialized(pipeline_env):
    assert (pipeline_env.project / ".git").exists()


def test_pipeline_env_settings_overridden(pipeline_env):
    import json
    settings_path = pipeline_env.project / ".claude" / "settings.json"
    settings = json.loads(settings_path.read_text())
    stages = settings.get("worca", {}).get("stages", {})
    assert stages.get("preflight", {}).get("enabled") is False
    assert stages.get("plan_review", {}).get("enabled") is False
    assert stages.get("learn", {}).get("enabled") is False


def test_webhook_server_url_is_localhost(webhook_server):
    assert webhook_server.url.startswith("http://localhost:")


def test_webhook_server_receives_posts(webhook_server):
    import urllib.request
    import json
    payload = json.dumps({"event_type": "test.event"}).encode()
    req = urllib.request.Request(
        webhook_server.url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    urllib.request.urlopen(req, timeout=5)
    assert len(webhook_server.received) == 1
    assert webhook_server.received[0]["event_type"] == "test.event"


def test_pipeline_env_is_dataclass_type(pipeline_env):
    assert isinstance(pipeline_env, PipelineEnv)


def test_webhook_server_is_dataclass_type(webhook_server):
    assert isinstance(webhook_server, WebhookCapture)
