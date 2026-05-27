---
title: Adding & routing models
description: Define model profiles, point aliases at different models, and route through alternate endpoints.
sidebar:
  order: 5
---

Agents reference models by short alias — `opus`, `sonnet`, `haiku` — and those aliases resolve through `worca.models` in `settings.json`. Editing that map lets you retarget an alias, add a profile, or route a model through an alternate endpoint.

## The two profile forms

A `worca.models` entry is either a plain model-ID string or an object with an `env` map:

```jsonc
"worca": {
  "models": {
    "opus": "claude-opus-4-7",
    "sonnet": {
      "id": "claude-sonnet-4-6",
      "env": {
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "32000"
      }
    }
  }
}
```

The string form just maps alias → model ID. The object form adds an `env` map that is **merged into the subprocess environment whenever that model runs** — the seam for routing through an alternate endpoint or tuning per-model behavior.

## Retargeting an alias

Because agents are configured by alias, pointing `opus` at a newer model upgrades every stage that uses it at once:

```jsonc
"worca": {
  "models": {
    "opus": "claude-opus-4-7"
  }
}
```

This is also how you unlock the full effort ladder — the shipped `opus` alias resolves to a 4-rung model; pointing it at Opus 4.7 restores all five rungs. See [Tuning effort](/advanced/tuning-effort/).

## Routing through an alternate endpoint

Use the `env` map to set whatever environment variables your gateway or proxy expects when that model runs:

```jsonc
"worca": {
  "models": {
    "sonnet": {
      "id": "your-gateway-model-id",
      "env": {
        "ANTHROPIC_BASE_URL": "https://gateway.internal/v1"
      }
    }
  }
}
```

## Two gotchas

- **Secrets** (API keys for an alternate endpoint) belong in `settings.local.json`, never the committed `settings.json`. See [Secrets](/configuration/secrets/).
- **Reserved keys** are stripped from any `env` map — anything matching `WORCA_*`, `PATH`, or `CLAUDECODE` is dropped with a warning, so a profile can't clobber the variables the pipeline depends on.

:::note
Customizing the `haiku` profile also retargets work-request title generation, which is hardcoded to that alias. That coupling is intentional.
:::
