"""Tests for scripts/validate-ecosystem.py parsing and check functions.

Proportionality: Decision 21. One pass + one fail per unit. Edge case tests
retained only for functions with regex, multi-branch parsing, or structural
exclusion logic.
"""

from __future__ import annotations


# ---------------------------------------------------------------------------
# parse_frontmatter
# ---------------------------------------------------------------------------

VALID_FRONTMATTER = """\
---
name: realisera
description: Autonomous development loops
trigger: start building
---
# Rest of the file
"""

NO_FRONTMATTER = """\
# Just a regular markdown file
Some content here.
"""

UNCLOSED_FRONTMATTER = """\
---
name: broken
description: This frontmatter never closes
trigger: oops
"""


class TestParseFrontmatter:
    """Complex: regex, multi-line continuation. Keep all 4 (distinct paths)."""

    def test_valid_frontmatter(self, validate_ecosystem):
        result = validate_ecosystem.parse_frontmatter(VALID_FRONTMATTER)
        assert result is not None
        assert result["name"] == "realisera"
        assert result["description"] == "Autonomous development loops"
        assert result["trigger"] == "start building"

    def test_no_frontmatter(self, validate_ecosystem):
        result = validate_ecosystem.parse_frontmatter(NO_FRONTMATTER)
        assert result is None

    def test_unclosed_frontmatter(self, validate_ecosystem):
        result = validate_ecosystem.parse_frontmatter(UNCLOSED_FRONTMATTER)
        assert result is None

    def test_multiline_value(self, validate_ecosystem):
        text = """\
---
name: test-skill
description: A skill that does
  multiple things across lines
---
"""
        result = validate_ecosystem.parse_frontmatter(text)
        assert result is not None
        assert "multiple things" in result["description"]


# ---------------------------------------------------------------------------
# extract_section
# ---------------------------------------------------------------------------

MULTI_SECTION_DOC = """\
## First section

Content of the first section.
More content here.

## Second section

Content of the second section.

## Third section

Final section content.
"""


class TestExtractSection:
    """Complex: regex boundary matching. Keep all 4 (distinct boundary cases)."""

    def test_extract_existing_section(self, validate_ecosystem):
        result = validate_ecosystem.extract_section(MULTI_SECTION_DOC, "Second section")
        assert result is not None
        assert "Content of the second section" in result

    def test_missing_section(self, validate_ecosystem):
        result = validate_ecosystem.extract_section(MULTI_SECTION_DOC, "Nonexistent")
        assert result is None

    def test_section_at_end_of_file(self, validate_ecosystem):
        result = validate_ecosystem.extract_section(MULTI_SECTION_DOC, "Third section")
        assert result is not None
        assert "Final section content" in result

    def test_section_does_not_bleed(self, validate_ecosystem):
        result = validate_ecosystem.extract_section(MULTI_SECTION_DOC, "First section")
        assert result is not None
        assert "Content of the first section" in result
        assert "Content of the second section" not in result


# ---------------------------------------------------------------------------
# Results class
# ---------------------------------------------------------------------------


class TestResults:
    """Simple: data accumulation. One pass + one fail."""

    def test_mixed_entries_counted_correctly(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        r.ok("s1", "c1")
        r.error("s1", "c2", "bad")
        r.warn("s1", "c3", "meh")
        r.ok("s2", "c1")
        r.error("s2", "c2", "also bad")
        r.warn("s2", "c3", "also meh")
        r.error("s3", "c1", "very bad")
        assert r.error_count == 3
        assert r.warn_count == 2
        assert len(r.entries) == 7

    def test_empty_results(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        assert r.error_count == 0
        assert r.warn_count == 0
        assert r.entries == []


# ---------------------------------------------------------------------------
# extract_subsection
# ---------------------------------------------------------------------------

NESTED_SECTIONS_DOC = """\
## Parent one

Intro text for parent one.

### Child alpha

Content of child alpha under parent one.
More alpha content.

### Child beta

Content of child beta under parent one.

## Parent two

Intro text for parent two.

### Child alpha

Content of child alpha under parent two (different parent).

### Child gamma

Content of child gamma.
"""


class TestExtractSubsection:
    """Complex: regex + parent scoping. Keep 4 distinct paths."""

    def test_extract_existing_subsection(self, validate_ecosystem):
        result = validate_ecosystem.extract_subsection(
            NESTED_SECTIONS_DOC, "Parent one", "Child alpha",
        )
        assert result is not None
        assert "Content of child alpha under parent one" in result

    def test_subsection_scoped_to_parent(self, validate_ecosystem):
        """Same child heading name under different parents returns different content."""
        result = validate_ecosystem.extract_subsection(
            NESTED_SECTIONS_DOC, "Parent two", "Child alpha",
        )
        assert result is not None
        assert "under parent two" in result
        assert "under parent one" not in result

    def test_missing_child(self, validate_ecosystem):
        result = validate_ecosystem.extract_subsection(
            NESTED_SECTIONS_DOC, "Parent one", "Nonexistent child",
        )
        assert result is None

    def test_missing_parent(self, validate_ecosystem):
        result = validate_ecosystem.extract_subsection(
            NESTED_SECTIONS_DOC, "Nonexistent parent", "Child alpha",
        )
        assert result is None


# ---------------------------------------------------------------------------
# Shared synthetic SKILL.md content for check function tests
# ---------------------------------------------------------------------------

SYNTHETIC_SKILL_VALID = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

## State artifacts

| File | Purpose |
|------|---------|
| `VISION.md` | North Star direction, Who It's For personas, Principles, Direction, Identity |
| `TODO.md` | Critical, Degraded, Normal, Annoying, Resolved severity buckets |
| `CHANGELOG.md` | Unreleased, Added, Changed, Fixed sections |
| `PROGRESS.md` | Cycle log: What, Commit, Inspiration, Discovered, Next |

### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists. If it has an Artifact Mapping section, use the path specified for each canonical filename. If .agentera/DOCS.md does not exist or has no mapping, use the default layout.

## Cross-skill integration

Realisera is part of a twelve-skill ecosystem. Each skill can invoke the others when the work calls for it.

### Realisera reads visionera output
### Realisera delegates to optimera
### Realisera uses inspirera
### Realisera uses resonera for decisions
### Realisera consumes planera plans
### Realisera is audited by inspektera
### Realisera reads profilera output

Every cycle runs the effective profile script (python3 scripts/effective_profile.py from the profilera skill directory). Entries with effective confidence 65+ are strong constraints; <45 are suggestions. If the profile is missing or not available, proceed without persona grounding.

## Safety rails

<critical>

- NEVER push to any remote. Local commits only.
- NEVER bypass the project's test/lint/build suite.
- NEVER modify git config or skip git hooks.
- NEVER force push or amend published commits.

</critical>

## Exit signals

- **complete**: One full cycle completed.
- **flagged**: Cycle completed but with notable issues.
- **stuck**: Cannot complete a cycle.
- **waiting**: The project needs user input.

Before reporting any status, inspect the last 3 entries in PROGRESS.md. If all 3 entries record consecutive failures, stop and surface the situation to the user.
"""

SYNTHETIC_SKILL_MISSING_FRONTMATTER = """\
# REALISERA

No frontmatter at all.

## State artifacts

Content here.
"""

SYNTHETIC_SKILL_BAD_SAFETY_RAILS = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

## Safety rails

No critical tags here. Just some guidelines.
- Don't push to remote.
"""

SYNTHETIC_SKILL_BAD_EXIT_SIGNALS = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

## Exit signals

- **complete**: One full cycle completed.
- **stuck**: Cannot complete a cycle.
"""

SYNTHETIC_SKILL_BAD_CROSS_SKILL = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

## Cross-skill integration

Realisera is part of a ten-skill ecosystem.
"""

SYNTHETIC_SKILL_OLD_ARTIFACT_PATH = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

## State artifacts

### Artifact path resolution

Before reading or writing any artifact, check if DOCS.md exists in the project root.
"""

SYNTHETIC_SKILL_DECIMAL_CONFIDENCE = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

Entries with conf:0.75 are strong constraints.
Tier boundaries 0.85-0.95 define high confidence.
"""

SYNTHETIC_SKILL_EM_DASHES = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

This skill \u2014 the autonomous loop \u2014 runs development cycles.
"""

SYNTHETIC_SKILL_NO_LOOP_GUARD = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

## Exit signals

- **complete**: One full cycle completed.
- **flagged**: Cycle completed but with notable issues.
- **stuck**: Cannot complete a cycle.
- **waiting**: The project needs user input.
"""

SYNTHETIC_SKILL_BAD_NAME = """\
---
name: NotKebabCase
description: A skill with bad casing
---

# SKILL
"""

SYNTHETIC_SKILL_NON_CANONICAL_SEVERITY_TABLE = """\
---
name: inspektera
description: Audit skill
---

# INSPEKTERA

| Finding | Severity | Details |
|---------|----------|---------|
| Stale docs | high | Docs are outdated |
| Missing tests | major | No test coverage |
"""

SYNTHETIC_SKILL_NON_CANONICAL_SEVERITY_HEADING = """\
---
name: inspektera
description: Audit skill
---

# INSPEKTERA

### [high] Missing test coverage

Some findings here.
"""

SYNTHETIC_SKILL_NON_CANONICAL_SEVERITY_SECTION = """\
---
name: inspektera
description: Audit skill
---

# INSPEKTERA

## Severity

These findings are categorized as low priority items.
"""

SYNTHETIC_SKILL_CANONICAL_SEVERITY = """\
---
name: inspektera
description: Audit skill
---

# INSPEKTERA

| Finding | Severity | Details |
|---------|----------|---------|
| Stale docs | critical | Must fix now |
| Small typo | annoying | Cosmetic only |
| Build slow | degraded | Performance issue |
"""

SYNTHETIC_SKILL_RESONERA_WITH_LABELS = """\
---
name: resonera
description: Structured deliberation
---

# RESONERA

Decisions can be classified as firm, provisional, or exploratory.
"""

SYNTHETIC_SKILL_RESONERA_MISSING_LABELS = """\
---
name: resonera
description: Structured deliberation
---

# RESONERA

Decisions can be classified as firm only.
"""

SYNTHETIC_SKILL_EM_DASH_IN_CODE_BLOCK = """\
---
name: test-skill
description: Test skill
---

# TEST

This is clean prose with no dashes.

```
code_example \u2014 this em-dash is in a code block
```

More clean prose here.
"""

SYNTHETIC_SKILL_HARD_WRAP_PROSE = """\
---
name: test-skill
description: Test skill
---

# TEST

This is a prose line that is exactly eighty characters long, which triggers the c
heck for hard wraps since the next line continues immediately after.
"""

SYNTHETIC_SKILL_NO_HARD_WRAP = """\
---
name: test-skill
description: Test skill
---

# TEST

Short prose line.

Another separate paragraph that stands alone.
"""

SYNTHETIC_SKILL_HARD_WRAP_STRUCTURAL = """\
---
name: test-skill
description: Test skill
---

# TEST

- This is a list item that is quite long and goes on for a while but should not be flagged
- Another list item immediately after the first one

| This is a table row that is quite long and goes on for a while but should not be flagged |
"""

SYNTHETIC_SKILL_EMPTY = ""

SYNTHETIC_SKILL_ARTIFACT_PATH_WRONG_LOCATION = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

## State artifacts

| File | Purpose |
|------|---------|
| `PROGRESS.md` | Cycle log |

## Cross-skill integration

Realisera is part of a twelve-skill ecosystem.

### Artifact path resolution

Before reading or writing any artifact, check if .agentera/DOCS.md exists.
"""

SYNTHETIC_SKILL_ARTIFACT_PATH_NO_SUBSECTION = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

## State artifacts

| File | Purpose |
|------|---------|
| `PROGRESS.md` | Cycle log |

Some text about state artifacts but no subsection for artifact path resolution.
"""

SYNTHETIC_SKILL_PROFILE_MISSING_SCRIPT = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

Entries with effective confidence 65+ are strong constraints; <45 are suggestions. If the profile is missing or not available, proceed without persona grounding.
"""

SYNTHETIC_SKILL_PROFILE_DECIMAL_THRESHOLDS = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

Every cycle runs the effective profile script (python3 scripts/effective_profile.py from the profilera skill directory). Entries with effective confidence 0.65+ are strong constraints; <0.45 are suggestions. If the profile is missing or not available, proceed without persona grounding.
"""

SYNTHETIC_SKILL_PROFILE_NO_FALLBACK = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

Every cycle runs the effective profile script (python3 scripts/effective_profile.py from the profilera skill directory). Entries with effective confidence 65+ are strong constraints; <45 are suggestions.
"""

SYNTHETIC_SKILL_SAFETY_RAILS_FEW_NEVERS = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

## Safety rails

<critical>

- NEVER push to any remote.
- NEVER bypass test suites.

</critical>
"""

SYNTHETIC_SKILL_LOOP_GUARD_CONSECUTIVE_FAIL = """\
---
name: orkestrera
description: Plan-driven orchestration
---

# ORKESTRERA

## Exit signals

- **complete**: All plan tasks done.
- **flagged**: Completed with issues.
- **stuck**: Cannot proceed.
- **waiting**: Needs user input.

After 3 consecutive failures on a task, mark it as failed and escalate. Retry the task at most 3 times before moving on.
"""

SYNTHETIC_SKILL_LOOP_GUARD_RETRY_BASED = """\
---
name: optimera
description: Metric-driven optimization
---

# OPTIMERA

## Exit signals

- **complete**: Objective met.
- **flagged**: Improvement found but below target.
- **stuck**: No improvement after 3 experiments.
- **waiting**: Needs user input.

After 3 failed experiments, stop and report. Retry the task if initial attempt fails, up to the maximum.
"""


# ---------------------------------------------------------------------------
# check_frontmatter
# ---------------------------------------------------------------------------


class TestCheckFrontmatter:
    """Complex: regex (kebab-case), multi-field branching. Keep 4 distinct paths."""

    def test_valid_frontmatter_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_frontmatter("realisera", SYNTHETIC_SKILL_VALID, r)
        assert r.error_count == 0
        assert any(level == "PASS" for level, _, check, _ in r.entries if check == "frontmatter")

    def test_missing_frontmatter_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_frontmatter("realisera", SYNTHETIC_SKILL_MISSING_FRONTMATTER, r)
        assert r.error_count == 1
        assert "Missing or malformed" in r.entries[0][3]

    def test_missing_name_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        text = "---\ndescription: A skill without a name\n---\n\n# SKILL\n"
        validate_ecosystem.check_frontmatter("test-skill", text, r)
        assert r.error_count >= 1
        details = [detail for _, _, _, detail in r.entries if "name" in detail.lower()]
        assert len(details) >= 1

    def test_non_kebab_case_name_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_frontmatter("bad-skill", SYNTHETIC_SKILL_BAD_NAME, r)
        assert r.error_count >= 1
        details = [detail for _, _, _, detail in r.entries if "kebab" in detail.lower()]
        assert len(details) == 1


# ---------------------------------------------------------------------------
# check_confidence_scale
# ---------------------------------------------------------------------------


class TestCheckConfidenceScale:
    """Complex: two regex patterns with branching. Keep 3 distinct paths."""

    def test_valid_content_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_confidence_scale("realisera", SYNTHETIC_SKILL_VALID, r)
        assert r.error_count == 0
        assert any(level == "PASS" for level, _, check, _ in r.entries if check == "confidence-scale")

    def test_decimal_confidence_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_confidence_scale("realisera", SYNTHETIC_SKILL_DECIMAL_CONFIDENCE, r)
        assert r.error_count == 1
        detail = r.entries[0][3]
        assert "0.0-1.0" in detail

    def test_tier_boundaries_flagged(self, validate_ecosystem):
        text = "---\nname: test-skill\ndescription: Test\n---\n\nTier boundaries are 0.85-0.95 for high confidence.\n"
        r = validate_ecosystem.Results()
        validate_ecosystem.check_confidence_scale("test-skill", text, r)
        assert r.error_count == 1
        assert "tier boundaries" in r.entries[0][3].lower()


# ---------------------------------------------------------------------------
# check_severity_levels
# ---------------------------------------------------------------------------


class TestCheckSeverityLevels:
    """Complex: 4 regex patterns (table, heading, section, mapping). Keep 4 distinct paths."""

    def test_canonical_severity_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_severity_levels("inspektera", SYNTHETIC_SKILL_CANONICAL_SEVERITY, r)
        assert r.error_count == 0
        assert any(level == "PASS" for level, _, check, _ in r.entries if check == "severity-levels")

    def test_non_canonical_in_table_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_severity_levels("inspektera", SYNTHETIC_SKILL_NON_CANONICAL_SEVERITY_TABLE, r)
        assert r.error_count >= 1
        details = " ".join(detail for _, _, _, detail in r.entries)
        assert "high" in details.lower() or "major" in details.lower()

    def test_non_canonical_in_heading_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_severity_levels("inspektera", SYNTHETIC_SKILL_NON_CANONICAL_SEVERITY_HEADING, r)
        assert r.error_count >= 1
        details = " ".join(detail for _, _, _, detail in r.entries)
        assert "high" in details.lower()

    def test_non_canonical_in_severity_section_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_severity_levels("inspektera", SYNTHETIC_SKILL_NON_CANONICAL_SEVERITY_SECTION, r)
        assert r.error_count >= 1
        details = " ".join(detail for _, _, _, detail in r.entries)
        assert "low" in details.lower()


# ---------------------------------------------------------------------------
# check_decision_labels
# ---------------------------------------------------------------------------


class TestCheckDecisionLabels:
    """Simple: set membership check scoped to resonera. One pass + one fail."""

    def test_resonera_with_all_labels_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_decision_labels("resonera", SYNTHETIC_SKILL_RESONERA_WITH_LABELS, r)
        assert r.error_count == 0
        assert any(level == "PASS" for level, _, check, _ in r.entries if check == "decision-labels")

    def test_resonera_missing_labels_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_decision_labels("resonera", SYNTHETIC_SKILL_RESONERA_MISSING_LABELS, r)
        assert r.error_count == 1
        detail = r.entries[0][3]
        assert "provisional" in detail or "exploratory" in detail


# ---------------------------------------------------------------------------
# check_em_dashes
# ---------------------------------------------------------------------------


class TestCheckEmDashes:
    """Complex: regex with code block filtering. Keep 3 (pass, prose error, code block exclusion)."""

    def test_no_em_dashes_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_em_dashes("realisera", SYNTHETIC_SKILL_VALID, r)
        assert r.error_count == 0
        assert any(level == "PASS" for level, _, check, _ in r.entries if check == "em-dashes")

    def test_em_dash_in_prose_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_em_dashes("realisera", SYNTHETIC_SKILL_EM_DASHES, r)
        assert r.error_count == 1
        assert "Em-dash" in r.entries[0][3]

    def test_em_dash_in_code_block_ignored(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_em_dashes("test-skill", SYNTHETIC_SKILL_EM_DASH_IN_CODE_BLOCK, r)
        assert r.error_count == 0


# ---------------------------------------------------------------------------
# check_hard_wraps
# ---------------------------------------------------------------------------


class TestCheckHardWraps:
    """Complex: line analysis with structural exclusions. Keep 3 distinct paths."""

    def test_no_hard_wraps_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_hard_wraps("test-skill", SYNTHETIC_SKILL_NO_HARD_WRAP, r)
        assert r.error_count == 0
        assert r.warn_count == 0
        assert any(level == "PASS" for level, _, check, _ in r.entries if check == "hard-wraps")

    def test_hard_wrapped_prose_warns(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_hard_wraps("test-skill", SYNTHETIC_SKILL_HARD_WRAP_PROSE, r)
        assert r.warn_count >= 1
        assert r.error_count == 0
        detail = r.entries[0][3]
        assert "hard wrap" in detail.lower()

    def test_structural_lines_not_flagged(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_hard_wraps("test-skill", SYNTHETIC_SKILL_HARD_WRAP_STRUCTURAL, r)
        assert r.warn_count == 0


# ---------------------------------------------------------------------------
# check_artifact_path_resolution
# ---------------------------------------------------------------------------


class TestCheckArtifactPathResolution:
    """Complex: multi-branch (old-style, wrong-location, missing). Keep 4 distinct paths."""

    def test_valid_content_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_artifact_path_resolution(
            "realisera", SYNTHETIC_SKILL_VALID, r,
        )
        assert r.error_count == 0
        assert any(
            level == "PASS" for level, _, check, _ in r.entries
            if check == "artifact-path-resolution"
        )

    def test_old_style_wording_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_artifact_path_resolution(
            "realisera", SYNTHETIC_SKILL_OLD_ARTIFACT_PATH, r,
        )
        assert r.error_count == 1
        detail = r.entries[0][3]
        assert "old-style" in detail.lower() or "DOCS.md exists" in detail

    def test_missing_subsection_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_artifact_path_resolution(
            "realisera", SYNTHETIC_SKILL_ARTIFACT_PATH_NO_SUBSECTION, r,
        )
        assert r.error_count == 1
        assert "Missing ### Artifact path resolution" in r.entries[0][3]

    def test_wrong_location_errors(self, validate_ecosystem):
        """Instruction under Cross-skill instead of State artifacts is an error."""
        r = validate_ecosystem.Results()
        validate_ecosystem.check_artifact_path_resolution(
            "realisera", SYNTHETIC_SKILL_ARTIFACT_PATH_WRONG_LOCATION, r,
        )
        assert r.error_count == 1
        detail = r.entries[0][3]
        assert "Cross-skill" in detail or "not as a ### subsection" in detail


# ---------------------------------------------------------------------------
# check_profile_consumption
# ---------------------------------------------------------------------------


class TestCheckProfileConsumption:
    """Complex: multiple regex checks (script ref, decimal thresholds, fallback). Keep 4 distinct error paths."""

    def test_valid_consumer_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_profile_consumption(
            "realisera", SYNTHETIC_SKILL_VALID, r,
        )
        assert r.error_count == 0
        assert any(
            level == "PASS" for level, _, check, _ in r.entries
            if check == "profile-consumption"
        )

    def test_missing_script_reference_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_profile_consumption(
            "realisera", SYNTHETIC_SKILL_PROFILE_MISSING_SCRIPT, r,
        )
        assert r.error_count >= 1
        details = " ".join(d for _, _, _, d in r.entries)
        assert "effective_profile" in details

    def test_decimal_thresholds_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_profile_consumption(
            "realisera", SYNTHETIC_SKILL_PROFILE_DECIMAL_THRESHOLDS, r,
        )
        assert r.error_count >= 1
        details = " ".join(d for _, _, _, d in r.entries)
        assert "0.65" in details or "threshold" in details.lower()

    def test_missing_fallback_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_profile_consumption(
            "realisera", SYNTHETIC_SKILL_PROFILE_NO_FALLBACK, r,
        )
        assert r.error_count >= 1
        details = " ".join(d for _, _, _, d in r.entries)
        assert "fallback" in details.lower()


# ---------------------------------------------------------------------------
# check_cross_skill_integration
# ---------------------------------------------------------------------------


class TestCheckCrossSkillIntegration:
    """Branching: section presence + ecosystem count. Keep 3 (pass, wrong count, missing section)."""

    def test_valid_content_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_cross_skill_integration(
            "realisera", SYNTHETIC_SKILL_VALID, r,
        )
        assert r.error_count == 0
        assert any(
            level == "PASS" for level, _, check, _ in r.entries
            if check == "cross-skill-refs"
        )

    def test_wrong_ecosystem_count_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_cross_skill_integration(
            "realisera", SYNTHETIC_SKILL_BAD_CROSS_SKILL, r,
        )
        assert r.error_count >= 1
        detail = r.entries[0][3]
        assert "ten-skill" in detail

    def test_missing_section_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_cross_skill_integration(
            "realisera", SYNTHETIC_SKILL_BAD_SAFETY_RAILS, r,
        )
        assert r.error_count >= 1
        detail = r.entries[0][3]
        assert "Missing ## Cross-skill integration" in detail


# ---------------------------------------------------------------------------
# check_safety_rails
# ---------------------------------------------------------------------------


class TestCheckSafetyRails:
    """Branching: section presence, critical tags, NEVER count. Keep 3 distinct paths."""

    def test_valid_content_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_safety_rails("realisera", SYNTHETIC_SKILL_VALID, r)
        assert r.error_count == 0
        assert any(
            level == "PASS" for level, _, check, _ in r.entries
            if check == "safety-rails"
        )

    def test_no_critical_tags_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_safety_rails(
            "realisera", SYNTHETIC_SKILL_BAD_SAFETY_RAILS, r,
        )
        assert r.error_count == 1
        assert "critical" in r.entries[0][3].lower()

    def test_too_few_never_bullets_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_safety_rails(
            "realisera", SYNTHETIC_SKILL_SAFETY_RAILS_FEW_NEVERS, r,
        )
        assert r.error_count == 1
        detail = r.entries[0][3]
        assert "2" in detail
        assert "minimum 3" in detail.lower()


# ---------------------------------------------------------------------------
# check_artifact_format
# ---------------------------------------------------------------------------


class TestCheckArtifactFormat:
    """Simple: string presence checks (advisory only). One pass + one fail."""

    def test_valid_producer_no_warnings(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_artifact_format("realisera", SYNTHETIC_SKILL_VALID, r)
        assert r.error_count == 0
        assert r.warn_count == 0

    def test_producer_missing_elements_warns(self, validate_ecosystem):
        minimal = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA

Some content but no artifact format references.
"""
        r = validate_ecosystem.Results()
        validate_ecosystem.check_artifact_format("realisera", minimal, r)
        assert r.error_count == 0
        assert r.warn_count >= 1
        for level, _, check, _ in r.entries:
            if check == "artifact-format":
                assert level == "WARN"


# ---------------------------------------------------------------------------
# check_exit_signals
# ---------------------------------------------------------------------------


class TestCheckExitSignals:
    """Simple: term presence check. One pass + one fail."""

    def test_valid_content_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_exit_signals("realisera", SYNTHETIC_SKILL_VALID, r)
        assert r.error_count == 0
        assert any(
            level == "PASS" for level, _, check, _ in r.entries
            if check == "exit-signals"
        )

    def test_missing_terms_errors(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_exit_signals(
            "realisera", SYNTHETIC_SKILL_BAD_EXIT_SIGNALS, r,
        )
        assert r.error_count == 1
        detail = r.entries[0][3]
        assert "flagged" in detail
        assert "waiting" in detail


# ---------------------------------------------------------------------------
# check_loop_guard
# ---------------------------------------------------------------------------


class TestCheckLoopGuard:
    """Complex: multiple detection patterns (consecutive failure, retry-based). Keep 4 distinct paths."""

    def test_valid_content_passes(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        validate_ecosystem.check_loop_guard("realisera", SYNTHETIC_SKILL_VALID, r)
        assert r.error_count == 0
        assert any(
            level == "PASS" for level, _, check, _ in r.entries
            if check == "loop-guard"
        )

    def test_missing_loop_guard_errors(self, validate_ecosystem):
        """Autonomous skill with exit signals but no loop guard elements."""
        r = validate_ecosystem.Results()
        validate_ecosystem.check_loop_guard(
            "realisera", SYNTHETIC_SKILL_NO_LOOP_GUARD, r,
        )
        assert r.error_count >= 1

    def test_consecutive_failure_detection_passes(self, validate_ecosystem):
        """orkestrera-style loop guard using consecutive failure + retry."""
        r = validate_ecosystem.Results()
        validate_ecosystem.check_loop_guard(
            "orkestrera", SYNTHETIC_SKILL_LOOP_GUARD_CONSECUTIVE_FAIL, r,
        )
        assert r.error_count == 0

    def test_retry_based_detection_passes(self, validate_ecosystem):
        """optimera-style loop guard using retry-based task failure."""
        r = validate_ecosystem.Results()
        validate_ecosystem.check_loop_guard(
            "optimera", SYNTHETIC_SKILL_LOOP_GUARD_RETRY_BASED, r,
        )
        assert r.error_count == 0
