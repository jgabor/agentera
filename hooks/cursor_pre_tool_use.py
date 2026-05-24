#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyyaml"]
# ///
"""Cursor preToolUse hook: block invalid reconstructable Write/Edit candidates."""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from validate_artifact import HookCliAdapter


def main() -> int:
    raw = sys.stdin.read()
    adapter = HookCliAdapter()
    rc, violations = adapter.run(raw)
    if rc == 2:
        reason = "; ".join(violations) if violations else "artifact validation failed"
        print(
            json.dumps(
                {
                    "permission": "deny",
                    "user_message": reason,
                    "agent_message": reason,
                }
            )
        )
        return 0
    print(json.dumps({"permission": "allow"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
