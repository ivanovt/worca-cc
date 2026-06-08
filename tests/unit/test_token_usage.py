"""Tests for worca.utils.token_usage — token extraction, aggregation, and cost estimation."""

import json

from worca.utils.token_usage import (
    extract_token_usage,
    aggregate_token_usage,
    aggregate_by_model,
    estimate_cost,
    load_pricing,
    get_model_pricing,
)


# --- extract_token_usage ---

def test_extract_complete_envelope():
    raw = {
        "type": "result",
        "total_cost_usd": 0.42,
        "duration_ms": 45200,
        "duration_api_ms": 38000,
        "num_turns": 12,
        "_resolved_model": "claude-sonnet-4-20250514",
        "usage": {
            "input_tokens": 28500,
            "output_tokens": 4200,
            "cache_creation_input_tokens": 12000,
            "cache_read_input_tokens": 8500,
        },
    }
    result = extract_token_usage(raw)
    assert result["input_tokens"] == 28500
    assert result["output_tokens"] == 4200
    assert result["cache_creation_input_tokens"] == 12000
    assert result["cache_read_input_tokens"] == 8500
    assert result["total_cost_usd"] == 0.42
    assert result["duration_ms"] == 45200
    assert result["duration_api_ms"] == 38000
    assert result["num_turns"] == 12
    assert result["model"] == "claude-sonnet-4-20250514"


def test_extract_duration_api_ms_missing_defaults_to_zero():
    raw = {"type": "result", "total_cost_usd": 0.1, "duration_ms": 5000}
    result = extract_token_usage(raw)
    assert result["duration_api_ms"] == 0


def test_extract_duration_api_ms_none_treated_as_zero():
    raw = {"type": "result", "duration_api_ms": None}
    result = extract_token_usage(raw)
    assert result["duration_api_ms"] == 0


def test_extract_missing_usage():
    raw = {"type": "result", "total_cost_usd": 0.1}
    result = extract_token_usage(raw)
    assert result["input_tokens"] == 0
    assert result["output_tokens"] == 0
    assert result["cache_creation_input_tokens"] == 0
    assert result["cache_read_input_tokens"] == 0
    assert result["total_cost_usd"] == 0.1


def test_extract_partial_usage():
    raw = {
        "type": "result",
        "usage": {"input_tokens": 1000, "output_tokens": 500},
        "total_cost_usd": 0.05,
        "num_turns": 3,
        "duration_ms": 5000,
    }
    result = extract_token_usage(raw)
    assert result["input_tokens"] == 1000
    assert result["output_tokens"] == 500
    assert result["cache_creation_input_tokens"] == 0
    assert result["cache_read_input_tokens"] == 0


def test_extract_none_values_treated_as_zero():
    raw = {
        "type": "result",
        "usage": {"input_tokens": None, "output_tokens": None},
        "total_cost_usd": None,
        "num_turns": None,
    }
    result = extract_token_usage(raw)
    assert result["input_tokens"] == 0
    assert result["output_tokens"] == 0
    assert result["total_cost_usd"] == 0
    assert result["num_turns"] == 0


def test_extract_non_dict_returns_zeroes():
    result = extract_token_usage("not a dict")
    assert result["input_tokens"] == 0
    assert result["output_tokens"] == 0
    assert result["total_cost_usd"] == 0


def test_extract_model_from_model_field():
    raw = {"type": "result", "model": "claude-opus-4-20250514", "usage": {}}
    result = extract_token_usage(raw)
    assert result["model"] == "claude-opus-4-20250514"


def test_extract_prefers_resolved_model():
    raw = {
        "type": "result",
        "_resolved_model": "claude-sonnet-4-20250514",
        "model": "fallback",
        "usage": {},
    }
    result = extract_token_usage(raw)
    assert result["model"] == "claude-sonnet-4-20250514"


# --- aggregate_token_usage ---

def test_aggregate_multiple_records():
    usages = [
        {
            "input_tokens": 1000,
            "output_tokens": 200,
            "cache_creation_input_tokens": 500,
            "cache_read_input_tokens": 300,
            "total_cost_usd": 0.10,
            "duration_ms": 5000,
            "duration_api_ms": 4000,
            "num_turns": 3,
        },
        {
            "input_tokens": 2000,
            "output_tokens": 400,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 600,
            "total_cost_usd": 0.20,
            "duration_ms": 8000,
            "duration_api_ms": 6500,
            "num_turns": 5,
        },
    ]
    result = aggregate_token_usage(usages)
    assert result["input_tokens"] == 3000
    assert result["output_tokens"] == 600
    assert result["cache_creation_input_tokens"] == 500
    assert result["cache_read_input_tokens"] == 900
    assert abs(result["total_cost_usd"] - 0.30) < 1e-9
    assert result["duration_ms"] == 13000
    assert result["duration_api_ms"] == 10500
    assert result["num_turns"] == 8
    assert result["iteration_count"] == 2


def test_aggregate_empty_list():
    result = aggregate_token_usage([])
    assert result["input_tokens"] == 0
    assert result["output_tokens"] == 0
    assert result["total_cost_usd"] == 0
    assert result["duration_api_ms"] == 0
    assert result["iteration_count"] == 0


def test_aggregate_single_record():
    usages = [{"input_tokens": 500, "output_tokens": 100, "total_cost_usd": 0.05}]
    result = aggregate_token_usage(usages)
    assert result["input_tokens"] == 500
    assert result["output_tokens"] == 100
    assert result["iteration_count"] == 1


def test_aggregate_handles_missing_fields():
    usages = [{"input_tokens": 100}, {"output_tokens": 200}]
    result = aggregate_token_usage(usages)
    assert result["input_tokens"] == 100
    assert result["output_tokens"] == 200
    assert result["iteration_count"] == 2


# --- aggregate_by_model ---

def test_aggregate_by_model_mixed():
    usages = [
        {
            "model": "claude-sonnet-4-20250514",
            "input_tokens": 1000,
            "output_tokens": 200,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "total_cost_usd": 0.10,
            "num_turns": 3,
        },
        {
            "model": "claude-opus-4-20250514",
            "input_tokens": 2000,
            "output_tokens": 500,
            "cache_creation_input_tokens": 100,
            "cache_read_input_tokens": 50,
            "total_cost_usd": 0.50,
            "num_turns": 5,
        },
        {
            "model": "claude-sonnet-4-20250514",
            "input_tokens": 1500,
            "output_tokens": 300,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
            "total_cost_usd": 0.15,
            "num_turns": 4,
        },
    ]
    result = aggregate_by_model(usages)
    assert "claude-sonnet-4-20250514" in result
    assert "claude-opus-4-20250514" in result

    sonnet = result["claude-sonnet-4-20250514"]
    assert sonnet["input_tokens"] == 2500
    assert sonnet["output_tokens"] == 500
    assert sonnet["cost_usd"] == 0.25
    assert sonnet["invocations"] == 2

    opus = result["claude-opus-4-20250514"]
    assert opus["input_tokens"] == 2000
    assert opus["output_tokens"] == 500
    assert opus["cost_usd"] == 0.50
    assert opus["invocations"] == 1


def test_aggregate_by_model_empty_model_uses_unknown():
    usages = [{"model": "", "input_tokens": 100, "total_cost_usd": 0.01}]
    result = aggregate_by_model(usages)
    assert "unknown" in result


def test_aggregate_by_model_empty_list():
    result = aggregate_by_model([])
    assert result == {}


# --- estimate_cost ---

def test_estimate_cost_opus():
    usage = {
        "input_tokens": 1_000_000,
        "output_tokens": 100_000,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }
    pricing = {
        "input_per_mtok": 15.00,
        "output_per_mtok": 75.00,
        "cache_write_per_mtok": 18.75,
        "cache_read_per_mtok": 1.50,
    }
    cost = estimate_cost(usage, pricing)
    # 1M * 15/1M + 100K * 75/1M = 15 + 7.5 = 22.5
    assert abs(cost - 22.5) < 0.001


def test_estimate_cost_with_cache():
    usage = {
        "input_tokens": 500_000,
        "output_tokens": 50_000,
        "cache_creation_input_tokens": 200_000,
        "cache_read_input_tokens": 300_000,
    }
    pricing = {
        "input_per_mtok": 3.00,
        "output_per_mtok": 15.00,
        "cache_write_per_mtok": 3.75,
        "cache_read_per_mtok": 0.30,
    }
    cost = estimate_cost(usage, pricing)
    # 500K*3/1M + 50K*15/1M + 200K*3.75/1M + 300K*0.30/1M
    # = 1.5 + 0.75 + 0.75 + 0.09 = 3.09
    assert abs(cost - 3.09) < 0.001


def test_estimate_cost_empty_usage():
    cost = estimate_cost({}, {"input_per_mtok": 15.0})
    assert cost == 0.0


def test_estimate_cost_empty_pricing():
    usage = {"input_tokens": 1000, "output_tokens": 500}
    cost = estimate_cost(usage, {})
    assert cost == 0.0


# --- load_pricing ---

def test_load_pricing_valid(tmp_path):
    settings = {
        "worca": {
            "pricing": {
                "models": {
                    "opus": {"input_per_mtok": 15.0},
                    "sonnet": {"input_per_mtok": 3.0},
                }
            }
        }
    }
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(settings))
    result = load_pricing(str(path))
    assert "opus" in result
    assert "sonnet" in result
    assert result["opus"]["input_per_mtok"] == 15.0


def test_load_pricing_missing_file():
    result = load_pricing("/nonexistent/settings.json")
    assert result == {}


def test_load_pricing_no_pricing_section(tmp_path):
    path = tmp_path / "settings.json"
    path.write_text(json.dumps({"worca": {}}))
    result = load_pricing(str(path))
    assert result == {}


# --- get_model_pricing ---

def test_get_model_pricing_matches_substring():
    pricing = {
        "opus": {"input_per_mtok": 15.0},
        "sonnet": {"input_per_mtok": 3.0},
    }
    result = get_model_pricing("claude-opus-4-20250514", pricing)
    assert result["input_per_mtok"] == 15.0


def test_get_model_pricing_no_match():
    pricing = {"opus": {"input_per_mtok": 15.0}}
    result = get_model_pricing("claude-haiku-4-20250514", pricing)
    assert result is None


def test_get_model_pricing_empty():
    assert get_model_pricing("", {}) is None
    assert get_model_pricing("model", {}) is None
    assert get_model_pricing("", {"opus": {}}) is None


# --- extract_token_usage: model_alias & cost override ---

def test_extract_records_model_alias_from_envelope():
    raw = {
        "type": "result",
        "_model_alias": "glm-ds",
        "_resolved_model": "claude-sonnet-4-20250514",
        "total_cost_usd": 0.42,
        "usage": {"input_tokens": 1000, "output_tokens": 200},
    }
    result = extract_token_usage(raw)
    assert result["model_alias"] == "glm-ds"


def test_extract_overrides_cost_from_alias_pricing(tmp_path):
    settings = {
        "worca": {
            "pricing": {
                "models": {
                    "glm-ds": {
                        "input_per_mtok": 2.0,
                        "output_per_mtok": 10.0,
                        "cache_write_per_mtok": 0,
                        "cache_read_per_mtok": 0,
                    }
                },
                "server_tools": {
                    "web_search_per_request": 0.01,
                },
            }
        }
    }
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(settings))

    raw = {
        "type": "result",
        "_model_alias": "glm-ds",
        "_resolved_model": "claude-sonnet-4-20250514",
        "total_cost_usd": 99.99,
        "usage": {"input_tokens": 1_000_000, "output_tokens": 100_000},
    }
    result = extract_token_usage(raw, settings_path=str(path))
    # 1M * 2/1M + 100K * 10/1M = 2.0 + 1.0 = 3.0
    assert abs(result["total_cost_usd"] - 3.0) < 0.001
    assert result["cost_source"] == "alias"


def test_extract_alias_no_pricing_entry_cost_is_zero(tmp_path, capsys):
    settings = {"worca": {"pricing": {"models": {}}}}
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(settings))

    raw = {
        "type": "result",
        "_model_alias": "unknown-alias",
        "_resolved_model": "claude-sonnet-4-20250514",
        "total_cost_usd": 5.0,
        "usage": {"input_tokens": 1000, "output_tokens": 200},
    }
    # Reset the warning set so this test gets a fresh warning
    from worca.utils.token_usage import _warned_aliases
    _warned_aliases.discard("unknown-alias")

    result = extract_token_usage(raw, settings_path=str(path))
    assert result["total_cost_usd"] == 0
    assert result["cost_source"] == "alias"

    captured = capsys.readouterr()
    assert "unknown-alias" in captured.err


def test_extract_alias_all_zero_pricing_cost_is_zero(tmp_path, capsys):
    settings = {
        "worca": {
            "pricing": {
                "models": {
                    "zero-model": {
                        "input_per_mtok": 0,
                        "output_per_mtok": 0,
                        "cache_write_per_mtok": 0,
                        "cache_read_per_mtok": 0,
                    }
                }
            }
        }
    }
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(settings))

    raw = {
        "type": "result",
        "_model_alias": "zero-model",
        "_resolved_model": "claude-sonnet-4-20250514",
        "total_cost_usd": 5.0,
        "usage": {"input_tokens": 1000, "output_tokens": 200},
    }
    result = extract_token_usage(raw, settings_path=str(path))
    assert result["total_cost_usd"] == 0
    assert result["cost_source"] == "alias"

    captured = capsys.readouterr()
    assert captured.err == ""


def test_extract_no_alias_cost_unchanged():
    raw = {
        "type": "result",
        "_resolved_model": "claude-sonnet-4-20250514",
        "total_cost_usd": 0.42,
        "usage": {"input_tokens": 1000, "output_tokens": 200},
    }
    result = extract_token_usage(raw)
    assert result["total_cost_usd"] == 0.42
    assert "cost_source" not in result
    assert "model_alias" not in result


def test_extract_alias_warning_emitted_once(tmp_path, capsys):
    settings = {"worca": {"pricing": {"models": {}}}}
    path = tmp_path / "settings.json"
    path.write_text(json.dumps(settings))

    from worca.utils.token_usage import _warned_aliases
    _warned_aliases.discard("warn-once-alias")

    raw = {
        "type": "result",
        "_model_alias": "warn-once-alias",
        "total_cost_usd": 1.0,
        "usage": {"input_tokens": 100},
    }

    extract_token_usage(raw, settings_path=str(path))
    first = capsys.readouterr()
    assert "warn-once-alias" in first.err

    extract_token_usage(raw, settings_path=str(path))
    second = capsys.readouterr()
    assert "warn-once-alias" not in second.err


# --- aggregate_by_model: prefers model_alias ---

def test_aggregate_by_model_prefers_alias():
    usages = [
        {
            "model": "claude-sonnet-4-20250514",
            "model_alias": "glm-ds",
            "input_tokens": 1000,
            "output_tokens": 200,
            "total_cost_usd": 0.10,
            "num_turns": 3,
        },
        {
            "model": "claude-sonnet-4-20250514",
            "input_tokens": 500,
            "output_tokens": 100,
            "total_cost_usd": 0.05,
            "num_turns": 2,
        },
    ]
    result = aggregate_by_model(usages)
    assert "glm-ds" in result
    assert "claude-sonnet-4-20250514" in result
    assert result["glm-ds"]["input_tokens"] == 1000
    assert result["glm-ds"]["invocations"] == 1
    assert result["claude-sonnet-4-20250514"]["input_tokens"] == 500
