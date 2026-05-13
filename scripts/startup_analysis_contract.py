"""Contract, extraction, and reporting for Agentera startup state-access analysis.

The measurement target is deliberately narrow: after a capability-related user
turn, how often does an Agentera CLI state call get followed by raw reads,
greps, or globs of Agentera artifacts before implementation work begins?
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import tomllib
from argparse import ArgumentParser
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
CONTRACT_PATH = REPO_ROOT / "references" / "analysis" / "startup-measurement-contract.yaml"
EXTRACT_CORPUS_PATH = REPO_ROOT / "scripts" / "extract_corpus.py"

TRANSCRIPT_KEYS = frozenset(
    {
        "content",
        "text",
        "prompt",
        "message",
        "preceding_context",
        "input_text",
        "output_text",
        "transcript",
    }
)
SESSION_KEYS = frozenset({"session_id", "sessionID", "sessionId", "conversation_id"})
PATH_KEYS = frozenset({"path", "project_path", "store_path", "file_path", "cwd", "report_path"})
BOUNDARY_DEGRADATION_REASONS = frozenset(
    {
        "pre_boundary_record",
        "missing_timestamp",
        "malformed_record",
        "missing_conversation_key",
        "no_agentera_state_sequence",
        "privacy_redaction_required",
    }
)
STATE_EVENT_CLASSES = frozenset(
    {
        "cli_state_call",
        "raw_artifact_access",
        "capability_prose_read",
        "implementation_boundary",
        "non_state_context",
    }
)
STARTUP_INTERMEDIATE_ENVELOPE = "startup_state_analysis_v1"
STARTUP_METRICS_ENVELOPE = "startup_state_metrics_v1"
STARTUP_REPORT_MARKDOWN = "startup-overhead-report.md"
STARTUP_REPORT_JSON = "startup-overhead-report.json"
BENCHMARK_HISTORY_JSONL = "runs.jsonl"
BENCHMARK_LATEST_REPORT_JSON = "latest-report.json"
BENCHMARK_LATEST_REPORT_MARKDOWN = "latest-report.md"
BOUNDED_RUNTIME_STATUSES = frozenset({"ok", "available", "missing", "sparse", "degraded", "skipped"})
BOUNDED_RUNTIME_REASONS = frozenset(
    {
        "candidate_files_found",
        "disabled",
        "extractor_unimplemented",
        "no_candidate_files",
        "no_runtime_stores_approved",
        "no_matching_records",
        "records_extracted",
        "schema_divergent",
        "store_absent",
        "store_locked",
        "store_not_directory",
        "store_unreadable",
    }
)
RUNTIME_STORE_ARGUMENTS = {
    "codex": "codex_sessions_dir",
    "claude-code": "claude_projects_dir",
    "opencode": "opencode_conversations_dir",
    "github-copilot": "copilot_conversations_dir",
}
STATE_CLI_COMMANDS = frozenset(
    {
        "hej",
        "plan",
        "progress",
        "health",
        "todo",
        "decisions",
        "docs",
        "objective",
        "experiments",
        "query",
    }
)
CLI_COMMAND_ARTIFACTS = {
    "plan": {"PLAN.md"},
    "progress": {"PROGRESS.md"},
    "health": {"HEALTH.md"},
    "todo": {"TODO.md"},
    "decisions": {"DECISIONS.md"},
    "docs": {"DOCS.md"},
    "objective": {"OBJECTIVE.md"},
    "experiments": {"EXPERIMENTS.md"},
    "hej": {"PLAN.md", "PROGRESS.md", "HEALTH.md", "TODO.md", "DOCS.md", "DECISIONS.md"},
}
QUERY_ARTIFACTS = {
    "plan": "PLAN.md",
    "progress": "PROGRESS.md",
    "health": "HEALTH.md",
    "todo": "TODO.md",
    "decisions": "DECISIONS.md",
    "docs": "DOCS.md",
    "session": "SESSION.md",
    "vision": "VISION.md",
    "objective": "OBJECTIVE.md",
    "experiments": "EXPERIMENTS.md",
}
PRIMARY_ROUTE_TO_CAPABILITY = {
    "build": "realisera",
    "plan": "planera",
    "status": "hej",
    "discuss": "resonera",
    "research": "inspirera",
    "optimize": "optimera",
    "audit": "inspektera",
    "document": "dokumentera",
    "profile": "profilera",
    "design": "visualisera",
    "orchestrate": "orkestrera",
    "vision": "visionera",
}
CAPABILITIES = frozenset(PRIMARY_ROUTE_TO_CAPABILITY.values())
CAPABILITIES_WITH_HEJ = CAPABILITIES | {"hej"}
_MARKER_RE = re.compile(
    r"─{2,}\s+(?P<glyph>\S)\s+(?P<capability>[a-z]+era|hej)\s+·\s+"
    r"(?P<word>[a-z]+(?:\s+\d+)?)\s+─{2,}"
)
_BARE_AGENTERA_ROUTE_RE = re.compile(r"(?m)^\s*/agentera(?:\s+(?P<route>[A-Za-z0-9._:-]+))?")
_BARE_CAPABILITY_ROUTE_RE = re.compile(r"(?m)^\s*/(?P<route>[a-z]+era|hej)(?:\s|$)")
_XML_ROUTE_RE = re.compile(r"<command-name>\s*/(?:agentera\s+)?(?P<route>[A-Za-z0-9._:-]+)\s*</command-name>")


def load_contract(path: Path = CONTRACT_PATH) -> dict[str, Any]:
    """Load the startup measurement contract from YAML."""

    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"contract must be a mapping: {path}")
    return data


def hash_label(kind: str, value: object, *, salt: str) -> str:
    """Return a salted, non-reconstructable label for private values."""

    if not salt:
        raise ValueError("salt is required for private labels")
    digest = hashlib.sha256(f"{salt}\0{value}".encode("utf-8")).hexdigest()[:16]
    return f"{kind}:{digest}"


def canonical_artifact_label(value: object, contract: dict[str, Any] | None = None) -> str | None:
    """Return a contract label for a known Agentera artifact path or name."""

    text = str(value).replace("\\", "/")
    labels = ((contract or load_contract()).get("privacy_boundary") or {}).get(
        "canonical_artifact_labels", {}
    )
    if isinstance(labels, dict):
        for suffix, label in labels.items():
            normalized = str(suffix).replace("\\", "/")
            if text == normalized or text.endswith("/" + normalized) or normalized in text:
                return str(label)
    mapped = {
        ".agentera/plan.yaml": "PLAN.md",
        ".agentera/progress.yaml": "PROGRESS.md",
        ".agentera/docs.yaml": "DOCS.md",
        ".agentera/decisions.yaml": "DECISIONS.md",
        ".agentera/health.yaml": "HEALTH.md",
        ".agentera/session.yaml": "SESSION.md",
        ".agentera/vision.yaml": "VISION.md",
        ".agentera/objective.yaml": "OBJECTIVE.md",
        ".agentera/experiments.yaml": "EXPERIMENTS.md",
    }
    for suffix, label in mapped.items():
        if text == suffix or text.endswith("/" + suffix) or suffix in text:
            return label
    if ".agentera/" in text:
        return "AGENTERA_ARTIFACTS"
    return None


def redact_for_startup_output(value: Any, *, salt: str, contract: dict[str, Any] | None = None) -> Any:
    """Redact nested analysis output according to the startup privacy boundary."""

    loaded = contract or load_contract()
    if isinstance(value, list):
        return [redact_for_startup_output(item, salt=salt, contract=loaded) for item in value]
    if not isinstance(value, dict):
        return value

    redacted: dict[str, Any] = {}
    for key, item in value.items():
        key_text = str(key)
        if key_text in TRANSCRIPT_KEYS:
            redacted[key_text] = "<redacted:transcript_text>"
        elif key_text in SESSION_KEYS:
            redacted[key_text] = hash_label("session", item, salt=salt)
        elif key_text in PATH_KEYS:
            label = canonical_artifact_label(item, loaded)
            redacted[key_text] = label or hash_label("path", item, salt=salt)
        else:
            redacted[key_text] = redact_for_startup_output(item, salt=salt, contract=loaded)
    return redacted


def _conversation_key(record: dict[str, Any]) -> str | None:
    key = record.get("conversation_key")
    if isinstance(key, str) and key:
        return key
    sid = record.get("session_id")
    if isinstance(sid, str) and sid:
        return sid
    data = record.get("data")
    if isinstance(data, dict):
        sid = data.get("session_id")
        if isinstance(sid, str) and sid:
            return sid
    sid = record.get("source_id")
    if isinstance(sid, str) and sid:
        return sid
    return None


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    text = value.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _timestamp_utc(value: object) -> datetime | None:
    timestamp = _parse_timestamp(value)
    if timestamp is None:
        return None
    if timestamp.tzinfo is None:
        return timestamp.replace(tzinfo=UTC)
    return timestamp.astimezone(UTC)


def _format_timestamp(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.astimezone(UTC).isoformat(timespec="seconds")


def _max_record_timestamp(records: list[Any], *, after: datetime | None = None) -> datetime | None:
    latest: datetime | None = None
    for record in records:
        if not isinstance(record, dict):
            continue
        timestamp = _timestamp_utc(record.get("timestamp"))
        if timestamp is None:
            continue
        if after is not None and timestamp <= after:
            continue
        if latest is None or timestamp > latest:
            latest = timestamp
    return latest


def _record_label(record: dict[str, Any], *, salt: str) -> str:
    return hash_label("record", record.get("source_id") or id(record), salt=salt)


def _extract_text(record: dict[str, Any]) -> str:
    data = record.get("data")
    if isinstance(data, dict):
        value = data.get("content") or data.get("text") or data.get("message") or data.get("prompt")
        return value if isinstance(value, str) else ""
    return ""


def _has_transcript_bearing_field(record: dict[str, Any]) -> bool:
    if "transcript" in record:
        return True
    data = record.get("data")
    return isinstance(data, dict) and "transcript" in data


def _intro_capability(text: str) -> str | None:
    for match in _MARKER_RE.finditer(text):
        word = match.group("word")
        if word not in {"complete", "flagged", "stuck", "waiting"}:
            return match.group("capability")
    return None


def _route_capability(text: str) -> str | None:
    match = _XML_ROUTE_RE.search(text)
    if match:
        route = match.group("route").lower()
        return route if route in CAPABILITIES_WITH_HEJ else PRIMARY_ROUTE_TO_CAPABILITY.get(route)
    match = _BARE_AGENTERA_ROUTE_RE.search(text)
    if match:
        route = (match.group("route") or "status").lower()
        return route if route in CAPABILITIES_WITH_HEJ else PRIMARY_ROUTE_TO_CAPABILITY.get(route)
    match = _BARE_CAPABILITY_ROUTE_RE.search(text)
    if match:
        return match.group("route").lower()
    return None


def _capability_invocation(text: str) -> str | None:
    route = _route_capability(text)
    if route:
        return route
    marker = _intro_capability(text)
    if marker:
        return marker
    lowered = text.lower()
    for capability in sorted(CAPABILITIES_WITH_HEJ):
        if re.search(rf"\b{re.escape(capability)}\b", lowered):
            return capability
    if "agentera" in lowered:
        return "agentera"
    return None


def _tool_name(record: dict[str, Any]) -> str:
    data = record.get("data")
    values = [record.get("tool"), record.get("tool_name"), record.get("name")]
    if isinstance(data, dict):
        values.extend([data.get("tool"), data.get("tool_name"), data.get("name")])
    for value in values:
        if isinstance(value, str) and value:
            return value
    return ""


def _tool_arguments(record: dict[str, Any]) -> dict[str, Any]:
    data = record.get("data")
    if isinstance(data, dict):
        arguments = data.get("arguments")
        if isinstance(arguments, dict):
            return arguments
        if isinstance(arguments, str):
            try:
                parsed = json.loads(arguments)
            except json.JSONDecodeError:
                return {"raw": arguments}
            return parsed if isinstance(parsed, dict) else {"value": parsed}
        return data
    return record


def _tool_argument(record: dict[str, Any], *keys: str) -> str:
    args = _tool_arguments(record)
    candidates = [args.get(key) for key in keys]
    candidates.extend(record.get(key) for key in keys)
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    return ""


def _arguments_text(record: dict[str, Any]) -> str:
    try:
        return json.dumps(_tool_arguments(record), sort_keys=True)
    except TypeError:
        return str(_tool_arguments(record))


def _state_cli_command(command: str) -> str | None:
    if not command:
        return None
    tokens = command.replace("\"", " ").replace("'", " ").split()
    for index, token in enumerate(tokens[:-1]):
        if token.endswith("agentera") and tokens[index + 1] in STATE_CLI_COMMANDS:
            return tokens[index + 1]
    return None


def _state_cli_artifacts(command: str, state_command: str) -> set[str]:
    if state_command == "query":
        tokens = command.replace("\"", " ").replace("'", " ").split()
        for index, token in enumerate(tokens[:-1]):
            if token.endswith("agentera") and tokens[index + 1] == "query":
                for arg in tokens[index + 2 :]:
                    label = QUERY_ARTIFACTS.get(arg.lower())
                    if label:
                        return {label}
                return set()
    return set(CLI_COMMAND_ARTIFACTS.get(state_command, set()))


def classify_startup_event(record: dict[str, Any]) -> tuple[str, str | None, str | None, set[str]]:
    """Classify one record into the state-access measurement vocabulary."""

    if not isinstance(record, dict) or record.get("source_kind") != "tool_call":
        return "non_state_context", None, None, set()
    tool = _tool_name(record)
    command = _tool_argument(record, "command")
    if tool == "bash":
        state_command = _state_cli_command(command)
        if state_command:
            return "cli_state_call", None, state_command, _state_cli_artifacts(command, state_command)
        return "implementation_boundary", None, None, set()

    arguments_text = _arguments_text(record).replace("\\", "/")
    if tool in {"read", "grep", "glob"} and (
        "skills/agentera/capabilities/" in arguments_text
        or "skills/agentera/SKILL.md" in arguments_text
        or "skills/agentera/protocol.yaml" in arguments_text
    ):
        return "capability_prose_read", "SKILL.md" if "SKILL.md" in arguments_text else None, None, set()
    artifact_label = canonical_artifact_label(arguments_text) if tool in {"read", "grep", "glob"} else None
    if artifact_label:
        return "raw_artifact_access", artifact_label, None, set()
    if tool in {"apply_patch", "edit", "write"}:
        return "implementation_boundary", None, None, set()
    return "non_state_context", None, None, set()


def _bounded_reason(reason: str, contract: dict[str, Any]) -> str:
    allowed = set(contract.get("degradation_reasons") or []) | BOUNDARY_DEGRADATION_REASONS
    return reason if reason in allowed else "malformed_record"


def _event_output(
    record: dict[str, Any],
    *,
    event_class: str,
    phase: str,
    salt: str,
    artifact_label: str | None = None,
    state_command: str | None = None,
    redundant_with_cli: bool | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "record": _record_label(record, salt=salt),
        "event_class": event_class if event_class in STATE_EVENT_CLASSES else "non_state_context",
        "phase": phase,
    }
    if artifact_label:
        item["artifact_label"] = artifact_label
    if state_command:
        item["state_command"] = state_command
    if redundant_with_cli is not None:
        item["redundant_with_cli"] = redundant_with_cli
    return item


def _new_sequence(conversation_key: str, capability: str | None, salt: str) -> dict[str, Any]:
    return {
        "conversation": hash_label("session", conversation_key, salt=salt),
        "capability": capability or "unknown",
        "start_anchor": "first_cli_state_call_after_capability_invocation",
        "events": [],
        "counts": {event_class: 0 for event_class in sorted(STATE_EVENT_CLASSES)},
        "cli_artifact_labels": [],
        "raw_artifact_labels_after_cli": [],
        "redundant_raw_artifact_labels": [],
        "degradation_reasons": [],
    }


def classify_startup_records(
    corpus: dict[str, Any],
    *,
    salt: str,
    contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Classify records into Agentera startup state-gathering sequences.

    A sequence starts at the first Agentera CLI state call after an
    Agentera/capability-related user turn. Raw artifact reads, greps, and globs
    after that call are counted until implementation work or the next user turn.
    """

    loaded = contract or load_contract()
    boundary = _timestamp_utc((loaded.get("boundary") or {}).get("committed_at"))
    records = corpus.get("records", []) if isinstance(corpus, dict) else []
    degradations: list[dict[str, Any]] = []
    groups: dict[str, list[dict[str, Any]]] = {}
    for record in records:
        if not isinstance(record, dict):
            degradations.append({"reason": _bounded_reason("malformed_record", loaded)})
            continue
        if _has_transcript_bearing_field(record):
            degradations.append({"record": _record_label(record, salt=salt), "reason": "privacy_redaction_required"})
            continue
        timestamp = _timestamp_utc(record.get("timestamp"))
        if timestamp is None:
            degradations.append({"record": _record_label(record, salt=salt), "reason": "missing_timestamp"})
            continue
        if boundary is not None and timestamp <= boundary:
            degradations.append({"record": _record_label(record, salt=salt), "reason": "pre_boundary_record"})
            continue
        key = _conversation_key(record)
        if key is None:
            degradations.append({"record": _record_label(record, salt=salt), "reason": "missing_conversation_key"})
            continue
        groups.setdefault(key, []).append(record)

    sequences: list[dict[str, Any]] = []
    for conversation_key, items in groups.items():
        items.sort(key=lambda item: item.get("timestamp", ""))
        active: dict[str, Any] | None = None
        segment_capability: str | None = None
        segment_open = False
        segment_had_state_sequence = False
        cli_artifacts_seen: set[str] = set()

        def close_active() -> None:
            nonlocal active, segment_had_state_sequence, cli_artifacts_seen
            if active is not None:
                active["cli_artifact_labels"] = sorted(cli_artifacts_seen)
                sequences.append(active)
                segment_had_state_sequence = True
                active = None
                cli_artifacts_seen = set()

        for record in items:
            text = _extract_text(record)
            data = record.get("data") if isinstance(record.get("data"), dict) else {}
            actor = data.get("actor") if isinstance(data, dict) else None
            if actor == "user":
                close_active()
                if segment_open and not segment_had_state_sequence:
                    degradations.append(
                        {
                            "conversation": hash_label("session", conversation_key, salt=salt),
                            "reason": "no_agentera_state_sequence",
                        }
                    )
                segment_capability = _capability_invocation(text)
                segment_open = segment_capability is not None
                segment_had_state_sequence = False
                continue

            if not segment_open:
                intro_capability = _intro_capability(text) if actor == "assistant" else None
                if intro_capability:
                    segment_capability = intro_capability
                    segment_open = True
                else:
                    continue

            event_class, artifact_label, state_command, cli_artifact_labels = classify_startup_event(record)
            if event_class == "non_state_context":
                continue
            if event_class == "cli_state_call" and active is None:
                active = _new_sequence(conversation_key, segment_capability, salt)
            if active is None:
                continue
            if event_class == "cli_state_call":
                cli_artifacts_seen.update(cli_artifact_labels)
            redundant = (
                artifact_label in cli_artifacts_seen
                if event_class == "raw_artifact_access" and artifact_label
                else None
            )
            phase = "implementation_boundary" if event_class == "implementation_boundary" else "state_gathering"
            active["counts"][event_class] += 1
            active["events"].append(
                _event_output(
                    record,
                    event_class=event_class,
                    phase=phase,
                    salt=salt,
                    artifact_label=artifact_label,
                    state_command=state_command,
                    redundant_with_cli=redundant,
                )
            )
            if event_class == "raw_artifact_access" and artifact_label:
                active["raw_artifact_labels_after_cli"].append(artifact_label)
                if redundant:
                    active["redundant_raw_artifact_labels"].append(artifact_label)
            if event_class == "implementation_boundary":
                close_active()
                segment_open = False
                segment_capability = None
                segment_had_state_sequence = False
        close_active()
        if segment_open and not segment_had_state_sequence:
            degradations.append(
                {
                    "conversation": hash_label("session", conversation_key, salt=salt),
                    "reason": "no_agentera_state_sequence",
                }
            )
    return {
        "contract_version": loaded.get("version"),
        "boundary_source": (loaded.get("boundary") or {}).get("source"),
        "state_gathering_sequences": sequences,
        "degradations": degradations,
    }


def _bounded_runtime_status(status: dict[str, Any]) -> dict[str, Any]:
    runtime = str(status.get("runtime") or "unknown")
    state = str(status.get("status") or "degraded")
    reason = str(status.get("reason") or "schema_divergent")
    item: dict[str, Any] = {
        "runtime": runtime,
        "status": state if state in BOUNDED_RUNTIME_STATUSES else "degraded",
        "reason": reason if reason in BOUNDED_RUNTIME_REASONS else "schema_divergent",
    }
    for key in ("candidate_count", "record_count", "error_count"):
        value = status.get(key)
        if isinstance(value, int):
            item[key] = value
    labels = status.get("remediation_labels")
    if isinstance(labels, list):
        item["remediation_labels"] = [str(label) for label in labels]
    return item


def _runtime_record_counts(records: list[Any]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for record in records:
        if isinstance(record, dict) and isinstance(record.get("runtime"), str):
            counts[record["runtime"]] += 1
    return dict(sorted(counts.items()))


def _records_after(records: list[Any], started_after: datetime | None) -> list[Any]:
    if started_after is None:
        return records
    filtered = []
    for record in records:
        if not isinstance(record, dict):
            continue
        timestamp = _timestamp_utc(record.get("timestamp"))
        if timestamp is not None and timestamp > started_after:
            filtered.append(record)
    return filtered


def _corpus_after(corpus: dict[str, Any], started_after: datetime | None) -> tuple[dict[str, Any], datetime | None]:
    records = corpus.get("records", []) if isinstance(corpus, dict) else []
    if not isinstance(records, list):
        records = []
    filtered_records = _records_after(records, started_after)
    metadata = dict(corpus.get("metadata") or {}) if isinstance(corpus.get("metadata"), dict) else {}
    runtime_counts = _runtime_record_counts(filtered_records)
    statuses = metadata.get("runtime_statuses")
    if isinstance(statuses, list):
        updated_statuses = []
        for status in statuses:
            if not isinstance(status, dict):
                continue
            updated = dict(status)
            runtime = updated.get("runtime")
            if isinstance(runtime, str) and "record_count" in updated:
                updated["record_count"] = runtime_counts.get(runtime, 0)
            updated_statuses.append(updated)
        metadata["runtime_statuses"] = updated_statuses
    filtered_corpus = dict(corpus)
    filtered_corpus["metadata"] = metadata
    filtered_corpus["records"] = filtered_records
    return filtered_corpus, _max_record_timestamp(filtered_records)


def _artifact_label_counts(sequences: list[dict[str, Any]]) -> dict[str, int]:
    counts: Counter[str] = Counter()
    for sequence in sequences:
        for event in sequence.get("events", []):
            if isinstance(event, dict) and isinstance(event.get("artifact_label"), str):
                counts[event["artifact_label"]] += 1
    return dict(sorted(counts.items()))


def _counter_dict(counter: Counter[str]) -> dict[str, int]:
    return dict(sorted(counter.items()))


def _sequence_count(sequence: dict[str, Any], event_class: str) -> int:
    counts = sequence.get("counts")
    if isinstance(counts, dict) and isinstance(counts.get(event_class), int):
        return counts[event_class]
    return sum(
        1
        for event in sequence.get("events", [])
        if isinstance(event, dict) and event.get("event_class") == event_class
    )


def _distribution(values: list[int]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "min": 0, "max": 0, "mean": 0, "p50": 0, "p75": 0, "histogram": {}}
    ordered = sorted(values)

    def percentile(fraction: float) -> int:
        index = min(len(ordered) - 1, math.ceil((len(ordered) * fraction) - 1))
        return ordered[max(index, 0)]

    return {
        "count": len(ordered),
        "min": ordered[0],
        "max": ordered[-1],
        "mean": round(sum(ordered) / len(ordered), 2),
        "p50": percentile(0.50),
        "p75": percentile(0.75),
        "histogram": {str(value): count for value, count in sorted(Counter(ordered).items())},
    }


def _derive_state_thresholds(
    *,
    total_sequences: int,
    per_capability: dict[str, dict[str, int]],
    raw_after_cli_per_sequence: list[int],
    redundant_raw_per_sequence: list[int],
    redundant_counts: Counter[str],
    redundant_capabilities: dict[str, set[str]],
    confidence_caveats: list[str],
) -> dict[str, Any]:
    capability_count = len(per_capability)
    credible_distribution = total_sequences >= 3
    raw_distribution = _distribution(raw_after_cli_per_sequence)
    redundant_distribution = _distribution(redundant_raw_per_sequence)
    redundant_artifacts = {
        label: {
            "count": count,
            "capability_count": len(redundant_capabilities.get(label, set())),
        }
        for label, count in sorted(redundant_counts.items())
        if count > 0
    }
    redundant_sequence_count = sum(1 for value in redundant_raw_per_sequence if value > 0)
    aggregate_redundant_capabilities = set().union(*redundant_capabilities.values()) if redundant_capabilities else set()
    if credible_distribution:
        redundant_sequence_threshold = max(2, math.ceil(total_sequences * 0.20))
        threshold_reason = (
            "Selected from post-boundary state-gathering distribution: raw artifact "
            "access after CLI state must recur in at least 20% of measured sequences, "
            "with a floor of two sequences."
        )
    else:
        redundant_sequence_threshold = None
        threshold_reason = "No broad-envelope threshold: fewer than three state-gathering sequences were measured."

    broad_trigger: dict[str, Any] | None = None
    if credible_distribution:
        for label, item in redundant_artifacts.items():
            if item["count"] >= redundant_sequence_threshold and item["capability_count"] >= 2:
                broad_trigger = {
                    "event_class": "raw_artifact_access",
                    "artifact_label": label,
                    "count": item["count"],
                    "capability_count": item["capability_count"],
                    "threshold": redundant_sequence_threshold,
                }
                break
        if broad_trigger is None and redundant_sequence_count >= redundant_sequence_threshold:
            broad_trigger = {
                "event_class": "raw_artifact_access",
                "artifact_label": "multiple",
                "count": redundant_sequence_count,
                "capability_count": len(aggregate_redundant_capabilities),
                "threshold": redundant_sequence_threshold,
                "aggregate": True,
            }

    if broad_trigger is not None:
        trigger = (
            f"redundant_raw_artifact_access in {broad_trigger['count']} of {total_sequences} state sequences"
            if broad_trigger.get("aggregate")
            else (
                f"raw_artifact_access_after_cli:{broad_trigger['artifact_label']} repeated "
                f"{broad_trigger['count']} times across {broad_trigger['capability_count']} capabilities"
            )
        )
        recommendation = {
            "action": "plan_cli_startup_envelope",
            "measured_trigger": trigger,
            "rationale": "Raw artifact access after CLI state exceeded the broad startup-envelope threshold.",
        }
    elif redundant_artifacts:
        recommendation = {
            "action": "targeted_capability_guidance_fixes",
            "measured_trigger": "raw_artifact_access_after_cli_hotspot",
            "rationale": "Raw artifact access follows CLI state, but evidence is narrow or below the broad-envelope gate.",
        }
    else:
        recommendation = {
            "action": "close_without_implementation",
            "measured_trigger": "none",
            "rationale": "No raw artifact access after overlapping CLI state was measured.",
        }
    if "insufficient_post_2_3_state_sequences" in confidence_caveats:
        recommendation = {
            "action": "close_without_implementation",
            "measured_trigger": "weak_evidence",
            "rationale": "No post-boundary Agentera state-gathering sequences were available.",
        }

    return {
        "measured_distribution": {
            "raw_after_cli_per_sequence": raw_distribution,
            "redundant_raw_after_cli_per_sequence": redundant_distribution,
            "redundant_sequence_count": redundant_sequence_count,
            "redundant_artifacts": redundant_artifacts,
            "capability_count": capability_count,
        },
        "action_thresholds": {
            "startup_envelope": {
                "credible": credible_distribution,
                "redundant_sequence_threshold": redundant_sequence_threshold,
                "selection_reason": threshold_reason,
            },
            "targeted_guidance": {
                "credible": bool(redundant_artifacts),
                "selection_reason": "Selected when raw artifact access after CLI state is narrow or below the broad-envelope threshold.",
            },
        },
        "recommendation": recommendation,
    }


def aggregate_startup_metrics(intermediate: dict[str, Any]) -> dict[str, Any]:
    """Aggregate ``startup_state_analysis_v1`` into the corrected metric report."""

    if not isinstance(intermediate, dict):
        intermediate = {}
    sequences = intermediate.get("state_gathering_sequences")
    if not isinstance(sequences, list):
        sequences = []
    degradations = intermediate.get("degradations")
    if not isinstance(degradations, list):
        degradations = []

    per_capability: dict[str, dict[str, int]] = {}
    cli_command_counts: Counter[str] = Counter()
    raw_after_cli_counts: Counter[str] = Counter()
    redundant_raw_counts: Counter[str] = Counter()
    prose_counts: Counter[str] = Counter()
    implementation_counts: Counter[str] = Counter()
    degradation_counts: Counter[str] = Counter()
    redundant_capabilities: dict[str, set[str]] = {}
    raw_after_cli_per_sequence: list[int] = []
    redundant_raw_per_sequence: list[int] = []

    for item in degradations:
        if isinstance(item, dict) and isinstance(item.get("reason"), str):
            degradation_counts[item["reason"]] += 1

    for sequence in sequences:
        if not isinstance(sequence, dict):
            continue
        capability = sequence.get("capability")
        if not isinstance(capability, str) or not capability:
            capability = "unknown"
        capability_counts = per_capability.setdefault(
            capability,
            {
                "state_sequences": 0,
                "cli_state_call": 0,
                "raw_artifact_access_after_cli": 0,
                "redundant_raw_artifact_access": 0,
                "capability_prose_read": 0,
                "implementation_boundary": 0,
            },
        )
        capability_counts["state_sequences"] += 1
        cli_count = _sequence_count(sequence, "cli_state_call")
        raw_count = len(sequence.get("raw_artifact_labels_after_cli") or [])
        redundant_count = len(sequence.get("redundant_raw_artifact_labels") or [])
        prose_count = _sequence_count(sequence, "capability_prose_read")
        impl_count = _sequence_count(sequence, "implementation_boundary")
        capability_counts["cli_state_call"] += cli_count
        capability_counts["raw_artifact_access_after_cli"] += raw_count
        capability_counts["redundant_raw_artifact_access"] += redundant_count
        capability_counts["capability_prose_read"] += prose_count
        capability_counts["implementation_boundary"] += impl_count
        prose_counts[capability] += prose_count
        implementation_counts[capability] += impl_count
        raw_after_cli_per_sequence.append(raw_count)
        redundant_raw_per_sequence.append(redundant_count)

        for event in sequence.get("events", []):
            if not isinstance(event, dict):
                continue
            state_command = event.get("state_command")
            if event.get("event_class") == "cli_state_call" and isinstance(state_command, str):
                cli_command_counts[state_command] += 1
            label = event.get("artifact_label")
            if event.get("event_class") == "raw_artifact_access" and isinstance(label, str):
                raw_after_cli_counts[label] += 1
                if event.get("redundant_with_cli") is True:
                    redundant_raw_counts[label] += 1
                    redundant_capabilities.setdefault(label, set()).add(capability)
        for reason in sequence.get("degradation_reasons", []):
            if isinstance(reason, str):
                degradation_counts[reason] += 1

    total_sequences = len([sequence for sequence in sequences if isinstance(sequence, dict)])
    runtime_coverage = intermediate.get("runtime_coverage")
    if not isinstance(runtime_coverage, list):
        runtime_coverage = []
    runtime_coverage = [_bounded_runtime_status(status) for status in runtime_coverage if isinstance(status, dict)]
    runtime_status_counts: Counter[str] = Counter()
    for status in runtime_coverage:
        if isinstance(status, dict) and isinstance(status.get("status"), str):
            runtime_status_counts[status["status"]] += 1

    confidence_caveats: list[str] = []
    if total_sequences == 0:
        confidence_caveats.append("insufficient_post_2_3_state_sequences")
    if any(
        isinstance(status, dict) and status.get("status") in {"missing", "sparse", "degraded", "skipped"}
        for status in runtime_coverage
    ):
        confidence_caveats.append("runtime_coverage_incomplete_or_degraded")
    if degradation_counts:
        confidence_caveats.append("some_records_or_sequences_degraded")

    threshold_derivation = _derive_state_thresholds(
        total_sequences=total_sequences,
        per_capability=per_capability,
        raw_after_cli_per_sequence=raw_after_cli_per_sequence,
        redundant_raw_per_sequence=redundant_raw_per_sequence,
        redundant_counts=redundant_raw_counts,
        redundant_capabilities=redundant_capabilities,
        confidence_caveats=confidence_caveats,
    )
    sequences_with_raw = sum(1 for value in raw_after_cli_per_sequence if value > 0)
    sequences_with_redundant = sum(1 for value in redundant_raw_per_sequence if value > 0)
    recommendation = threshold_derivation["recommendation"]
    result = {
        "output_envelope": STARTUP_METRICS_ENVELOPE,
        "input_envelope": intermediate.get("output_envelope"),
        "contract_version": intermediate.get("contract_version"),
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "boundary_source": intermediate.get("boundary_source"),
        "boundary_commit": intermediate.get("boundary_commit"),
        "boundary_committed_at": intermediate.get("boundary_committed_at"),
        "benchmark_mode": intermediate.get("benchmark_mode") or "full_boundary_snapshot",
        "benchmark_previous_watermark_at": intermediate.get("benchmark_previous_watermark_at"),
        "benchmark_window_started_after": intermediate.get("benchmark_window_started_after"),
        "benchmark_watermark_at": intermediate.get("benchmark_watermark_at"),
        "corpus_adapter_version": intermediate.get("corpus_adapter_version"),
        "runtime_coverage": runtime_coverage,
        "runtime_status_counts": _counter_dict(runtime_status_counts),
        "runtime_record_counts": intermediate.get("runtime_record_counts") or {},
        "total_records": _safe_int(intermediate.get("total_records_read")),
        "total_state_sequences": total_sequences,
        "state_sequences_with_raw_after_cli": sequences_with_raw,
        "state_sequences_with_redundant_raw_access": sequences_with_redundant,
        "total_cli_state_calls": sum(cli_command_counts.values()),
        "total_raw_artifact_access_after_cli": sum(raw_after_cli_counts.values()),
        "total_redundant_raw_artifact_accesses": sum(redundant_raw_counts.values()),
        "raw_after_cli_sequence_rate": round(sequences_with_raw / total_sequences, 4) if total_sequences else 0,
        "redundant_raw_sequence_rate": round(sequences_with_redundant / total_sequences, 4) if total_sequences else 0,
        "per_capability_state_counts": dict(sorted(per_capability.items())),
        "cli_state_command_counts": _counter_dict(cli_command_counts),
        "raw_artifact_access_after_cli_counts": _counter_dict(raw_after_cli_counts),
        "redundant_raw_artifact_access_counts": _counter_dict(redundant_raw_counts),
        "capability_prose_read_counts": _counter_dict(prose_counts),
        "implementation_boundary_counts": _counter_dict(implementation_counts),
        "degradation_reason_counts": _counter_dict(degradation_counts),
        "privacy_redaction_summary": {
            "raw_transcript_text": "not_emitted",
            "full_local_paths": "not_emitted",
            "raw_store_paths": "not_emitted",
            "session_ids": "salted_or_not_emitted",
            "artifact_labels": "canonical_only",
        },
        "confidence_caveats": confidence_caveats,
        "insufficient_evidence_reason": "no_post_2_3_state_sequences" if total_sequences == 0 else None,
        "threshold_derivation": threshold_derivation,
        "startup_recommendation": recommendation,
        "implementation_recommended": recommendation["action"] == "plan_cli_startup_envelope",
        "compatibility_note": "Section 22 corpus records are read-only; aggregation consumes only startup_state_analysis_v1.",
    }
    if total_sequences:
        result["recommendation_gate_input"] = threshold_derivation["measured_distribution"]
    return result


def _markdown_table(headers: list[str], rows: list[list[object]]) -> list[str]:
    lines = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    if not rows:
        return lines + ["| " + " | ".join("none" for _ in headers) + " |"]
    return lines + ["| " + " | ".join(str(value) for value in row) + " |" for row in rows]


def render_startup_report(metrics: dict[str, Any]) -> str:
    """Render privacy-preserving startup state-access metrics for human review."""

    threshold = (metrics.get("threshold_derivation") or {}).get("action_thresholds") or {}
    envelope_threshold = threshold.get("startup_envelope") or {}
    guidance_threshold = threshold.get("targeted_guidance") or {}
    recommendation = metrics.get("startup_recommendation") or {}
    measured_distribution = (metrics.get("threshold_derivation") or {}).get("measured_distribution") or {}
    runtime_coverage = metrics.get("runtime_coverage") if isinstance(metrics.get("runtime_coverage"), list) else []
    capability_counts = metrics.get("per_capability_state_counts") or {}

    lines = [
        "# Agentera Startup State-Access Analysis",
        "",
        "This report is local-only and privacy-preserving. It measures raw Agentera artifact access after CLI state calls during capability startup/state gathering.",
        "",
        "## Boundary Source",
        "",
        f"- Contract version: `{metrics.get('contract_version')}`",
        f"- Boundary source: `{metrics.get('boundary_source')}`",
        f"- Boundary commit: `{metrics.get('boundary_commit')}`",
        f"- Boundary timestamp: `{metrics.get('boundary_committed_at')}`",
        f"- Corpus adapter version: `{metrics.get('corpus_adapter_version')}`",
        "",
        "## Benchmark Window",
        "",
        f"- Mode: `{metrics.get('benchmark_mode')}`",
        f"- Previous watermark: `{metrics.get('benchmark_previous_watermark_at')}`",
        f"- Window started after: `{metrics.get('benchmark_window_started_after')}`",
        f"- Watermark: `{metrics.get('benchmark_watermark_at')}`",
        "",
        "## Runtime Coverage",
        "",
    ]
    runtime_rows = []
    for status in runtime_coverage:
        if isinstance(status, dict):
            runtime_rows.append(
                [
                    status.get("runtime", "unknown"),
                    status.get("status", "unknown"),
                    status.get("reason", "unknown"),
                    status.get("record_count", 0),
                    status.get("candidate_count", 0),
                    status.get("error_count", 0),
                ]
            )
    lines.extend(_markdown_table(["Runtime", "Status", "Reason", "Records", "Candidates", "Errors"], runtime_rows))
    lines.extend(
        [
            "",
            "## Metrics",
            "",
            f"- Total state-gathering sequences: `{metrics.get('total_state_sequences')}`",
            f"- Sequences with raw artifact access after CLI: `{metrics.get('state_sequences_with_raw_after_cli')}`",
            f"- Sequences with redundant raw artifact access: `{metrics.get('state_sequences_with_redundant_raw_access')}`",
            f"- Raw-after-CLI sequence rate: `{metrics.get('raw_after_cli_sequence_rate')}`",
            f"- Redundant raw sequence rate: `{metrics.get('redundant_raw_sequence_rate')}`",
            f"- CLI state command counts: `{json.dumps(metrics.get('cli_state_command_counts') or {}, sort_keys=True)}`",
            f"- Raw artifact access after CLI counts: `{json.dumps(metrics.get('raw_artifact_access_after_cli_counts') or {}, sort_keys=True)}`",
            f"- Redundant raw artifact access counts: `{json.dumps(metrics.get('redundant_raw_artifact_access_counts') or {}, sort_keys=True)}`",
            "",
        ]
    )
    capability_rows = [
        [
            capability,
            counts.get("state_sequences", 0),
            counts.get("cli_state_call", 0),
            counts.get("raw_artifact_access_after_cli", 0),
            counts.get("redundant_raw_artifact_access", 0),
            counts.get("capability_prose_read", 0),
        ]
        for capability, counts in sorted(capability_counts.items())
        if isinstance(counts, dict)
    ]
    lines.extend(
        _markdown_table(
            ["Capability", "Sequences", "CLI Calls", "Raw After CLI", "Redundant Raw", "Prose Reads"],
            capability_rows,
        )
    )
    lines.extend(
        [
            "",
            "## Threshold Rationale",
            "",
            f"- Startup envelope threshold credible: `{envelope_threshold.get('credible')}`",
            f"- Redundant-sequence threshold: `{envelope_threshold.get('redundant_sequence_threshold')}`",
            f"- Startup envelope selection reason: {envelope_threshold.get('selection_reason')}",
            f"- Targeted-guidance selection reason: {guidance_threshold.get('selection_reason')}",
            f"- Measured distribution: `{json.dumps(measured_distribution, sort_keys=True)}`",
            "",
            "## Recommendation",
            "",
            f"- Action: `{recommendation.get('action')}`",
            f"- Measured trigger: `{recommendation.get('measured_trigger')}`",
            f"- Rationale: {recommendation.get('rationale')}",
            f"- Implementation recommended: `{metrics.get('implementation_recommended')}`",
            "",
            "## Privacy Caveats",
            "",
            "- Raw transcript text is not emitted.",
            "- Full local paths and raw store paths are not emitted.",
            "- Session identifiers are salted or omitted.",
            "- Raw artifact accesses use canonical artifact labels such as `PLAN.md`, not filesystem paths.",
            "- Runtime coverage may be incomplete or degraded; inspect `confidence_caveats` before selecting follow-up work.",
            "",
        ]
    )
    return "\n".join(lines)


def write_startup_reports(metrics: dict[str, Any], output_dir: Path) -> dict[str, str]:
    """Write structured and human-readable startup reports."""

    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / STARTUP_REPORT_JSON
    markdown_path = output_dir / STARTUP_REPORT_MARKDOWN
    json_path.write_text(json.dumps(metrics, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    markdown_path.write_text(render_startup_report(metrics), encoding="utf-8")
    return {"structured": str(json_path), "human_readable": str(markdown_path)}


def default_agentera_home() -> Path:
    """Return the Agentera data home used for local benchmark history."""

    override = os.environ.get("AGENTERA_HOME")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "agentera"
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))
        return Path(appdata) / "agentera"
    xdg = os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))
    return Path(xdg) / "agentera"


def default_startup_benchmark_dir() -> Path:
    """Return the default user-local startup state benchmark directory."""

    return default_agentera_home() / "benchmarks" / "startup-state"


def _agentera_version() -> str:
    try:
        data = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError):
        return "unknown"
    project = data.get("project")
    if isinstance(project, dict) and isinstance(project.get("version"), str):
        return project["version"]
    return "unknown"


def _git_output(args: list[str]) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=REPO_ROOT,
            text=True,
            capture_output=True,
            check=False,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def _git_metadata() -> dict[str, Any]:
    commit = _git_output(["rev-parse", "HEAD"]) or "unknown"
    status = _git_output(["status", "--porcelain"])
    return {"git_commit": commit, "git_dirty": bool(status) if status is not None else None}


def _runtime_scope(metrics: dict[str, Any], approved_scope: list[str] | None = None) -> list[str]:
    if approved_scope:
        return sorted({str(label) for label in approved_scope if label})
    labels = set()
    for item in metrics.get("runtime_coverage") or []:
        if isinstance(item, dict) and isinstance(item.get("runtime"), str):
            labels.add(item["runtime"])
    runtime_counts = metrics.get("runtime_record_counts")
    if isinstance(runtime_counts, dict):
        labels.update(str(label) for label in runtime_counts if label)
    return sorted(labels) or ["unknown"]


def _runtime_scope_matches(row: dict[str, Any], runtime_scope: list[str]) -> bool:
    value = row.get("runtime_scope")
    if not isinstance(value, list):
        return False
    return sorted(str(label) for label in value) == sorted(str(label) for label in runtime_scope)


def previous_benchmark_watermark(benchmark_dir: Path, runtime_scope: list[str]) -> datetime | None:
    """Return the latest retained watermark for the same runtime scope."""

    history_path = benchmark_dir / BENCHMARK_HISTORY_JSONL
    try:
        lines = history_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return None
    except OSError:
        return None
    watermark: datetime | None = None
    for line in lines:
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(row, dict) or not _runtime_scope_matches(row, runtime_scope):
            continue
        candidate = _timestamp_utc(row.get("benchmark_watermark_at"))
        if candidate is not None:
            watermark = candidate
    return watermark


def _safe_int(value: object) -> int:
    return value if isinstance(value, int) else 0


def build_benchmark_history_row(
    metrics: dict[str, Any],
    *,
    runtime_scope: list[str] | None = None,
) -> dict[str, Any]:
    """Build the privacy-bounded aggregate benchmark history row."""

    recommendation = metrics.get("startup_recommendation") if isinstance(metrics, dict) else None
    if not isinstance(recommendation, dict):
        recommendation = {}
    row = {
        "contract_version": metrics.get("contract_version"),
        "generated_at": metrics.get("generated_at"),
        "agentera_version": _agentera_version(),
        **_git_metadata(),
        "runtime_scope": _runtime_scope(metrics, runtime_scope),
        "benchmark_mode": metrics.get("benchmark_mode") or "full_boundary_snapshot",
        "benchmark_previous_watermark_at": metrics.get("benchmark_previous_watermark_at"),
        "benchmark_window_started_after": metrics.get("benchmark_window_started_after"),
        "benchmark_watermark_at": metrics.get("benchmark_watermark_at"),
        "total_records": _safe_int(metrics.get("total_records")),
        "total_state_sequences": _safe_int(metrics.get("total_state_sequences")),
        "state_sequences_with_raw_after_cli": _safe_int(metrics.get("state_sequences_with_raw_after_cli")),
        "state_sequences_with_redundant_raw_access": _safe_int(
            metrics.get("state_sequences_with_redundant_raw_access")
        ),
        "raw_after_cli_rate": metrics.get("raw_after_cli_sequence_rate", 0),
        "redundant_raw_access_rate": metrics.get("redundant_raw_sequence_rate", 0),
        "cli_state_command_counts": metrics.get("cli_state_command_counts") or {},
        "raw_artifact_access_after_cli_counts": metrics.get("raw_artifact_access_after_cli_counts") or {},
        "redundant_raw_artifact_access_counts": metrics.get("redundant_raw_artifact_access_counts") or {},
        "per_capability_state_counts": metrics.get("per_capability_state_counts") or {},
        "degradation_reason_counts": metrics.get("degradation_reason_counts") or {},
        "bounded_degradation_counts": {
            "record_or_sequence": metrics.get("degradation_reason_counts") or {},
            "runtime_status": metrics.get("runtime_status_counts") or {},
        },
        "startup_recommendation_action": recommendation.get("action"),
    }
    return row


def _temporary_peer_path(path: Path) -> Path:
    timestamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S%f")
    return path.with_name(f".{path.name}.{os.getpid()}.{timestamp}.tmp")


def persist_startup_benchmark(
    metrics: dict[str, Any],
    benchmark_dir: Path,
    *,
    runtime_scope: list[str] | None = None,
) -> dict[str, str]:
    """Append aggregate benchmark history and replace fixed latest reports."""

    benchmark_dir = benchmark_dir.expanduser()
    if not benchmark_dir.is_absolute():
        raise ValueError("benchmark directory must be an absolute path")

    structured_text = json.dumps(metrics, indent=2, sort_keys=True) + "\n"
    human_text = render_startup_report(metrics)
    row_text = json.dumps(build_benchmark_history_row(metrics, runtime_scope=runtime_scope), sort_keys=True) + "\n"

    benchmark_dir.mkdir(parents=True, exist_ok=True)
    history_path = benchmark_dir / BENCHMARK_HISTORY_JSONL
    json_path = benchmark_dir / BENCHMARK_LATEST_REPORT_JSON
    markdown_path = benchmark_dir / BENCHMARK_LATEST_REPORT_MARKDOWN
    json_tmp = _temporary_peer_path(json_path)
    markdown_tmp = _temporary_peer_path(markdown_path)
    try:
        json_tmp.write_text(structured_text, encoding="utf-8")
        markdown_tmp.write_text(human_text, encoding="utf-8")
        with history_path.open("a", encoding="utf-8") as history:
            history.write(row_text)
        json_tmp.replace(json_path)
        markdown_tmp.replace(markdown_path)
    except Exception:
        for tmp_path in (json_tmp, markdown_tmp):
            try:
                tmp_path.unlink()
            except FileNotFoundError:
                pass
        raise
    return {
        "history": str(history_path),
        "structured": str(json_path),
        "human_readable": str(markdown_path),
    }


def build_startup_intermediate(
    corpus: dict[str, Any],
    *,
    salt: str,
    contract: dict[str, Any] | None = None,
    benchmark_mode: str | None = None,
    benchmark_previous_watermark_at: datetime | None = None,
    benchmark_window_started_after: datetime | None = None,
    benchmark_watermark_at: datetime | None = None,
) -> dict[str, Any]:
    """Derive a redacted state-access intermediate from a Section 22 corpus."""

    loaded = contract or load_contract()
    records = corpus.get("records", []) if isinstance(corpus, dict) else []
    if not isinstance(records, list):
        records = []
    metadata = corpus.get("metadata", {}) if isinstance(corpus, dict) else {}
    if not isinstance(metadata, dict):
        metadata = {}
    runtime_statuses = metadata.get("runtime_statuses")
    if not isinstance(runtime_statuses, list):
        runtime_statuses = []
    boundary = _timestamp_utc((loaded.get("boundary") or {}).get("committed_at"))
    window_started_after = benchmark_window_started_after or boundary
    watermark_at = benchmark_watermark_at or _max_record_timestamp(records, after=window_started_after)

    classified = classify_startup_records(corpus, salt=salt, contract=loaded)
    sequences = classified["state_gathering_sequences"]
    degradations = classified["degradations"]
    runtime_coverage = [
        _bounded_runtime_status(status) for status in runtime_statuses if isinstance(status, dict)
    ]
    return {
        "output_envelope": STARTUP_INTERMEDIATE_ENVELOPE,
        "contract_version": loaded.get("version"),
        "boundary_source": (loaded.get("boundary") or {}).get("source"),
        "boundary_commit": (loaded.get("boundary") or {}).get("commit"),
        "boundary_committed_at": (loaded.get("boundary") or {}).get("committed_at"),
        "benchmark_mode": benchmark_mode or "full_boundary_snapshot",
        "benchmark_previous_watermark_at": _format_timestamp(benchmark_previous_watermark_at),
        "benchmark_window_started_after": _format_timestamp(window_started_after),
        "benchmark_watermark_at": _format_timestamp(watermark_at),
        "corpus_adapter_version": metadata.get("adapter_version"),
        "runtime_coverage": runtime_coverage,
        "runtime_record_counts": _runtime_record_counts(records),
        "total_records_read": len(records),
        "total_state_sequences": len(sequences),
        "artifact_label_counts": _artifact_label_counts(sequences),
        "state_gathering_sequences": sequences,
        "degradations": degradations,
        "compatibility_note": "Section 22 corpus records are read-only; startup state data is emitted only in startup_state_analysis_v1.",
    }


def build_no_runtime_startup_intermediate(
    *,
    contract: dict[str, Any] | None = None,
    benchmark_mode: str = "since_previous_benchmark",
    benchmark_previous_watermark_at: datetime | None = None,
) -> dict[str, Any]:
    """Build a benchmarkable intermediate without reading runtime history."""

    loaded = contract or load_contract()
    boundary = _timestamp_utc((loaded.get("boundary") or {}).get("committed_at"))
    window_started_after = benchmark_previous_watermark_at or boundary
    return {
        "output_envelope": STARTUP_INTERMEDIATE_ENVELOPE,
        "contract_version": loaded.get("version"),
        "boundary_source": (loaded.get("boundary") or {}).get("source"),
        "boundary_commit": (loaded.get("boundary") or {}).get("commit"),
        "boundary_committed_at": (loaded.get("boundary") or {}).get("committed_at"),
        "benchmark_mode": benchmark_mode,
        "benchmark_previous_watermark_at": _format_timestamp(benchmark_previous_watermark_at),
        "benchmark_window_started_after": _format_timestamp(window_started_after),
        "benchmark_watermark_at": _format_timestamp(benchmark_previous_watermark_at),
        "corpus_adapter_version": None,
        "runtime_coverage": [
            {
                "runtime": "none",
                "status": "skipped",
                "reason": "no_runtime_stores_approved",
                "record_count": 0,
            }
        ],
        "runtime_record_counts": {},
        "total_records_read": 0,
        "total_state_sequences": 0,
        "artifact_label_counts": {},
        "state_gathering_sequences": [],
        "degradations": [],
        "compatibility_note": "No runtime stores were approved, so no local runtime history was read.",
    }


def extract_startup_intermediate_from_corpus_file(
    corpus_path: Path,
    *,
    salt: str,
    output_path: Path | None = None,
    contract: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Read a local corpus/session-record file and optionally write a redacted intermediate."""

    try:
        corpus = json.loads(corpus_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        corpus = {
            "metadata": {
                "runtime_statuses": [
                    {
                        "runtime": "local-corpus",
                        "status": "degraded",
                        "reason": "schema_divergent",
                        "error_count": 1,
                    }
                ]
            },
            "records": [],
        }
    intermediate = build_startup_intermediate(corpus, salt=salt, contract=contract)
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(intermediate, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return intermediate


def _load_extract_corpus_module() -> Any:
    spec = importlib.util.spec_from_file_location("agentera_extract_corpus_for_startup", EXTRACT_CORPUS_PATH)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load extract_corpus module: {EXTRACT_CORPUS_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def extract_startup_intermediate_from_runtime_stores(
    *,
    project_roots: list[Path],
    salt: str,
    codex_sessions_dir: Path | None = None,
    claude_projects_dir: Path | None = None,
    opencode_conversations_dir: Path | None = None,
    copilot_conversations_dir: Path | None = None,
    output_path: Path | None = None,
    contract: dict[str, Any] | None = None,
    extract_corpus_module: Any | None = None,
    benchmark_mode: str | None = None,
    benchmark_previous_watermark_at: datetime | None = None,
) -> dict[str, Any]:
    """Extract fixture/temp runtime stores into ``startup_state_analysis_v1``."""

    extract_corpus = extract_corpus_module or _load_extract_corpus_module()
    corpus = extract_corpus.build_corpus(
        project_roots=project_roots,
        codex_sessions_dir=codex_sessions_dir,
        claude_projects_dir=claude_projects_dir,
        opencode_conversations_dir=opencode_conversations_dir,
        copilot_conversations_dir=copilot_conversations_dir,
    )
    window_corpus, watermark_at = _corpus_after(corpus, benchmark_previous_watermark_at)
    explicit_watermark_at = None
    if benchmark_previous_watermark_at is not None:
        explicit_watermark_at = watermark_at or benchmark_previous_watermark_at
    intermediate = build_startup_intermediate(
        window_corpus,
        salt=salt,
        contract=contract,
        benchmark_mode=benchmark_mode,
        benchmark_previous_watermark_at=benchmark_previous_watermark_at,
        benchmark_window_started_after=benchmark_previous_watermark_at,
        benchmark_watermark_at=explicit_watermark_at,
    )
    if output_path is not None:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(intermediate, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return intermediate


def _load_json_file(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"expected JSON object: {path}")
    return data


def _parse_runtime_store(value: str) -> tuple[str, Path]:
    runtime, separator, store_path = value.partition("=")
    if not separator or not runtime or not store_path:
        valid = ", ".join(sorted(RUNTIME_STORE_ARGUMENTS))
        raise ValueError(f"runtime store must use RUNTIME=ABSOLUTE_PATH; valid runtimes: {valid}")
    if runtime not in RUNTIME_STORE_ARGUMENTS:
        valid = ", ".join(sorted(RUNTIME_STORE_ARGUMENTS))
        raise ValueError(f"unsupported runtime {runtime!r}; valid runtimes: {valid}")
    path = Path(store_path)
    if not path.is_absolute():
        raise ValueError(f"runtime store for {runtime} must be an absolute path")
    return runtime, path


def main(argv: list[str] | None = None) -> int:
    parser = ArgumentParser(
        description="Generate local-only, privacy-preserving Agentera startup state-access reports."
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--corpus-json", type=Path, help="Local Section 22 corpus JSON to analyze.")
    source.add_argument("--intermediate-json", type=Path, help="Existing startup_state_analysis_v1 JSON to aggregate.")
    source.add_argument(
        "--runtime-store",
        action="append",
        default=[],
        metavar="RUNTIME=ABSOLUTE_PATH",
        help="Approved runtime store to inspect; repeatable for codex, claude-code, opencode, github-copilot.",
    )
    source.add_argument(
        "--no-runtime-stores",
        action="store_true",
        help="Run without inspecting local runtime history; useful for no-prerequisite benchmark smoke runs.",
    )
    parser.add_argument(
        "--project-root",
        action="append",
        type=Path,
        default=[],
        help="Project root used for corpus context when --runtime-store is used; repeatable.",
    )
    parser.add_argument("--output-dir", type=Path, required=True, help="Directory for report artifacts.")
    parser.add_argument(
        "--persist-benchmark",
        action="store_true",
        help="Persist aggregate benchmark history and fixed latest reports.",
    )
    parser.add_argument(
        "--benchmark-dir",
        type=Path,
        help="Durable benchmark directory; defaults to ${AGENTERA_HOME}/benchmarks/startup-state/.",
    )
    parser.add_argument(
        "--since-previous-benchmark",
        action="store_true",
        help="When persisting a benchmark, analyze only records after the previous retained watermark for this runtime scope.",
    )
    parser.add_argument("--salt", required=True, help="Salt for non-reconstructable private labels.")
    args = parser.parse_args(argv)
    if args.since_previous_benchmark and not (args.persist_benchmark or args.benchmark_dir is not None):
        parser.error("--since-previous-benchmark requires --persist-benchmark or --benchmark-dir")
    benchmark_dir = args.benchmark_dir or default_startup_benchmark_dir()

    approved_runtime_scope: list[str] | None = None
    if args.corpus_json is not None:
        intermediate = build_startup_intermediate(_load_json_file(args.corpus_json), salt=args.salt)
    elif args.intermediate_json is not None:
        intermediate = _load_json_file(args.intermediate_json)
    elif args.no_runtime_stores:
        approved_runtime_scope = ["none"]
        previous_watermark = (
            previous_benchmark_watermark(benchmark_dir, approved_runtime_scope)
            if args.since_previous_benchmark
            else None
        )
        intermediate = build_no_runtime_startup_intermediate(
            benchmark_mode="since_previous_benchmark" if args.since_previous_benchmark else "no_runtime",
            benchmark_previous_watermark_at=previous_watermark,
        )
    else:
        runtime_paths: dict[str, Path] = {}
        try:
            for raw_store in args.runtime_store:
                runtime, store_path = _parse_runtime_store(raw_store)
                if runtime in runtime_paths:
                    parser.error(f"duplicate runtime-store approval for {runtime}")
                runtime_paths[runtime] = store_path
        except ValueError as error:
            parser.error(str(error))
        if not runtime_paths:
            parser.error("at least one --runtime-store RUNTIME=ABSOLUTE_PATH approval is required")
        approved_runtime_scope = sorted(runtime_paths)
        previous_watermark = (
            previous_benchmark_watermark(benchmark_dir, approved_runtime_scope)
            if args.since_previous_benchmark
            else None
        )
        project_roots = args.project_root or [Path.cwd()]
        intermediate = extract_startup_intermediate_from_runtime_stores(
            project_roots=project_roots,
            salt=args.salt,
            benchmark_mode="since_previous_benchmark" if args.since_previous_benchmark else "full_boundary_snapshot",
            benchmark_previous_watermark_at=previous_watermark,
            **{field: runtime_paths.get(runtime) for runtime, field in RUNTIME_STORE_ARGUMENTS.items()},
        )
    metrics = aggregate_startup_metrics(intermediate)
    paths = write_startup_reports(metrics, args.output_dir)
    benchmark_paths = {}
    if args.persist_benchmark or args.benchmark_dir is not None:
        try:
            benchmark_paths = persist_startup_benchmark(
                metrics,
                benchmark_dir,
                runtime_scope=approved_runtime_scope,
            )
        except ValueError as error:
            parser.error(str(error))
    stdout_reports = {name: Path(path).name for name, path in paths.items()}
    output = {"status": "ok", "reports": stdout_reports}
    if benchmark_paths:
        output["benchmark"] = {name: Path(path).name for name, path in benchmark_paths.items()}
    print(json.dumps(output, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
