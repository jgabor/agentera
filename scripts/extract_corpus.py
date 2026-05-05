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
``instruction_document``, ``history_prompt``, ``conversation_turn``, and
``project_config_signal``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

ADAPTER_VERSION = "agentera-v2-corpus-1"
FAMILIES = (
    "instruction_document",
    "history_prompt",
    "conversation_turn",
    "project_config_signal",
)
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
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "agentera"
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA", str(Path.home() / "AppData" / "Roaming"))
        return Path(appdata) / "agentera"
    xdg = os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local" / "share"))
    return Path(xdg) / "agentera"


def default_output_path() -> Path:
    return default_profile_dir() / "intermediate" / "corpus.json"


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


def dedupe_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_id: dict[str, dict[str, Any]] = {}
    for item in records:
        by_id[item["source_id"]] = item
    return sorted(
        by_id.values(),
        key=lambda item: (
            item.get("timestamp", ""),
            item.get("source_kind", ""),
            item.get("source_id", ""),
        ),
    )


def build_metadata(records: list[dict[str, Any]], errors: list[str]) -> dict[str, Any]:
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
        "total_records": len(records),
        "errors": errors,
    }
    return metadata


def build_corpus(
    *,
    project_roots: list[Path],
    codex_sessions_dir: Path | None,
    claude_projects_dir: Path | None,
) -> dict[str, Any]:
    errors: list[str] = []
    normalized_roots = [root.resolve() for root in project_roots if root.exists()]
    for root in project_roots:
        if not root.exists():
            errors.append(f"{root}: project root does not exist")

    records: list[dict[str, Any]] = []
    records.extend(extract_instruction_documents(normalized_roots, errors))
    records.extend(extract_project_config_signals(normalized_roots, errors))
    records.extend(extract_codex_sessions(codex_sessions_dir, errors))
    records.extend(extract_claude_project_sessions(claude_projects_dir, errors))
    records = dedupe_records(records)
    return {
        "metadata": build_metadata(records, errors),
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
        "--no-codex",
        action="store_true",
        help="skip Codex session extraction",
    )
    parser.add_argument(
        "--no-claude",
        action="store_true",
        help="skip Claude Code session extraction",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    project_roots = args.project_root or [Path.cwd()]
    corpus = build_corpus(
        project_roots=project_roots,
        codex_sessions_dir=None if args.no_codex else args.codex_sessions_dir,
        claude_projects_dir=None if args.no_claude else args.claude_projects_dir,
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
