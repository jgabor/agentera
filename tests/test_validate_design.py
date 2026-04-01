"""Tests for skills/visualisera/scripts/validate_design.py."""

from __future__ import annotations


# ---------------------------------------------------------------------------
# parse_yaml_subset
# ---------------------------------------------------------------------------

NESTED_YAML = """\
primary: "#3B82F6"
secondary: "#10B981"
neutral:
  50: "#F9FAFB"
  900: "#111827"
"""

LIST_YAML = """\
- heading
- body
- caption
"""

NESTED_WITH_COMMENT = """\
# Color palette
primary: "#3B82F6"  # Blue
accent: "#F59E0B"
shades:
  light: "#DBEAFE"
  dark: "#1E3A5F"
"""


class TestParseYamlSubset:
    def test_nested_structure(self, validate_design):
        result = validate_design.parse_yaml_subset(NESTED_YAML)
        assert isinstance(result, dict)
        assert result["primary"] == '"#3B82F6"'
        assert result["secondary"] == '"#10B981"'
        assert isinstance(result["neutral"], dict)
        assert result["neutral"]["50"] == '"#F9FAFB"'
        assert result["neutral"]["900"] == '"#111827"'

    def test_top_level_list(self, validate_design):
        result = validate_design.parse_yaml_subset(LIST_YAML)
        assert isinstance(result, list)
        assert result == ["heading", "body", "caption"]

    def test_empty_input(self, validate_design):
        result = validate_design.parse_yaml_subset("")
        assert result == {}

    def test_comments_stripped(self, validate_design):
        result = validate_design.parse_yaml_subset(NESTED_WITH_COMMENT)
        assert result["primary"] == '"#3B82F6"'
        assert result["accent"] == '"#F59E0B"'
        assert isinstance(result["shades"], dict)

    def test_malformed_missing_colon(self, validate_design):
        text = "this line has no colon"
        try:
            validate_design.parse_yaml_subset(text)
            assert False, "Should have raised ValueError"
        except ValueError as exc:
            assert "line 1" in str(exc)


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------

VALID_DESIGN = """\
<!-- design:colors -->
```yaml
primary: "#3B82F6"
secondary: "#10B981"
```

<!-- design:theme -->
```yaml
light:
  bg: primary
  fg: secondary
```

<!-- design:fonts -->
```yaml
heading: Inter
body: "Source Sans Pro"
```
"""


class TestValidate:
    def test_valid_sections(self, validate_design):
        sections = validate_design.extract_sections(VALID_DESIGN)
        result = validate_design.validate("test.md", sections)
        assert result["valid"] is True
        assert "colors" in result["sections_found"]
        assert "theme" in result["sections_found"]
        assert "fonts" in result["sections_found"]
        assert len(result["errors"]) == 0

    def test_reports_missing_standard_sections(self, validate_design):
        sections = validate_design.extract_sections(VALID_DESIGN)
        result = validate_design.validate("test.md", sections)
        # Many standard sections are not present in VALID_DESIGN
        assert "spacing" in result["sections_missing"]
        assert "shadows" in result["sections_missing"]

    def test_theme_unresolved_reference(self, validate_design):
        text = """\
<!-- design:colors -->
```yaml
primary: "#3B82F6"
```

<!-- design:theme -->
```yaml
light:
  bg: nonexistent_color
```
"""
        sections = validate_design.extract_sections(text)
        result = validate_design.validate("test.md", sections)
        unresolved = [e for e in result["errors"] if e["type"] == "unresolved_reference"]
        assert len(unresolved) > 0
        assert "nonexistent_color" in unresolved[0]["message"]

    def test_empty_design(self, validate_design):
        sections = validate_design.extract_sections("")
        result = validate_design.validate("test.md", sections)
        assert result["valid"] is True  # No errors, just missing sections
        assert result["sections_found"] == []
        assert len(result["sections_missing"]) == len(validate_design.STANDARD_SECTIONS)

    def test_summary_counts(self, validate_design):
        sections = validate_design.extract_sections(VALID_DESIGN)
        result = validate_design.validate("test.md", sections)
        assert result["summary"]["total_sections"] == 3
        assert result["summary"]["total_tokens"] > 0
        assert result["summary"]["has_theme"] is True
