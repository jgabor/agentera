#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Build a portable Section 22 corpus for profilera.

The extractor writes the normalized corpus envelope consumed by
``scripts/usage_stats.py`` and the profilera capability:

    uv run scripts/extract_corpus.py
    uv run scripts/extract_corpus.py --output /tmp/corpus.json
    uv run scripts/extract_corpus.py --project-root ~/git/agentera
    uv run scripts/extract_corpus.py --codex-sessions-dir ~/.codex/sessions

It intentionally treats host storage as adapter input and emits the four
portable record families from ``references/contract.md``:
``instruction_document``, ``history_prompt``, ``conversation_turn``,
``tool_call``, and ``project_config_signal``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote

ADAPTER_VERSION = "agentera-v2-corpus-1"
FAMILIES = (
    "instruction_document",
    "history_prompt",
    "conversation_turn",
    "tool_call",
    "project_config_signal",
)
RUNTIME_STORE_GLOBS = {
    "codex": "*.jsonl",
    "claude-code": "*.jsonl",
    "opencode": "opencode.db",
    "github-copilot": "session-store.db",
}
MAX_SQLITE_ROWS = 100_000
MAX_SQLITE_SESSIONS = 60
COPILOT_SPARSE_REMEDIATION = "/chronicle reindex"
DECISION_RE = re.compile(
    r"\b("
    r"decide|decision|prefer|preference|instead|avoid|don't|do not|"
    r"should|trade[- ]?off|scope|plan|commit|review|fix|why|question|"
    r"blocked|stuck|approve|reject|change|keep|remove"
    r")\b",
    re.IGNORECASE,
)
CORRECTION_RE = re.compile(
    r"\b(no|not quite|actually|rather|instead|wrong|correction|"
    r"that's not|that is not|don't|do not)\b",
    re.IGNORECASE,
)
QUESTION_RE = re.compile(r"\?|^\s*(why|what|how|should|can|could|would)\b", re.IGNORECASE)


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def iso_from_mtime(path: Path) -> str:
    return (
        datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )


def stable_id(*parts: object) -> str:
    raw = "\0".join(str(part) for part in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def project_id_from_path(path: Path | None) -> str:
    if path is None:
        return "global"
    name = path.name or str(path)
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-").lower()
    return slug or "global"


def default_profile_dir() -> Path:
    override = os.environ.get("PROFILERA_PROFILE_DIR")
    if override:
        return Path(override)
    return default_agentera_home()


def default_agentera_home() -> Path:
    override = os.environ.get("AGENTERA_HOME")
    if override:
        return Path(override)
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "agentera"
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))
        return Path(appdata) / "agentera"
    xdg = os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))
    return Path(xdg) / "agentera"


def default_output_path() -> Path:
    return default_profile_dir() / "intermediate" / "corpus.json"


def runtime_status(
    runtime: str,
    *,
    status: str,
    reason: str,
    store_path: Path | None,
    candidate_count: int | None = None,
    record_count: int | None = None,
    error_count: int | None = None,
    remediation_labels: list[str] | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "runtime": runtime,
        "status": status,
        "reason": reason,
    }
    if store_path is not None:
        item["store_path"] = str(store_path)
    if candidate_count is not None:
        item["candidate_count"] = candidate_count
    if record_count is not None:
        item["record_count"] = record_count
    if error_count is not None:
        item["error_count"] = error_count
    if remediation_labels:
        item["remediation_labels"] = remediation_labels
    return item


def discover_runtime_store(runtime: str, store_path: Path | None) -> dict[str, Any]:
    if store_path is None:
        return runtime_status(runtime, status="skipped", reason="disabled", store_path=None)
    if not store_path.exists():
        return runtime_status(
            runtime,
            status="missing",
            reason="store_absent",
            store_path=store_path,
            remediation_labels=(
                [COPILOT_SPARSE_REMEDIATION] if runtime == "github-copilot" else None
            ),
        )
    if runtime in {"opencode", "github-copilot"} and store_path.is_file():
        return runtime_status(
            runtime,
            status="available",
            reason="candidate_files_found",
            store_path=store_path,
            candidate_count=1,
        )
    if not store_path.is_dir():
        return runtime_status(runtime, status="degraded", reason="store_not_directory", store_path=store_path)
    try:
        candidates = list(store_path.rglob(RUNTIME_STORE_GLOBS[runtime]))
    except PermissionError:
        return runtime_status(runtime, status="degraded", reason="store_locked", store_path=store_path)
    except OSError:
        return runtime_status(runtime, status="degraded", reason="store_unreadable", store_path=store_path)
    if not candidates:
        return runtime_status(
            runtime,
            status="sparse",
            reason="no_candidate_files",
            store_path=store_path,
            candidate_count=0,
            remediation_labels=(
                [COPILOT_SPARSE_REMEDIATION] if runtime == "github-copilot" else None
            ),
        )
    return runtime_status(
        runtime,
        status="available",
        reason="candidate_files_found",
        store_path=store_path,
        candidate_count=len(candidates),
    )


def record(
    *,
    source_kind: str,
    timestamp: str,
    project_path: Path | None,
    runtime: str,
    data: dict[str, Any],
    source_parts: Iterable[object],
    session_id: str | None = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "source_id": stable_id(source_kind, *source_parts),
        "timestamp": timestamp,
        "project_id": project_id_from_path(project_path),
        "source_kind": source_kind,
        "runtime": runtime,
        "adapter_version": ADAPTER_VERSION,
        "data": data,
    }
    if project_path is not None:
        item["project_path"] = str(project_path)
    if session_id:
        item["session_id"] = session_id
    return item


def _tool_call_record(
    *,
    event: dict[str, Any],
    fallback_timestamp: str,
    project_path: Path | None,
    runtime: str,
    source_path: Path,
    index: int,
    session_id: str,
) -> dict[str, Any] | None:
    item = _payload_item(event)
    kind = _event_kind(event)
    item_type = item.get("type")
    if kind not in {"tool_call", "function_call"} and item_type not in {
        "tool_call",
        "function_call",
        "tool_use",
    }:
        return None

    tool_name = item.get("tool_name") or item.get("name") or item.get("tool")
    if not isinstance(tool_name, str) or not tool_name:
        return None
    arguments = item.get("arguments") or item.get("input") or item.get("args") or {}
    if isinstance(arguments, str):
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError:
            parsed = {"raw": arguments}
        arguments = parsed
    if not isinstance(arguments, dict):
        arguments = {"value": arguments}
    return record(
        source_kind="tool_call",
        timestamp=event_timestamp(event, fallback_timestamp),
        project_path=project_path,
        runtime=runtime,
        source_parts=(source_path.resolve(), index, "tool", tool_name),
        session_id=session_id,
        data={
            "tool_name": tool_name,
            "arguments": arguments,
        },
    )


def iter_jsonl(path: Path, errors: list[str]) -> Iterable[dict[str, Any]]:
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line_no, line in enumerate(fh, start=1):
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    item = json.loads(stripped)
                except json.JSONDecodeError as exc:
                    errors.append(f"{path}:{line_no}: invalid jsonl: {exc}")
                    continue
                if isinstance(item, dict):
                    yield item
    except OSError as exc:
        errors.append(f"{path}: cannot read: {exc}")


def text_from_content(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = [text_from_content(item) for item in value]
        return "\n".join(part for part in parts if part)
    if isinstance(value, dict):
        for key in ("text", "input_text", "output_text", "message", "content"):
            text = text_from_content(value.get(key))
            if text:
                return text
        return ""
    return str(value)


def event_timestamp(item: dict[str, Any], fallback: str) -> str:
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    nested = payload.get("item") if isinstance(payload.get("item"), dict) else {}
    for source in (item, payload, nested):
        for key in ("timestamp", "created_at", "createdAt", "time"):
            value = source.get(key)
            if isinstance(value, str) and value:
                return value
            if isinstance(value, (int, float)):
                return (
                    datetime.fromtimestamp(float(value), timezone.utc)
                    .isoformat()
                    .replace("+00:00", "Z")
                )
    return fallback


def signal_type(text: str) -> str | None:
    if not text or not DECISION_RE.search(text):
        return None
    if CORRECTION_RE.search(text):
        return "correction"
    if QUESTION_RE.search(text):
        return "question"
    return "decision"


def extract_instruction_documents(project_roots: list[Path], errors: list[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    doc_names = {
        "AGENTS.md": "agents_md",
        "CLAUDE.md": "claude_md",
    }
    for root in project_roots:
        for filename, doc_type in doc_names.items():
            path = root / filename
            if not path.exists():
                continue
            try:
                content = path.read_text(encoding="utf-8")
            except OSError as exc:
                errors.append(f"{path}: cannot read instruction document: {exc}")
                continue
            records.append(
                record(
                    source_kind="instruction_document",
                    timestamp=iso_from_mtime(path),
                    project_path=root,
                    runtime="filesystem",
                    source_parts=(path.resolve(),),
                    data={
                        "doc_type": doc_type,
                        "name": filename,
                        "content": content,
                        "scope": "project",
                    },
                )
            )
    return records


def package_json_signals(path: Path) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        return []
    signals: list[str] = []
    name = data.get("name")
    if isinstance(name, str) and name:
        signals.append(f"name={name}")
    for section in ("scripts", "dependencies", "devDependencies"):
        section_data = data.get(section)
        if not isinstance(section_data, dict):
            continue
        for key in sorted(section_data)[:30]:
            signals.append(f"{section}:{key}")
    return signals


def text_config_signals(path: Path, config_type: str) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return []
    signals: list[str] = []
    for raw_line in lines:
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        if config_type == "gomod" and (
            line.startswith("module ") or line.startswith("go ") or line.startswith("require ")
        ):
            signals.append(line)
        elif config_type == "pyproject" and (
            line.startswith("[") or line.startswith("requires-python")
            or line.startswith("dependencies") or line.startswith("name")
        ):
            signals.append(line)
        elif config_type == "cargo_toml" and (
            line.startswith("[") or line.startswith("name") or line.startswith("edition")
        ):
            signals.append(line)
        elif config_type == "lefthook" and ":" in line:
            signals.append(line)
        if len(signals) >= 40:
            break
    return signals


def extract_project_config_signals(project_roots: list[Path], errors: list[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    config_files = {
        "package.json": ("package_json", package_json_signals),
        "pyproject.toml": ("pyproject", lambda p: text_config_signals(p, "pyproject")),
        "go.mod": ("gomod", lambda p: text_config_signals(p, "gomod")),
        "Cargo.toml": ("cargo_toml", lambda p: text_config_signals(p, "cargo_toml")),
        ".lefthook.yml": ("lefthook", lambda p: text_config_signals(p, "lefthook")),
        "lefthook.yml": ("lefthook", lambda p: text_config_signals(p, "lefthook")),
    }
    for root in project_roots:
        for filename, (config_type, extractor) in config_files.items():
            path = root / filename
            if not path.exists():
                continue
            try:
                signals = extractor(path)
            except (OSError, json.JSONDecodeError) as exc:
                errors.append(f"{path}: cannot extract config signals: {exc}")
                continue
            if not signals:
                continue
            records.append(
                record(
                    source_kind="project_config_signal",
                    timestamp=iso_from_mtime(path),
                    project_path=root,
                    runtime="filesystem",
                    source_parts=(path.resolve(), config_type),
                    data={
                        "config_type": config_type,
                        "file_path": str(path.relative_to(root)),
                        "signals": signals,
                    },
                )
            )
    return records


def _payload_item(event: dict[str, Any]) -> dict[str, Any]:
    payload = event.get("payload")
    if isinstance(payload, dict):
        nested = payload.get("item")
        if isinstance(nested, dict):
            return nested
        return payload
    return event


def _event_kind(event: dict[str, Any]) -> str:
    for key in ("type", "event", "name"):
        value = event.get(key)
        if isinstance(value, str):
            return value
    return ""


def extract_codex_sessions(sessions_dir: Path | None, errors: list[str]) -> list[dict[str, Any]]:
    if sessions_dir is None or not sessions_dir.exists():
        return []
    records: list[dict[str, Any]] = []
    jsonl_paths = sorted(sessions_dir.rglob("*.jsonl"))
    for path in jsonl_paths:
        fallback_timestamp = iso_from_mtime(path)
        session_id = path.stem
        project_path: Path | None = None
        previous_assistant = ""
        for index, event in enumerate(iter_jsonl(path, errors), start=1):
            kind = _event_kind(event)
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            if kind == "session_meta":
                sid = payload.get("id") or event.get("id")
                if isinstance(sid, str) and sid:
                    session_id = sid
                cwd = payload.get("cwd") or payload.get("working_directory")
                if isinstance(cwd, str) and cwd:
                    project_path = Path(cwd)
                continue
            if kind == "turn_context":
                cwd = payload.get("cwd") or payload.get("working_directory")
                if isinstance(cwd, str) and cwd:
                    project_path = Path(cwd)
                continue

            tool_record = _tool_call_record(
                event=event,
                fallback_timestamp=fallback_timestamp,
                project_path=project_path,
                runtime="codex",
                source_path=path,
                index=index,
                session_id=session_id,
            )
            if tool_record is not None:
                records.append(tool_record)
                continue

            item = _payload_item(event)
            item_type = item.get("type")
            role = item.get("role") or item.get("actor")
            if kind == "user_msg":
                role = "user"
            if role not in {"user", "assistant"}:
                continue
            if item_type not in {None, "message"} and kind not in {"response_item", "user_msg"}:
                continue

            content = text_from_content(item.get("content") or item.get("text") or item.get("message"))
            if not content:
                continue
            timestamp = event_timestamp(event, fallback_timestamp)
            data: dict[str, Any] = {
                "actor": role,
                "content": content,
            }
            if role == "user":
                if previous_assistant:
                    data["preceding_context"] = previous_assistant[-2000:]
                sig = signal_type(content)
                if sig:
                    data["signal_type"] = sig
            else:
                previous_assistant = content
            records.append(
                record(
                    source_kind="conversation_turn",
                    timestamp=timestamp,
                    project_path=project_path,
                    runtime="codex",
                    source_parts=(path.resolve(), index, role, content[:80]),
                    session_id=session_id,
                    data=data,
                )
            )
            if role == "user":
                sig = signal_type(content)
                if sig:
                    records.append(
                        record(
                            source_kind="history_prompt",
                            timestamp=timestamp,
                            project_path=project_path,
                            runtime="codex",
                            source_parts=(path.resolve(), index, "history", content[:120]),
                            session_id=session_id,
                            data={
                                "prompt": content,
                                "signal_type": sig,
                            },
                        )
                    )
    return records


def extract_claude_project_sessions(projects_dir: Path | None, errors: list[str]) -> list[dict[str, Any]]:
    if projects_dir is None or not projects_dir.exists():
        return []
    records: list[dict[str, Any]] = []
    for path in sorted(projects_dir.rglob("*.jsonl")):
        fallback_timestamp = iso_from_mtime(path)
        session_id = path.stem
        project_path: Path | None = None
        previous_assistant = ""
        for index, event in enumerate(iter_jsonl(path, errors), start=1):
            tool_record = _tool_call_record(
                event=event,
                fallback_timestamp=fallback_timestamp,
                project_path=project_path,
                runtime="claude-code",
                source_path=path,
                index=index,
                session_id=session_id,
            )
            if tool_record is not None:
                records.append(tool_record)
                continue

            role = event.get("role") or event.get("type")
            if role not in {"user", "assistant"}:
                message = event.get("message")
                if isinstance(message, dict):
                    role = message.get("role")
            if role not in {"user", "assistant"}:
                continue
            cwd = event.get("cwd")
            if isinstance(cwd, str) and cwd:
                project_path = Path(cwd)
            content = text_from_content(
                event.get("content")
                or event.get("text")
                or (event.get("message") if isinstance(event.get("message"), dict) else None)
            )
            if not content:
                continue
            timestamp = event_timestamp(event, fallback_timestamp)
            data: dict[str, Any] = {
                "actor": role,
                "content": content,
            }
            if role == "user":
                if previous_assistant:
                    data["preceding_context"] = previous_assistant[-2000:]
                sig = signal_type(content)
                if sig:
                    data["signal_type"] = sig
            else:
                previous_assistant = content
            records.append(
                record(
                    source_kind="conversation_turn",
                    timestamp=timestamp,
                    project_path=project_path,
                    runtime="claude-code",
                    source_parts=(path.resolve(), index, role, content[:80]),
                    session_id=session_id,
                    data=data,
                )
            )
            if role == "user":
                sig = signal_type(content)
                if sig:
                    records.append(
                        record(
                            source_kind="history_prompt",
                            timestamp=timestamp,
                            project_path=project_path,
                            runtime="claude-code",
                            source_parts=(path.resolve(), index, "history", content[:120]),
                            session_id=session_id,
                            data={
                                "prompt": content,
                                "signal_type": sig,
                            },
                        )
                    )
    return records


def _opencode_db_candidates(store_path: Path) -> list[Path]:
    if store_path.is_file():
        return [store_path]
    return sorted(store_path.rglob("opencode.db"))


def _sqlite_uri(path: Path) -> str:
    return f"file:{quote(str(path.resolve()), safe='/:')}?mode=ro&immutable=1"


def _table_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return {str(row[1]) for row in rows}


def _first_column(columns: set[str], candidates: tuple[str, ...]) -> str | None:
    for candidate in candidates:
        if candidate in columns:
            return candidate
    return None


def _qualified(alias: str, column: str | None, label: str) -> str:
    if column is None:
        return f"NULL AS {label}"
    escaped = column.replace('"', '""')
    return f'{alias}."{escaped}" AS {label}'


def _opencode_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    tables = {
        str(row[0])
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    }
    required = {"session", "message", "part"}
    if not required.issubset(tables):
        missing = ",".join(sorted(required - tables))
        raise ValueError(f"missing opencode tables: {missing}")

    session_cols = _table_columns(conn, "session")
    message_cols = _table_columns(conn, "message")
    part_cols = _table_columns(conn, "part")
    session_id = _first_column(session_cols, ("id", "session_id", "sessionID"))
    message_id = _first_column(message_cols, ("id", "message_id", "messageID"))
    message_session = _first_column(message_cols, ("sessionID", "session_id", "session", "sessionId"))
    part_message = _first_column(part_cols, ("messageID", "message_id", "message", "messageId"))
    if not (session_id and message_id and message_session and part_message):
        raise ValueError("missing opencode join columns")

    message_data = _first_column(message_cols, ("data",))
    part_data = _first_column(part_cols, ("data",))
    role_col = _first_column(message_cols, ("role", "actor", "author"))
    if role_col is None and message_data is None:
        raise ValueError("missing opencode message role column")

    message_time = _first_column(
        message_cols,
        ("time_created", "time", "timestamp", "created_at", "createdAt"),
    )
    part_time = _first_column(part_cols, ("time_created", "time", "timestamp", "created_at", "createdAt"))
    session_time = _first_column(
        session_cols,
        ("time_created", "time", "timestamp", "created_at", "createdAt"),
    )
    session_updated = _first_column(
        session_cols,
        ("time_updated", "updated_at", "updatedAt", "time_created", "time"),
    )
    project_col = _first_column(session_cols, ("cwd", "project_path", "projectPath", "directory", "path"))
    message_text = _first_column(message_cols, ("content", "text", "message"))
    part_text = _first_column(part_cols, ("text", "content", "input", "output"))
    part_type = _first_column(part_cols, ("type", "kind"))
    part_id = _first_column(part_cols, ("id", "part_id", "partID"))

    sort_expr = f"COALESCE(m.\"{message_time or message_id}\", p.\"{part_time or part_message}\", s.\"{session_time or session_id}\")"
    recent_session_expr = f's."{session_updated or session_time or session_id}"'
    query = f"""
        WITH recent_sessions AS (
            SELECT s."{session_id}" AS recent_session_id
            FROM session s
            ORDER BY {recent_session_expr} DESC,
                     s."{session_id}" DESC
            LIMIT ?
        ),
        recent AS (
            SELECT
                {_qualified('s', session_id, 'session_id')},
                {_qualified('s', project_col, 'project_path')},
                {_qualified('m', message_id, 'message_id')},
                {_qualified('m', role_col, 'role')},
                {_qualified('m', message_time, 'message_time')},
                {_qualified('m', message_text, 'message_text')},
                {_qualified('m', message_data, 'message_data')},
                {_qualified('p', part_id, 'part_id')},
                {_qualified('p', part_time, 'part_time')},
                {_qualified('p', part_type, 'part_type')},
                {_qualified('p', part_text, 'part_text')},
                {_qualified('p', part_data, 'part_data')},
                {sort_expr} AS sort_time
            FROM message m
            JOIN session s ON m."{message_session}" = s."{session_id}"
            JOIN recent_sessions rs ON rs.recent_session_id = s."{session_id}"
            LEFT JOIN part p ON p."{part_message}" = m."{message_id}"
            ORDER BY sort_time DESC,
                     m."{message_id}" DESC,
                     p."{part_id or part_message}" DESC
            LIMIT ?
        )
        SELECT
            session_id,
            project_path,
            message_id,
            role,
            message_time,
            message_text,
            message_data,
            part_id,
            part_time,
            part_type,
            part_text,
            part_data
        FROM recent
        ORDER BY sort_time,
                 message_id,
                 part_id
    """
    return conn.execute(query, (MAX_SQLITE_SESSIONS, MAX_SQLITE_ROWS)).fetchall()


def _sqlite_timestamp(value: Any, fallback: str) -> str:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric > 10_000_000_000:
            numeric /= 1000
        return datetime.fromtimestamp(numeric, timezone.utc).isoformat().replace("+00:00", "Z")
    return fallback


def _json_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _nested_time_created(data: dict[str, Any]) -> Any:
    time_data = data.get("time")
    if isinstance(time_data, dict):
        return time_data.get("created") or time_data.get("start")
    return data.get("time_created") or data.get("timestamp")


def extract_opencode_sessions(store_path: Path | None, errors: list[str]) -> list[dict[str, Any]]:
    if store_path is None or not store_path.exists():
        return []
    records: list[dict[str, Any]] = []
    for db_path in _opencode_db_candidates(store_path)[:1]:
        fallback_timestamp = iso_from_mtime(db_path)
        try:
            conn = sqlite3.connect(_sqlite_uri(db_path), uri=True)
            conn.row_factory = sqlite3.Row
            rows = _opencode_rows(conn)
        except sqlite3.OperationalError as exc:
            if "lock" in str(exc).lower() or "busy" in str(exc).lower():
                raise PermissionError from exc
            errors.append(f"{db_path}: opencode sqlite read failed: {exc.__class__.__name__}")
            continue
        except (sqlite3.DatabaseError, ValueError) as exc:
            errors.append(f"{db_path}: opencode schema divergent: {exc}")
            continue
        finally:
            try:
                conn.close()
            except UnboundLocalError:
                pass

        messages: dict[str, dict[str, Any]] = {}
        for row in rows:
            message_data = _json_dict(row["message_data"])
            part_data = _json_dict(row["part_data"])
            message_id = str(row["message_id"])
            role = row["role"] or message_data.get("role")
            message_time = row["message_time"] or _nested_time_created(message_data)
            item = messages.setdefault(
                message_id,
                {
                    "role": role,
                    "session_id": str(row["session_id"]),
                    "project_path": row["project_path"],
                    "timestamp": _sqlite_timestamp(message_time, fallback_timestamp),
                    "parts": [],
                    "tools": [],
                },
            )
            part_type = row["part_type"] or part_data.get("type")
            part_text = text_from_content(row["part_text"] or part_data.get("text"))
            if part_text:
                item["parts"].append(part_text)
            elif row["message_text"]:
                item["parts"].append(text_from_content(row["message_text"]))
            if part_type == "tool" or part_data.get("tool"):
                state = part_data.get("state") if isinstance(part_data.get("state"), dict) else {}
                arguments = state.get("input") if isinstance(state.get("input"), dict) else {}
                tool_name = part_data.get("tool") or part_data.get("name")
                if isinstance(tool_name, str) and tool_name:
                    item["tools"].append(
                        {
                            "part_id": row["part_id"],
                            "tool_name": tool_name,
                            "arguments": arguments,
                            "timestamp": _sqlite_timestamp(
                                row["part_time"] or _nested_time_created(part_data),
                                item["timestamp"],
                            ),
                        }
                    )

        previous_assistant = ""
        for index, item in enumerate(messages.values(), start=1):
            role = str(item["role"]).lower()
            if role not in {"user", "assistant"}:
                continue
            content = "\n".join(part for part in item["parts"] if part)
            if not content and not item["tools"]:
                continue
            project_path = Path(item["project_path"]) if item["project_path"] else None
            if content:
                data: dict[str, Any] = {
                    "actor": role,
                    "content": content,
                }
                if role == "user":
                    if previous_assistant:
                        data["preceding_context"] = previous_assistant[-2000:]
                    sig = signal_type(content)
                    if sig:
                        data["signal_type"] = sig
                else:
                    previous_assistant = content
                records.append(
                    record(
                        source_kind="conversation_turn",
                        timestamp=item["timestamp"],
                        project_path=project_path,
                        runtime="opencode",
                        source_parts=(db_path.resolve(), index, role, content[:80]),
                        session_id=item["session_id"],
                        data=data,
                    )
                )
            for tool_index, tool_item in enumerate(item["tools"], start=1):
                records.append(
                    record(
                        source_kind="tool_call",
                        timestamp=tool_item["timestamp"],
                        project_path=project_path,
                        runtime="opencode",
                        source_parts=(
                            db_path.resolve(),
                            index,
                            tool_index,
                            "tool",
                            tool_item["tool_name"],
                            tool_item.get("part_id"),
                        ),
                        session_id=item["session_id"],
                        data={
                            "tool_name": tool_item["tool_name"],
                            "arguments": tool_item["arguments"],
                        },
                    )
                )
            if role == "user" and content:
                sig = signal_type(content)
                if sig:
                    records.append(
                        record(
                            source_kind="history_prompt",
                            timestamp=item["timestamp"],
                            project_path=project_path,
                            runtime="opencode",
                            source_parts=(db_path.resolve(), index, "history", content[:120]),
                            session_id=item["session_id"],
                            data={
                                "prompt": content,
                                "signal_type": sig,
                            },
                        )
                    )
    return records


def _copilot_db_candidates(store_path: Path) -> list[Path]:
    if store_path.is_file():
        return [store_path]
    return sorted(store_path.rglob("session-store.db"))


def _copilot_rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    tables = {
        str(row[0])
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    }
    required = {"sessions", "turns"}
    if not required.issubset(tables):
        missing = ",".join(sorted(required - tables))
        raise ValueError(f"missing copilot tables: {missing}")

    session_cols = _table_columns(conn, "sessions")
    turn_cols = _table_columns(conn, "turns")
    session_id = _first_column(session_cols, ("id", "session_id", "sessionID"))
    turn_id = _first_column(turn_cols, ("id", "turn_id", "turnID"))
    turn_session = _first_column(turn_cols, ("session_id", "sessionID", "session", "sessionId"))
    if not (session_id and turn_session):
        raise ValueError("missing copilot join columns")

    role_col = _first_column(turn_cols, ("role", "actor", "author"))
    text_col = _first_column(turn_cols, ("content", "text", "message", "prompt", "response"))
    if role_col is None:
        raise ValueError("missing copilot turn role column")
    if text_col is None:
        raise ValueError("missing copilot turn text column")

    session_time = _first_column(session_cols, ("time", "timestamp", "created_at", "createdAt"))
    turn_time = _first_column(turn_cols, ("time", "timestamp", "created_at", "createdAt"))
    turn_order = _first_column(turn_cols, ("turn_index", "turnIndex", "idx", "position", "sequence"))
    project_col = _first_column(session_cols, ("cwd", "project_path", "projectPath", "directory", "path"))

    order_expr = f't."{turn_order}"' if turn_order else f't."{turn_time or turn_session}"'
    id_expr = f't."{turn_id}"' if turn_id else "t.rowid"
    query = f"""
        SELECT
            {_qualified('s', session_id, 'session_id')},
            {_qualified('s', project_col, 'project_path')},
            {_qualified('t', turn_id, 'turn_id')},
            {_qualified('t', role_col, 'role')},
            {_qualified('t', turn_time, 'turn_time')},
            {_qualified('s', session_time, 'session_time')},
            {_qualified('t', text_col, 'turn_text')}
        FROM turns t
        JOIN sessions s ON t."{turn_session}" = s."{session_id}"
        ORDER BY COALESCE({order_expr}, t."{turn_session}"),
                 CASE LOWER(t."{role_col}") WHEN 'user' THEN 0 WHEN 'assistant' THEN 1 ELSE 2 END,
                 {id_expr}
        LIMIT ?
    """
    return conn.execute(query, (MAX_SQLITE_ROWS,)).fetchall()


def extract_copilot_sessions(store_path: Path | None, errors: list[str]) -> list[dict[str, Any]]:
    if store_path is None or not store_path.exists():
        return []
    records: list[dict[str, Any]] = []
    for db_path in _copilot_db_candidates(store_path)[:1]:
        fallback_timestamp = iso_from_mtime(db_path)
        try:
            conn = sqlite3.connect(_sqlite_uri(db_path), uri=True)
            conn.row_factory = sqlite3.Row
            rows = _copilot_rows(conn)
        except sqlite3.OperationalError as exc:
            if "lock" in str(exc).lower() or "busy" in str(exc).lower():
                raise PermissionError from exc
            errors.append(f"{db_path}: copilot sqlite read failed: {exc.__class__.__name__}")
            continue
        except (sqlite3.DatabaseError, ValueError) as exc:
            errors.append(f"{db_path}: copilot schema divergent: {exc}")
            continue
        finally:
            try:
                conn.close()
            except UnboundLocalError:
                pass

        previous_assistant = ""
        for index, row in enumerate(rows, start=1):
            role = str(row["role"]).lower()
            if role not in {"user", "assistant"}:
                continue
            content = text_from_content(row["turn_text"])
            if not content:
                continue
            project_path = Path(row["project_path"]) if row["project_path"] else None
            timestamp = _sqlite_timestamp(
                row["turn_time"] or row["session_time"],
                fallback_timestamp,
            )
            data: dict[str, Any] = {
                "actor": role,
                "content": content,
            }
            if role == "user":
                if previous_assistant:
                    data["preceding_context"] = previous_assistant[-2000:]
                sig = signal_type(content)
                if sig:
                    data["signal_type"] = sig
            else:
                previous_assistant = content
            records.append(
                record(
                    source_kind="conversation_turn",
                    timestamp=timestamp,
                    project_path=project_path,
                    runtime="github-copilot",
                    source_parts=(db_path.resolve(), index, role, content[:80]),
                    session_id=str(row["session_id"]),
                    data=data,
                )
            )
            if role == "user":
                sig = signal_type(content)
                if sig:
                    records.append(
                        record(
                            source_kind="history_prompt",
                            timestamp=timestamp,
                            project_path=project_path,
                            runtime="github-copilot",
                            source_parts=(db_path.resolve(), index, "history", content[:120]),
                            session_id=str(row["session_id"]),
                            data={
                                "prompt": content,
                                "signal_type": sig,
                            },
                        )
                    )
    return records


class ExtractionNotImplementedError(Exception):
    """Raised when discovery is supported but runtime extraction is deferred."""


def extract_unimplemented_runtime(store_path: Path | None, errors: list[str]) -> list[dict[str, Any]]:
    del store_path, errors
    raise ExtractionNotImplementedError


def resolve_opencode_db_path() -> Path | None:
    try:
        result = subprocess.run(
            ["opencode", "db", "path"],
            text=True,
            capture_output=True,
            timeout=2,
            check=False,
        )
    except (FileNotFoundError, subprocess.SubprocessError, OSError):
        return None
    if result.returncode != 0:
        return None
    candidate = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
    return Path(candidate).expanduser() if candidate else None


def resolve_copilot_store_path() -> Path:
    return Path(os.environ.get("COPILOT_HOME", str(Path.home() / ".copilot"))).expanduser()


def extract_runtime_store(
    *,
    runtime: str,
    store_path: Path | None,
    errors: list[str],
    extractor: Any,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    discovery = discover_runtime_store(runtime, store_path)
    if discovery["status"] != "available":
        return [], discovery

    error_start = len(errors)
    try:
        records = extractor(store_path, errors)
    except ExtractionNotImplementedError:
        return [], runtime_status(
            runtime,
            status="degraded",
            reason="extractor_unimplemented",
            store_path=store_path,
            candidate_count=discovery.get("candidate_count"),
            record_count=0,
            error_count=0,
        )
    except PermissionError:
        return [], runtime_status(
            runtime,
            status="degraded",
            reason="store_locked",
            store_path=store_path,
            candidate_count=discovery.get("candidate_count"),
        )
    except OSError:
        return [], runtime_status(
            runtime,
            status="degraded",
            reason="store_unreadable",
            store_path=store_path,
            candidate_count=discovery.get("candidate_count"),
        )

    error_count = len(errors) - error_start
    if error_count:
        return records, runtime_status(
            runtime,
            status="degraded",
            reason="schema_divergent",
            store_path=store_path,
            candidate_count=discovery.get("candidate_count"),
            record_count=len(records),
            error_count=error_count,
        )
    if not records:
        return records, runtime_status(
            runtime,
            status="sparse",
            reason="no_matching_records",
            store_path=store_path,
            candidate_count=discovery.get("candidate_count"),
            record_count=0,
            remediation_labels=(
                [COPILOT_SPARSE_REMEDIATION] if runtime == "github-copilot" else None
            ),
        )
    return records, runtime_status(
        runtime,
        status="ok",
        reason="records_extracted",
        store_path=store_path,
        candidate_count=discovery.get("candidate_count"),
        record_count=len(records),
        error_count=0,
    )


def dedupe_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for item in records:
        by_id[item["source_id"]] = item

    def sort_key(item: dict[str, Any]) -> tuple[str, str, int, str]:
        actor = item.get("data", {}).get("actor") if isinstance(item.get("data"), dict) else None
        actor_order = {"user": 0, "assistant": 1}.get(str(actor), 2)
        return (
            item.get("timestamp", ""),
            item.get("source_kind", ""),
            actor_order,
            item.get("source_id", ""),
        )

    return sorted(
        by_id.values(),
        key=sort_key,
    )


def build_metadata(
    records: list[dict[str, Any]],
    errors: list[str],
    runtime_statuses: list[dict[str, Any]],
) -> dict[str, Any]:
    counts = Counter(
        item.get("source_kind") for item in records if item.get("source_kind") in FAMILIES
    )
    families: dict[str, dict[str, Any]] = {}
    for family in FAMILIES:
        count = counts.get(family, 0)
        families[family] = {
            "count": count,
            "status": "ok" if count else "missing",
        }
        if count == 0:
            families[family]["error"] = "no records extracted for this family"
    runtimes = sorted(
        {str(item.get("runtime")) for item in records if item.get("runtime")}
    )
    metadata: dict[str, Any] = {
        "extracted_at": iso_now(),
        "runtimes": runtimes,
        "adapter_version": ADAPTER_VERSION,
        "families": families,
        "runtime_statuses": runtime_statuses,
        "total_records": len(records),
        "errors": errors,
    }
    return metadata


def build_corpus(
    *,
    project_roots: list[Path],
    codex_sessions_dir: Path | None,
    claude_projects_dir: Path | None,
    opencode_conversations_dir: Path | None = None,
    copilot_conversations_dir: Path | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    normalized_roots = [root.resolve() for root in project_roots if root.exists()]
    for root in project_roots:
        if not root.exists():
            errors.append(f"{root}: project root does not exist")

    records: list[dict[str, Any]] = []
    records.extend(extract_instruction_documents(normalized_roots, errors))
    records.extend(extract_project_config_signals(normalized_roots, errors))
    runtime_statuses: list[dict[str, Any]] = []
    for runtime, store_path, extractor in (
        ("codex", codex_sessions_dir, extract_codex_sessions),
        ("claude-code", claude_projects_dir, extract_claude_project_sessions),
        ("opencode", opencode_conversations_dir, extract_opencode_sessions),
        ("github-copilot", copilot_conversations_dir, extract_copilot_sessions),
    ):
        runtime_records, status = extract_runtime_store(
            runtime=runtime,
            store_path=store_path,
            errors=errors,
            extractor=extractor,
        )
        records.extend(runtime_records)
        runtime_statuses.append(status)
    records = dedupe_records(records)
    return {
        "metadata": build_metadata(records, errors, runtime_statuses),
        "records": records,
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract a portable profilera corpus.json envelope.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=default_output_path(),
        help="corpus.json path to write (default: PROFILERA_PROFILE_DIR/intermediate/corpus.json)",
    )
    parser.add_argument(
        "--project-root",
        action="append",
        type=Path,
        default=[],
        help="project root to scan for instruction docs and config signals; repeatable",
    )
    parser.add_argument(
        "--codex-sessions-dir",
        type=Path,
        default=Path.home() / ".codex" / "sessions",
        help="Codex sessions directory to scan (default: ~/.codex/sessions)",
    )
    parser.add_argument(
        "--claude-projects-dir",
        type=Path,
        default=Path.home() / ".claude" / "projects",
        help="Claude Code project JSONL directory to scan (default: ~/.claude/projects)",
    )
    parser.add_argument(
        "--opencode-conversations-dir",
        type=Path,
        default=None,
        help="OpenCode opencode.db file or directory (default: opencode db path when available)",
    )
    parser.add_argument(
        "--copilot-conversations-dir",
        type=Path,
        default=None,
        help="GitHub Copilot session-store.db file or directory (default: COPILOT_HOME or ~/.copilot)",
    )
    parser.add_argument(
        "--no-codex",
        action="store_true",
        help="skip Codex session extraction",
    )
    parser.add_argument(
        "--no-claude",
        action="store_true",
        help="skip Claude Code session extraction",
    )
    parser.add_argument(
        "--no-opencode",
        action="store_true",
        help="skip OpenCode runtime discovery",
    )
    parser.add_argument(
        "--no-copilot",
        action="store_true",
        help="skip GitHub Copilot runtime discovery",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    project_roots = args.project_root or [Path.cwd()]
    corpus = build_corpus(
        project_roots=project_roots,
        codex_sessions_dir=None if args.no_codex else args.codex_sessions_dir,
        claude_projects_dir=None if args.no_claude else args.claude_projects_dir,
        opencode_conversations_dir=(
            None
            if args.no_opencode
            else args.opencode_conversations_dir or resolve_opencode_db_path()
        ),
        copilot_conversations_dir=(
            None if args.no_copilot else args.copilot_conversations_dir or resolve_copilot_store_path()
        ),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(corpus, indent=2, sort_keys=False) + "\n", encoding="utf-8")
    total = corpus["metadata"]["total_records"]
    family_bits = ", ".join(
        f"{name}={summary['count']}"
        for name, summary in corpus["metadata"]["families"].items()
    )
    print(f"wrote corpus: {args.output} ({total} records; {family_bits})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
