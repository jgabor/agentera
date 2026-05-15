from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parent.parent
CAPABILITIES_DIR = REPO_ROOT / "skills" / "agentera" / "capabilities"
TOUCH_DECISION_SATISFACTION_CAPABILITIES = [
    "realisera",
    "inspektera",
    "dokumentera",
    "orkestrera",
    "resonera",
]


def _prose(capability: str) -> str:
    return (CAPABILITIES_DIR / capability / "prose.md").read_text(encoding="utf-8")


def _validation_rules(capability: str) -> dict[str, dict[str, object]]:
    data = yaml.safe_load((CAPABILITIES_DIR / capability / "schemas" / "validation.yaml").read_text())
    return {entry["rule"]: entry for entry in data["VALIDATION"].values()}


def test_capability_guidance_bounds_decision_satisfaction_authority():
    for capability in TOUCH_DECISION_SATISFACTION_CAPABILITIES:
        content = " ".join(_prose(capability).split())

        for required in [
            "Decision satisfaction authority",
            "provisional satisfaction",
            "evidence",
            "only the user confirms final satisfaction",
        ]:
            assert required in content, f"{capability} prose must state satisfaction authority: {required!r}"

        assert "must not" in content.lower(), f"{capability} must prohibit agent final confirmation"
        assert "user-confirm" in content.lower(), f"{capability} must name user-confirmation boundary"


def test_capability_guidance_preserves_satisfaction_caveats_without_inference():
    for capability in TOUCH_DECISION_SATISFACTION_CAPABILITIES:
        content = " ".join(_prose(capability).split())

        for required in [
            "compacted",
            "missing satisfaction state",
            "open, provisional, or review-needed",
            "preserve the caveat and review pressure",
            "instead of reconstructing hidden outcomes",
            "claiming automation proved intent",
        ]:
            assert required in content, f"{capability} prose must preserve satisfaction caveats: {required!r}"


def test_validation_schemas_include_satisfaction_authority_rule():
    for capability in TOUCH_DECISION_SATISFACTION_CAPABILITIES:
        rules = _validation_rules(capability)
        rule = rules["satisfaction_authority_boundary"]
        text = " ".join([str(rule["description"]), *map(str, rule["checks"])])

        assert rule["severity"] == "critical"
        assert "provisional" in text
        assert "evidence" in text
        assert "MUST NOT user-confirm satisfaction" in text
        assert "caveat and review pressure" in text
        assert "must not reconstruct hidden outcomes" in text
        assert "claim it proved user intent" in text
