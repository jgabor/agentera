"""Tests for skills/profilera/scripts/extract_all.py."""

from __future__ import annotations


# ---------------------------------------------------------------------------
# is_decision_rich
# ---------------------------------------------------------------------------


class TestIsDecisionRich:
    def test_decision_signal(self, extract_all):
        is_rich, signal = extract_all.is_decision_rich("Should we use a cache here?")
        assert is_rich is True
        assert signal == "decision"

    def test_correction_signal(self, extract_all):
        is_rich, signal = extract_all.is_decision_rich(
            "Actually, that approach is wrong for this case"
        )
        assert is_rich is True
        assert signal == "correction"

    def test_question_signal_long_text_with_question_mark(self, extract_all):
        text = "x" * 81 + " what do you think about this design choice?"
        is_rich, signal = extract_all.is_decision_rich(text)
        assert is_rich is True
        assert signal == "question"

    def test_short_text_rejected(self, extract_all):
        is_rich, _ = extract_all.is_decision_rich("hi there")
        assert is_rich is False

    def test_empty_text_rejected(self, extract_all):
        is_rich, signal = extract_all.is_decision_rich("")
        assert is_rich is False
        assert signal == ""


# ---------------------------------------------------------------------------
# parse_frontmatter
# ---------------------------------------------------------------------------

FRONTMATTER_VALID = """\
---
name: test-entry
description: A test entry for parsing
type: preference
---
Body content here.
"""

FRONTMATTER_MULTILINE = """\
---
name: folded-value
description: >
  This is a long
  description value
---
After frontmatter.
"""


class TestParseFrontmatter:
    def test_extracts_fields_and_body(self, extract_all):
        fm, body = extract_all.parse_frontmatter(FRONTMATTER_VALID)
        assert fm["name"] == "test-entry"
        assert fm["description"] == "A test entry for parsing"
        assert fm["type"] == "preference"
        assert body == "Body content here."

    def test_no_frontmatter_returns_empty_dict(self, extract_all):
        fm, body = extract_all.parse_frontmatter("Just plain text.")
        assert fm == {}
        assert body == "Just plain text."

    def test_folded_scalar_joins_lines(self, extract_all):
        fm, body = extract_all.parse_frontmatter(FRONTMATTER_MULTILINE)
        assert fm["name"] == "folded-value"
        assert "long" in fm["description"]
        assert "description value" in fm["description"]

    def test_unclosed_frontmatter_returns_empty_dict(self, extract_all):
        text = "---\nname: broken\nno closing marker"
        fm, body = extract_all.parse_frontmatter(text)
        assert fm == {}

    def test_empty_string(self, extract_all):
        fm, body = extract_all.parse_frontmatter("")
        assert fm == {}
        assert body == ""


# ---------------------------------------------------------------------------
# parse_jsonl
# ---------------------------------------------------------------------------


class TestParseJsonl:
    def test_parses_valid_lines(self, extract_all, tmp_path):
        f = tmp_path / "test.jsonl"
        f.write_text('{"a":1}\n{"b":2}\n')
        results = list(extract_all.parse_jsonl(f))
        assert len(results) == 2
        assert results[0] == {"a": 1}

    def test_skips_malformed_lines(self, extract_all, tmp_path):
        f = tmp_path / "bad.jsonl"
        f.write_text('{"ok":true}\nnot json\n{"also":true}\n')
        results = list(extract_all.parse_jsonl(f))
        assert len(results) == 2


# ---------------------------------------------------------------------------
# extract_text
# ---------------------------------------------------------------------------


class TestExtractText:
    def test_string_passthrough(self, extract_all):
        assert extract_all.extract_text("hello") == "hello"

    def test_content_blocks(self, extract_all):
        blocks = [
            {"type": "text", "text": "first"},
            {"type": "tool_use", "id": "x"},
            {"type": "text", "text": "second"},
        ]
        result = extract_all.extract_text(blocks)
        assert "first" in result
        assert "second" in result

    def test_non_string_non_list_returns_empty(self, extract_all):
        assert extract_all.extract_text(42) == ""


# ---------------------------------------------------------------------------
# project_name_from_dir
# ---------------------------------------------------------------------------


class TestProjectNameFromDir:
    def test_git_project_path(self, extract_all):
        assert extract_all.project_name_from_dir("-home-jgabor-git-lira") == "lira"

    def test_hyphenated_project_name(self, extract_all):
        assert extract_all.project_name_from_dir("-home-jgabor-git-jg-go") == "jg-go"

    def test_dot_prefix_from_leading_hyphen(self, extract_all):
        assert extract_all.project_name_from_dir("-home-jgabor--claude") == ".claude"

    def test_unknown_prefix_returns_as_is(self, extract_all):
        assert extract_all.project_name_from_dir("some-other-dir") == "some-other-dir"


# ---------------------------------------------------------------------------
# truncate
# ---------------------------------------------------------------------------


class TestTruncate:
    def test_short_text_unchanged(self, extract_all):
        assert extract_all.truncate("hello", 10) == "hello"

    def test_long_text_truncated_with_ellipsis(self, extract_all):
        result = extract_all.truncate("a" * 20, 10)
        assert len(result) == 13  # 10 chars + "..."
        assert result.endswith("...")


# ---------------------------------------------------------------------------
# _extract_gomod
# ---------------------------------------------------------------------------

GOMOD_TEXT = """\
module github.com/user/project

go 1.22

require (
	github.com/stretchr/testify v1.9.0
)
"""


class TestExtractGomod:
    def test_extracts_module_and_version(self, extract_all):
        signals = extract_all._extract_gomod(GOMOD_TEXT)
        assert "module: github.com/user/project" in signals
        assert "go version: 1.22" in signals

    def test_extracts_dependencies(self, extract_all):
        signals = extract_all._extract_gomod(GOMOD_TEXT)
        dep_signals = [s for s in signals if s.startswith("dep:")]
        assert len(dep_signals) >= 1

    def test_empty_input(self, extract_all):
        assert extract_all._extract_gomod("") == []


# ---------------------------------------------------------------------------
# _extract_golangci
# ---------------------------------------------------------------------------

GOLANGCI_TEXT = """\
linters:
  enable:
    - errcheck
    - gosimple
  disable:
    - deadcode

linters-settings:
  gofumpt:
    extra-rules: true
"""


class TestExtractGolangci:
    def test_extracts_enabled_linters(self, extract_all):
        signals = extract_all._extract_golangci(GOLANGCI_TEXT)
        assert "linter: errcheck" in signals
        assert "linter: gosimple" in signals

    def test_detects_gofumpt_formatter(self, extract_all):
        signals = extract_all._extract_golangci(GOLANGCI_TEXT)
        assert "formatter: gofumpt" in signals

    def test_empty_input(self, extract_all):
        assert extract_all._extract_golangci("") == []


# ---------------------------------------------------------------------------
# _extract_lefthook
# ---------------------------------------------------------------------------

LEFTHOOK_TEXT = """\
pre-commit:
  commands:
    lint:
      run: golangci-lint run
    test:
      run: go test ./...
"""


class TestExtractLefthook:
    def test_extracts_hook_names(self, extract_all):
        signals = extract_all._extract_lefthook(LEFTHOOK_TEXT)
        hook_signals = [s for s in signals if s.startswith("hook:")]
        assert "hook: pre-commit" in hook_signals

    def test_extracts_run_commands(self, extract_all):
        signals = extract_all._extract_lefthook(LEFTHOOK_TEXT)
        run_signals = [s for s in signals if s.startswith("run:")]
        assert len(run_signals) >= 1

    def test_empty_input(self, extract_all):
        assert extract_all._extract_lefthook("") == []


# ---------------------------------------------------------------------------
# _extract_magefile
# ---------------------------------------------------------------------------


class TestExtractMagefile:
    def test_extracts_exported_functions(self, extract_all):
        text = "func Build() error {\n}\nfunc Test() error {\n}\n"
        signals = extract_all._extract_magefile(text)
        assert "target: Build" in signals
        assert "target: Test" in signals

    def test_ignores_unexported_functions(self, extract_all):
        text = "func helper() {}\nfunc Exported() {}\n"
        signals = extract_all._extract_magefile(text)
        assert len(signals) == 1
        assert "target: Exported" in signals

    def test_empty_input(self, extract_all):
        assert extract_all._extract_magefile("") == []


# ---------------------------------------------------------------------------
# _extract_package_json
# ---------------------------------------------------------------------------


class TestExtractPackageJson:
    def test_extracts_name_and_deps(self, extract_all):
        text = '{"name": "my-app", "dependencies": {"react": "^18"}}'
        signals = extract_all._extract_package_json(text)
        assert "name: my-app" in signals
        assert "dep: react" in signals

    def test_extracts_scripts(self, extract_all):
        text = '{"scripts": {"build": "tsc", "test": "jest"}}'
        signals = extract_all._extract_package_json(text)
        assert "script: build" in signals
        assert "script: test" in signals

    def test_invalid_json_returns_empty(self, extract_all):
        assert extract_all._extract_package_json("not json") == []


# ---------------------------------------------------------------------------
# _extract_generic
# ---------------------------------------------------------------------------


class TestExtractGeneric:
    def test_returns_truncated_content(self, extract_all):
        signals = extract_all._extract_generic("some config content")
        assert len(signals) == 1
        assert signals[0] == "some config content"

    def test_long_input_truncated(self, extract_all):
        text = "x" * 2000
        signals = extract_all._extract_generic(text)
        assert len(signals[0]) == 1003  # 1000 + "..."
