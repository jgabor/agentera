#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Tier 2 eval runner for agentera skill smoke testing.

Invokes each skill via `claude -p` (Claude Code pipe mode) with a minimal
trigger prompt and checks for crashes / non-zero exit codes.  Scope is
crash/error detection only — output correctness is not evaluated.

Run from repo root:
    python3 scripts/eval_skills.py                    # run all skills
    python3 scripts/eval_skills.py --skill realisera  # run one skill
    python3 scripts/eval_skills.py --dry-run           # list skills + prompts
    python3 scripts/eval_skills.py --parallel N        # N concurrent workers
    python3 scripts/eval_skills.py --timeout 60        # per-skill timeout (s)
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent

# Minimal trigger prompt per skill — sufficient to activate the skill without
# producing a large or expensive response.
TRIGGER_PROMPTS: dict[str, str] = {
    "dokumentera": "Audit the documentation for this project.",
    "hej": "Start a new session and give me a status briefing on this project.",
    "inspektera": "Run a codebase health audit.",
    "inspirera": "Analyze https://example.com and map patterns to this project.",
    "optimera": "Optimize test suite execution time.",
    "planera": "Plan the next feature for this project.",
    "profilera": "Generate a decision profile from session history.",
    "realisera": "Run one autonomous development cycle.",
    "resonera": "Deliberate on whether to add a new dependency.",
    "visionera": "Create a vision document for this project.",
    "visualisera": "Create a visual identity system for this project.",
}

DEFAULT_TIMEOUT = 120   # seconds per skill
DEFAULT_PARALLEL = 1    # sequential by default


# ---------------------------------------------------------------------------
# Skill discovery
# ---------------------------------------------------------------------------

def _parse_frontmatter_name(text: str) -> str | None:
    """Return the 'name' field from YAML frontmatter, or None if absent."""
    if not text.startswith("---"):
        return None
    end = text.find("---", 3)
    if end == -1:
        return None
    block = text[3:end]
    m = re.search(r"^name:\s*(.+)", block, re.MULTILINE)
    return m.group(1).strip() if m else None


def discover_skills() -> list[dict[str, str]]:
    """Return a sorted list of {name, prompt} dicts for all discovered skills.

    Falls back to the directory name when frontmatter is absent.
    """
    skills_dir = REPO_ROOT / "skills"
    entries: list[dict[str, str]] = []
    for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
        text = skill_md.read_text(encoding="utf-8")
        name = _parse_frontmatter_name(text) or skill_md.parent.name
        prompt = TRIGGER_PROMPTS.get(name, f"Invoke the {name} skill.")
        entries.append({"name": name, "prompt": prompt})
    return entries


# ---------------------------------------------------------------------------
# Invocation
# ---------------------------------------------------------------------------

def _invoke_skill(name: str, prompt: str, timeout: int) -> dict:
    """Run `claude -p --output-format json` with *prompt* on stdin.

    Returns a result dict suitable for inclusion in the JSON report:
        {"skill": str, "status": "pass"|"fail", "duration_s": float,
         "error": str|None}
    """
    start = time.monotonic()
    error: str | None = None
    status = "pass"

    try:
        result = subprocess.run(
            ["claude", "-p", "--output-format", "json"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(REPO_ROOT),
        )
        duration = time.monotonic() - start

        if result.returncode != 0:
            stderr_snippet = result.stderr.strip()[:300] if result.stderr else ""
            stdout_snippet = result.stdout.strip()[:300] if result.stdout else ""
            detail = stderr_snippet or stdout_snippet or "(no output)"
            error = f"Exit code {result.returncode}: {detail}"
            status = "fail"
        else:
            # Scan stdout for obvious error indicators even when exit code is 0.
            combined = (result.stdout or "") + (result.stderr or "")
            error_indicators = [
                r"\bTraceback \(most recent call last\)\b",
                r"\bError:\s",
                r"\bfatal error\b",
                r'"is_error"\s*:\s*true',
            ]
            for pattern in error_indicators:
                m = re.search(pattern, combined, re.IGNORECASE)
                if m:
                    snippet = combined[max(0, m.start() - 20) : m.end() + 80].strip()
                    error = f"Error indicator in output: {snippet[:300]}"
                    status = "fail"
                    break

    except subprocess.TimeoutExpired:
        duration = time.monotonic() - start
        error = f"Timed out after {timeout}s"
        status = "fail"
    except FileNotFoundError:
        # `claude` binary not found — should have been checked before entering
        # this function, but guard here for safety.
        duration = time.monotonic() - start
        error = "'claude' not found on PATH"
        status = "fail"
    except Exception as exc:  # noqa: BLE001
        duration = time.monotonic() - start
        error = f"Unexpected error: {exc}"
        status = "fail"

    return {
        "skill": name,
        "status": status,
        "duration_s": round(duration, 2),
        "error": error,
    }


# ---------------------------------------------------------------------------
# Top-level runners
# ---------------------------------------------------------------------------

def run_skills(
    skills: list[dict[str, str]],
    timeout: int,
    parallel: int,
) -> list[dict]:
    """Invoke all skills, possibly in parallel, and return result dicts."""
    results: list[dict] = []

    if parallel <= 1:
        for entry in skills:
            result = _invoke_skill(entry["name"], entry["prompt"], timeout)
            results.append(result)
    else:
        with ProcessPoolExecutor(max_workers=parallel) as executor:
            futures = {
                executor.submit(_invoke_skill, entry["name"], entry["prompt"], timeout): entry["name"]
                for entry in skills
            }
            # Collect in completion order; re-sort by original order afterwards.
            completed: dict[str, dict] = {}
            for future in as_completed(futures):
                skill_name = futures[future]
                try:
                    completed[skill_name] = future.result()
                except Exception as exc:  # noqa: BLE001
                    completed[skill_name] = {
                        "skill": skill_name,
                        "status": "fail",
                        "duration_s": 0.0,
                        "error": f"Executor error: {exc}",
                    }
        # Preserve original order.
        name_order = [e["name"] for e in skills]
        results = [completed[n] for n in name_order if n in completed]

    return results


# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def build_report(results: list[dict]) -> dict:
    passed = sum(1 for r in results if r["status"] == "pass")
    failed = len(results) - passed
    return {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "skills_tested": len(results),
        "passed": passed,
        "failed": failed,
        "results": results,
    }


def build_dry_run(skills: list[dict[str, str]]) -> dict:
    return {
        "mode": "dry-run",
        "skills": [
            {"name": s["name"], "prompt": s["prompt"]}
            for s in skills
        ],
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Tier 2 eval runner: smoke-tests agentera skills via `claude -p`. "
            "Detects crashes and non-zero exit codes only."
        )
    )
    parser.add_argument(
        "--skill",
        metavar="NAME",
        help="Run a single named skill instead of all skills.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List skills and prompts as JSON without invoking claude.",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=DEFAULT_PARALLEL,
        metavar="N",
        help=f"Number of concurrent skill invocations (default: {DEFAULT_PARALLEL}).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_TIMEOUT,
        metavar="SECONDS",
        help=f"Per-skill timeout in seconds (default: {DEFAULT_TIMEOUT}).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    # Discover skills from the filesystem.
    all_skills = discover_skills()
    if not all_skills:
        print(
            "ERROR: No SKILL.md files found under skills/",
            file=sys.stderr,
        )
        return 1

    # Filter to a single skill if requested.
    if args.skill:
        matched = [s for s in all_skills if s["name"] == args.skill]
        if not matched:
            known = ", ".join(s["name"] for s in all_skills)
            print(
                f"ERROR: Unknown skill '{args.skill}'. Known skills: {known}",
                file=sys.stderr,
            )
            return 1
        skills_to_run = matched
    else:
        skills_to_run = all_skills

    # Dry-run: print skills + prompts and exit.
    if args.dry_run:
        print(json.dumps(build_dry_run(skills_to_run), indent=2))
        return 0

    # Verify that `claude` is available before spawning subprocesses.
    if shutil.which("claude") is None:
        print(
            "ERROR: 'claude' not found on PATH. "
            "Install Claude Code and ensure the 'claude' binary is accessible.",
            file=sys.stderr,
        )
        return 1

    # Run the evals.
    results = run_skills(skills_to_run, timeout=args.timeout, parallel=args.parallel)
    report = build_report(results)
    print(json.dumps(report, indent=2))

    # Exit 1 if any skill failed.
    return 0 if report["failed"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
