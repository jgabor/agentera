"""Tests for scripts/usage_stats.py.

Test budget per the Suite Usage Analytics plan, Task 1: 1 pass + 1 fail per
testable unit. The marker detector qualifies for edge expansion: each of the
four exit statuses (complete, flagged, stuck, waiting) and at least three
distinct skill glyphs.

Testable units:
  - find_markers (marker detector + exit-signal classification)
  - is_assistant_conversation_turn (turn predicate)
  - group_by_conversation (conversation grouper)
  - pair_invocations (pairing walker)
"""

from __future__ import annotations


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _intro(glyph: str = "⧉", skill: str = "realisera", word: str = "cycle") -> str:
    return f"─── {glyph} {skill} · {word} ───"


def _exit(glyph: str = "⧉", skill: str = "realisera", status: str = "complete") -> str:
    return f"─── {glyph} {skill} · {status} ───"


def _turn(
    source_id: str,
    timestamp: str,
    actor: str,
    content: str,
    source_kind: str = "conversation_turn",
) -> dict:
    return {
        "source_id": source_id,
        "timestamp": timestamp,
        "project_id": "agentera",
        "source_kind": source_kind,
        "runtime": "claude-code",
        "adapter_version": "test",
        "data": {"actor": actor, "content": content},
    }


# ---------------------------------------------------------------------------
# find_markers (marker detector)
# ---------------------------------------------------------------------------


class TestFindMarkers:
    def test_pass_detects_basic_intro(self, usage_stats):
        markers = usage_stats.find_markers(
            "narration\n" + _intro("⧉", "realisera", "cycle 5") + "\nmore"
        )
        assert len(markers) == 1
        assert markers[0].kind == "intro"
        assert markers[0].skill == "realisera"
        assert markers[0].glyph == "⧉"
        assert markers[0].word == "cycle 5"

    def test_fail_ignores_malformed_dividers(self, usage_stats):
        # Single-dash dividers (not U+2500 runs) and lines that miss the
        # middle-dot separator are not workflow markers.
        bad_inputs = [
            "- ⧉ realisera · cycle -",
            "─── ⧉ realisera cycle ───",   # missing middle dot
            "─── realisera · cycle ───",   # missing glyph
            "─── ⧉ Realisera · cycle ───", # uppercase skill name
        ]
        for text in bad_inputs:
            assert usage_stats.find_markers(text) == [], text

    # ---------- edge expansion: each exit status value ----------

    def test_edge_complete_status(self, usage_stats):
        m = usage_stats.find_markers(_exit("⧉", "realisera", "complete"))
        assert m and m[0].kind == "exit" and m[0].word == "complete"

    def test_edge_flagged_status(self, usage_stats):
        m = usage_stats.find_markers(_exit("⧉", "realisera", "flagged"))
        assert m and m[0].kind == "exit" and m[0].word == "flagged"

    def test_edge_stuck_status(self, usage_stats):
        m = usage_stats.find_markers(_exit("⧉", "realisera", "stuck"))
        assert m and m[0].kind == "exit" and m[0].word == "stuck"

    def test_edge_waiting_status(self, usage_stats):
        m = usage_stats.find_markers(_exit("⧉", "realisera", "waiting"))
        assert m and m[0].kind == "exit" and m[0].word == "waiting"

    # ---------- edge expansion: at least three skill glyphs ----------

    def test_edge_planera_glyph(self, usage_stats):
        m = usage_stats.find_markers(_intro("≡", "planera", "planning"))
        assert m and m[0].skill == "planera" and m[0].glyph == "≡"

    def test_edge_orkestrera_glyph(self, usage_stats):
        m = usage_stats.find_markers(_intro("⎈", "orkestrera", "session"))
        assert m and m[0].skill == "orkestrera" and m[0].glyph == "⎈"

    def test_edge_inspektera_glyph(self, usage_stats):
        m = usage_stats.find_markers(_intro("⛶", "inspektera", "audit"))
        assert m and m[0].skill == "inspektera" and m[0].glyph == "⛶"


# ---------------------------------------------------------------------------
# is_assistant_conversation_turn (turn predicate)
# ---------------------------------------------------------------------------


class TestIsAssistantConversationTurn:
    def test_pass_assistant_conversation_turn(self, usage_stats):
        rec = _turn("s1", "2026-04-26T00:00:00Z", "assistant", "hi")
        assert usage_stats.is_assistant_conversation_turn(rec) is True

    def test_fail_user_turn_is_excluded(self, usage_stats):
        rec = _turn("s1", "2026-04-26T00:00:00Z", "user", "hi")
        assert usage_stats.is_assistant_conversation_turn(rec) is False

    def test_fail_non_conversation_turn_kind_is_excluded(self, usage_stats):
        rec = _turn(
            "s1", "2026-04-26T00:00:00Z", "assistant", "hi",
            source_kind="history_prompt",
        )
        assert usage_stats.is_assistant_conversation_turn(rec) is False


# ---------------------------------------------------------------------------
# group_by_conversation (conversation grouper)
# ---------------------------------------------------------------------------


class TestGroupByConversation:
    def test_pass_groups_and_sorts_by_timestamp(self, usage_stats):
        records = [
            _turn("s1", "2026-04-26T00:02:00Z", "assistant", "second"),
            _turn("s1", "2026-04-26T00:01:00Z", "assistant", "first"),
            _turn("s2", "2026-04-26T00:00:00Z", "assistant", "other-conv"),
            _turn("s1", "2026-04-26T00:00:30Z", "user", "user-noise"),
        ]
        grouped = usage_stats.group_by_conversation(records)
        assert set(grouped) == {"s1", "s2"}
        s1_contents = [t["data"]["content"] for t in grouped["s1"]]
        # User turn dropped; assistant turns sorted by timestamp ascending.
        assert s1_contents == ["first", "second"]
        assert len(grouped["s2"]) == 1

    def test_fail_excludes_user_and_non_conversation_records(self, usage_stats):
        records = [
            _turn("s1", "2026-04-26T00:00:00Z", "user", "ignored"),
            _turn(
                "s1", "2026-04-26T00:00:00Z", "assistant", "config",
                source_kind="project_config_signal",
            ),
        ]
        grouped = usage_stats.group_by_conversation(records)
        # All records were either user-actor or wrong source_kind: nothing groups.
        assert grouped == {}


# ---------------------------------------------------------------------------
# pair_invocations (pairing walker)
# ---------------------------------------------------------------------------


class TestPairInvocations:
    def test_pass_intro_with_matching_exit_is_completed(self, usage_stats):
        turns = [
            _turn(
                "s1", "2026-04-26T00:00:00Z", "assistant",
                _intro("⧉", "realisera", "cycle 1"),
            ),
            _turn(
                "s1", "2026-04-26T00:01:00Z", "assistant",
                _exit("⧉", "realisera", "complete"),
            ),
        ]
        invs = usage_stats.pair_invocations(turns)
        assert len(invs) == 1
        inv = invs[0]
        assert inv.skill == "realisera"
        assert inv.completed is True
        assert inv.exit_status == "complete"
        assert inv.intro_word == "cycle 1"

    def test_fail_orphan_intro_is_recorded_as_incomplete(self, usage_stats):
        turns = [
            _turn(
                "s1", "2026-04-26T00:00:00Z", "assistant",
                _intro("⧉", "realisera", "cycle 1"),
            ),
        ]
        invs = usage_stats.pair_invocations(turns)
        assert len(invs) == 1
        assert invs[0].completed is False
        assert invs[0].exit_status is None

    # The acceptance criterion explicitly calls out the multi-invocation
    # ordering case; one extra targeted test covers it without expanding
    # beyond the budget.
    def test_multiple_invocations_pair_in_order_of_appearance(self, usage_stats):
        # Two sequential realisera invocations in the same conversation.
        turns = [
            _turn(
                "s1", "2026-04-26T00:00:00Z", "assistant",
                _intro("⧉", "realisera", "cycle 1"),
            ),
            _turn(
                "s1", "2026-04-26T00:01:00Z", "assistant",
                _exit("⧉", "realisera", "complete"),
            ),
            _turn(
                "s1", "2026-04-26T00:02:00Z", "assistant",
                _intro("⧉", "realisera", "cycle 2"),
            ),
            _turn(
                "s1", "2026-04-26T00:03:00Z", "assistant",
                _exit("⧉", "realisera", "flagged"),
            ),
        ]
        invs = usage_stats.pair_invocations(turns)
        assert len(invs) == 2
        assert [inv.intro_word for inv in invs] == ["cycle 1", "cycle 2"]
        assert [inv.exit_status for inv in invs] == ["complete", "flagged"]


# ---------------------------------------------------------------------------
# analyze_corpus (top-level orchestrator) and ignore-non-assistant rule
# ---------------------------------------------------------------------------


class TestAnalyzeCorpus:
    def test_user_quoted_markers_are_ignored(self, usage_stats):
        # User pastes example marker text; assistant later runs realisera
        # exactly once. Only the assistant invocation must count.
        corpus = {
            "records": [
                _turn(
                    "s1", "2026-04-26T00:00:00Z", "user",
                    "Look at this output:\n" + _intro("⧉", "realisera", "cycle 99"),
                ),
                _turn(
                    "s1", "2026-04-26T00:01:00Z", "assistant",
                    _intro("⧉", "realisera", "cycle 1"),
                ),
                _turn(
                    "s1", "2026-04-26T00:02:00Z", "assistant",
                    _exit("⧉", "realisera", "complete"),
                ),
            ]
        }
        analysis = usage_stats.analyze_corpus(corpus)
        assert len(analysis.invocations) == 1
        assert analysis.skills == {
            "realisera": {"total": 1, "completed": 1, "incomplete": 0}
        }
