#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Spec linter for agentera SKILL.md files.

Validates all 12 SKILL.md files against the spec
(SPEC.md). Checks frontmatter, confidence scales,
severity levels, decision labels, artifact path resolution, profile
consumption, cross-skill integration, safety rails, artifact format
contracts, exit signals, loop guard, em-dashes, hard wraps,
spec_sections declaration, context file existence, context file
freshness, platform annotation validation, and pre-dispatch commit
gate enforcement.

Run from repo root:
    python3 scripts/validate_spec.py
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REQUIRED_REFS: dict[str, list[str]] = {
    "hej": [
        "visionera",
        "resonera",
        "planera",
        "realisera",
        "inspektera",
        "optimera",
        "dokumentera",
        "visualisera",
        "profilera",
        "inspirera",
        "orkestrera",
    ],
    "inspirera": ["realisera", "optimera", "visionera", "resonera", "profilera"],
    "profilera": ["realisera", "optimera", "inspirera", "resonera", "inspektera"],
    "realisera": [
        "visionera",
        "optimera",
        "inspirera",
        "resonera",
        "planera",
        "inspektera",
        "profilera",
    ],
    "optimera": ["realisera", "resonera", "inspektera", "profilera"],
    "resonera": [
        "realisera",
        "optimera",
        "inspirera",
        "profilera",
        "planera",
        "inspektera",
    ],
    "inspektera": ["realisera", "resonera", "planera", "optimera", "profilera"],
    "planera": [
        "resonera",
        "realisera",
        "optimera",
        "inspektera",
        "profilera",
        "inspirera",
        "dokumentera",
    ],
    "visionera": [
        "realisera",
        "resonera",
        "profilera",
        "inspirera",
        "inspektera",
        "visualisera",
    ],
    "dokumentera": [
        "planera",
        "realisera",
        "inspektera",
        "visionera",
        "profilera",
    ],
    "visualisera": [
        "visionera",
        "realisera",
        "dokumentera",
        "inspektera",
        "profilera",
        "inspirera",
        "resonera",
    ],
    "orkestrera": [
        "planera",
        "realisera",
        "inspektera",
        "inspirera",
        "dokumentera",
        "profilera",
        "visionera",
        "resonera",
        "optimera",
        "visualisera",
    ],
}

SCRIPT_PATTERN_CONSUMERS = {
    "realisera",
    "optimera",
    "inspektera",
    "planera",
    "inspirera",
}

AUTONOMOUS_LOOP_SKILLS = {"realisera", "optimera", "orkestrera"}

# Artifact format contracts (spec section 4).
# Key = artifact name, value = (producer skill(s), key structural elements).
ARTIFACT_CONTRACTS: dict[str, tuple[list[str], list[str]]] = {
    "VISION.md": (
        ["visionera", "realisera"],
        ["North Star", "Who It's For", "Principles", "Direction", "Identity"],
    ),
    "DECISIONS.md": (
        ["resonera"],
        [
            "Question",
            "Context",
            "Alternatives",
            "Choice",
            "Reasoning",
            "Confidence",
            "Feeds into",
        ],
    ),
    "PLAN.md": (
        ["planera"],
        ["Status", "Depends on", "Acceptance"],
    ),
    "PROGRESS.md": (
        ["realisera"],
        ["Cycle", "What", "Commit", "Inspiration", "Discovered", "Next"],
    ),
    "TODO.md": (
        ["realisera", "inspektera"],
        ["Critical", "Degraded", "Normal", "Annoying", "Resolved"],
    ),
    "CHANGELOG.md": (
        ["realisera"],
        ["Unreleased", "Added", "Changed", "Fixed"],
    ),
    "HEALTH.md": (
        ["inspektera"],
        ["Dimensions", "Findings", "Overall", "Grades"],
    ),
    "OBJECTIVE.md": (
        ["optimera"],
        ["Metric", "Target", "Baseline", "Constraints"],
    ),
    "EXPERIMENTS.md": (
        ["optimera"],
        ["Hypothesis", "Method", "Result", "Conclusion"],
    ),
    "DOCS.md": (
        ["dokumentera"],
        ["Conventions", "Artifact Mapping", "Index"],
    ),
    "DESIGN.md": (
        ["visualisera"],
        [],  # Defined externally in DESIGN-spec.md
    ),
    "PROFILE.md": (
        ["profilera"],
        ["Category", "Decision", "conf"],
    ),
}


# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------

_USE_COLOR = sys.stdout.isatty()


def _green(text: str) -> str:
    return f"\033[32m{text}\033[0m" if _USE_COLOR else text


def _red(text: str) -> str:
    return f"\033[31m{text}\033[0m" if _USE_COLOR else text


def _yellow(text: str) -> str:
    return f"\033[33m{text}\033[0m" if _USE_COLOR else text


# ---------------------------------------------------------------------------
# Result accumulator
# ---------------------------------------------------------------------------


class Results:
    """Collects PASS / ERROR / WARN results and prints them."""

    def __init__(self) -> None:
        self.entries: list[
            tuple[str, str, str, str]
        ] = []  # (level, skill, check, detail)

    def ok(self, skill: str, check: str) -> None:
        self.entries.append(("PASS", skill, check, ""))

    def error(self, skill: str, check: str, detail: str) -> None:
        self.entries.append(("ERROR", skill, check, detail))

    def warn(self, skill: str, check: str, detail: str) -> None:
        self.entries.append(("WARN", skill, check, detail))

    @property
    def error_count(self) -> int:
        return sum(1 for level, *_ in self.entries if level == "ERROR")

    @property
    def warn_count(self) -> int:
        return sum(1 for level, *_ in self.entries if level == "WARN")

    def print(self) -> None:
        for level, skill, check, detail in self.entries:
            tag = {
                "PASS": _green("PASS "),
                "ERROR": _red("ERROR"),
                "WARN": _yellow("WARN "),
            }[level]
            line = f"{tag}  {skill:<14s} {check}"
            if detail:
                line += f"    {detail}"
            print(line)


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------


def parse_frontmatter(text: str) -> dict[str, str] | None:
    """Return frontmatter fields as a dict, or None if missing."""
    if not text.startswith("---"):
        return None
    end = text.find("---", 3)
    if end == -1:
        return None
    block = text[3:end].strip()
    result: dict[str, str] = {}
    current_key: str | None = None
    for line in block.splitlines():
        m = re.match(r"^(\w[\w-]*):\s*(.*)", line)
        if m:
            current_key = m.group(1)
            result[current_key] = m.group(2).strip()
        elif current_key and line.startswith("  "):
            # Continuation of a multi-line value.
            result[current_key] += " " + line.strip()
    return result


def extract_section(text: str, heading: str) -> str | None:
    """Extract content between a ## heading and the next ## heading."""
    pattern = re.compile(
        rf"^## {re.escape(heading)}\s*\n(.*?)(?=^## |\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(text)
    return m.group(1) if m else None


def extract_subsection(
    text: str, parent_heading: str, child_heading: str
) -> str | None:
    """Extract content of a ### subsection under a specific ## parent."""
    parent = extract_section(text, parent_heading)
    if parent is None:
        return None
    pattern = re.compile(
        rf"^### {re.escape(child_heading)}\s*\n(.*?)(?=^###? |\Z)",
        re.MULTILINE | re.DOTALL,
    )
    m = pattern.search(parent)
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# Individual checks
# ---------------------------------------------------------------------------


def check_frontmatter(skill: str, text: str, r: Results) -> None:
    """Check 1: YAML frontmatter with name and description."""
    fm = parse_frontmatter(text)
    if fm is None:
        r.error(skill, "frontmatter", "Missing or malformed YAML frontmatter")
        return
    if "name" not in fm:
        r.error(skill, "frontmatter", "Missing 'name' field")
    elif not re.fullmatch(r"[a-z][a-z0-9-]*", fm["name"]):
        r.error(skill, "frontmatter", f"Name '{fm['name']}' is not kebab-case")
    if "description" not in fm:
        r.error(skill, "frontmatter", "Missing 'description' field")
    if fm and "name" in fm and "description" in fm:
        if re.fullmatch(r"[a-z][a-z0-9-]*", fm.get("name", "")):
            r.ok(skill, "frontmatter")


def check_confidence_scale(skill: str, text: str, r: Results) -> None:
    """Check 2: Flag 0.0-1.0 scale confidence tier definitions."""
    # Pattern for tier boundary definitions like 0.85-0.95, 0.65-0.80, etc.
    tier_pattern = re.compile(r"0\.\d{2}-0\.\d{2}")
    # Pattern for inline conf metadata like conf:0.75
    conf_metadata_pattern = re.compile(r"conf:\s*0\.\d+")

    tier_matches = tier_pattern.findall(text)
    conf_matches = conf_metadata_pattern.findall(text)

    if tier_matches or conf_matches:
        details = []
        if tier_matches:
            details.append(f"0.0-1.0 tier boundaries: {', '.join(set(tier_matches))}")
        if conf_matches:
            details.append(f"0.0-1.0 conf metadata: {', '.join(set(conf_matches))}")
        r.error(skill, "confidence-scale", "; ".join(details))
    else:
        r.ok(skill, "confidence-scale")


def _find_severity_in_tables(text: str, non_canonical: set[str]) -> list[str]:
    """Pattern 1: Table rows within severity-related tables.

    Find tables whose header row contains "severity" or "level", then
    check body rows for non-canonical terms.
    """
    errors: list[str] = []
    for table_match in re.finditer(
        r"^(\|[^\n]*(?:severity|level)[^\n]*\|)\n\|[-| :]+\|\n((?:\|[^\n]*\n)*)",
        text,
        re.IGNORECASE | re.MULTILINE,
    ):
        table_body = table_match.group(2)
        for row in table_body.strip().splitlines():
            for term in non_canonical:
                if re.search(rf"\b{term}\b", row, re.IGNORECASE):
                    errors.append(
                        f"Non-canonical severity term '{term}' in table: "
                        f"{row.strip()[:80]}"
                    )
    return errors


def _find_severity_in_headings(text: str, non_canonical_re: str) -> list[str]:
    """Pattern 2: Headings that label findings by severity.

    e.g. "### [high] description" or "#### Finding — high (confidence: N)"
    Only match when the heading looks like a finding label (contains
    em-dash or brackets around the term).
    """
    errors: list[str] = []
    heading_pattern = re.compile(
        rf"^#+\s.*?(?:\[|[—–]\s*)({non_canonical_re})\b",
        re.IGNORECASE | re.MULTILINE,
    )
    for m in heading_pattern.finditer(text):
        term = m.group(1).lower()
        line = m.group(0).strip()
        errors.append(f"Non-canonical severity term '{term}' in heading: {line[:80]}")
    return errors


def _find_severity_in_section(text: str, non_canonical: set[str]) -> list[str]:
    """Pattern 3: Explicit severity label definitions in a severity section.

    e.g. "severity: high" or "- **Info** — minor" in a severity section.
    The em/en-dash variant requires the term on the same line and NOT
    followed by a hyphen (avoids "high-confidence" = certainty, not severity).
    For this pattern, require nearby severity context words on the same line
    or in the surrounding section.
    """
    errors: list[str] = []
    severity_section = extract_section(text, "Severity") or ""
    for section_text in [severity_section]:
        if not section_text:
            continue
        for term in non_canonical:
            if re.search(rf"\b{term}\b", section_text, re.IGNORECASE):
                # Find the line for context.
                for line in section_text.splitlines():
                    if re.search(rf"\b{term}\b", line, re.IGNORECASE):
                        errors.append(
                            f"Non-canonical severity term '{term}' in severity section: "
                            f"{line.strip()[:80]}"
                        )
                        break
    return errors


def _find_severity_in_mappings(text: str, non_canonical_re: str) -> list[str]:
    """Pattern 4: Lines that explicitly define severity-to-label mappings.

    e.g. "- **Info** — minor (cosmetic)" where the pattern is
    **canonical** — non-canonical
    """
    errors: list[str] = []
    mapping_pattern = re.compile(
        rf"\*\*(?:critical|warning|info|degraded|normal|annoying)\*\*\s*[—–]\s*({non_canonical_re})\b",
        re.IGNORECASE,
    )
    for m in mapping_pattern.finditer(text):
        term = m.group(1).lower()
        line = text[: m.end()].rsplit("\n", 1)[-1].strip()
        errors.append(f"Non-canonical severity term '{term}' in mapping: {line[:80]}")
    return errors


def check_severity_levels(skill: str, text: str, r: Results) -> None:
    """Check 3: Severity levels use canonical terms.

    Looks for lines that *define* severity levels: table rows with severity
    as a column, markdown headings that label findings by severity, and
    explicit severity label assignments.  Ignores incidental uses of common
    words like "high" or "low" that happen to appear near "finding".
    """
    # Non-canonical severity terms to flag.
    non_canonical = {
        "high",
        "medium",
        "low",
        "major",
        "minor",
        "severe",
        "fatal",
        "trivial",
        "blocker",
    }
    non_canonical_re = "|".join(sorted(non_canonical))

    errors: list[str] = (
        _find_severity_in_tables(text, non_canonical)
        + _find_severity_in_headings(text, non_canonical_re)
        + _find_severity_in_section(text, non_canonical)
        + _find_severity_in_mappings(text, non_canonical_re)
    )

    if errors:
        for detail in sorted(set(errors)):
            r.error(skill, "severity-levels", detail)
    else:
        r.ok(skill, "severity-levels")


def check_decision_labels(skill: str, text: str, r: Results) -> None:
    """Check 4: DECISIONS.md format includes firm/provisional/exploratory."""
    if skill != "resonera":
        # Light check only applies to resonera.
        r.ok(skill, "decision-labels")
        return

    required = {"firm", "provisional", "exploratory"}
    found = set()
    for label in required:
        if re.search(rf"\b{label}\b", text, re.IGNORECASE):
            found.add(label)

    missing = required - found
    if missing:
        r.error(
            skill, "decision-labels", f"Missing labels: {', '.join(sorted(missing))}"
        )
    else:
        r.ok(skill, "decision-labels")


def check_artifact_path_resolution(skill: str, text: str, r: Results) -> None:
    """Check 5: Artifact path resolution subsection under State artifacts."""
    state_section = extract_section(text, "State artifacts")
    if state_section is None:
        # Some skills might not have state artifacts -- skip check.
        r.ok(skill, "artifact-path-resolution")
        return

    subsection = extract_subsection(text, "State artifacts", "Artifact path resolution")
    core_sentence = "check if .agentera/DOCS.md exists"
    old_sentence = "check if DOCS.md exists"

    if subsection and core_sentence.lower() in subsection.lower():
        r.ok(skill, "artifact-path-resolution")
        return

    # Check for old-style wording (pre-D13: "check if DOCS.md exists in the project root").
    if old_sentence.lower() in text.lower():
        r.error(
            skill,
            "artifact-path-resolution",
            "Uses old-style 'check if DOCS.md exists' — update to "
            "'check if .agentera/DOCS.md exists'",
        )
        return

    # Check if new sentence appears elsewhere (wrong location).
    if core_sentence.lower() in text.lower():
        cross_skill = extract_section(text, "Cross-skill integration")
        if cross_skill and core_sentence.lower() in cross_skill.lower():
            r.error(
                skill,
                "artifact-path-resolution",
                "Artifact path resolution instruction found under Cross-skill integration "
                "instead of State artifacts",
            )
        else:
            r.error(
                skill,
                "artifact-path-resolution",
                "Artifact path resolution instruction exists but not as a ### subsection "
                "under ## State artifacts",
            )
    else:
        r.error(
            skill,
            "artifact-path-resolution",
            "Missing ### Artifact path resolution subsection under ## State artifacts",
        )


def check_profile_consumption(skill: str, text: str, r: Results) -> None:
    """Check 6: Profile consumption patterns."""
    if skill not in SCRIPT_PATTERN_CONSUMERS:
        r.ok(skill, "profile-consumption")
        return

    errors: list[str] = []

    # Must reference the effective_profile script.
    if (
        "scripts/effective_profile.py" not in text
        and "scripts.effective_profile" not in text
    ):
        errors.append("Missing reference to effective_profile script")

    # Must use integer thresholds 65+ and <45 (not 0.65+ and <0.45).
    # The spec says this will currently fail since migration hasn't happened.
    has_decimal_thresholds = bool(
        re.search(r"0\.65\+?", text) or re.search(r"<\s*0\.45", text)
    )
    # Use negative lookbehind to avoid matching "0.65+" as "65+".
    has_integer_thresholds = bool(
        re.search(r"(?<!\.)65\+", text) or re.search(r"<\s*45(?!\d)", text)
    )

    if has_decimal_thresholds and not has_integer_thresholds:
        errors.append(
            "Uses 0.65+/<0.45 thresholds instead of 65+/<45 "
            "(NOTE: Task 3 will fix this)"
        )

    # Must have fallback instruction about missing profile.
    # Need both: (a) mention of profile absence and (b) instruction to continue.
    fallback_patterns = [
        r"(?:missing|absent|doesn't exist|does not exist|not available|unavailable|not found)",
        r"(?:proceed|continue|skip|omit)\s+without",
    ]
    has_fallback = all(re.search(pat, text, re.IGNORECASE) for pat in fallback_patterns)
    if not has_fallback:
        errors.append("Missing fallback instruction for when profile is unavailable")

    if errors:
        for detail in errors:
            r.error(skill, "profile-consumption", detail)
    else:
        r.ok(skill, "profile-consumption")


def check_cross_skill_integration(skill: str, text: str, r: Results) -> None:
    """Check 7: Cross-skill integration section."""
    section = extract_section(text, "Cross-skill integration")
    if section is None:
        r.error(skill, "cross-skill-refs", "Missing ## Cross-skill integration section")
        return

    # Must contain "twelve-skill suite".
    if "twelve-skill suite" not in section.lower():
        bad_counts = []
        for n in ("eleven", "ten", "nine", "eight", "seven", "six", "five"):
            if f"{n}-skill" in section.lower():
                bad_counts.append(f"{n}-skill")
        if bad_counts:
            r.error(
                skill,
                "cross-skill-refs",
                f"Uses '{bad_counts[0]}' instead of 'twelve-skill suite'",
            )
        elif "skill suite" in section.lower() and "twelve-skill" not in section.lower():
            r.error(
                skill,
                "cross-skill-refs",
                "Says 'skill suite' without specifying 'twelve-skill'",
            )
        else:
            r.error(
                skill,
                "cross-skill-refs",
                "Missing 'twelve-skill suite' in cross-skill integration section",
            )

    # Check required references (case-insensitive word boundary match).
    required = REQUIRED_REFS.get(skill, [])
    missing = []
    for ref in required:
        # Match the skill name as part of a word (e.g., /realisera, Realisera).
        if not re.search(rf"(?i)\b{ref}\b", section):
            missing.append(ref)

    if missing:
        r.error(
            skill,
            "cross-skill-refs",
            f"Missing reference to: {', '.join(missing)}",
        )

    if "twelve-skill suite" in section.lower() and not missing:
        r.ok(skill, "cross-skill-refs")


def check_safety_rails(skill: str, text: str, r: Results) -> None:
    """Check 8: Safety rails section with <critical> tags and NEVER bullets."""
    section = extract_section(text, "Safety rails")
    if section is None:
        r.error(skill, "safety-rails", "Missing ## Safety rails section")
        return

    if "<critical>" not in section:
        r.error(skill, "safety-rails", "Missing <critical> tag")
        return

    if "</critical>" not in section:
        r.error(skill, "safety-rails", "Missing </critical> closing tag")
        return

    # Extract content between critical tags.
    m = re.search(r"<critical>(.*?)</critical>", section, re.DOTALL)
    if not m:
        r.error(
            skill, "safety-rails", "Could not parse content between <critical> tags"
        )
        return

    critical_content = m.group(1)
    never_bullets = re.findall(r"^\s*-\s+NEVER\b", critical_content, re.MULTILINE)

    if len(never_bullets) < 3:
        r.error(
            skill,
            "safety-rails",
            f"Only {len(never_bullets)} NEVER bullet(s) found (minimum 3 required)",
        )
    else:
        r.ok(skill, "safety-rails")


def check_artifact_format(skill: str, text: str, r: Results) -> None:
    """Check 9: Artifact format contracts (advisory, warnings only)."""
    found_any = False
    for artifact, (producers, elements) in ARTIFACT_CONTRACTS.items():
        if skill not in producers:
            continue
        if not elements:
            continue
        found_any = True
        missing = [elem for elem in elements if elem.lower() not in text.lower()]
        if missing:
            r.warn(
                skill,
                "artifact-format",
                f"{artifact} format missing references to: {', '.join(missing)}",
            )

    if not found_any:
        # Skill is not a producer -- nothing to check.
        pass


def check_exit_signals(skill: str, text: str, r: Results) -> None:
    """Check 10: Exit signals section with all four status terms."""
    section = extract_section(text, "Exit signals")
    if section is None:
        r.error(skill, "exit-signals", "Missing ## Exit signals section")
        return

    required_terms = ["complete", "flagged", "stuck", "waiting"]
    missing = [term for term in required_terms if term not in section]
    if missing:
        r.error(
            skill,
            "exit-signals",
            f"Missing status term(s): {', '.join(missing)}",
        )
    else:
        r.ok(skill, "exit-signals")


def check_loop_guard(skill: str, text: str, r: Results) -> None:
    """Check 11: Loop guard for autonomous-loop skills.

    For realisera and optimera: the ## Exit signals section must
    reference the 3-failure threshold and PROGRESS.md or consecutive failure
    detection.  For all other skills this check passes unconditionally.
    """
    if skill not in AUTONOMOUS_LOOP_SKILLS:
        r.ok(skill, "loop-guard")
        return

    section = extract_section(text, "Exit signals")
    if section is None:
        r.error(
            skill,
            "loop-guard",
            "Missing ## Exit signals section (required for loop guard check)",
        )
        return

    errors: list[str] = []

    # Must reference the failure threshold of 3.
    if not re.search(r"\b3\b", section):
        errors.append("Missing reference to '3' (the consecutive-failure threshold)")

    # Must reference PROGRESS.md, consecutive failure detection, or retry-based task failure.
    has_progress_ref = "PROGRESS.md" in section
    has_consecutive_ref = bool(re.search(r"consecutive\s+fail", section, re.IGNORECASE))
    has_retry_ref = bool(
        re.search(r"\bretr", section, re.IGNORECASE)
        and re.search(r"\btask", section, re.IGNORECASE)
    )
    if not has_progress_ref and not has_consecutive_ref and not has_retry_ref:
        errors.append(
            "Missing reference to PROGRESS.md, consecutive failure detection, "
            "or retry-based task failure detection"
        )

    if errors:
        for detail in errors:
            r.error(skill, "loop-guard", detail)
    else:
        r.ok(skill, "loop-guard")


# ---------------------------------------------------------------------------
# Punctuation and line-break checks (spec Sections 14-15)
# ---------------------------------------------------------------------------


def _strip_code_blocks(text: str) -> str:
    """Remove fenced code blocks (``` ... ```) from text, including indented ones."""
    return re.sub(
        r"^(\s*`{3,})[^\n]*\n.*?^\s*`{3,}\s*$",
        "",
        text,
        flags=re.MULTILINE | re.DOTALL,
    )


def _strip_inline_code(text: str) -> str:
    """Remove inline code (`...`) from text."""
    return re.sub(r"`[^`\n]+`", "", text)


def _strip_frontmatter(text: str) -> str:
    """Remove YAML frontmatter (--- ... ---) from the start of text."""
    if text.startswith("---"):
        end = text.find("---", 3)
        if end != -1:
            return text[end + 3 :]
    return text


def check_em_dashes(skill: str, text: str, r: Results) -> None:
    """Check 12: No em-dash characters in prose (spec Section 14).

    Deterministic. Searches for U+2014 outside code blocks and inline code.
    """
    cleaned = _strip_frontmatter(text)
    cleaned = _strip_code_blocks(cleaned)
    cleaned = _strip_inline_code(cleaned)

    em_dash_lines = []
    for i, line in enumerate(cleaned.splitlines(), start=1):
        if "\u2014" in line:
            em_dash_lines.append(i)

    if em_dash_lines:
        r.error(
            skill,
            "em-dashes",
            f"Em-dash character found in prose on {len(em_dash_lines)} line(s)",
        )
    else:
        r.ok(skill, "em-dashes")


def check_hard_wraps(skill: str, text: str, r: Results) -> None:
    """Check 13: No hard-wrapped prose paragraphs (spec Section 15).

    Advisory. Detects consecutive non-blank prose lines outside code blocks,
    lists, tables, headings, and frontmatter.
    """
    cleaned = _strip_frontmatter(text)
    cleaned = _strip_code_blocks(cleaned)

    structural_line = re.compile(
        r"^\s*("
        r"#"  # heading
        r"|-\s"  # unordered list
        r"|\*\s"  # unordered list (asterisk)
        r"|\d+\w*\.\s"  # ordered list (1. or 3b. or 5c.)
        r"|\|"  # table row
        r"|>"  # blockquote
        r"|<!--"  # HTML comment
        r"|</?critical>"  # critical tags
        r"|▸"  # list item glyph
        r"|\*\*"  # bold label (metadata line)
        r"|✗\s"  # narration contrast (bad example)
        r"|✓\s"  # narration contrast (good example)
        r"|Format:"  # format instruction line
        r"|$"  # blank line
        r")"
    )

    consecutive_prose = 0
    prev_line = ""
    violations = 0

    for line in cleaned.splitlines():
        if structural_line.match(line):
            consecutive_prose = 0
            prev_line = ""
        else:
            consecutive_prose += 1
            if consecutive_prose >= 2 and 70 <= len(prev_line.strip()) <= 120:
                violations += 1
                consecutive_prose = 0
            prev_line = line

    if violations > 0:
        r.warn(
            skill,
            "hard-wraps",
            f"{violations} instance(s) of consecutive prose lines (possible hard wraps)",
        )
    else:
        r.ok(skill, "hard-wraps")


# ---------------------------------------------------------------------------
# Ecosystem context checks (spec alignment)
# ---------------------------------------------------------------------------


def check_spec_sections_declared(skill: str, text: str, r: Results) -> None:
    """Check 14: SKILL.md frontmatter declares spec_sections field."""
    fm = parse_frontmatter(text)
    if fm is None:
        r.error(skill, "spec-sections-declared", "No frontmatter found")
        return

    if "spec_sections" not in fm:
        r.error(
            skill,
            "spec-sections-declared",
            "Missing 'spec_sections' field in frontmatter",
        )
        return

    # Validate the format: should be a bracketed list of integers.
    raw = fm["spec_sections"]
    m = re.fullmatch(r"\[[\d,\s]+]", raw)
    if not m:
        r.error(
            skill,
            "spec-sections-declared",
            f"Invalid spec_sections format: {raw!r} (expected [N, N, ...])",
        )
        return

    r.ok(skill, "spec-sections-declared")


def check_context_file_exists(
    skill: str, text: str, r: Results, *, skill_path: Path
) -> None:
    """Check 15: references/contract.md exists for the skill."""
    context_path = skill_path.parent / "references" / "contract.md"
    if context_path.exists():
        r.ok(skill, "context-file-exists")
    else:
        r.error(
            skill,
            "context-file-exists",
            f"Missing {context_path.parent.name}/references/contract.md",
        )


def check_context_file_current(
    skill: str,
    text: str,
    r: Results,
    *,
    skill_path: Path,
    spec_hash: str,
) -> None:
    """Check 16: contract.md source hash matches current SPEC.md."""
    context_path = skill_path.parent / "references" / "contract.md"
    if not context_path.exists():
        # Already reported by check_context_file_exists; skip silently.
        return

    content = context_path.read_text(encoding="utf-8")
    m = re.search(r"<!-- source: .+?\(sha256: ([a-f0-9]+)\) -->", content)
    if not m:
        r.error(
            skill,
            "context-file-current",
            "No source hash found in contract.md header",
        )
        return

    file_hash = m.group(1)
    if file_hash == spec_hash:
        r.ok(skill, "context-file-current")
    else:
        r.error(
            skill,
            "context-file-current",
            f"Source hash mismatch: file has {file_hash[:12]}... "
            f"but SPEC.md is {spec_hash[:12]}...",
        )


# Skills that must enforce spec Section 20 (Reality Verification Gate).
REALITY_VERIFICATION_ENFORCERS = {"realisera", "orkestrera"}

# Skills that dispatch subagents to worktrees and must enforce the
# pre-dispatch commit gate (spec Section 23).
WORKTREE_DISPATCH_SKILLS = {"realisera", "optimera"}

RECOGNIZED_CAPABILITIES = {
    "skill-discovery",
    "artifact-resolution",
    "profile-path",
    "sub-agent-dispatch",
    "eval-mechanism",
    "hook-lifecycle",
}


def check_reality_verification_gate(skill: str, text: str, r: Results) -> None:
    """Check 17: Reality Verification Gate (spec section 20).

    Realisera and orkestrera must reference spec Section 20 by
    name and include the `**Verified**` field in their documented format.
    Other skills pass unconditionally.
    """
    if skill not in REALITY_VERIFICATION_ENFORCERS:
        r.ok(skill, "reality-verification-gate")
        return

    # Accept any of the explicit spec-anchored phrasings. Plain "Section 20"
    # alone is not enough: require a qualifying prefix or the "Reality
    # Verification Gate" descriptor to avoid false positives.
    section_patterns = [
        r"contract Section 20",
        r"spec Section 20",
        r"spec Section 20",
        r"Section 20[,:]?\s*Reality Verification Gate",
    ]
    has_section_ref = any(
        re.search(pat, text, re.IGNORECASE) for pat in section_patterns
    )

    has_verified_field = "**Verified**" in text

    errors: list[str] = []
    if not has_section_ref:
        errors.append(
            f"{skill}/SKILL.md: missing reference to Section 20 "
            "(Reality Verification Gate)"
        )
    if not has_verified_field:
        errors.append(
            f"{skill}/SKILL.md: missing `**Verified**` field in documented format"
        )

    if errors:
        for detail in errors:
            r.error(skill, "reality-verification-gate", detail)
    else:
        r.ok(skill, "reality-verification-gate")


def check_platform_annotations(skill: str, text: str, r: Results) -> None:
    """Check 18: Platform annotations reference recognized capability names.

    Every <!-- platform: NAME --> annotation in a SKILL.md must use a
    capability name from the recognized set defined in the spec Section 21.
    """
    annotations = re.findall(r"<!-- platform: (\S+) -->", text)
    if not annotations:
        r.ok(skill, "platform-annotations")
        return

    unknown = [name for name in annotations if name not in RECOGNIZED_CAPABILITIES]
    if unknown:
        for name in sorted(set(unknown)):
            r.error(
                skill,
                "platform-annotations",
                f"Unrecognized capability name '{name}' "
                f"(expected one of: {', '.join(sorted(RECOGNIZED_CAPABILITIES))})",
            )
    else:
        r.ok(skill, "platform-annotations")


def _has_section_23_ref(text: str) -> bool:
    patterns = [
        r"contract Section 23",
        r"spec Section 23",
        r"Section 23[,:]?\s*Pre-dispatch Commit Gate",
        r"Pre-dispatch [Cc]ommit [Gg]ate",
    ]
    return any(re.search(pat, text, re.IGNORECASE) for pat in patterns)


def _has_scoped_staging(text: str) -> bool:
    return bool(
        re.search(r"(?:do not|don't|never)\s+use\s+`?git add -A", text, re.IGNORECASE)
        or re.search(r"(?:do not|don't|never)\s+use\s+`?git add \.", text, re.IGNORECASE)
        or re.search(r"not\s+`?git add -A`?\s+or\s+`?git add \.", text, re.IGNORECASE)
    )


_GATE_INDICATORS: list[tuple[str, str]] = [
    ("section-ref", "Missing reference to Section 23 (Pre-dispatch Commit Gate)"),
    ("checkpoint-msg", "Missing checkpoint commit message ('checkpoint before worktree dispatch')"),
    ("clean-tree", "Missing clean-tree check ('git status --porcelain')"),
    ("scoped-staging", "Missing scoped staging instruction (must prohibit 'git add -A' or 'git add .')"),
]


def check_pre_dispatch_commit_gate(skill: str, text: str, r: Results) -> None:
    """Check 19: Pre-dispatch Commit Gate (spec Section 23)."""
    if skill not in WORKTREE_DISPATCH_SKILLS:
        r.ok(skill, "pre-dispatch-commit-gate")
        return

    if not re.search(r'isolation:\s*"worktree"', text):
        r.error(
            skill,
            "pre-dispatch-commit-gate",
            'Expected worktree dispatch language (isolation: "worktree") but not found',
        )
        return

    checks = {
        "section-ref": _has_section_23_ref(text),
        "checkpoint-msg": "checkpoint before worktree dispatch" in text,
        "clean-tree": "git status --porcelain" in text,
        "scoped-staging": _has_scoped_staging(text),
    }

    errors = [msg for key, msg in _GATE_INDICATORS if not checks[key]]

    if errors:
        for detail in errors:
            r.error(skill, "pre-dispatch-commit-gate", detail)
    else:
        r.ok(skill, "pre-dispatch-commit-gate")

    check_commit_message_hygiene(skill, text, r)


def check_commit_message_hygiene(skill: str, text: str, r: Results) -> None:
    """Check 20: No task/plan/todo references in commit message guidance (spec Section 23).

    Scans commit-related sections of SKILL.md for patterns like
    "Task N", "PLAN.md", or "TODO.md" that would leak internal planning
    artifacts into commit messages.
    """
    commit_sections = []
    for heading in ("commit", "Commit"):
        section = extract_section(text, heading)
        if section:
            commit_sections.append(section)
    subsection = extract_subsection(text, "Pre-dispatch Commit Gate", "Gate procedure")
    if subsection:
        commit_sections.append(subsection)
    subsection = extract_subsection(text, "Pre-dispatch Commit Gate", "General commit message rules")
    if subsection:
        commit_sections.append(subsection)

    if not commit_sections:
        r.ok(skill, "commit-message-hygiene")
        return

    combined = "\n".join(commit_sections)

    prohibited = [
        (r"\bTask\s+\d+", "Task number reference"),
        (r"\bCycle\s+\d+", "Cycle number reference"),
        (r"\bDecision\s+\d+", "Decision number reference"),
        (r"\bSurprise\s+#\d+", "Surprise number reference"),
        (r"\bPLAN\.md\b", "PLAN.md reference"),
        (r"\bTODO\.md\b", "TODO.md reference"),
        (r"\bPROGRESS\.md\b", "PROGRESS.md reference"),
        (r"\bDECISIONS\.md\b", "DECISIONS.md reference"),
    ]

    errors: list[str] = []
    for pattern, label in prohibited:
        matches = re.findall(pattern, combined)
        if matches:
            errors.append(f"{label} found in commit section: {', '.join(set(matches))}")

    if errors:
        for detail in errors:
            r.error(skill, "commit-message-hygiene", detail)
    else:
        r.ok(skill, "commit-message-hygiene")


def check_artifact_writing_conventions(skill: str, text: str, r: Results) -> None:
    """Check 21: All artifact-producing skills reference Section 24.

    Deterministic: skills that produce artifacts per Section 4 contracts
    must contain a reference to 'Section 24' or 'Artifact Writing
    Conventions' in their SKILL.md.
    """
    # Skills that produce artifacts per ARTIFACT_CONTRACTS
    artifact_producers = set()
    for producers, _ in ARTIFACT_CONTRACTS.values():
        artifact_producers.update(producers)

    if skill not in artifact_producers:
        r.ok(skill, "artifact-writing-conventions")
        return

    has_ref = (
        re.search(r"Section\s+24", text) is not None
        or re.search(r"Artifact\s+Writing\s+Conventions", text) is not None
    )

    if not has_ref:
        r.error(
            skill,
            "artifact-writing-conventions",
            f"Missing reference to Section 24 (Artifact Writing Conventions)",
        )
    else:
        r.ok(skill, "artifact-writing-conventions")


def check_banned_vocabulary(skill: str, text: str, r: Results) -> None:
    """Check 22: Advisory check for non-canonical vocabulary in artifact-writing context.

    Scans SKILL.md prose (outside code blocks and frontmatter) for
    'avoid' terms from the Section 24 vocabulary table when used near
    artifact-writing keywords.
    """
    prose = re.sub(r"```[\s\S]*?```", "", text)
    prose = re.sub(r"^---.*?---", "", prose, flags=re.DOTALL)
    prose = re.sub(r"`[^`]+`", "", prose)

    non_canonical = {
        "problem", "concern", "observation",
        "iteration",
        "spawn", "launch",
        "checked", "confirmed", "validated",
        "score", "rating",
        "category",
        "certainty", "belief", "likelihood",
        "priority", "importance",
        "trend", "movement",
        "outdated", "expired",
        "snapshot", "backup",
    }

    context_patterns = [
        re.compile(rf"\b{cw}\b", re.IGNORECASE)
        for cw in (
            "write", "append", "entry", "format", "structure",
            "artifact", "heading", "log", "record",
        )
    ]

    errors: list[str] = []
    for term in sorted(non_canonical):
        pattern = re.compile(rf"\b{term}\b", re.IGNORECASE)
        for match in pattern.finditer(prose):
            start = max(0, match.start() - 80)
            end = min(len(prose), match.end() + 80)
            window = prose[start:end]
            if any(cp.search(window) for cp in context_patterns):
                line_num = prose[:match.start()].count("\n") + 1
                errors.append(
                    f"Non-canonical term '{term}' near artifact-writing context "
                    f"(line {line_num})"
                )
                break

    if errors:
        for detail in errors:
            r.warn(skill, "banned-vocabulary", detail)
    else:
        r.ok(skill, "banned-vocabulary")


def check_sentence_length(skill: str, text: str, r: Results) -> None:
    """Check 23: Advisory check for sentences exceeding 25 words in artifact examples.

    Counts words per sentence in artifact format examples within SKILL.md
    files (inside code blocks showing artifact structure). Flags sentences
    exceeding 25 words.
    """
    code_blocks = re.findall(r"```(?:md|markdown)?\n([\s\S]*?)```", text)

    errors: list[str] = []
    for block in code_blocks:
        if not re.search(r"^#{1,3}\s", block, re.MULTILINE):
            continue

        block_start_line = text[:text.find(block)].count("\n")
        lines = block.split("\n")
        for line_offset, line in enumerate(lines):
            stripped = line.strip()
            if not stripped:
                continue
            if re.match(r"^[-*|#>]", stripped):
                continue
            if re.match(r"^\*\*\w", stripped):
                continue

            protected = re.sub(r"`[^`]+`", "CODE", stripped)
            protected = re.sub(r"https?://\S+", "URL", protected)
            protected = re.sub(r"\b\w+\.\w+\.\w+", "PATH", protected)
            protected = re.sub(r"\b(?:e\.g|i\.e|etc|vs)\.", "ABBR", protected)

            sentences = re.split(r"(?<=[.!?])\s+", protected)
            for sentence in sentences:
                words = sentence.split()
                if len(words) > 25:
                    errors.append(
                        f"Sentence exceeds 25-word cap ({len(words)} words) "
                        f"in artifact example (line ~{block_start_line + line_offset + 1})"
                    )

    if errors:
        for detail in errors:
            r.warn(skill, "sentence-length", detail)
    else:
        r.ok(skill, "sentence-length")


_BARE_CLAUDE_PLUGIN_ROOT_RE = re.compile(r"\$\{CLAUDE_PLUGIN_ROOT\}")
_FALLBACK_CLAUDE_PLUGIN_ROOT_RE = re.compile(
    r"\$\{AGENTERA_HOME:-\$CLAUDE_PLUGIN_ROOT\}"
)


def check_no_bare_claude_plugin_root(skill: str, text: str, r: Results) -> None:
    """Check 24: Skill prose must not embed bare ``${CLAUDE_PLUGIN_ROOT}``.

    Per spec Section 7 (Install Root), skill prose that names a helper
    script under the install root must use the bash-fallback form
    ``${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}`` so the invocation resolves
    identically across runtimes. A bare ``${CLAUDE_PLUGIN_ROOT}`` form is
    Claude-Code-specific and breaks under OpenCode, Codex, and Copilot.

    Code blocks (fenced regions) are excluded so example output that
    mentions the bare token verbatim does not produce noise.
    """
    prose = re.sub(r"```[\s\S]*?```", "", text)

    bare_lines: list[int] = []
    for match in _BARE_CLAUDE_PLUGIN_ROOT_RE.finditer(prose):
        # Skip occurrences that are part of the fallback form.
        window_start = max(0, match.start() - len("${AGENTERA_HOME:-"))
        window = prose[window_start : match.end()]
        if _FALLBACK_CLAUDE_PLUGIN_ROOT_RE.search(window):
            continue
        line_num = prose[: match.start()].count("\n") + 1
        bare_lines.append(line_num)

    if bare_lines:
        for line_num in bare_lines:
            r.warn(
                skill,
                "no-bare-claude-plugin-root",
                f"{skill}/SKILL.md line {line_num}: bare '${{CLAUDE_PLUGIN_ROOT}}' "
                "in skill prose; use '${AGENTERA_HOME:-$CLAUDE_PLUGIN_ROOT}' "
                "(spec Section 7 Install Root)",
            )
    else:
        r.ok(skill, "no-bare-claude-plugin-root")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def validate_skill(path: Path, r: Results, *, spec_hash: str) -> None:
    """Run all checks on a single SKILL.md."""
    skill = path.parent.name
    text = path.read_text(encoding="utf-8")

    check_frontmatter(skill, text, r)
    check_confidence_scale(skill, text, r)
    check_severity_levels(skill, text, r)
    check_decision_labels(skill, text, r)
    check_artifact_path_resolution(skill, text, r)
    check_profile_consumption(skill, text, r)
    check_cross_skill_integration(skill, text, r)
    check_safety_rails(skill, text, r)
    check_artifact_format(skill, text, r)
    check_exit_signals(skill, text, r)
    check_loop_guard(skill, text, r)
    check_em_dashes(skill, text, r)
    check_hard_wraps(skill, text, r)
    check_spec_sections_declared(skill, text, r)
    check_context_file_exists(skill, text, r, skill_path=path)
    check_context_file_current(skill, text, r, skill_path=path, spec_hash=spec_hash)
    check_reality_verification_gate(skill, text, r)
    check_platform_annotations(skill, text, r)
    check_pre_dispatch_commit_gate(skill, text, r)
    check_artifact_writing_conventions(skill, text, r)
    check_banned_vocabulary(skill, text, r)
    check_sentence_length(skill, text, r)
    check_no_bare_claude_plugin_root(skill, text, r)


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Validate SKILL.md files against SPEC.md. "
            "Default: validates all 12 canonical skills under skills/. "
            "Use --skill PATH (repeatable) to validate arbitrary SKILL.md "
            "files, e.g. when authoring a third-party skill against the spec."
        ),
    )
    parser.add_argument(
        "--skill",
        action="append",
        dest="skills",
        metavar="PATH",
        help=(
            "Path to a SKILL.md file to validate. May be repeated. "
            "When omitted, all canonical skills under skills/*/SKILL.md are validated."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)

    repo_root = Path(__file__).resolve().parent.parent
    spec_path = repo_root / "SPEC.md"

    if args.skills:
        skill_files: list[Path] = []
        for raw in args.skills:
            path = Path(raw).resolve()
            if not path.exists():
                print(f"ERROR: SKILL.md not found: {raw}", file=sys.stderr)
                return 1
            skill_files.append(path)
        header = "=== External Skill Validation ===\n"
    else:
        skills_dir = repo_root / "skills"
        skill_files = sorted(skills_dir.glob("*/SKILL.md"))
        if not skill_files:
            print("ERROR: No SKILL.md files found in skills/", file=sys.stderr)
            return 1
        header = "=== Ecosystem Validation ===\n"

    # Compute spec hash for context-file-current checks.
    if spec_path.exists():
        spec_hash = hashlib.sha256(
            spec_path.read_text(encoding="utf-8").encode("utf-8"),
        ).hexdigest()
    else:
        spec_hash = ""

    print(header)

    r = Results()
    for path in skill_files:
        validate_skill(path, r, spec_hash=spec_hash)

    r.print()

    print(f"\n---")
    print(
        f"Results: {r.error_count} error(s), {r.warn_count} warning(s) "
        f"across {len(skill_files)} skills"
    )

    return 1 if r.error_count > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
