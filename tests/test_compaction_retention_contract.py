"""Contract tests for shared 10/40/50 retention caps across compaction surfaces.

Intentional ordering divergence (pinned here so drift is caught in review):

- ``hooks.common.compact_session_bookmark_entries`` (and session hooks): newest
  entries are those with the greatest ``timestamp`` string (descending sort).
- ``hooks.compaction.compact_entries`` (PROGRESS/DECISIONS/HEALTH artifacts):
  newest entries are those with the greatest numeric ID parsed from headers
  (Cycle N, Decision N, etc.), independent of input order.

Both paths delegate the final cap to ``hooks.common.apply_retention_caps`` using
``MAX_FULL_ENTRIES`` (10), ``MAX_ONELINE_ENTRIES`` (40), and ``MAX_TOTAL_ENTRIES``
(50).
"""

from __future__ import annotations

import pytest


def _count_kinds(result: list[dict]) -> tuple[int, int]:
    full = sum(1 for entry in result if entry.get("kind") == "full")
    oneline = sum(1 for entry in result if entry.get("kind") == "oneline")
    return full, oneline


def _format_artifact_oneline(entry: dict) -> str:
    return str(entry["header"])


def _assert_honors_retention_caps(
    result: list[dict],
    *,
    max_full: int,
    max_oneline: int,
    max_total: int,
) -> None:
    full_count, oneline_count = _count_kinds(result)
    assert len(result) <= max_total
    assert full_count <= max_full
    assert oneline_count <= max_oneline


def _overflow_artifact_entries(count: int) -> list[dict]:
    return [
        {"header": f"Cycle {index}", "body": f"body-{index}", "kind": "full"}
        for index in range(1, count + 1)
    ]


def _overflow_session_entries(count: int) -> list[dict]:
    return [
        {
            "timestamp": f"2026-05-{index:02d} 10:00",
            "artifacts": ["PLAN.md"],
            "summary": f"Session {index}",
            "kind": "full",
        }
        for index in range(1, count + 1)
    ]


@pytest.fixture(scope="module")
def retention_constants(hooks_common):
    return {
        "max_full": hooks_common.MAX_FULL_ENTRIES,
        "max_oneline": hooks_common.MAX_ONELINE_ENTRIES,
        "max_total": hooks_common.MAX_TOTAL_ENTRIES,
    }


def test_retention_constants_are_uniform_10_40_50(hooks_common, retention_constants):
    assert retention_constants == {
        "max_full": 10,
        "max_oneline": 40,
        "max_total": 50,
    }
    assert hooks_common.MAX_TOTAL_ENTRIES == (
        hooks_common.MAX_FULL_ENTRIES + hooks_common.MAX_ONELINE_ENTRIES
    )


def test_apply_retention_caps_honors_max_limits(hooks_common, retention_constants):
    full = [{"kind": "full", "n": index} for index in range(20)]
    archive = [{"kind": "oneline", "n": index} for index in range(60)]
    result = hooks_common.apply_retention_caps(full, archive)

    _assert_honors_retention_caps(result, **retention_constants)
    full_count, oneline_count = _count_kinds(result)
    assert full_count == retention_constants["max_full"]
    assert oneline_count == retention_constants["max_oneline"]
    assert len(result) == retention_constants["max_total"]


def test_compact_entries_honors_max_limits(compaction, retention_constants):
    result = compaction.compact_entries(
        _overflow_artifact_entries(60),
        format_oneline=_format_artifact_oneline,
    )

    _assert_honors_retention_caps(result, **retention_constants)
    full_count, oneline_count = _count_kinds(result)
    assert full_count == retention_constants["max_full"]
    assert oneline_count == retention_constants["max_oneline"]
    assert len(result) == retention_constants["max_total"]


def test_compact_session_bookmark_entries_honors_max_limits(hooks_common, retention_constants):
    result = hooks_common.compact_session_bookmark_entries(_overflow_session_entries(60))

    _assert_honors_retention_caps(result, **retention_constants)
    full_count, oneline_count = _count_kinds(result)
    assert full_count == retention_constants["max_full"]
    assert oneline_count == retention_constants["max_oneline"]
    assert len(result) == retention_constants["max_total"]


def test_ordering_divergence_numeric_id_vs_timestamp(hooks_common, compaction):
    """Artifact compaction favors numeric header IDs; session bookmarks favor timestamps."""
    artifact_entries = _overflow_artifact_entries(12)
    # Reverse file order: low numeric IDs appear first, but recency is by header number.
    artifact_entries = list(reversed(artifact_entries))

    session_entries = [
        {
            "timestamp": f"2026-05-{index:02d} 10:00",
            "artifacts": [],
            "summary": f"Cycle {13 - index}",
            "kind": "full",
        }
        for index in range(1, 13)
    ]

    artifact_result = compaction.compact_entries(
        artifact_entries,
        format_oneline=_format_artifact_oneline,
    )
    session_result = hooks_common.compact_session_bookmark_entries(session_entries)

    artifact_full_headers = [
        entry["header"] for entry in artifact_result if entry.get("kind") == "full"
    ]
    session_full_summaries = [
        entry.get("summary") for entry in session_result if entry.get("kind") == "full"
    ]

    # Numeric-ID recency: Cycle 12 leads full-detail slots even though Cycle 1 was listed first.
    assert artifact_result[0]["header"] == "Cycle 12"
    assert artifact_full_headers == [f"Cycle {index}" for index in range(12, 2, -1)]

    # Timestamp recency: May 12 entry carries summary "Cycle 1", not "Cycle 12".
    assert session_result[0]["summary"] == "Cycle 1"
    assert session_full_summaries == [f"Cycle {index}" for index in range(1, 11)]
    assert "Cycle 12" not in session_full_summaries

    # Same nominal numbering scheme, opposite first-slot winners — intentional divergence.
    assert artifact_result[0]["header"] != session_result[0]["summary"]
