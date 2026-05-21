"""Tests for scripts/measure_capability_context_payloads.py."""

from __future__ import annotations


def _outputs(module, fill: str = "ok") -> dict[str, str]:
    return {
        capability: f'{{"capability":"{capability}","context":"{fill}"}}\n'
        for capability in module.CAPABILITIES
    }


def test_measure_records_bytes_and_gpt5_tokens_for_all_capabilities(
    measure_capability_context_payloads,
):
    module = measure_capability_context_payloads
    token_counts = {
        capability: index + 10
        for index, capability in enumerate(module.CAPABILITIES)
    }

    def fake_counter(output: str) -> int:
        for capability, token_count in token_counts.items():
            if f'"capability":"{capability}"' in output:
                return token_count
        raise AssertionError(output)

    measurements, violations = module.measure_payloads(_outputs(module), fake_counter)
    payload = module.payload(
        measurements,
        violations,
        enforce_budgets=True,
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        token_mode="exact",
    )

    assert payload["status"] == "pass"
    assert payload["capabilities"] == module.CAPABILITIES
    assert len(payload["measurements"]) == 12
    assert payload["token_counter"]["command"] == "<output> | npx tiktoken-cli -m gpt-5"
    assert payload["token_counter"]["local_benchmark_command"] == (
        "uv run scripts/measure_capability_context_payloads.py --json --enforce-budgets"
    )
    assert all(measurement["bytes"] > 0 for measurement in payload["measurements"])
    assert all(measurement["gpt5_tokens"] is not None for measurement in payload["measurements"])
    assert all(measurement["token_status"] == "measured" for measurement in payload["measurements"])


def test_budget_failure_names_capability_counts_and_budgets(
    measure_capability_context_payloads,
):
    module = measure_capability_context_payloads
    outputs = _outputs(module)
    outputs["planera"] = "x" * 13_001

    measurements, violations = module.measure_payloads(
        outputs,
        lambda output: 3_500 if output == outputs["planera"] else 1,
    )
    payload = module.payload(
        measurements,
        violations,
        enforce_budgets=True,
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        token_mode="exact",
    )

    assert payload["status"] == "fail"
    assert payload["violations"] == [
        {
            "capability": "planera",
            "byte_count": 13_001,
            "byte_budget": 12_000,
            "token_count": 3_500,
            "token_budget": 3_000,
            "reasons": ["bytes_exceeded", "tokens_exceeded"],
        }
    ]


def test_skip_token_mode_keeps_normal_tests_offline(
    measure_capability_context_payloads,
):
    module = measure_capability_context_payloads
    measurements, violations = module.measure_payloads(_outputs(module), token_counter=None)
    payload = module.payload(
        measurements,
        violations,
        enforce_budgets=True,
        token_counter_command=module.DEFAULT_TOKEN_COUNTER_COMMAND,
        token_mode="skip",
    )

    assert payload["status"] == "pass"
    assert all(measurement["gpt5_tokens"] is None for measurement in payload["measurements"])
    assert all(measurement["token_status"] == "skipped" for measurement in payload["measurements"])
    assert payload["token_counter"]["command"] == "<output> | npx tiktoken-cli -m gpt-5"
