"""Tests for skills/visualisera/scripts/validate_design.py.

Proportionality: Decision 21. One pass + one fail per unit. Edge case tests
retained for parse_yaml_subset (complex parsing with nesting, lists, comments)
and validate (cross-section reference resolution).
"""

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


class TestParseYamlSubset:
    """Complex: parsing with nesting, lists, error handling. Keep 3 distinct paths."""

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
    """Complex: cross-section reference resolution. Keep 3 (valid, unresolved ref, empty)."""

    def test_valid_sections(self, validate_design):
        sections = validate_design.extract_sections(VALID_DESIGN)
        result = validate_design.validate("test.md", sections)
        assert result["valid"] is True
        assert "colors" in result["sections_found"]
        assert "theme" in result["sections_found"]
        assert "fonts" in result["sections_found"]
        assert len(result["errors"]) == 0

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
        assert result["valid"] is True
        assert result["sections_found"] == []
        assert len(result["sections_missing"]) == len(validate_design.STANDARD_SECTIONS)
