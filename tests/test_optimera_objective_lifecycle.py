"""Regression coverage for optimera objective lifecycle prose contracts."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
OPTIMERA_SKILL = REPO_ROOT / "skills" / "optimera" / "SKILL.md"
HEJ_SKILL = REPO_ROOT / "skills" / "hej" / "SKILL.md"
RESONERA_SKILL = REPO_ROOT / "skills" / "resonera" / "SKILL.md"


@dataclass(frozen=True)
class ObjectiveCase:
    name: str
    status: str
    experiments_time: str | None = None


def _is_closed(objective: ObjectiveCase) -> bool:
    return objective.status.startswith("**Status**: closed")


def _infer_objective(objectives: list[ObjectiveCase]) -> str:
    if not objectives:
        return "new-objective"

    active = [objective for objective in objectives if not _is_closed(objective)]
    if not active:
        return "successor-needed"
    if len(active) == 1:
        return active[0].name
    if any(objective.experiments_time is None for objective in active):
        return "ambiguous"

    newest = max(objective.experiments_time for objective in active)
    newest_active = [objective for objective in active if objective.experiments_time == newest]
    if len(newest_active) != 1:
        return "ambiguous"
    return newest_active[0].name


def _should_append_closure(objective_text: str, experiments_text: str) -> bool:
    return "**Status**: closed" not in objective_text and "## Closure" not in experiments_text


class TestOptimeraObjectiveInferenceContract:
    """Covers exactly the 3+ branch inference behavior from Task 5."""

    def test_inference_branches_match_contract(self):
        assert _infer_objective([
            ObjectiveCase("active", "**Status**: active"),
        ]) == "active"
        assert _infer_objective([
            ObjectiveCase("closed-newer", "**Status**: closed", "2026-04-29T20:00:00Z"),
            ObjectiveCase("older-active", "**Status**: active", "2026-04-29T19:00:00Z"),
        ]) == "older-active"
        assert _infer_objective([
            ObjectiveCase("closed-a", "**Status**: closed"),
            ObjectiveCase("closed-b", "**Status**: closed (legacy)"),
        ]) == "successor-needed"
        assert _infer_objective([]) == "new-objective"
        assert _infer_objective([
            ObjectiveCase("alpha", "**Status**: active", "2026-04-29T20:00:00Z"),
            ObjectiveCase("beta", "**Status**: active", "2026-04-29T20:00:00Z"),
        ]) == "ambiguous"

    def test_contract_text_names_required_branches(self):
        text = OPTIMERA_SKILL.read_text(encoding="utf-8")
        required_fragments = [
            "If no objective subdirectories exist, keep the existing new-objective path",
            "classify it as closed before any active selection",
            "If one or more objective subdirectories exist and all are closed",
            "If only one non-closed subdirectory exists, use it",
            "pick the one with the most recent modification timestamp",
            "the result is otherwise ambiguous, ask the user",
        ]
        for fragment in required_fragments:
            assert fragment in text

    def test_routing_consumers_exclude_closed_before_recency(self):
        hej_text = HEJ_SKILL.read_text(encoding="utf-8")
        resonera_text = RESONERA_SKILL.read_text(encoding="utf-8")
        assert "Exclude closed objectives before recency checks" in hej_text
        assert "closed objective with newer history must not outrank" in hej_text
        assert "exclude closed objectives first" in resonera_text
        assert "choose among non-closed objectives by EXPERIMENTS.md git recency" in resonera_text


class TestOptimeraClosureIdempotencyContract:
    def test_already_closed_objective_does_not_append_duplicate_closure(self):
        objective_text = "# Objective\n\n**Status**: closed\n"
        experiments_text = "# Experiments\n\n## Closure · 2026-04-29T20:00:00Z\n"
        assert not _should_append_closure(objective_text, experiments_text)

        text = OPTIMERA_SKILL.read_text(encoding="utf-8")
        assert "do not append a duplicate" in text
        assert "without writing another closure entry" in text
