#!/usr/bin/env python3
"""Pre-flight token probe for the optimera harness.

Measures the total input context (cache_read + cache_creation + input_tokens)
for both harness conditions via minimal claude -p probes. Each probe sends a
1-token user message ("x") with --max-turns 1, capturing the first assistant
message's usage counters.

The probe replicates the harness's hermeticity flags (--strict-mcp-config,
--agents, --setting-sources, --tools) so the measurement reflects the same
tool definitions and system prompt surface as the real run.

Modes:
  standalone    Print a JSON summary of both conditions to stdout.
  harness       Write preflight.json to a run directory for the harness
                composer to pick up.
  tier1         Measure the Tier 1 primary metric: exact token count of
                SKILL.md + references/contract.md via the count_tokens API.
                Zero variance, deterministic. Writes tier1.json (and
                preflight.json for backward compatibility) when --run-dir
                is specified.

Why this exists: the harness's primary metric (peak_context + output_total)
is dominated by run-to-run behavioral variance (13-20%). The pre-flight
probe measures the FIXED cost (system prompt + tool definitions) with zero
variance, enabling exact comparison of SKILL.md changes without a full $3
Docker run. A SKILL.md edit that adds 500 bytes should show a ~125 token
increase in the probe, even though the full-run metric can't detect it.

The Tier 1 metric (--tier1) goes further: it directly counts SKILL.md and
contract.md tokens via the Anthropic count_tokens API, giving an exact,
sub-token-variance primary metric for the Decision 29 two-tier design.

Limitation: prompt caching means the probe's total_context includes the
Claude Code base system prompt. The delta between conditions (with - without)
isolates the skill's contribution. Absolute per-file token counts require
an API key (ANTHROPIC_API_KEY), which this script supports when available.

Stdlib-only.

Usage:
    python3 count_prompt_tokens.py --skill-dir skills/realisera
    python3 count_prompt_tokens.py --skill-dir skills/realisera --run-dir .optimera/runs/20260412T072605Z
    python3 count_prompt_tokens.py --skill-dir skills/realisera --tier1
    python3 count_prompt_tokens.py --skill-dir skills/realisera --tier1 --run-dir .optimera/runs/20260412T072605Z
    python3 count_prompt_tokens.py --file some_prompt.txt
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


CLAUDE_BIN = os.environ.get("CLAUDE_BIN", "/opt/claude-code/bin/claude")
DEFAULT_MODEL = "claude-sonnet-4-6"

# Same hermeticity flags as the harness condition runner.
HERMETICITY_FLAGS = [
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--agents", "{}",
    "--setting-sources", "",
    "--tools", "Read", "Glob", "Grep", "Bash", "Skill",
]


def _probe_via_cli(
    system_prompt: str | None,
    model: str,
    extra_flags: list[str] | None = None,
) -> dict[str, int]:
    """Run a minimal claude -p probe and return usage from the first assistant message."""
    cmd = [
        CLAUDE_BIN, "-p", "x",
        "--model", model,
        "--output-format", "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--dangerously-skip-permissions",
        "--max-turns", "1",
    ]

    tmp_path = None
    if system_prompt is not None:
        tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False)
        tmp.write(system_prompt)
        tmp.close()
        tmp_path = tmp.name
        cmd.extend(["--system-prompt", tmp_path])

    cmd.extend(HERMETICITY_FLAGS)
    if extra_flags:
        cmd.extend(extra_flags)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    finally:
        if tmp_path:
            os.unlink(tmp_path)

    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "assistant":
            continue
        usage = (event.get("message") or {}).get("usage") or {}
        return {
            "input_tokens": usage.get("input_tokens", 0) or 0,
            "cache_read": usage.get("cache_read_input_tokens", 0) or 0,
            "cache_create": usage.get("cache_creation_input_tokens", 0) or 0,
            "total_context": (
                (usage.get("input_tokens", 0) or 0)
                + (usage.get("cache_read_input_tokens", 0) or 0)
                + (usage.get("cache_creation_input_tokens", 0) or 0)
            ),
        }

    return {"error": 1, "input_tokens": 0, "cache_read": 0, "cache_create": 0, "total_context": 0}


def _count_via_api(text: str, model: str) -> int | None:
    """Use the Anthropic count_tokens API if ANTHROPIC_API_KEY is set. Returns token count or None."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None

    payload = json.dumps({
        "model": model,
        "system": text,
        "messages": [{"role": "user", "content": "x"}],
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages/count_tokens",
        data=payload,
        headers={
            "x-api-key": api_key,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            return data.get("input_tokens")
    except (urllib.error.URLError, json.JSONDecodeError, KeyError):
        return None


def measure_file(path: str, model: str) -> dict[str, int | str | None]:
    """Measure a single file's token cost. Uses API if available, else estimates."""
    with open(path) as fh:
        text = fh.read()

    byte_count = len(text.encode("utf-8"))
    api_tokens = _count_via_api(text, model)

    return {
        "path": path,
        "bytes": byte_count,
        "tokens_api": api_tokens,
        "tokens_est": byte_count // 4,
        "source": "api" if api_tokens is not None else "estimate",
    }


def measure_conditions(
    skill_dir: str,
    model: str,
) -> dict[str, object]:
    """Run both conditions and compute the differential."""

    # Condition 1: without (no plugin)
    without = _probe_via_cli(system_prompt=None, model=model)

    # Condition 2: with (plugin mounted via --plugin-dir)
    # We can't mount a plugin-dir in a bare probe (it needs the marketplace
    # structure). Instead, we load the SKILL.md as the system prompt to
    # approximate the delta.
    skill_md_path = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(skill_md_path):
        return {"error": f"SKILL.md not found at {skill_md_path}"}

    with open(skill_md_path) as fh:
        skill_text = fh.read()

    with_skill = _probe_via_cli(system_prompt=skill_text, model=model)

    # File-level measurements
    files = {}
    for name in ("SKILL.md", "references/contract.md"):
        fpath = os.path.join(skill_dir, name)
        if os.path.isfile(fpath):
            files[name] = measure_file(fpath, model)

    delta = with_skill["total_context"] - without["total_context"]

    return {
        "without": without,
        "with_skill": with_skill,
        "delta_total_context": delta,
        "files": files,
        "model": model,
        "note": (
            "delta may be near-zero due to prompt caching. "
            "File-level tokens_api is exact when ANTHROPIC_API_KEY is set."
        ),
    }


def measure_tier1(skill_dir: str, model: str) -> dict:
    """Measure Tier 1 metric: sum of SKILL.md + contract.md tokens.

    Returns dict with:
      - tier1_total: int (sum of token counts)
      - files: dict mapping filename to {tokens, source, bytes}
      - model: str
      - error: str (if API unavailable and no fallback)
    """
    tier1_files = {}
    tier1_total = 0
    error = None

    for name in ("SKILL.md", "references/contract.md"):
        fpath = os.path.join(skill_dir, name)
        if not os.path.isfile(fpath):
            continue
        measurement = measure_file(fpath, model)
        tokens = measurement.get("tokens_api") or measurement.get("tokens_est") or 0
        source = measurement.get("source", "estimate")
        byte_count = measurement.get("bytes", 0)
        tier1_files[name] = {
            "tokens": tokens,
            "source": source,
            "bytes": byte_count,
        }
        tier1_total += tokens

    if not tier1_files:
        error = f"no measurable files found in {skill_dir}"
        return {"tier1_total": 0, "files": {}, "model": model, "error": error}

    result: dict = {
        "tier1_total": tier1_total,
        "files": tier1_files,
        "model": model,
    }
    if error:
        result["error"] = error
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description="Pre-flight token probe for optimera harness")
    group = ap.add_mutually_exclusive_group(required=True)
    group.add_argument("--skill-dir", help="Path to skill directory (e.g., skills/realisera)")
    group.add_argument("--file", help="Measure a single file")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="Model ID")
    ap.add_argument("--run-dir", help="Write output file(s) to this run directory")
    ap.add_argument(
        "--tier1",
        action="store_true",
        default=False,
        help=(
            "Measure Tier 1 primary metric: exact token count of SKILL.md + "
            "references/contract.md. Requires --skill-dir. Writes tier1.json "
            "and preflight.json when --run-dir is given, otherwise prints to stdout."
        ),
    )
    args = ap.parse_args()

    if args.tier1 and args.file:
        ap.error("--tier1 requires --skill-dir, not --file")

    if args.file:
        result = measure_file(args.file, args.model)
        output = json.dumps(result, indent=2)
        if args.run_dir:
            out_path = os.path.join(args.run_dir, "preflight.json")
            with open(out_path, "w") as fh:
                fh.write(output + "\n")
            print(f"wrote {out_path}", file=sys.stderr)
        else:
            print(output)
        return 0

    # --skill-dir path
    if args.tier1:
        # Tier 1: measure SKILL.md + contract.md via count_tokens API
        tier1_result = measure_tier1(args.skill_dir, args.model)
        tier1_output = json.dumps(tier1_result, indent=2)

        # Also produce the standard preflight data for backward compatibility
        preflight_result = measure_conditions(args.skill_dir, args.model)
        preflight_output = json.dumps(preflight_result, indent=2)

        if args.run_dir:
            tier1_path = os.path.join(args.run_dir, "tier1.json")
            with open(tier1_path, "w") as fh:
                fh.write(tier1_output + "\n")
            print(f"wrote {tier1_path}", file=sys.stderr)

            preflight_path = os.path.join(args.run_dir, "preflight.json")
            with open(preflight_path, "w") as fh:
                fh.write(preflight_output + "\n")
            print(f"wrote {preflight_path}", file=sys.stderr)
        else:
            print(tier1_output)

        if tier1_result.get("error"):
            print(f"tier1 error: {tier1_result['error']}", file=sys.stderr)
            return 1
        return 0

    # Standard --skill-dir without --tier1
    result = measure_conditions(args.skill_dir, args.model)
    output = json.dumps(result, indent=2)

    if args.run_dir:
        out_path = os.path.join(args.run_dir, "preflight.json")
        with open(out_path, "w") as fh:
            fh.write(output + "\n")
        print(f"wrote {out_path}", file=sys.stderr)
    else:
        print(output)

    return 0


if __name__ == "__main__":
    sys.exit(main())
