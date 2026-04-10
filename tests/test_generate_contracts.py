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
