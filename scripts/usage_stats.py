"""Suite usage analytics: detect skill invocations from a Section 21 corpus.

This is the core analysis pipeline (Task 1 of the Suite Usage Analytics plan,
Decision 31). It reads a Section 21 corpus envelope, finds skill workflow
markers in assistant `conversation_turn` records, and pairs introduction
markers with their matching exit signals within each conversation.

Output surfaces (USAGE.md, stdout summary, --json, --project filter) are out
of scope for this task and belong to later tasks. The minimal CLI here exists
only so tests can exercise the pipeline.

Marker format (per SPEC.md sections 5 + 12)::

    ─── <glyph> <skillname> · <word> ───

`<glyph>` is a single character (e.g. ⧉, ≡, ⛶). `<skillname>` is lowercase
ending in ``era``. `<word>` is either a phase label (any word) for an
introduction or an exit status (``complete``, ``flagged``, ``stuck``,
``waiting``).

Usage::

    python3 scripts/usage_stats.py --corpus path/to/corpus.json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from pprint import pprint
from typing import Iterable

# ---------------------------------------------------------------------------
# Marker grammar
# ---------------------------------------------------------------------------

EXIT_STATUSES: frozenset[str] = frozenset({"complete", "flagged", "stuck", "waiting"})

# Divider runs of U+2500 (one or more), padded by spaces, around the body.
# Body = "<glyph> <skillname> · <word>" where:
#   - glyph: any single non-space character (skills define their own glyph)
#   - skillname: lowercase letters ending in "era"
#   - separator: U+00B7 middle dot, padded
#   - word: an arbitrary phase label or an exit status, lowercase letters
_MARKER_RE = re.compile(
    r"─{2,}\s+"                # leading divider run (>=2 dashes)
    r"(?P<glyph>\S)\s+"             # single-character skill glyph
    r"(?P<skill>[a-z]+era)\s+"      # skill name ending in "era"
    r"·\s+"                    # middle dot separator
    r"(?P<word>[a-z]+(?:\s+\d+)?)"  # phase word, optionally trailing number
    r"\s+─{2,}"                # trailing divider run
)


@dataclass(frozen=True)
class Marker:
    """One workflow marker parsed from an assistant turn."""

    kind: str              # "intro" or "exit"
    skill: str             # lowercase skill name
    glyph: str             # single character glyph
    word: str              # phase word for intro, or exit status for exit
    line: str              # the matched substring (for debugging)


@dataclass
class Invocation:
    """One paired (or orphaned) skill invocation within a conversation."""

    skill: str
    glyph: str
    intro_word: str                          # the phase word at introduction
    intro_source_id: str                     # source_id of the intro turn
    intro_timestamp: str                     # timestamp of the intro turn
    completed: bool                          # True if a matching exit was found
    exit_status: str | None = None           # one of EXIT_STATUSES, or None
    exit_source_id: str | None = None
    exit_timestamp: str | None = None


# ---------------------------------------------------------------------------
# Marker detection
# ---------------------------------------------------------------------------


def find_markers(text: str) -> list[Marker]:
    """Return every well-formed workflow marker in ``text``.

    A marker is classified as an exit if its `word` is in EXIT_STATUSES,
    otherwise it is treated as an introduction (any phase label is allowed
    per SPEC; e.g. ``planning``, ``audit``, ``cycle``, ``cycle 5``).
    """
    if not text:
        return []
    markers: list[Marker] = []
    for match in _MARKER_RE.finditer(text):
        word = match.group("word")
        kind = "exit" if word in EXIT_STATUSES else "intro"
        markers.append(
            Marker(
                kind=kind,
                skill=match.group("skill"),
                glyph=match.group("glyph"),
                word=word,
                line=match.group(0),
            )
        )
    return markers


# ---------------------------------------------------------------------------
# Conversation turn predicate + grouping
# ---------------------------------------------------------------------------


def is_assistant_conversation_turn(record: dict) -> bool:
    """True iff this record is a conversation_turn from the assistant.

    User turns are excluded because they may quote markers in pasted text;
    only the agent's own narration counts as a real invocation.
    """
    if not isinstance(record, dict):
        return False
    if record.get("source_kind") != "conversation_turn":
        return False
    data = record.get("data")
    if not isinstance(data, dict):
        return False
    return data.get("actor") == "assistant"


def group_by_conversation(records: Iterable[dict]) -> dict[str, list[dict]]:
    """Group assistant conversation turns by ``source_id`` (one bucket per
    record), then sort each bucket by ``timestamp``.

    Section 21 records carry no guaranteed order. The corpus envelope assigns
    a stable ``source_id`` per logical record; we treat that as the
    conversation key for grouping. Within a bucket we sort by ISO 8601
    timestamp, falling back to original list order on ties.
    """
    buckets: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        if not is_assistant_conversation_turn(record):
            continue
        sid = record.get("source_id")
        if not isinstance(sid, str):
            continue
        buckets[sid].append(record)
    for sid, items in buckets.items():
        items.sort(key=lambda r: r.get("timestamp", ""))
    return dict(buckets)


# ---------------------------------------------------------------------------
# Pairing walker
# ---------------------------------------------------------------------------


def pair_invocations(turns: Iterable[dict]) -> list[Invocation]:
    """Walk assistant turns in order and pair intros with exits per skill.

    Algorithm: maintain a per-skill FIFO queue of unmatched introductions.
    When an exit for that skill appears, dequeue the oldest unmatched intro
    and mark the invocation as completed with that exit's status. Any intros
    still queued at the end of the conversation are emitted as incomplete
    invocations.

    Markers are processed in document order within each turn, then in
    timestamp order across turns. This preserves the rule that nested
    invocations (intro_a, intro_b, exit_b, exit_a) match correctly.
    """
    pending: dict[str, list[Invocation]] = defaultdict(list)
    completed: list[Invocation] = []
    for turn in turns:
        sid = turn.get("source_id", "")
        ts = turn.get("timestamp", "")
        text = ((turn.get("data") or {}).get("content") or "")
        for marker in find_markers(text):
            if marker.kind == "intro":
                pending[marker.skill].append(
                    Invocation(
                        skill=marker.skill,
                        glyph=marker.glyph,
                        intro_word=marker.word,
                        intro_source_id=sid,
                        intro_timestamp=ts,
                        completed=False,
                    )
                )
            else:
                queue = pending.get(marker.skill)
                if not queue:
                    # Orphan exit (no matching intro). Ignore: not a counted
                    # invocation, just stray output.
                    continue
                # Match against the most recent unmatched intro for this
                # skill so nested invocations of the same skill pair LIFO.
                inv = queue.pop()
                inv.completed = True
                inv.exit_status = marker.word
                inv.exit_source_id = sid
                inv.exit_timestamp = ts
                completed.append(inv)
    # Emit leftover intros as incomplete invocations.
    incomplete: list[Invocation] = []
    for queue in pending.values():
        incomplete.extend(queue)
    # Stable sort by intro timestamp so the result reflects appearance order.
    return sorted(
        completed + incomplete,
        key=lambda inv: (inv.intro_timestamp, inv.intro_source_id),
    )


# ---------------------------------------------------------------------------
# Top-level orchestrator (debug-only for Task 1)
# ---------------------------------------------------------------------------


@dataclass
class CorpusAnalysis:
    """Aggregated invocation analysis. Output surfaces are not yet attached.

    Task 1 only exposes the pipeline; later tasks will derive USAGE.md /
    stdout / JSON output from the same `invocations` list.
    """

    invocations: list[Invocation] = field(default_factory=list)
    skills: dict[str, dict[str, int]] = field(default_factory=dict)


def analyze_corpus(corpus: dict) -> CorpusAnalysis:
    """Run the full pipeline against a Section 21 corpus envelope."""
    records = corpus.get("records", []) if isinstance(corpus, dict) else []
    grouped = group_by_conversation(records)
    invocations: list[Invocation] = []
    for turns in grouped.values():
        invocations.extend(pair_invocations(turns))
    invocations.sort(
        key=lambda inv: (inv.intro_timestamp, inv.intro_source_id, inv.skill)
    )
    skills: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "completed": 0, "incomplete": 0})
    for inv in invocations:
        bucket = skills[inv.skill]
        bucket["total"] += 1
        bucket[("completed" if inv.completed else "incomplete")] += 1
    return CorpusAnalysis(invocations=invocations, skills=dict(skills))


# ---------------------------------------------------------------------------
# Minimal CLI (debug-only)
# ---------------------------------------------------------------------------


def _read_corpus(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="usage_stats",
        description="Detect skill invocations and pair them with exit signals "
                    "(Task 1 core pipeline; output surfaces land in later tasks).",
    )
    parser.add_argument(
        "--corpus",
        type=Path,
        required=True,
        help="Path to a Section 21 corpus.json envelope.",
    )
    args = parser.parse_args(argv)
    corpus = _read_corpus(args.corpus)
    analysis = analyze_corpus(corpus)
    pprint(
        {
            "skills": analysis.skills,
            "invocations": [vars(inv) for inv in analysis.invocations],
        },
        stream=sys.stdout,
        sort_dicts=False,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
