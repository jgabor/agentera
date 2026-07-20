#!/usr/bin/env node
/**
 * Sync extract-corpus parity surfaces from the TypeScript source of truth.
 *
 * Writes:
 *   - packages/cli/test/analytics/fixtures/extract-corpus-parity-manifest.json
 *   - packages/cli/bundle/extract-corpus-parity.json (when bundle dir exists)
 *   - scripts/extract_corpus.py (generated Python-visible wrapper)
 *
 * Exits non-zero when the committed manifest would drift without an intentional
 * regen (`node packages/cli/scripts/generate-extract-corpus-parity.mjs --write`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const fixturePath = path.join(pkgRoot, "test/analytics/fixtures/extract-corpus-parity-manifest.json");
const bundleManifestPath = path.join(pkgRoot, "bundle/extract-corpus-parity.json");
const pythonPath = path.join(repoRoot, "scripts/extract_corpus.py");
const distParity = path.join(pkgRoot, "dist/analytics/extractCorpus/extractCorpusParity.js");
const writeMode = process.argv.includes("--write");

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function ensureBuilt() {
  if (fs.existsSync(distParity)) return;
  const build = spawnSync("pnpm", ["-C", pkgRoot, "run", "build"], { stdio: "inherit" });
  if (build.status !== 0) {
    console.error("generate-extract-corpus-parity: build failed");
    process.exit(build.status ?? 1);
  }
}

function loadManifest() {
  ensureBuilt();
  return import(pathToFileUrl(distParity)).then((mod) => mod.buildExtractCorpusParityManifest());
}

function pathToFileUrl(p) {
  return new URL(`file://${p.split(path.sep).join("/")}`).href;
}

function renderPythonWrapper(manifest) {
  return `#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Generated independent Python parity oracle for the TypeScript extractor.

TypeScript owns the production extractor and synchronized constants. This
restricted oracle independently implements only the committed OpenCode parity
fixture contract so cross-language drift remains observable.

DO NOT EDIT. Regenerate with:
  node packages/cli/scripts/generate-extract-corpus-parity.mjs --write
  pnpm -C packages/cli run bundle:data
"""

from __future__ import annotations

from datetime import datetime, timezone
import json
import sqlite3
import sys
from pathlib import Path

# GENERATED constants synced from packages/cli/src/analytics/extractCorpus/core.ts
ADAPTER_VERSION = ${JSON.stringify(manifest.adapter_version)}
MAX_SQLITE_ROWS = ${manifest.max_sqlite_rows}
MAX_SQLITE_SESSIONS = ${manifest.max_sqlite_sessions}
MAX_TOOL_ARG_TEXT = ${manifest.max_tool_arg_text}
COPILOT_SPARSE_REMEDIATION = ${JSON.stringify(manifest.copilot_sparse_remediation)}
RUNTIME_STORE_GLOBS = ${JSON.stringify(manifest.runtime_store_globs, null, 4).replaceAll("\n", "\n")}
FAMILIES = ${JSON.stringify(manifest.families)}

_REQUIRED_TABLES = ("session", "message", "part")
_SIGNAL_WORDS = {
    "decide", "decision", "prefer", "preference", "instead", "avoid",
    "should", "trade", "off", "scope", "plan", "commit", "review", "fix",
    "why", "question", "blocked", "stuck", "approve", "reject", "change",
    "keep", "remove",
}


def _iso_timestamp(value: object) -> str | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, (int, float)):
        numeric = float(value)
        if numeric > 10_000_000_000:
            numeric /= 1000
        return datetime.fromtimestamp(numeric, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return None


def _is_signal(text: str) -> bool:
    words = set("".join(char if char.isalpha() else " " for char in text.lower()).split())
    return bool(words & _SIGNAL_WORDS) or "do not" in text.lower() or "don't" in text.lower()


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _require_fixture_schema(conn: sqlite3.Connection) -> None:
    tables = {str(row[0]) for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    missing = [table for table in _REQUIRED_TABLES if table not in tables]
    if missing:
        raise ValueError(f"missing opencode tables: {', '.join(missing)}")
    required = {
        "session": {"id", "time_created"},
        "message": {"id", "sessionID", "role", "time_created", "content"},
        "part": {"messageID", "type", "text", "data", "time_created"},
    }
    for table, columns in required.items():
        missing_columns = sorted(columns - _columns(conn, table))
        if missing_columns:
            raise ValueError(f"missing opencode {table} columns: {', '.join(missing_columns)}")


def _python_opencode_snapshot(db_path: Path) -> dict:
    if not db_path.is_file():
        raise FileNotFoundError(f"missing opencode db at {db_path}")
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as conn:
        _require_fixture_schema(conn)
        session_times = [
            timestamp
            for (value,) in conn.execute(
                "SELECT time_created FROM session ORDER BY time_created DESC, id DESC LIMIT ?",
                (MAX_SQLITE_SESSIONS,),
            )
            if (timestamp := _iso_timestamp(value)) is not None
        ]
        rows = conn.execute(
            """
            SELECT m.id, m.role, m.time_created, m.content,
                   p.type, p.text, p.data, p.time_created
            FROM message m
            JOIN session s ON m.sessionID = s.id
            LEFT JOIN part p ON p.messageID = m.id
            ORDER BY COALESCE(p.time_created, m.time_created), m.id, p.id
            LIMIT ?
            """,
            (MAX_SQLITE_ROWS,),
        )

        messages: dict[str, dict] = {}
        for message_id, role, message_time, message_text, part_type, part_text, part_data, part_time in rows:
            item = messages.setdefault(
                str(message_id),
                {"role": str(role or "").lower(), "timestamp": _iso_timestamp(message_time), "parts": [], "tools": []},
            )
            text = part_text or message_text
            if isinstance(text, str) and text:
                item["parts"].append(text)
            data = {}
            if isinstance(part_data, str) and part_data:
                try:
                    parsed = json.loads(part_data)
                    if isinstance(parsed, dict):
                        data = parsed
                except json.JSONDecodeError:
                    pass
            if part_type == "tool" or data.get("tool"):
                item["tools"].append(_iso_timestamp(part_time) or item["timestamp"])

        extraction_times: list[str] = []
        for item in messages.values():
            if item["role"] not in {"user", "assistant"}:
                continue
            content = "\\n".join(item["parts"])
            if content:
                extraction_times.append(item["timestamp"])
            extraction_times.extend(timestamp for timestamp in item["tools"] if timestamp)
            if item["role"] == "user" and content and _is_signal(content):
                extraction_times.append(item["timestamp"])

    extraction_times = [timestamp for timestamp in extraction_times if timestamp]
    coverage = {
        "record_count": 0,
        "earliest": min(session_times, default=None),
        "latest": max(session_times, default=None),
    }
    extraction = {
        "record_count": len(extraction_times),
        "earliest": min(extraction_times, default=None),
        "latest": max(extraction_times, default=None),
    }
    return {
        "record_count": extraction["record_count"],
        "earliest": coverage["earliest"],
        "latest": coverage["latest"],
        "probe_shapes": {
            "coverage": coverage,
            "extraction": extraction,
            "discovery": {"status": "available", "file_count": 1},
        },
    }


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) >= 2 and args[0] == "--parity-probe-opencode":
        try:
            snapshot = _python_opencode_snapshot(Path(args[1]))
        except (OSError, sqlite3.Error, ValueError) as error:
            sys.stderr.write(f"extract-corpus parity: {error}\\n")
            return 1
        print(json.dumps(snapshot, indent=2, sort_keys=True))
        return 0
    sys.stderr.write(
        "extract_corpus.py is a generated independent parity oracle. "
        "Use 'agentera report refresh --consent local-history' for extraction, "
        "or --parity-probe-opencode <opencode.db> for parity probes.\\n"
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

async function main() {
  const manifest = await loadManifest();
  const rendered = stableJson(manifest);
  const python = renderPythonWrapper(manifest);

  if (writeMode) {
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, rendered, "utf8");
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
    fs.writeFileSync(pythonPath, python, "utf8");
    fs.chmodSync(pythonPath, 0o755);
    if (fs.existsSync(path.dirname(bundleManifestPath))) {
      fs.writeFileSync(bundleManifestPath, rendered, "utf8");
    }
    console.log("generate-extract-corpus-parity: wrote manifest, bundle copy, and scripts/extract_corpus.py");
    return;
  }

  const errors = [];
  if (!fs.existsSync(fixturePath)) {
    errors.push(`missing committed manifest at ${path.relative(repoRoot, fixturePath)}; run with --write`);
  } else {
    const committed = fs.readFileSync(fixturePath, "utf8");
    if (committed !== rendered) {
      errors.push(
        `extract-corpus parity manifest drift: ${path.relative(repoRoot, fixturePath)} is stale; ` +
          "run `node packages/cli/scripts/generate-extract-corpus-parity.mjs --write`",
      );
    }
  }

  if (!fs.existsSync(pythonPath)) {
    errors.push(`missing generated Python wrapper at ${path.relative(repoRoot, pythonPath)}; run with --write`);
  } else {
    const currentPy = fs.readFileSync(pythonPath, "utf8");
    if (currentPy !== python) {
      errors.push(
        `extract-corpus Python wrapper drift: ${path.relative(repoRoot, pythonPath)} is stale; ` +
          "run `node packages/cli/scripts/generate-extract-corpus-parity.mjs --write`",
      );
    }
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`generate-extract-corpus-parity: ${err}`);
    process.exit(1);
  }
  console.log("generate-extract-corpus-parity: manifest and Python wrapper are in sync with TypeScript");
}

main().catch((err) => {
  console.error(`generate-extract-corpus-parity: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
