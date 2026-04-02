"""Tests for scripts/validate-ecosystem.py parsing functions."""

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
    def test_empty_results(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        assert r.error_count == 0
        assert r.warn_count == 0
        assert r.entries == []

    def test_ok_does_not_count_as_error_or_warn(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        r.ok("skill-a", "check-1")
        r.ok("skill-b", "check-2")
        assert r.error_count == 0
        assert r.warn_count == 0
        assert len(r.entries) == 2

    def test_error_count(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        r.error("skill-a", "check-1", "something broke")
        r.error("skill-a", "check-2", "another failure")
        assert r.error_count == 2
        assert r.warn_count == 0

    def test_warn_count(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        r.warn("skill-a", "check-1", "minor issue")
        r.warn("skill-b", "check-1", "another minor issue")
        r.warn("skill-c", "check-1", "yet another")
        assert r.warn_count == 3
        assert r.error_count == 0

    def test_mixed_entries(self, validate_ecosystem):
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

    def test_entry_tuple_structure(self, validate_ecosystem):
        r = validate_ecosystem.Results()
        r.ok("skill-x", "frontmatter")
        r.error("skill-x", "safety-rails", "missing NEVER bullets")
        r.warn("skill-x", "hard-wraps", "2 instances")
        assert r.entries[0] == ("PASS", "skill-x", "frontmatter", "")
        assert r.entries[1] == ("ERROR", "skill-x", "safety-rails", "missing NEVER bullets")
        assert r.entries[2] == ("WARN", "skill-x", "hard-wraps", "2 instances")


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
    def test_extract_existing_subsection(self, validate_ecosystem):
        result = validate_ecosystem.extract_subsection(
            NESTED_SECTIONS_DOC, "Parent one", "Child alpha",
        )
        assert result is not None
        assert "Content of child alpha under parent one" in result

    def test_subsection_does_not_bleed_to_sibling(self, validate_ecosystem):
        result = validate_ecosystem.extract_subsection(
            NESTED_SECTIONS_DOC, "Parent one", "Child alpha",
        )
        assert result is not None
        assert "Content of child beta" not in result

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

    def test_last_subsection_in_parent(self, validate_ecosystem):
        result = validate_ecosystem.extract_subsection(
            NESTED_SECTIONS_DOC, "Parent one", "Child beta",
        )
        assert result is not None
        assert "Content of child beta" in result


# ---------------------------------------------------------------------------
# Shared synthetic SKILL.md content for check function tests (Tasks 2 & 3)
# ---------------------------------------------------------------------------
# Targets "realisera" because it is in both SCRIPT_PATTERN_CONSUMERS and
# AUTONOMOUS_LOOP_SKILLS, which triggers the most check paths.
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
| `TODO.md` | Critical, Degraded, Annoying, Resolved severity buckets |
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
