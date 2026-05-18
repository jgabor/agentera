#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Shared compaction engine for growing artifacts.

Implements the uniform 10/40/50 compaction rule from SPEC.md Section 4:
keep the 10 most recent full-detail entries, collapse the next 40 to
one-line archive entries, drop anything beyond 50. Exposes a generic
parse/compact/write pipeline plus per-artifact specs for PROGRESS,
DECISIONS, HEALTH, EXPERIMENTS, and the TODO Resolved section.

Imported by hooks/session_stop.py, scripts/compact_artifact.py, and
hooks/validate_artifact.py.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import yaml


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


@dataclass(frozen=True)
class CompactionStatus:
    """Read-only compaction classification for one artifact path."""

    artifact: str
    path: str
    classification: str
    active_count: int | None
    archive_count: int | None
    total_count: int | None
    over_limit_count: int | None
    reason: str
    protected_overflow_count: int | None = 0
    exists: bool = True


@dataclass(frozen=True)
class CompactionOperation:
    """Check/fix outcome for one known artifact family."""

    status: CompactionStatus
    mode: str
    action: str
    changed: bool = False
    result: CompactResult | None = None
    message: str = ""


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
_NUMBER_RE = re.compile(r"(?:Cycle|Decision|Audit|Experiment|EXP-)\s*(\d+)")


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


_TODO_CHECKBOX_RE = re.compile(r"^-\s*\[x\]\s*")
_TODO_ISS_LABEL_RE = re.compile(r"ISS-\d+:?\s*")


def _is_todo_oneline_passthrough(entry: dict) -> bool:
    """True when the resolved entry is already a tilde-wrapped one-liner needing no rebuild."""
    return entry["kind"] == "oneline" and "~~" in entry["header"]


def _strip_todo_metadata(header: str) -> str:
    """Strip checkbox, tilde wrappers, legacy IDs, and resolution notes from a TODO header."""
    stripped = _TODO_CHECKBOX_RE.sub("", header)
    stripped = stripped.replace("~~", "").strip()
    stripped = stripped.split(" · ", 1)[0].strip()
    stripped = _TODO_ISS_LABEL_RE.sub("", stripped).strip()
    return stripped


def _format_todo_oneline(entry: dict) -> str:
    """Todo-resolved one-liner: pass through if already one-line + tilde-wrapped, otherwise
    build `- [x] ~~[type] <=15-word summary~~`. Parse treats each resolved bullet as an
    entry whose header holds the item text.
    """
    header = entry["header"].strip()
    if _is_todo_oneline_passthrough(entry):
        return header if header.startswith("- ") else f"- {header}"
    summary = _truncate_words(_strip_todo_metadata(header) or "(resolved)", 15)
    return f"- [x] ~~{summary}~~"


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


DEFAULT_ARTIFACT_PATHS: dict[str, str] = {
    "VISION.md": ".agentera/vision.yaml",
    "TODO.md": "TODO.md",
    "CHANGELOG.md": "CHANGELOG.md",
    "DECISIONS.md": ".agentera/decisions.yaml",
    "PLAN.md": ".agentera/plan.yaml",
    "PROGRESS.md": ".agentera/progress.yaml",
    "HEALTH.md": ".agentera/health.yaml",
    "DOCS.md": ".agentera/docs.yaml",
    "DESIGN.md": "DESIGN.md",
}

COMPACTABLE_YAML_ARTIFACTS: dict[str, tuple[str, str]] = {
    "PROGRESS.md": ("cycles", "archive"),
    "DECISIONS.md": ("decisions", "archive"),
    "HEALTH.md": ("audits", "archive"),
}

YAML_SPEC_BY_ARTIFACT: dict[str, str] = {
    "PROGRESS.md": "progress",
    "DECISIONS.md": "decisions",
    "HEALTH.md": "health",
}

NON_COMPACTABLE_ARTIFACTS: dict[str, tuple[str, str]] = {
    "CHANGELOG.md": ("exempt", "public release history is not compacted"),
    "PLAN.md": ("unsupported", "active plan is lifecycle state, not a uniform retained-entry log"),
    "DOCS.md": ("unsupported", "docs owns artifact mapping and schema metadata"),
    "VISION.md": ("protected", "vision state is protected during execution cycles"),
    "DESIGN.md": ("unsupported", "design is a human-facing identity artifact, not a uniform retained-entry log"),
}


def _over_limit_count(active_count: int, archive_count: int) -> int:
    """Return the largest entry excess across the 10/40/50 contract."""
    total_count = active_count + archive_count
    return max(
        max(active_count - MAX_FULL_ENTRIES, 0),
        max(archive_count - MAX_ONELINE_ENTRIES, 0),
        max(total_count - MAX_TOTAL_ENTRIES, 0),
    )


def _parse_docs_yaml_mapping(docs_text: str) -> dict[str, str]:
    """Extract artifact path overrides from the v2 docs.yaml mapping list."""
    mapping: dict[str, str] = {}
    in_mapping = False
    current: str | None = None
    for line in docs_text.splitlines():
        if line.startswith("mapping:"):
            in_mapping = True
            continue
        if in_mapping and line and not line.startswith((" ", "-")):
            break
        if not in_mapping:
            continue
        artifact_match = re.match(r"-\s+artifact:\s*(.+?)\s*$", line)
        if artifact_match:
            current = artifact_match.group(1).strip().strip("'\"")
            continue
        path_match = re.match(r"\s+path:\s*(.+?)\s*$", line)
        if path_match and current:
            mapping[current] = path_match.group(1).strip().strip("'\"")
            current = None
    return mapping


def _artifact_paths(project_root: Path) -> dict[str, Path]:
    """Resolve canonical artifact paths, preserving docs.yaml mapping precedence."""
    paths = dict(DEFAULT_ARTIFACT_PATHS)
    docs_path = project_root / ".agentera" / "docs.yaml"
    if docs_path.exists():
        paths.update(_parse_docs_yaml_mapping(docs_path.read_text(encoding="utf-8")))
    return {artifact: project_root / path for artifact, path in paths.items()}


def _missing_status(artifact: str, path: Path, classification: str) -> CompactionStatus:
    return CompactionStatus(
        artifact=artifact,
        path=str(path),
        classification=classification,
        active_count=0,
        archive_count=0,
        total_count=0,
        over_limit_count=0,
        reason="artifact path is not present",
        exists=False,
    )


def _yaml_counts(path: Path, active_key: str, archive_key: str) -> tuple[int, int]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        return 0, 0
    active = data.get(active_key) or []
    archive = data.get(archive_key) or []
    return (
        len(active) if isinstance(active, list) else 0,
        len(archive) if isinstance(archive, list) else 0,
    )


def _yaml_lists(path: Path, active_key: str, archive_key: str) -> tuple[list[object], list[object]]:
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        return [], []
    active = data.get(active_key) or []
    archive = data.get(archive_key) or []
    return (
        active if isinstance(active, list) else [],
        archive if isinstance(archive, list) else [],
    )


def _yaml_entry_number(entry: object) -> int:
    """Best-effort numeric recency key for YAML active/archive entries."""
    if isinstance(entry, dict):
        number = entry.get("number")
        if isinstance(number, int):
            return number
        if isinstance(number, str) and number.isdigit():
            return int(number)
        summary = str(entry.get("summary", ""))
    else:
        summary = str(entry)
    match = _NUMBER_RE.search(summary)
    return int(match.group(1)) if match else 0


def _yaml_entry_timestamp(entry: object) -> str:
    if isinstance(entry, dict):
        return str(entry.get("timestamp") or entry.get("date") or "")
    return ""


def _yaml_summary_text(entry: dict, *fields: str) -> str:
    for field in fields:
        value = entry.get(field)
        if isinstance(value, str) and value.strip():
            return _truncate_words(value.strip(), 15)
        if isinstance(value, dict) and value:
            return _truncate_words(
                ", ".join(f"{key}: {val}" for key, val in value.items()),
                15,
            )
    return "no summary"


def _yaml_archive_entry(spec_name: str, entry: object) -> dict[str, object]:
    """Convert a full YAML entry to its schema archive representation."""
    if not isinstance(entry, dict):
        return {"summary": str(entry)}

    if spec_name == "progress":
        number = entry.get("number", "?")
        date = str(entry.get("timestamp", "")).split()[0]
        date_part = f" ({date})" if date else ""
        summary = _yaml_summary_text(entry, "what", "type")
        return {"summary": f"Cycle {number}{date_part}: {summary}"}

    if spec_name == "decisions":
        number = entry.get("number", "?")
        date = str(entry.get("date", ""))
        date_part = f" ({date})" if date else ""
        choice = _yaml_summary_text(entry, "choice", "question")
        archive_entry: dict[str, object] = {"summary": f"Decision {number}{date_part}: {choice}"}
        for field in ("number", "date", "choice", "outcome", "feeds_into", "satisfaction"):
            value = entry.get(field)
            if value not in (None, "", [], {}):
                archive_entry[field] = value
        if "outcome" not in archive_entry and archive_entry.get("choice") not in (None, ""):
            archive_entry["outcome"] = archive_entry["choice"]
        return archive_entry

    if spec_name == "health":
        number = entry.get("number", "?")
        date = str(entry.get("date", ""))
        date_part = f" ({date})" if date else ""
        summary = _yaml_summary_text(entry, "trajectory", "grades")
        return {"summary": f"Audit {number}{date_part}: {summary}"}

    if spec_name == "session":
        timestamp = str(entry.get("timestamp", ""))
        summary = _yaml_summary_text(entry, "summary")
        return {"timestamp": timestamp, "summary": summary}

    return {"summary": _yaml_summary_text(entry, "summary")}


def _yaml_sort_entries(entries: list[object], spec_name: str) -> list[object]:
    """Return full entries in the schema's active ordering."""
    if spec_name in {"decisions", "health"}:
        return sorted(entries, key=_yaml_entry_number)
    if spec_name == "session":
        return sorted(entries, key=_yaml_entry_timestamp, reverse=True)
    return sorted(entries, key=_yaml_entry_number, reverse=True)


def _yaml_recent_full_and_older(entries: list[object], spec_name: str) -> tuple[list[object], list[object]]:
    """Select the newest full entries, then restore schema active ordering."""
    if spec_name == "session":
        newest_first = sorted(entries, key=_yaml_entry_timestamp, reverse=True)
    else:
        newest_first = sorted(entries, key=_yaml_entry_number, reverse=True)
    recent = newest_first[:MAX_FULL_ENTRIES]
    older = newest_first[MAX_FULL_ENTRIES:]
    return _yaml_sort_entries(recent, spec_name), older


def _yaml_archive_sort_key(entry: object) -> tuple[str, int | str]:
    timestamp = _yaml_entry_timestamp(entry)
    if timestamp:
        return ("timestamp", timestamp)
    return ("number", _yaml_entry_number(entry))


def _yaml_archive_entries(entries: list[object]) -> list[object]:
    """Return newest archive entries first when enough signal exists."""
    return sorted(entries, key=_yaml_archive_sort_key, reverse=True)


def _decision_satisfaction_state(entry: object) -> str | None:
    if not isinstance(entry, dict):
        return None
    satisfaction = entry.get("satisfaction")
    if not isinstance(satisfaction, dict):
        return None
    state = satisfaction.get("state")
    return state if isinstance(state, str) else None


def _decision_requires_user_review(entry: object) -> bool:
    if not isinstance(entry, dict):
        return True
    satisfaction = entry.get("satisfaction")
    if not isinstance(satisfaction, dict):
        return True
    confirmation = satisfaction.get("user_confirmation")
    return (
        _decision_satisfaction_state(entry) != "user_confirmed_satisfied"
        or not isinstance(confirmation, dict)
        or not confirmation
    )


def _decision_protected_overflow_count(active: list[object], archive: list[object]) -> int:
    protected_active = sum(1 for entry in active if _decision_requires_user_review(entry))
    protected_archive = sum(1 for entry in archive if _decision_requires_user_review(entry))
    return max(
        protected_active - MAX_FULL_ENTRIES,
        protected_archive - MAX_ONELINE_ENTRIES,
        protected_active + protected_archive - MAX_TOTAL_ENTRIES,
        0,
    )


def _select_decision_active_entries(active: list[object]) -> tuple[list[object], list[object]]:
    """Keep review-needed decisions full, filling remaining active slots with newest satisfied entries."""
    protected = [entry for entry in active if _decision_requires_user_review(entry)]
    if len(protected) > MAX_FULL_ENTRIES:
        raise RuntimeError(
            "DECISIONS.md: protected-overflow review pressure; "
            f"{len(protected)} protected active decision(s) exceed {MAX_FULL_ENTRIES} full-detail slots"
        )
    satisfied = [entry for entry in active if not _decision_requires_user_review(entry)]
    newest_satisfied = sorted(satisfied, key=_yaml_entry_number, reverse=True)
    keep_satisfied = newest_satisfied[: MAX_FULL_ENTRIES - len(protected)]
    compact_satisfied = newest_satisfied[MAX_FULL_ENTRIES - len(protected):]
    return _yaml_sort_entries(protected + keep_satisfied, "decisions"), compact_satisfied


def _select_decision_archive_entries(archive_candidates: list[object]) -> list[object]:
    protected = [entry for entry in archive_candidates if _decision_requires_user_review(entry)]
    if len(protected) > MAX_ONELINE_ENTRIES:
        raise RuntimeError(
            "DECISIONS.md: protected-overflow review pressure; "
            f"{len(protected)} protected archived decision(s) exceed {MAX_ONELINE_ENTRIES} archive slots"
        )
    satisfied = [entry for entry in archive_candidates if not _decision_requires_user_review(entry)]
    keep_satisfied = _yaml_archive_entries(satisfied)[: MAX_ONELINE_ENTRIES - len(protected)]
    return _yaml_archive_entries(protected + keep_satisfied)


def compact_yaml_file(path: Path, artifact: str) -> CompactResult:
    """Compact a v2 YAML artifact, preserving unrelated top-level keys."""
    if artifact not in COMPACTABLE_YAML_ARTIFACTS:
        raise ValueError(f"unsupported YAML artifact: {artifact}")
    if not path.exists():
        raise FileNotFoundError(str(path))

    active_key, archive_key = COMPACTABLE_YAML_ARTIFACTS[artifact]
    spec_name = YAML_SPEC_BY_ARTIFACT[artifact]
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        data = {}

    active = data.get(active_key) or []
    archive = data.get(archive_key) or []
    if not isinstance(active, list):
        active = []
    if not isinstance(archive, list):
        archive = []

    full_before = len(active)
    oneline_before = len(archive)
    if _over_limit_count(full_before, oneline_before) == 0:
        return CompactResult(full_before, oneline_before, full_before, oneline_before, 0, False)

    if spec_name == "decisions":
        recent_full, older_active = _select_decision_active_entries(active)
    else:
        recent_full, older_active = _yaml_recent_full_and_older(active, spec_name)
    compacted_from_active = [
        _yaml_archive_entry(spec_name, entry)
        for entry in older_active
    ]
    archive_candidates = _yaml_archive_entries(compacted_from_active + archive)
    if spec_name == "decisions":
        archive_after = _select_decision_archive_entries(archive_candidates)
    else:
        archive_after = archive_candidates[:MAX_ONELINE_ENTRIES]

    data[active_key] = recent_full
    data[archive_key] = archive_after
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")

    full_after = len(recent_full)
    oneline_after = len(archive_after)
    dropped = full_before + oneline_before - full_after - oneline_after
    return CompactResult(full_before, oneline_before, full_after, oneline_after, dropped, True)


def _count_status(
    artifact: str,
    path: Path,
    active_count: int,
    archive_count: int,
    protected_overflow_count: int = 0,
) -> CompactionStatus:
    total_count = active_count + archive_count
    return CompactionStatus(
        artifact=artifact,
        path=str(path),
        classification="compactable",
        active_count=active_count,
        archive_count=archive_count,
        total_count=total_count,
        over_limit_count=_over_limit_count(active_count, archive_count),
        reason="protected-overflow review pressure" if protected_overflow_count else "uniform_10_40_50",
        protected_overflow_count=protected_overflow_count,
    )


def compute_compaction_status(project_root: Path) -> list[CompactionStatus]:
    """Compute read-only compaction classifications for known artifact families.

    This inventories current status only. It never rewrites artifacts and treats
    objective-scoped experiment files as protected unless a later explicit fix
    path opts into objective-state mutation.
    """
    paths = _artifact_paths(project_root)
    statuses: list[CompactionStatus] = []

    todo_path = paths["TODO.md"]
    if todo_path.exists():
        entries = parse_entries(todo_path.read_text(encoding="utf-8"), "todo-resolved")
        active_count = sum(1 for entry in entries if entry["kind"] == "full")
        archive_count = sum(1 for entry in entries if entry["kind"] == "oneline")
        statuses.append(_count_status("TODO.md#Resolved", todo_path, active_count, archive_count))
    else:
        statuses.append(_missing_status("TODO.md#Resolved", todo_path, "compactable"))

    for artifact, (active_key, archive_key) in COMPACTABLE_YAML_ARTIFACTS.items():
        path = paths[artifact]
        if path.exists():
            active, archive = _yaml_lists(path, active_key, archive_key)
            protected_overflow_count = (
                _decision_protected_overflow_count(active, archive)
                if artifact == "DECISIONS.md"
                else 0
            )
            statuses.append(_count_status(artifact, path, len(active), len(archive), protected_overflow_count))
        else:
            statuses.append(_missing_status(artifact, path, "compactable"))

    for artifact, (classification, reason) in NON_COMPACTABLE_ARTIFACTS.items():
        path = paths[artifact]
        statuses.append(CompactionStatus(
            artifact=artifact,
            path=str(path),
            classification=classification,
            active_count=None,
            archive_count=None,
            total_count=None,
            over_limit_count=None,
            reason=reason,
            exists=path.exists(),
        ))

    for experiments_path in sorted((project_root / ".agentera" / "optimera").glob("*/experiments.yaml")):
        active_count, archive_count = _yaml_counts(experiments_path, "experiments", "archive")
        statuses.append(CompactionStatus(
            artifact="EXPERIMENTS.md",
            path=str(experiments_path),
            classification="protected",
            active_count=active_count,
            archive_count=archive_count,
            total_count=active_count + archive_count,
            over_limit_count=_over_limit_count(active_count, archive_count),
            reason="objective-state experiment files are classified but skipped by default",
        ))

    return statuses


def _operation_for_status(status: CompactionStatus, mode: str) -> CompactionOperation:
    if not status.exists:
        return CompactionOperation(status, mode, "missing", message=status.reason)
    if status.classification != "compactable":
        return CompactionOperation(status, mode, "skipped", message=status.reason)
    if status.protected_overflow_count:
        return CompactionOperation(
            status,
            mode,
            "protected_overflow",
            message=f"protected-overflow review pressure by {status.protected_overflow_count}",
        )
    if not status.over_limit_count:
        return CompactionOperation(status, mode, "ok", message="within uniform_10_40_50 limits")
    return CompactionOperation(
        status,
        mode,
        "over_limit" if mode == "check" else "pending_fix",
        message=f"over uniform_10_40_50 limit by {status.over_limit_count}",
    )


def check_compaction(project_root: Path) -> list[CompactionOperation]:
    """Report compaction status for known artifacts without modifying files."""
    return [_operation_for_status(status, "check") for status in compute_compaction_status(project_root)]


def fix_compaction(project_root: Path) -> list[CompactionOperation]:
    """Apply compaction to over-limit compactable artifacts only.

    Missing optional artifacts and protected/unsupported/exempt artifacts are
    reported as skipped/missing and do not prevent unrelated fixes.
    """
    operations: list[CompactionOperation] = []
    for status in compute_compaction_status(project_root):
        baseline = _operation_for_status(status, "fix")
        if baseline.action != "pending_fix":
            operations.append(baseline)
            continue

        path = Path(status.path)
        try:
            if status.artifact == "TODO.md#Resolved":
                result = compact_file(path, "todo-resolved")
            elif status.artifact in YAML_SPEC_BY_ARTIFACT:
                result = compact_yaml_file(path, status.artifact)
            else:
                operations.append(CompactionOperation(
                    status,
                    "fix",
                    "skipped",
                    message=f"no fixer registered for {status.artifact}",
                ))
                continue
        except Exception as exc:
            operations.append(CompactionOperation(status, "fix", "error", message=str(exc)))
            continue

        operations.append(CompactionOperation(
            status,
            "fix",
            "compacted" if result.changed else "ok",
            changed=result.changed,
            result=result,
            message=(
                f"full {result.full_before}->{result.full_after}; "
                f"archive {result.oneline_before}->{result.oneline_after}; "
                f"dropped {result.dropped}"
            ),
        ))
    return operations


def run_compaction(project_root: Path, mode: str = "check") -> list[CompactionOperation]:
    """Shared project-level compaction entry point for check/fix callers."""
    if mode == "check":
        return check_compaction(project_root)
    if mode == "fix":
        return fix_compaction(project_root)
    raise ValueError(f"unknown compaction mode: {mode}")


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


def _compact_todo_entries(entries: list[dict]) -> list[dict]:
    """Compact resolved TODO entries in file order.

    TODO entries use content identity, not generated numeric IDs, so summary text
    such as "Decision 45" must not affect recency. The Resolved section is
    newest-first.
    """
    result: list[dict] = []
    full_count = 0
    oneline_count = 0
    for entry in entries:
        if entry["kind"] == "full" and full_count < MAX_FULL_ENTRIES:
            result.append(entry)
            full_count += 1
            continue

        if oneline_count < MAX_ONELINE_ENTRIES:
            if entry["kind"] == "full":
                result.append({
                    "header": _format_todo_oneline(entry),
                    "body": "",
                    "kind": "oneline",
                })
            else:
                result.append(entry)
            oneline_count += 1
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

    if (
        total_before <= MAX_TOTAL_ENTRIES
        and full_before <= MAX_FULL_ENTRIES
        and oneline_before <= MAX_ONELINE_ENTRIES
    ):
        return CompactResult(full_before, oneline_before, full_before, oneline_before, 0, False)

    compacted = _compact_todo_entries(entries)
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
        or oneline_before > MAX_ONELINE_ENTRIES
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
