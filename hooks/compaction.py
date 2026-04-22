#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Shared compaction engine for growing artifacts.

Implements the uniform 10/40/50 compaction rule from SPEC.md Section 4:
keep the 10 most recent full-detail entries, collapse the next 40 to
one-line archive entries, drop anything beyond 50. Exposes a generic
parse/compact/write pipeline plus per-artifact specs for PROGRESS,
DECISIONS, HEALTH, EXPERIMENTS, and the TODO Resolved section.

Pure stdlib. Imported by hooks/session_stop.py, scripts/compact_artifact.py,
and hooks/validate_artifact.py.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable


# ---------------------------------------------------------------------------
# Thresholds
# ---------------------------------------------------------------------------

MAX_FULL_ENTRIES = 10
MAX_ONELINE_ENTRIES = 40
MAX_TOTAL_ENTRIES = MAX_FULL_ENTRIES + MAX_ONELINE_ENTRIES


# ---------------------------------------------------------------------------
# Data shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CompactResult:
    """Outcome of a compact_file invocation."""

    full_before: int
    oneline_before: int
    full_after: int
    oneline_after: int
    dropped: int
    changed: bool


@dataclass
class ArtifactSpec:
    """Describes how to parse and compact one artifact type.

    Attributes:
        name: canonical key (progress, decisions, health, experiments,
            todo-resolved).
        entry_heading_re: regex that matches the start-of-entry line in
            the full-detail region.
        oneline_heading_re: regex that matches one-liner lines in the
            archive region (None if archive uses full ## headings).
        archive_heading: ## heading that introduces the archive section
            (None for todo-resolved, which compacts in place).
        format_oneline: callable turning an entry dict into the archive
            string representation (without trailing newline).
        scoped_section: for todo-resolved, the ## heading that bounds
            the section being compacted (None otherwise).
    """

    name: str
    entry_heading_re: re.Pattern
    archive_heading: str | None
    format_oneline: Callable[[dict], str]
    oneline_heading_re: re.Pattern | None = None
    scoped_section: str | None = None
    extra: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Body field extraction helpers
# ---------------------------------------------------------------------------


def _extract_field(body: str, label: str) -> str:
    """Return the value of a **Label**: line in body, or empty string."""
    pattern = re.compile(
        rf"^\*\*{re.escape(label)}\*\*:\s*(.+?)$",
        re.MULTILINE,
    )
    m = pattern.search(body)
    return m.group(1).strip() if m else ""


def _first_non_empty(body: str) -> str:
    """Return the first non-empty stripped line of body."""
    for line in body.splitlines():
        if line.strip():
            return line.strip()
    return ""


def _truncate_words(text: str, limit: int = 15) -> str:
    """Truncate text to at most `limit` words; ellipsis if cut."""
    words = text.split()
    if len(words) <= limit:
        return text
    return " ".join(words[:limit]) + "..."


# ---------------------------------------------------------------------------
# Header parsers (number + date + title extraction)
# ---------------------------------------------------------------------------


_HEADER_NUM_RE = re.compile(r"(?:Cycle|Decision|Audit|Experiment)\s+(\d+)")
_HEADER_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")


def _parse_header(header: str) -> tuple[str, str, str]:
    """Extract (number, date, title) from a heading line.

    Number and date are returned as strings ("" if absent). Title is
    the remainder after the last midpoint dot, stripped.
    """
    num_match = _HEADER_NUM_RE.search(header)
    date_match = _HEADER_DATE_RE.search(header)
    number = num_match.group(1) if num_match else ""
    date = date_match.group(1) if date_match else ""
    # Title: everything after the last " · " (middle dot).
    parts = header.split(" · ")
    title = parts[-1].strip() if len(parts) >= 2 else ""
    # Strip date prefix from title if the last segment is just a date.
    if title == date:
        title = parts[-2].strip() if len(parts) >= 3 else ""
    return number, date, title


# ---------------------------------------------------------------------------
# One-line formatters
# ---------------------------------------------------------------------------


def _format_progress_oneline(entry: dict) -> str:
    """Progress one-liner: `- Cycle N (YYYY-MM-DD): <title>`.

    Title prefers the header's post-date segment; falls back to the
    body's **What** field, then first non-empty body line.
    """
    number, date, title = _parse_header(entry["header"])
    if not title:
        title = _extract_field(entry["body"], "What") or _first_non_empty(entry["body"])
    title = _truncate_words(title or "(no summary)", 20)
    number_part = f"Cycle {number}" if number else "Cycle ?"
    date_part = f" ({date})" if date else ""
    return f"- {number_part}{date_part}: {title}"


def _format_decision_oneline(entry: dict) -> str:
    """Decision one-liner: `- Decision N (YYYY-MM-DD): <chosen>`.

    Prefers **Chosen alternative** field; falls back to first non-empty
    body line.
    """
    number, date, _ = _parse_header(entry["header"])
    chosen = _extract_field(entry["body"], "Chosen alternative")
    if not chosen:
        chosen = _extract_field(entry["body"], "Chosen")
    if not chosen:
        chosen = _first_non_empty(entry["body"])
    chosen = _truncate_words(chosen or "(no rationale)", 20)
    number_part = f"Decision {number}" if number else "Decision ?"
    date_part = f" ({date})" if date else ""
    return f"- {number_part}{date_part}: {chosen}"


def _format_health_oneline(entry: dict) -> str:
    """Health one-liner: `### Audit N · YYYY-MM-DD (<grade> <trajectory>)`.

    Grade prefers an **Overall** field or a **Grades** field summary;
    trajectory prefers **Overall trajectory** field. Falls back to
    stripped defaults.
    """
    number, date, _ = _parse_header(entry["header"])
    # Prefer an explicit Grade or Grades summary.
    grade = _extract_field(entry["body"], "Overall")
    if not grade:
        grade = _extract_field(entry["body"], "Grade")
    trajectory = _extract_field(entry["body"], "Overall trajectory")
    if not trajectory:
        # If Overall contains trajectory symbols, reuse it for both.
        trajectory = ""
    summary_bits: list[str] = []
    if grade:
        summary_bits.append(_truncate_words(grade, 10))
    if trajectory and trajectory != grade:
        summary_bits.append(_truncate_words(trajectory, 10))
    summary = " | ".join(summary_bits) if summary_bits else "no summary"
    number_part = f"Audit {number}" if number else "Audit ?"
    date_part = f" · {date}" if date else ""
    return f"### {number_part}{date_part} ({summary})"


def _format_experiment_oneline(entry: dict) -> str:
    """Experiment one-liner: `- EXP-N: <=15-word result summary`.

    Prefers **Metric** field (captures before/after delta); falls back
    to **Conclusion**, **Result**, then first non-empty body line.
    """
    number, _, _ = _parse_header(entry["header"])
    summary = _extract_field(entry["body"], "Metric")
    if not summary:
        summary = _extract_field(entry["body"], "Conclusion")
    if not summary:
        summary = _extract_field(entry["body"], "Result")
    if not summary:
        summary = _first_non_empty(entry["body"])
    summary = _truncate_words(summary or "(no result)", 15)
    number_part = f"EXP-{number}" if number else "EXP-?"
    return f"- {number_part}: {summary}"


def _format_todo_oneline(entry: dict) -> str:
    """Todo-resolved one-liner.

    Preserves the existing checkbox if already one-line; otherwise
    builds `- [x] ~~[ISS-NN]: <=15-word summary~~`. The parse step for
    todo-resolved treats every resolved bullet as an entry, so the
    header already holds the item text.
    """
    header = entry["header"].strip()
    # Already one-line (no body) and wrapped in tildes: pass through.
    if entry["kind"] == "oneline" and "~~" in header:
        return header if header.startswith("- ") else f"- {header}"
    # Extract ISS-NN if present.
    iss_match = re.search(r"ISS-\d+", header)
    iss = iss_match.group(0) if iss_match else "ISS-?"
    # Build a short summary from header (strip checkbox/tildes/ISS).
    summary = header
    summary = re.sub(r"^-\s*\[x\]\s*", "", summary)
    summary = summary.replace("~~", "").strip()
    summary = re.sub(r"ISS-\d+:?\s*", "", summary).strip()
    summary = _truncate_words(summary or "(resolved)", 15)
    return f"- [x] ~~{iss}: {summary}~~"


# ---------------------------------------------------------------------------
# Specs
# ---------------------------------------------------------------------------


SPECS: dict[str, ArtifactSpec] = {
    "progress": ArtifactSpec(
        name="progress",
        entry_heading_re=re.compile(
            r"^■?\s*##\s+Cycle\s+\d+",
            re.MULTILINE,
        ),
        oneline_heading_re=re.compile(r"^-\s+Cycle\s+\d+", re.MULTILINE),
        archive_heading="## Archived Cycles",
        format_oneline=_format_progress_oneline,
    ),
    "decisions": ArtifactSpec(
        name="decisions",
        entry_heading_re=re.compile(r"^##\s+Decision\s+\d+", re.MULTILINE),
        oneline_heading_re=re.compile(r"^-\s+Decision\s+\d+", re.MULTILINE),
        archive_heading="## Archived Decisions",
        format_oneline=_format_decision_oneline,
    ),
    "health": ArtifactSpec(
        name="health",
        entry_heading_re=re.compile(r"^##\s+Audit\s+\d+", re.MULTILINE),
        oneline_heading_re=re.compile(r"^###\s+Audit\s+\d+", re.MULTILINE),
        archive_heading="## Archived Audits",
        format_oneline=_format_health_oneline,
    ),
    "experiments": ArtifactSpec(
        name="experiments",
        entry_heading_re=re.compile(r"^##\s+Experiment\s+\d+", re.MULTILINE),
        oneline_heading_re=re.compile(r"^-\s+EXP-\d+", re.MULTILINE),
        archive_heading="## Archived Experiments",
        format_oneline=_format_experiment_oneline,
    ),
    "todo-resolved": ArtifactSpec(
        name="todo-resolved",
        entry_heading_re=re.compile(r"^-\s+\[x\]\s+", re.MULTILINE),
        oneline_heading_re=None,
        archive_heading=None,
        format_oneline=_format_todo_oneline,
        scoped_section="## Resolved",
    ),
}


# ---------------------------------------------------------------------------
# Generic parse helpers
# ---------------------------------------------------------------------------


def _split_archive(text: str, archive_heading: str) -> tuple[str, str]:
    """Return (pre_archive, archive_body) pair.

    If the archive heading is not found, returns (text, ""). The
    archive body is everything after the heading up to the next ##
    heading (or end of file).
    """
    if not archive_heading:
        return text, ""
    pattern = re.compile(
        rf"^{re.escape(archive_heading)}\s*$",
        re.MULTILINE,
    )
    match = pattern.search(text)
    if not match:
        return text, ""
    pre = text[: match.start()].rstrip()
    after = text[match.end():]
    # Find next ## heading (but not ### sub-headings for health archive).
    next_section = re.search(r"^##\s", after, re.MULTILINE)
    if next_section:
        archive_body = after[: next_section.start()]
        trailing = after[next_section.start():]
    else:
        archive_body = after
        trailing = ""
    return pre, archive_body.strip() + ("\n\n" + trailing if trailing else "")


def _parse_full_entries(text: str, spec: ArtifactSpec) -> list[dict]:
    """Split text into full-detail entries using spec.entry_heading_re."""
    entries: list[dict] = []
    matches = list(spec.entry_heading_re.finditer(text))
    for i, m in enumerate(matches):
        # Header is the full line containing the match.
        line_start = text.rfind("\n", 0, m.start()) + 1
        line_end = text.find("\n", m.start())
        if line_end == -1:
            line_end = len(text)
        header_line = text[line_start:line_end].strip()
        # Preserve a leading status glyph (e.g., ■) on the rewritten header.
        glyph_match = re.match(r"^(■)\s*", header_line)
        glyph = glyph_match.group(1) + " " if glyph_match else ""
        remainder = header_line[glyph_match.end():] if glyph_match else header_line
        # Strip the ##/### markdown markers from the remainder.
        header = glyph + remainder.lstrip("#").strip()
        # Body is everything between this header and the next.
        body_start = line_end + 1
        body_end = (
            matches[i + 1].start() - 1
            if i + 1 < len(matches)
            else len(text)
        )
        # Roll body_end back to the start of the next header's line.
        if i + 1 < len(matches):
            next_line_start = text.rfind(
                "\n",
                0,
                matches[i + 1].start(),
            ) + 1
            body_end = next_line_start
        body = text[body_start:body_end].strip()
        entries.append({
            "header": header,
            "body": body,
            "kind": "full",
        })
    return entries


def _parse_oneline_entries(text: str, spec: ArtifactSpec) -> list[dict]:
    """Split text into one-line entries using spec.oneline_heading_re."""
    if spec.oneline_heading_re is None:
        return []
    entries: list[dict] = []
    for line in text.splitlines():
        if spec.oneline_heading_re.match(line):
            entries.append({
                "header": line.rstrip(),
                "body": "",
                "kind": "oneline",
            })
    return entries


def parse_entries(text: str, spec_name: str) -> list[dict]:
    """Parse text into a single ordered list of entries.

    For non-todo specs: full entries from above the archive heading,
    followed by one-line entries from the archive body. For
    todo-resolved: one entry per `- [x]` bullet in the ## Resolved
    section, marked "full" if it has nested detail lines below,
    "oneline" otherwise.
    """
    spec = SPECS[spec_name]

    if spec.name == "todo-resolved":
        return _parse_todo_resolved(text, spec)

    pre, archive_body = _split_archive(text, spec.archive_heading or "")
    full_entries = _parse_full_entries(pre, spec)
    oneline_entries = _parse_oneline_entries(archive_body, spec)
    return full_entries + oneline_entries


def _extract_resolved_section(text: str) -> tuple[int, int, str]:
    """Locate the `## Resolved` section and return (start, end, body)."""
    m = re.search(r"^##\s+Resolved\s*$", text, re.MULTILINE)
    if not m:
        return -1, -1, ""
    body_start = m.end() + 1
    next_section = re.search(r"^##\s", text[body_start:], re.MULTILINE)
    body_end = (
        body_start + next_section.start()
        if next_section
        else len(text)
    )
    return m.start(), body_end, text[body_start:body_end]


def _parse_todo_resolved(text: str, spec: ArtifactSpec) -> list[dict]:
    """Parse resolved checkbox bullets under the ## Resolved section."""
    _, _, body = _extract_resolved_section(text)
    if not body:
        return []
    entries: list[dict] = []
    lines = body.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        if spec.entry_heading_re.match(line):
            # Detail lines: indented continuation until next bullet
            # or blank-then-non-indented line.
            detail_lines: list[str] = []
            j = i + 1
            while j < len(lines):
                nxt = lines[j]
                if nxt.startswith(" ") or nxt.startswith("\t"):
                    detail_lines.append(nxt)
                    j += 1
                elif nxt.strip() == "":
                    # Blank may be internal to detail: peek ahead.
                    if (
                        j + 1 < len(lines)
                        and (
                            lines[j + 1].startswith(" ")
                            or lines[j + 1].startswith("\t")
                        )
                    ):
                        detail_lines.append(nxt)
                        j += 1
                    else:
                        break
                else:
                    break
            body_text = "\n".join(detail_lines).strip()
            entries.append({
                "header": line.rstrip(),
                "body": body_text,
                "kind": "full" if body_text else "oneline",
            })
            i = j
        else:
            i += 1
    return entries


# ---------------------------------------------------------------------------
# Compaction core
# ---------------------------------------------------------------------------


_NUMBER_RE = re.compile(r"(?:Cycle|Decision|Audit|Experiment|EXP-)\s*(\d+)")


def _entry_number(entry: dict) -> int:
    """Extract the numeric identifier from an entry header (0 if absent)."""
    m = _NUMBER_RE.search(entry["header"])
    return int(m.group(1)) if m else 0


def _detect_direction(entries: list[dict]) -> str:
    """Return "ascending" or "descending" based on majority of adjacent pairs.

    Robust to out-of-order insertions (agents append entries mid-file
    under load, so first-vs-last is unreliable). Defaults to "descending"
    when no signal is available, matching SPEC Section 4 (most recent
    first, archive below).
    """
    asc = 0
    desc = 0
    for i in range(len(entries) - 1):
        a = _entry_number(entries[i])
        b = _entry_number(entries[i + 1])
        if a == 0 or b == 0 or a == b:
            continue
        if a < b:
            asc += 1
        else:
            desc += 1
    if asc == 0 and desc == 0:
        return "descending"
    return "ascending" if asc > desc else "descending"


def compact_entries(
    entries: list[dict],
    max_full: int = MAX_FULL_ENTRIES,
    max_oneline: int = MAX_ONELINE_ENTRIES,
    format_oneline: Callable[[dict], str] | None = None,
) -> list[dict]:
    """Apply 10/40/50 rules to an ordered entry list.

    Identifies the 10 most recent entries by numeric identifier (Cycle N,
    Decision N, etc.) regardless of input order — adjacent-pair majority
    vote picks the file's ascending-or-descending convention so
    out-of-sequence insertions don't flip the direction. The next
    `max_oneline` entries are converted to one-line via `format_oneline`
    (if currently full). Beyond `max_full + max_oneline` are dropped.
    """
    max_total = max_full + max_oneline
    if not entries:
        return []

    ascending = _detect_direction(entries) == "ascending"

    # Work internally in newest-first order so slicing applies the
    # "10 most recent" rule correctly regardless of input ordering.
    newest_first = sorted(entries, key=_entry_number, reverse=True)

    result: list[dict] = []
    for i, entry in enumerate(newest_first):
        if i < max_full:
            result.append(entry)
        elif i < max_total:
            if entry["kind"] == "full" and format_oneline is not None:
                result.append({
                    "header": format_oneline(entry),
                    "body": "",
                    "kind": "oneline",
                })
            else:
                result.append(entry)
        # else: drop.

    if ascending:
        result.reverse()
    return result


# ---------------------------------------------------------------------------
# File-level compaction
# ---------------------------------------------------------------------------


def _format_progress_like(
    header_prefix: str,
    entries: list[dict],
    spec: ArtifactSpec,
) -> str:
    """Render the compacted entries back as file content.

    Preserves the leading ``# Title`` region (everything before the
    first entry or archive heading) via `header_prefix`. Writes full
    entries with `## ` prefix, followed by the archive heading and
    one-line entries.
    """
    lines: list[str] = []
    if header_prefix.strip():
        lines.append(header_prefix.rstrip())
        lines.append("")

    full_entries = [e for e in entries if e["kind"] == "full"]
    oneline_entries = [e for e in entries if e["kind"] == "oneline"]

    for entry in full_entries:
        header = entry["header"]
        # If the header begins with a status glyph (e.g., ■), emit
        # `<glyph> ## <rest>` to match the SPEC format.
        glyph_match = re.match(r"^(■)\s+(.*)$", header)
        if glyph_match:
            lines.append(f"{glyph_match.group(1)} ## {glyph_match.group(2)}")
        else:
            lines.append(f"## {header}")
        if entry["body"]:
            lines.append("")
            lines.append(entry["body"])
        lines.append("")

    if oneline_entries and spec.archive_heading:
        lines.append(spec.archive_heading)
        lines.append("")
        for entry in oneline_entries:
            lines.append(entry["header"])
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def _extract_header_prefix(text: str, spec: ArtifactSpec) -> str:
    """Everything before the first entry heading or archive heading."""
    first_entry = spec.entry_heading_re.search(text)
    first_archive_idx = -1
    if spec.archive_heading:
        pattern = re.compile(
            rf"^{re.escape(spec.archive_heading)}\s*$",
            re.MULTILINE,
        )
        archive_match = pattern.search(text)
        if archive_match:
            first_archive_idx = archive_match.start()

    candidates = [
        first_entry.start() if first_entry else -1,
        first_archive_idx,
    ]
    valid = [c for c in candidates if c >= 0]
    if not valid:
        return text.rstrip()
    return text[: min(valid)].rstrip()


def _compact_todo_resolved(path: Path) -> CompactResult:
    """Compact only the `## Resolved` section of a TODO.md."""
    spec = SPECS["todo-resolved"]
    text = path.read_text(encoding="utf-8")
    start, end, body = _extract_resolved_section(text)
    if start < 0:
        return CompactResult(0, 0, 0, 0, 0, False)

    entries = _parse_todo_resolved(text, spec)
    full_before = sum(1 for e in entries if e["kind"] == "full")
    oneline_before = sum(1 for e in entries if e["kind"] == "oneline")
    total_before = len(entries)

    if total_before <= MAX_FULL_ENTRIES + MAX_ONELINE_ENTRIES and full_before <= MAX_FULL_ENTRIES:
        return CompactResult(full_before, oneline_before, full_before, oneline_before, 0, False)

    compacted = compact_entries(
        entries,
        format_oneline=spec.format_oneline,
    )
    full_after = sum(1 for e in compacted if e["kind"] == "full")
    oneline_after = sum(1 for e in compacted if e["kind"] == "oneline")
    dropped = total_before - len(compacted)

    # Rebuild the Resolved section body.
    new_lines: list[str] = []
    for entry in compacted:
        if entry["kind"] == "full":
            new_lines.append(entry["header"])
            if entry["body"]:
                new_lines.append(entry["body"])
        else:
            new_lines.append(spec.format_oneline(entry))
    new_body = "\n".join(new_lines) + "\n"

    # Splice back.
    prefix = text[: end - len(body)] if body else text[: start]
    # Find where body begins after the heading line.
    heading_end = text.find("\n", start) + 1
    new_text = text[:heading_end] + "\n" + new_body + text[end:]
    path.write_text(new_text, encoding="utf-8")
    return CompactResult(full_before, oneline_before, full_after, oneline_after, dropped, True)


def compact_file(path: Path, spec_name: str) -> CompactResult:
    """Read, parse, apply compaction, write back if needed.

    Returns a CompactResult describing what happened. `changed=False`
    means the file was not modified (under threshold, or no entries).
    Raises ValueError on unknown spec_name, FileNotFoundError on
    missing path.
    """
    if spec_name not in SPECS:
        raise ValueError(f"unknown spec: {spec_name}")
    if not path.exists():
        raise FileNotFoundError(str(path))

    spec = SPECS[spec_name]
    if spec.name == "todo-resolved":
        return _compact_todo_resolved(path)

    text = path.read_text(encoding="utf-8")
    entries = parse_entries(text, spec_name)
    full_before = sum(1 for e in entries if e["kind"] == "full")
    oneline_before = sum(1 for e in entries if e["kind"] == "oneline")
    total_before = full_before + oneline_before

    needs_compact = (
        full_before > MAX_FULL_ENTRIES
        or total_before > MAX_FULL_ENTRIES + MAX_ONELINE_ENTRIES
    )
    if not needs_compact:
        return CompactResult(
            full_before, oneline_before, full_before, oneline_before, 0, False,
        )

    compacted = compact_entries(
        entries,
        format_oneline=spec.format_oneline,
    )
    full_after = sum(1 for e in compacted if e["kind"] == "full")
    oneline_after = sum(1 for e in compacted if e["kind"] == "oneline")
    dropped = total_before - len(compacted)

    header_prefix = _extract_header_prefix(text, spec)
    new_text = _format_progress_like(header_prefix, compacted, spec)
    path.write_text(new_text, encoding="utf-8")
    return CompactResult(full_before, oneline_before, full_after, oneline_after, dropped, True)


# ---------------------------------------------------------------------------
# Over-threshold detection (for the validate_artifact nudge)
# ---------------------------------------------------------------------------


def detect_overflow(text: str, spec_name: str) -> tuple[int, int]:
    """Return (full_count, oneline_count) for a parsed file text."""
    entries = parse_entries(text, spec_name)
    full_count = sum(1 for e in entries if e["kind"] == "full")
    oneline_count = sum(1 for e in entries if e["kind"] == "oneline")
    return full_count, oneline_count
