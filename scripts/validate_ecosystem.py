#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Ecosystem linter for agentera SKILL.md files.

Validates all 12 SKILL.md files against the ecosystem spec
(references/ecosystem-spec.md). Checks frontmatter, confidence scales,
severity levels, decision labels, artifact path resolution, profile
consumption, cross-skill integration, safety rails, artifact format
contracts, exit signals, and loop guard.

Run from repo root:
    python3 scripts/validate_ecosystem.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

REQUIRED_REFS: dict[str, list[str]] = {
    "hej": [
        "visionera", "resonera", "planera", "realisera", "inspektera",
        "optimera", "dokumentera", "visualisera", "profilera", "inspirera",
        "orkestrera",
    ],
    "inspirera": ["realisera", "optimera", "visionera", "resonera", "profilera"],
    "profilera": ["realisera", "optimera", "inspirera", "resonera", "inspektera"],
    "realisera": [
        "visionera", "optimera", "inspirera", "resonera", "planera",
        "inspektera", "profilera",
    ],
    "optimera": ["realisera", "resonera", "inspektera", "profilera"],
    "resonera": [
        "realisera", "optimera", "inspirera", "profilera", "planera",
        "inspektera",
    ],
    "inspektera": ["realisera", "resonera", "planera", "optimera", "profilera"],
    "planera": [
        "resonera", "realisera", "optimera", "inspektera", "profilera",
        "inspirera", "dokumentera",
    ],
    "visionera": [
        "realisera", "resonera", "profilera", "inspirera", "inspektera",
        "visualisera",
    ],
    "dokumentera": [
        "planera", "realisera", "inspektera", "visionera", "profilera",
    ],
    "visualisera": [
        "visionera", "realisera", "dokumentera", "inspektera", "profilera",
        "inspirera", "resonera",
    ],
    "orkestrera": [
        "planera", "realisera", "inspektera", "inspirera", "dokumentera",
        "profilera", "visionera", "resonera", "optimera", "visualisera",
    ],
}

SCRIPT_PATTERN_CONSUMERS = {
    "realisera", "optimera", "inspektera", "planera", "inspirera",
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
        ["Question", "Context", "Alternatives", "Choice", "Reasoning", "Confidence", "Feeds into"],
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
        self.entries: list[tuple[str, str, str, str]] = []  # (level, skill, check, detail)

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


def extract_subsection(text: str, parent_heading: str, child_heading: str) -> str | None:
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


def check_severity_levels(skill: str, text: str, r: Results) -> None:
    """Check 3: Severity levels use canonical terms.

    Looks for lines that *define* severity levels: table rows with severity
    as a column, markdown headings that label findings by severity, and
    explicit severity label assignments.  Ignores incidental uses of common
    words like "high" or "low" that happen to appear near "finding".
    """
    # Non-canonical severity terms to flag.
    non_canonical = {
        "high", "medium", "low", "major", "minor", "severe",
        "fatal", "trivial", "blocker",
    }
    non_canonical_re = "|".join(sorted(non_canonical))

    errors: list[str] = []

    # Strategy: only flag non-canonical terms in genuine severity-defining
    # contexts.  We look for sections/paragraphs about severity, and then
    # check for non-canonical terms within them.

    # Pattern 1: Table rows within severity-related tables.
    # Find tables whose header row contains "severity" or "level", then
    # check body rows for non-canonical terms.
    for table_match in re.finditer(
        r"^(\|[^\n]*(?:severity|level)[^\n]*\|)\n\|[-| :]+\|\n((?:\|[^\n]*\n)*)",
        text, re.IGNORECASE | re.MULTILINE,
    ):
        table_body = table_match.group(2)
        for row in table_body.strip().splitlines():
            for term in non_canonical:
                if re.search(rf"\b{term}\b", row, re.IGNORECASE):
                    errors.append(
                        f"Non-canonical severity term '{term}' in table: "
                        f"{row.strip()[:80]}"
                    )

    # Pattern 2: Headings that label findings by severity.
    # e.g. "### [high] description" or "#### Finding — high (confidence: N)"
    # Only match when the heading looks like a finding label (contains
    # em-dash or brackets around the term).
    heading_pattern = re.compile(
        rf"^#+\s.*?(?:\[|[—–]\s*)({non_canonical_re})\b",
        re.IGNORECASE | re.MULTILINE,
    )
    for m in heading_pattern.finditer(text):
        term = m.group(1).lower()
        line = m.group(0).strip()
        errors.append(f"Non-canonical severity term '{term}' in heading: {line[:80]}")

    # Pattern 3: Explicit severity label definitions.
    # e.g. "severity: high" or "- **Info** — minor" in a severity section.
    # The em/en-dash variant requires the term on the same line and NOT
    # followed by a hyphen (avoids "high-confidence" = certainty, not severity).
    # For this pattern, require nearby severity context words on the same line
    # or in the surrounding section.
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

    # Pattern 4: Lines that explicitly define severity-to-label mappings.
    # e.g. "- **Info** — minor (cosmetic)" where the pattern is
    # **canonical** — non-canonical
    mapping_pattern = re.compile(
        rf"\*\*(?:critical|warning|info|degraded|normal|annoying)\*\*\s*[—–]\s*({non_canonical_re})\b",
        re.IGNORECASE,
    )
    for m in mapping_pattern.finditer(text):
        term = m.group(1).lower()
        line = text[: m.end()].rsplit("\n", 1)[-1].strip()
        errors.append(f"Non-canonical severity term '{term}' in mapping: {line[:80]}")

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
        r.error(skill, "decision-labels", f"Missing labels: {', '.join(sorted(missing))}")
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
            skill, "artifact-path-resolution",
            "Uses old-style 'check if DOCS.md exists' — update to "
            "'check if .agentera/DOCS.md exists'",
        )
        return

    # Check if new sentence appears elsewhere (wrong location).
    if core_sentence.lower() in text.lower():
        cross_skill = extract_section(text, "Cross-skill integration")
        if cross_skill and core_sentence.lower() in cross_skill.lower():
            r.error(
                skill, "artifact-path-resolution",
                "Artifact path resolution instruction found under Cross-skill integration "
                "instead of State artifacts",
            )
        else:
            r.error(
                skill, "artifact-path-resolution",
                "Artifact path resolution instruction exists but not as a ### subsection "
                "under ## State artifacts",
            )
    else:
        r.error(
            skill, "artifact-path-resolution",
            "Missing ### Artifact path resolution subsection under ## State artifacts",
        )


def check_profile_consumption(skill: str, text: str, r: Results) -> None:
    """Check 6: Profile consumption patterns."""
    if skill not in SCRIPT_PATTERN_CONSUMERS:
        r.ok(skill, "profile-consumption")
        return

    errors: list[str] = []

    # Must reference the effective_profile script.
    if "scripts/effective_profile.py" not in text and "scripts.effective_profile" not in text:
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
    has_fallback = all(
        re.search(pat, text, re.IGNORECASE) for pat in fallback_patterns
    )
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

    # Must contain "twelve-skill ecosystem".
    if "twelve-skill ecosystem" not in section.lower():
        bad_counts = []
        for n in ("eleven", "ten", "nine", "eight", "seven", "six", "five"):
            if f"{n}-skill" in section.lower():
                bad_counts.append(f"{n}-skill")
        if bad_counts:
            r.error(
                skill, "cross-skill-refs",
                f"Uses '{bad_counts[0]}' instead of 'twelve-skill ecosystem'",
            )
        elif "skill ecosystem" in section.lower():
            r.error(
                skill, "cross-skill-refs",
                "Says 'skill ecosystem' without specifying 'twelve-skill'",
            )
        else:
            r.error(
                skill, "cross-skill-refs",
                "Missing 'twelve-skill ecosystem' in cross-skill integration section",
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
            skill, "cross-skill-refs",
            f"Missing reference to: {', '.join(missing)}",
        )

    if "twelve-skill ecosystem" in section.lower() and not missing:
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
        r.error(skill, "safety-rails", "Could not parse content between <critical> tags")
        return

    critical_content = m.group(1)
    never_bullets = re.findall(r"^\s*-\s+NEVER\b", critical_content, re.MULTILINE)

    if len(never_bullets) < 3:
        r.error(
            skill, "safety-rails",
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
                skill, "artifact-format",
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
            skill, "exit-signals",
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
            skill, "loop-guard",
            "Missing ## Exit signals section (required for loop guard check)",
        )
        return

    errors: list[str] = []

    # Must reference the failure threshold of 3.
    if not re.search(r"\b3\b", section):
        errors.append("Missing reference to '3' (the consecutive-failure threshold)")

    # Must reference PROGRESS.md, consecutive failure detection, or retry-based task failure.
    has_progress_ref = "PROGRESS.md" in section
    has_consecutive_ref = bool(
        re.search(r"consecutive\s+fail", section, re.IGNORECASE)
    )
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
# Punctuation and line-break checks (ecosystem-spec sections 14-15)
# ---------------------------------------------------------------------------

def _strip_code_blocks(text: str) -> str:
    """Remove fenced code blocks (``` ... ```) from text, including indented ones."""
    return re.sub(
        r"^(\s*`{3,})[^\n]*\n.*?^\s*`{3,}\s*$", "", text,
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
            return text[end + 3:]
    return text


def check_em_dashes(skill: str, text: str, r: Results) -> None:
    """Check 12: No em-dash characters in prose (ecosystem-spec section 14).

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
            skill, "em-dashes",
            f"Em-dash character found in prose on {len(em_dash_lines)} line(s)",
        )
    else:
        r.ok(skill, "em-dashes")


def check_hard_wraps(skill: str, text: str, r: Results) -> None:
    """Check 13: No hard-wrapped prose paragraphs (ecosystem-spec section 15).

    Advisory. Detects consecutive non-blank prose lines outside code blocks,
    lists, tables, headings, and frontmatter.
    """
    cleaned = _strip_frontmatter(text)
    cleaned = _strip_code_blocks(cleaned)

    structural_line = re.compile(
        r"^\s*("
        r"#"              # heading
        r"|-\s"           # unordered list
        r"|\*\s"          # unordered list (asterisk)
        r"|\d+\w*\.\s"    # ordered list (1. or 3b. or 5c.)
        r"|\|"            # table row
        r"|>"             # blockquote
        r"|<!--"          # HTML comment
        r"|</?critical>"  # critical tags
        r"|▸"             # list item glyph
        r"|\*\*"          # bold label (metadata line)
        r"|✗\s"           # narration contrast (bad example)
        r"|✓\s"           # narration contrast (good example)
        r"|Format:"       # format instruction line
        r"|$"             # blank line
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
            skill, "hard-wraps",
            f"{violations} instance(s) of consecutive prose lines (possible hard wraps)",
        )
    else:
        r.ok(skill, "hard-wraps")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def validate_skill(path: Path, r: Results) -> None:
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


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    skills_dir = repo_root / "skills"

    skill_files = sorted(skills_dir.glob("*/SKILL.md"))
    if not skill_files:
        print("ERROR: No SKILL.md files found in skills/", file=sys.stderr)
        return 1

    print(f"=== Ecosystem Validation ===\n")

    r = Results()
    for path in skill_files:
        validate_skill(path, r)

    r.print()

    print(f"\n---")
    print(
        f"Results: {r.error_count} error(s), {r.warn_count} warning(s) "
        f"across {len(skill_files)} skills"
    )

    return 1 if r.error_count > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
