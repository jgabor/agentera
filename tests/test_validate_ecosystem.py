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
