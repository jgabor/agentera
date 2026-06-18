#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Generated extract-corpus wrapper — TypeScript is authoritative.

DO NOT EDIT. Regenerate with:
  node packages/cli/scripts/generate-extract-corpus-parity.mjs --write
  pnpm -C packages/cli run bundle:data
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# GENERATED constants synced from packages/cli/src/analytics/extractCorpus/core.ts
ADAPTER_VERSION = "agentera-v2-corpus-1"
MAX_SQLITE_ROWS = 100000
MAX_SQLITE_SESSIONS = 60
MAX_TOOL_ARG_TEXT = 500
COPILOT_SPARSE_REMEDIATION = "/chronicle reindex"
RUNTIME_STORE_GLOBS = {
    "codex": "*.jsonl",
    "claude-code": "*.jsonl",
    "cursor": "*.jsonl",
    "cursor-agent": "store.db",
    "opencode": "opencode.db",
    "github-copilot": "session-store.db"
}
FAMILIES = ["instruction_document","history_prompt","conversation_turn","tool_call","project_config_signal"]

REPO_ROOT = Path(__file__).resolve().parents[1]
PROBE_SCRIPT = REPO_ROOT / "packages/cli/scripts/extract-corpus-parity-probe.mjs"


def _run_ts_probe(db_path: Path) -> dict:
    proc = subprocess.run(
        ["node", str(PROBE_SCRIPT), "--opencode", str(db_path)],
        cwd=str(REPO_ROOT),
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "extract-corpus parity probe failed")
    return json.loads(proc.stdout)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) >= 2 and args[0] == "--parity-probe-opencode":
        snapshot = _run_ts_probe(Path(args[1]))
        print(json.dumps(snapshot, indent=2, sort_keys=True))
        return 0
    sys.stderr.write(
        "extract_corpus.py is a generated TypeScript wrapper. "
        "Use 'agentera report refresh --consent local-history' for extraction, "
        "or --parity-probe-opencode <opencode.db> for parity probes.\n"
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
