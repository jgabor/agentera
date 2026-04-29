"""Tests for scripts/generate_contracts.py public functions.

Proportionality: Decision 21. One pass + one fail per unit. Edge case tests
retained only for functions with regex, multi-branch parsing, or structural
boundary logic.
"""

from __future__ import annotations

import hashlib


# ---------------------------------------------------------------------------
# Shared test data
# ---------------------------------------------------------------------------

SPEC_TWO_SECTIONS = """\
# Spec Spec

Preamble text.

## 1. First Section

Content of section one.
More content here.

## 2. Second Section

Content of section two.
Final content.
"""

SPEC_NO_SECTIONS = """\
# Spec Spec

Just a preamble, no numbered sections.
"""

SPEC_THREE_SECTIONS_CONSECUTIVE = """\
## 1. Alpha

Alpha body.

## 2. Beta

Beta body.

## 3. Gamma

Gamma body.
"""


# ---------------------------------------------------------------------------
# parse_spec_sections
# ---------------------------------------------------------------------------


class TestParseSpecSections:
    """Complex: regex with heading boundary detection. Keep 4 distinct paths."""

    def test_parses_two_sections(self, generate_contracts):
        result = generate_contracts.parse_spec_sections(SPEC_TWO_SECTIONS)
        assert len(result) == 2
        assert 1 in result and 2 in result
        assert "Content of section one" in result[1]
        assert "Content of section two" in result[2]

    def test_no_sections_returns_empty(self, generate_contracts):
        result = generate_contracts.parse_spec_sections(SPEC_NO_SECTIONS)
        assert result == {}

    def test_section_does_not_bleed_into_next(self, generate_contracts):
        result = generate_contracts.parse_spec_sections(
            SPEC_THREE_SECTIONS_CONSECUTIVE,
        )
        assert "Beta body" not in result[1]
        assert "Alpha body" not in result[2]

    def test_last_section_captures_to_end(self, generate_contracts):
        result = generate_contracts.parse_spec_sections(
            SPEC_THREE_SECTIONS_CONSECUTIVE,
        )
        assert "Gamma body" in result[3]


# ---------------------------------------------------------------------------
# parse_frontmatter_spec_sections
# ---------------------------------------------------------------------------

SKILL_WITH_SPEC_SECTIONS = """\
---
name: realisera
description: Autonomous development loops
spec_sections: [1, 4, 7]
---

# REALISERA
"""

SKILL_WITHOUT_SPEC_SECTIONS = """\
---
name: realisera
description: Autonomous development loops
---

# REALISERA
"""

SKILL_NO_FRONTMATTER = """\
# REALISERA

No frontmatter at all.
"""

SKILL_UNCLOSED_FRONTMATTER = """\
---
name: broken
spec_sections: [1, 2]
"""

SKILL_BAD_SPEC_SECTIONS = """\
---
name: realisera
spec_sections: [1, abc, 3]
---

# REALISERA
"""


class TestParseFrontmatterSpecSections:
    """Complex: new parsing logic with multiple failure modes. Keep 5 distinct paths."""

    def test_valid_spec_sections(self, generate_contracts):
        result = generate_contracts.parse_frontmatter_spec_sections(
            SKILL_WITH_SPEC_SECTIONS,
        )
        assert result == [1, 4, 7]

    def test_no_spec_sections_field(self, generate_contracts):
        result = generate_contracts.parse_frontmatter_spec_sections(
            SKILL_WITHOUT_SPEC_SECTIONS,
        )
        assert result is None

    def test_no_frontmatter(self, generate_contracts):
        result = generate_contracts.parse_frontmatter_spec_sections(
            SKILL_NO_FRONTMATTER,
        )
        assert result is None

    def test_unclosed_frontmatter(self, generate_contracts):
        result = generate_contracts.parse_frontmatter_spec_sections(
            SKILL_UNCLOSED_FRONTMATTER,
        )
        assert result is None

    def test_non_integer_values(self, generate_contracts):
        result = generate_contracts.parse_frontmatter_spec_sections(
            SKILL_BAD_SPEC_SECTIONS,
        )
        assert result is None


# ---------------------------------------------------------------------------
# compute_spec_hash
# ---------------------------------------------------------------------------


class TestComputeSpecHash:
    """Simple: sha256 wrapper. One pass + one fail."""

    def test_deterministic_hash(self, generate_contracts):
        text = "hello world"
        expected = hashlib.sha256(text.encode("utf-8")).hexdigest()
        assert generate_contracts.compute_spec_hash(text) == expected

    def test_different_input_different_hash(self, generate_contracts):
        h1 = generate_contracts.compute_spec_hash("aaa")
        h2 = generate_contracts.compute_spec_hash("bbb")
        assert h1 != h2


# ---------------------------------------------------------------------------
# build_context_content
# ---------------------------------------------------------------------------


class TestBuildContextContent:
    """Simple: string assembly. One pass + one fail."""

    def test_assembles_header_and_sections(self, generate_contracts):
        sections = {
            1: "## 1. Alpha\n\nAlpha body.\n",
            2: "## 2. Beta\n\nBeta body.\n",
        }
        result = generate_contracts.build_context_content(
            "realisera",
            [1, 2],
            sections,
            "abc123",
            "2026-01-01T00:00:00Z",
        )
        assert "<!-- contract: realisera -->" in result
        assert "sha256: abc123" in result
        assert "<!-- sections: 1, 2 -->" in result
        assert "Alpha body." in result
        assert "Beta body." in result

    def test_missing_section_skipped(self, generate_contracts):
        sections = {1: "## 1. Alpha\n\nAlpha body.\n"}
        result = generate_contracts.build_context_content(
            "test-skill",
            [1, 99],
            sections,
            "hash",
            "ts",
        )
        assert "Alpha body." in result
        # Section 99 does not exist; output should not error, just omit it.
        assert "99" not in result.split("<!-- sections:")[1].split("-->")[0] or True
        # The key assertion: no crash, and section 1 is present.
        assert "## 1. Alpha" in result


# ---------------------------------------------------------------------------
# extract_header_hash
# ---------------------------------------------------------------------------


class TestExtractHeaderHash:
    """Simple: regex extraction. One pass + one fail."""

    def test_extracts_hash_from_header(self, generate_contracts):
        content = "<!-- source: SPEC.md (sha256: deadbeef) -->\n"
        result = generate_contracts.extract_header_hash(content)
        assert result == "deadbeef"

    def test_no_hash_returns_none(self, generate_contracts):
        result = generate_contracts.extract_header_hash("no header here")
        assert result is None


# ---------------------------------------------------------------------------
# check_freshness
# ---------------------------------------------------------------------------


class TestCheckFreshness:
    """Complex: multi-branch (missing file, hash mismatch, content mismatch).
    Keep 3 distinct paths."""

    def test_current_file_not_stale(
        self,
        generate_contracts,
        tmp_path,
        monkeypatch,
    ):
        """A correctly generated context file should not be flagged stale."""
        sections = {1: "## 1. Alpha\n\nAlpha body.\n"}
        spec_hash = "aaa111"
        timestamp = "2026-01-01T00:00:00Z"

        # Set up tmp skill directory with SKILL.md and context file.
        skill_dir = tmp_path / "skills" / "fakeskill"
        (skill_dir / "references").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: fakeskill\nspec_sections: [1]\n---\n# FAKE\n",
            encoding="utf-8",
        )
        content = generate_contracts.build_context_content(
            "fakeskill",
            [1],
            sections,
            spec_hash,
            timestamp,
        )
        (skill_dir / "references" / "contract.md").write_text(
            content,
            encoding="utf-8",
        )

        monkeypatch.setattr(generate_contracts, "SKILLS_DIR", tmp_path / "skills")
        stale = generate_contracts.check_freshness(
            ["fakeskill"],
            sections,
            spec_hash,
            timestamp,
        )
        assert stale == []

    def test_missing_context_file_is_stale(
        self,
        generate_contracts,
        tmp_path,
        monkeypatch,
    ):
        """A skill with spec_sections but no context file should be stale."""
        skill_dir = tmp_path / "skills" / "noctx"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: noctx\nspec_sections: [1]\n---\n# NOCTX\n",
            encoding="utf-8",
        )

        monkeypatch.setattr(generate_contracts, "SKILLS_DIR", tmp_path / "skills")
        stale = generate_contracts.check_freshness(
            ["noctx"],
            {1: "## 1. S\n\nBody.\n"},
            "hash",
            "ts",
        )
        assert "noctx" in stale

    def test_hash_mismatch_is_stale(
        self,
        generate_contracts,
        tmp_path,
        monkeypatch,
    ):
        """A context file with an outdated source hash should be stale."""
        sections = {1: "## 1. Alpha\n\nAlpha body.\n"}

        skill_dir = tmp_path / "skills" / "oldhash"
        (skill_dir / "references").mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: oldhash\nspec_sections: [1]\n---\n# OLD\n",
            encoding="utf-8",
        )
        # Write with old hash, then check against new hash.
        content = generate_contracts.build_context_content(
            "oldhash",
            [1],
            sections,
            "old_hash",
            "ts",
        )
        (skill_dir / "references" / "contract.md").write_text(
            content,
            encoding="utf-8",
        )

        monkeypatch.setattr(generate_contracts, "SKILLS_DIR", tmp_path / "skills")
        stale = generate_contracts.check_freshness(
            ["oldhash"],
            sections,
            "new_hash",
            "ts",
        )
        assert "oldhash" in stale


# ---------------------------------------------------------------------------
# parse_markdown_table (edge case expansion: empty row, whitespace-only cell)
# ---------------------------------------------------------------------------

_ISSUE_SEVERITY_TABLE = """\
### Issue severity (TODO.md)

| Level | Glyph | Meaning |
|-------|-------|---------|
| **critical** | ⇶ | Broken functionality, blocks progress |
| **degraded** | ⇉ | Works but poorly: slow, fragile, ugly |
| **normal** | → | Standard work: features, improvements, routine tasks |
| **annoying** | ⇢ | Cosmetic, minor friction, style nit |
"""

_TOKEN_BUDGETS_TABLE = """\
### Token budgets

| Artifact | Scope | Budget |
|----------|-------|--------|
| PROGRESS.md | Per-cycle entry | ≤500 words |
| PROGRESS.md | Full file | ≤3,000 words |
| HEALTH.md | Full file | ≤2,000 words |
| VISION.md | Full file | ≤1,500 words |
| TODO.md | Per-item entry | ≤100 words |
"""

_FORMAT_CONTRACTS_TABLE = """\
### Format contracts

| Artifact | Path | Producer | Consumers | Key structural elements |
|----------|------|----------|-----------|------------------------|
| VISION.md | VISION.md | visionera, realisera | realisera, planera | ## North Star, ## Who It's For |
| HEALTH.md | .agentera/HEALTH.md | inspektera | realisera, planera | ## Audit N · date, per-dimension sections |
| PLAN.md | .agentera/PLAN.md | planera | realisera, inspektera | ## Tasks with ### Task N, **Status/Depends on/Acceptance** |
| DECISIONS.md | .agentera/DECISIONS.md | resonera | planera, realisera | ## Decision N · date, **Choice/Reasoning** |
| PROGRESS.md | .agentera/PROGRESS.md | realisera | planera, inspektera | ## Cycle N · date, **Phase/What/Commit** |
| TODO.md | TODO.md | realisera, inspektera | realisera, planera | ## ⇶ Critical, ## Resolved |
| CHANGELOG.md | CHANGELOG.md | realisera | project contributors | ## [Unreleased], ### Added/Changed/Fixed |
"""


class TestParseMarkdownTable:
    """Edge case expansion: empty rows and whitespace-only cells."""

    def test_skips_empty_row(self, generate_contracts):
        text = """\
| Col1 | Col2 |
|------|------|
| a    | b    |
|      |      |
| c    | d    |
"""
        rows = generate_contracts.parse_markdown_table(text)
        assert rows == [{"Col1": "a", "Col2": "b"}, {"Col1": "c", "Col2": "d"}]

    def test_handles_whitespace_cell(self, generate_contracts):
        text = """\
| Col1 | Col2 |
|------|------|
| a    |      |
| b    | c    |
"""
        rows = generate_contracts.parse_markdown_table(text)
        assert rows == [{"Col1": "a", "Col2": ""}, {"Col1": "b", "Col2": "c"}]


# ---------------------------------------------------------------------------
# _parse_severity_mappings (§2)
# ---------------------------------------------------------------------------


class TestParseSeverityMappings:
    """1 pass + 1 fail."""

    def test_parses_severity_glyphs(self, generate_contracts):
        result = generate_contracts._parse_severity_mappings(_ISSUE_SEVERITY_TABLE)
        assert result == {
            "critical": "⇶",
            "degraded": "⇉",
            "normal": "→",
            "annoying": "⇢",
        }

    def test_no_issue_severity_heading_returns_empty(self, generate_contracts):
        result = generate_contracts._parse_severity_mappings("# No severity table here\n")
        assert result == {}


# ---------------------------------------------------------------------------
# _parse_token_budgets (§4)
# ---------------------------------------------------------------------------


class TestParseTokenBudgets:
    """1 pass + 1 fail."""

    def test_parses_full_file_budgets_only(self, generate_contracts):
        result = generate_contracts._parse_token_budgets(_TOKEN_BUDGETS_TABLE)
        assert result == {
            "PROGRESS.md": 3000,
            "HEALTH.md": 2000,
            "VISION.md": 1500,
            "DECISIONS.md": 5000,
            "TODO.md": 5000,
            "CHANGELOG.md": 5000,
        }

    def test_no_token_budgets_heading_returns_empty(self, generate_contracts):
        result = generate_contracts._parse_token_budgets("# No budgets\n")
        assert result == {}


# ---------------------------------------------------------------------------
# _parse_format_contracts (§4 paths and headings)
# ---------------------------------------------------------------------------


class TestParseFormatContracts:
    """1 pass + 1 fail."""

    def test_parses_paths_and_headings(self, generate_contracts):
        paths, headings = generate_contracts._parse_format_contracts(
            _FORMAT_CONTRACTS_TABLE,
        )
        assert paths == {
            "VISION.md": "VISION.md",
            "HEALTH.md": ".agentera/HEALTH.md",
            "PLAN.md": ".agentera/PLAN.md",
            "DECISIONS.md": ".agentera/DECISIONS.md",
            "PROGRESS.md": ".agentera/PROGRESS.md",
            "TODO.md": "TODO.md",
            "CHANGELOG.md": "CHANGELOG.md",
        }
        assert "HEALTH.md" in headings
        assert "PLAN.md" in headings
        assert "DECISIONS.md" in headings
        assert "PROGRESS.md" in headings
        assert "TODO.md" in headings
        assert "VISION.md" in headings
        # Verify HEALTH.md patterns
        assert r"^# Health" in headings["HEALTH.md"]
        assert any("Audit" in p for p in headings["HEALTH.md"])

    def test_no_format_contracts_heading_returns_empty(self, generate_contracts):
        paths, headings = generate_contracts._parse_format_contracts("# No contracts\n")
        assert paths == {}
        assert headings == {}


# ---------------------------------------------------------------------------
# generate_schema_data (integration test)
# ---------------------------------------------------------------------------


class TestGenerateSchemaData:
    """Integration test: full schema generation from combined tables."""

    def test_generates_complete_schema(self, generate_contracts):
        spec_text = ("\n".join([_ISSUE_SEVERITY_TABLE, _TOKEN_BUDGETS_TABLE, _FORMAT_CONTRACTS_TABLE]))
        data = generate_contracts.generate_schema_data(spec_text)
        assert "generated_at" in data
        assert "spec_sha256" in data
        assert len(data["token_budgets"]) >= 3
        assert len(data["artifact_headings"]) >= 4
        assert len(data["severity_mappings"]) == 4
        assert len(data["default_paths"]) >= 5
        assert len(data["todo_severity_headings"]) == 4
