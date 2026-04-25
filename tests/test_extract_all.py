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


# ---------------------------------------------------------------------------
# _generate_source_id
# ---------------------------------------------------------------------------


class TestGenerateSourceId:
    def test_produces_hex_string(self, extract_all):
        sid = extract_all._generate_source_id("claude-code", "history_prompt", "/path")
        assert len(sid) == 16
        assert all(c in "0123456789abcdef" for c in sid)

    def test_same_inputs_produce_same_id(self, extract_all):
        a = extract_all._generate_source_id("claude-code", "history_prompt", "x")
        b = extract_all._generate_source_id("claude-code", "history_prompt", "x")
        assert a == b

    def test_different_inputs_produce_different_ids(self, extract_all):
        a = extract_all._generate_source_id("claude-code", "history_prompt", "x")
        b = extract_all._generate_source_id("claude-code", "history_prompt", "y")
        assert a != b


# ---------------------------------------------------------------------------
# _probe_claude_code
# ---------------------------------------------------------------------------


class TestProbeClaude:
    def test_detects_claude_md(self, extract_all, tmp_path, monkeypatch):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        (fake_claude / "CLAUDE.md").write_text("# Claude")
        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        assert extract_all._probe_claude_code() is True

    def test_returns_false_when_no_data(self, extract_all, tmp_path, monkeypatch):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        assert extract_all._probe_claude_code() is False


# ---------------------------------------------------------------------------
# _probe_copilot_cli
# ---------------------------------------------------------------------------


class TestProbeCopilot:
    def test_reports_checked_surfaces_without_data(self, extract_all, tmp_path):
        fake_copilot = tmp_path / ".copilot"
        probe = extract_all._probe_copilot_cli(fake_copilot)
        assert probe["available"] is False
        assert probe["checked_surfaces"]
        assert all(str(path).startswith(str(fake_copilot))
                   for path in probe["checked_surfaces"])
        assert probe["families"]["history_prompt"]["status"] == "missing"
        assert probe["families"]["conversation_turn"]["status"] == "missing"

    def test_detects_copilot_settings(self, extract_all, tmp_path):
        fake_copilot = tmp_path / ".copilot"
        fake_copilot.mkdir()
        (fake_copilot / "settings.json").write_text('{"telemetry": false}')
        probe = extract_all._probe_copilot_cli(fake_copilot)
        assert probe["available"] is True
        assert probe["families"]["project_config_signal"]["status"] == "available"


# ---------------------------------------------------------------------------
# _probe_codex_cli
# ---------------------------------------------------------------------------


class TestProbeCodex:
    def test_reports_checked_surfaces_without_data(self, extract_all, tmp_path):
        fake_codex = tmp_path / ".codex"
        probe = extract_all._probe_codex_cli(fake_codex)
        assert probe["available"] is False
        assert probe["checked_surfaces"]
        assert all(str(path).startswith(str(fake_codex))
                   for path in probe["checked_surfaces"])
        assert probe["families"]["instruction_document"]["status"] == "missing"
        assert probe["families"]["conversation_turn"]["status"] == "missing"

    def test_detects_codex_sessions(self, extract_all, tmp_path):
        fake_codex = tmp_path / ".codex"
        sessions = fake_codex / "sessions" / "2026" / "04" / "24"
        sessions.mkdir(parents=True)
        (sessions / "session.jsonl").write_text('{"role":"user","content":"hi"}\n')
        probe = extract_all._probe_codex_cli(fake_codex)
        assert probe["available"] is True
        assert probe["families"]["conversation_turn"]["status"] == "available"


# ---------------------------------------------------------------------------
# validate_corpus
# ---------------------------------------------------------------------------


class TestValidateCorpus:
    def test_valid_records_pass(self, extract_all):
        records = [
            {
                "source_id": "abc123",
                "timestamp": "2026-04-11T00:00:00Z",
                "project_id": "myproject",
                "source_kind": "history_prompt",
                "runtime": "claude-code",
                "adapter_version": "2.6.0",
                "data": {},
            }
        ]
        errors, warnings = extract_all.validate_corpus(records)
        assert errors == []
        assert warnings == []

    def test_missing_fields_produce_errors(self, extract_all):
        records = [
            {
                "source_id": "abc123",
                # timestamp missing
                "project_id": "myproject",
                # source_kind missing
                "runtime": "claude-code",
                "adapter_version": "2.6.0",
                # data missing
            }
        ]
        errors, warnings = extract_all.validate_corpus(records)
        assert len(errors) == 1
        assert "timestamp" in errors[0]
        assert "source_kind" in errors[0]
        assert "data" in errors[0]

    def test_domain_fields_must_be_nested_under_data(self, extract_all):
        records = [
            {
                "source_id": "abc123",
                "timestamp": "2026-04-11T00:00:00Z",
                "project_id": "myproject",
                "source_kind": "history_prompt",
                "runtime": "claude-code",
                "adapter_version": "2.6.0",
                "prompt": "Should this be top-level?",
                "signal_type": "question",
            }
        ]

        errors, warnings = extract_all.validate_corpus(records)

        assert len(errors) == 1
        assert "data" in errors[0]
        assert warnings == []

    def test_data_must_be_object(self, extract_all):
        records = [
            {
                "source_id": "abc123",
                "timestamp": "2026-04-11T00:00:00Z",
                "project_id": "myproject",
                "source_kind": "history_prompt",
                "runtime": "claude-code",
                "adapter_version": "2.6.0",
                "data": "prompt text",
            }
        ]

        errors, warnings = extract_all.validate_corpus(records)

        assert errors == ["Record abc123: data must be an object"]
        assert warnings == []

    def test_unrecognized_source_kind_produces_warning(self, extract_all):
        records = [
            {
                "source_id": "abc123",
                "timestamp": "2026-04-11T00:00:00Z",
                "project_id": "myproject",
                "source_kind": "custom_extension",
                "runtime": "claude-code",
                "adapter_version": "2.6.0",
                "data": {},
            }
        ]
        errors, warnings = extract_all.validate_corpus(records)
        assert errors == []
        assert len(warnings) == 1
        assert "custom_extension" in warnings[0]


# ---------------------------------------------------------------------------
# _records_from_* (provenance attachment)
# ---------------------------------------------------------------------------


class TestRecordsProvenance:
    def test_memory_records_have_provenance(self, extract_all):
        entries = [{"source": "/path/to/file.md", "project": "myproj", "content": "x"}]
        records = extract_all._records_from_memory(entries)
        assert len(records) == 1
        rec = records[0]
        for field in ("source_id", "timestamp", "project_id", "source_kind",
                       "runtime", "adapter_version", "data"):
            assert field in rec, f"Missing field: {field}"
        assert rec["source_kind"] == "instruction_document"
        assert rec["runtime"] == "claude-code"

    def test_empty_entries_produce_no_records(self, extract_all):
        assert extract_all._records_from_history([]) == []
        assert extract_all._records_from_configs([]) == []

    def test_codex_records_have_runtime_ids_and_provenance(self, extract_all):
        entries = [{
            "source": "/tmp/.codex/sessions/session.jsonl",
            "line": 1,
            "runtime_session_id": "sess-1",
            "runtime_record_id": "turn-1",
            "timestamp": "2026-04-24T00:00:00Z",
            "project": "agentera",
            "role": "user",
            "content": "Should we keep this?",
        }]
        records = extract_all._records_from_codex_conversations(entries)
        assert len(records) == 1
        rec = records[0]
        assert rec["runtime"] == "codex-cli"
        assert rec["source_kind"] == "conversation_turn"
        assert rec["data"]["runtime_session_id"] == "sess-1"
        assert rec["data"]["runtime_record_id"] == "turn-1"
        for field in ("source_id", "timestamp", "project_id", "adapter_version"):
            assert rec[field]


# ---------------------------------------------------------------------------
# _cleanup_legacy_files
# ---------------------------------------------------------------------------


class TestCleanupLegacyFiles:
    def test_removes_existing_legacy_files(self, extract_all, tmp_path):
        # Create some of the legacy files
        (tmp_path / "crystallized.json").write_text("{}")
        (tmp_path / "extraction_summary.json").write_text("{}")
        removed = extract_all._cleanup_legacy_files(tmp_path)
        assert "crystallized.json" in removed
        assert "extraction_summary.json" in removed
        assert not (tmp_path / "crystallized.json").exists()
        assert not (tmp_path / "extraction_summary.json").exists()

    def test_no_legacy_files_returns_empty(self, extract_all, tmp_path):
        removed = extract_all._cleanup_legacy_files(tmp_path)
        assert removed == []


# ---------------------------------------------------------------------------
# Copilot config redaction
# ---------------------------------------------------------------------------


class TestCopilotJsonSignals:
    def test_redacts_sensitive_primitive_values(self, extract_all):
        signals = extract_all._copilot_json_signals({
            "access_token": "tok-123",
            "apiKey": "key-456",
            "password": "pw-789",
            "theme": "dark",
        })

        joined = "\n".join(signals)
        assert "tok-123" not in joined
        assert "key-456" not in joined
        assert "pw-789" not in joined
        assert "access_token: [redacted]" in signals
        assert "apiKey: [redacted]" in signals
        assert "password: [redacted]" in signals
        assert "theme: dark" in signals

    def test_nested_and_list_values_stay_bounded(self, extract_all):
        signals = extract_all._copilot_json_signals({
            "nested": {"secret": "nested-secret", "theme": "dark"},
            "plugins": [{"token": "list-token"}, "plain-list-value"],
        })

        joined = "\n".join(signals)
        assert "nested-secret" not in joined
        assert "list-token" not in joined
        assert "plain-list-value" not in joined
        assert "nested: 2 keys" in signals
        assert "plugins: 2 items" in signals

    def test_non_sensitive_false_positives_remain(self, extract_all):
        signals = extract_all._copilot_json_signals({
            "keyboardLayout": "vim",
            "monkeyMode": "enabled",
            "tokenizer": "cl100k_base",
        })

        assert "keyboardLayout: vim" in signals
        assert "monkeyMode: enabled" in signals
        assert "tokenizer: cl100k_base" in signals


# ---------------------------------------------------------------------------
# build_corpus (envelope generation)
# ---------------------------------------------------------------------------


class TestBuildCorpus:
    def test_multi_runtime_envelope_includes_all_runtime_ids(
        self, extract_all, tmp_path, monkeypatch
    ):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        (fake_claude / "CLAUDE.md").write_text("# Test\nPrefer minimal changes.")
        fake_projects = fake_claude / "projects"
        fake_projects.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_copilot.mkdir()
        (fake_copilot / "settings.json").write_text('{"theme": "dark"}')
        fake_codex = tmp_path / ".codex"
        sessions = fake_codex / "sessions"
        sessions.mkdir(parents=True)
        (sessions / "session.jsonl").write_text(
            '{"session_id":"sess-1","id":"turn-1","role":"user",'
            '"content":"Should we keep runtime IDs?"}\n'
        )
        fake_git = tmp_path / "git"
        fake_git.mkdir()

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_projects)
        monkeypatch.setattr(extract_all, "GIT_DIR", fake_git)
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        corpus, errors, warnings = extract_all.build_corpus()

        assert errors == []
        assert warnings == []
        assert set(corpus["metadata"]["runtimes"]) == {
            "claude-code",
            "copilot-cli",
            "codex-cli",
        }
        assert {record["runtime"] for record in corpus["records"]} == {
            "claude-code",
            "copilot-cli",
            "codex-cli",
        }

    def test_envelope_structure_with_data(self, extract_all, tmp_path, monkeypatch):
        # Set up minimal Claude Code runtime data
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        (fake_claude / "CLAUDE.md").write_text("# Test")
        fake_projects = fake_claude / "projects"
        fake_projects.mkdir()
        fake_git = tmp_path / "git"
        fake_git.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_codex = tmp_path / ".codex"

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_projects)
        monkeypatch.setattr(extract_all, "GIT_DIR", fake_git)
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        corpus, errors, warnings = extract_all.build_corpus()
        assert "metadata" in corpus
        assert "records" in corpus
        assert isinstance(corpus["records"], list)
        assert corpus["metadata"]["total_records"] == len(corpus["records"])
        assert errors == []

    def test_returns_empty_when_no_runtime(self, extract_all, tmp_path, monkeypatch):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_codex = tmp_path / ".codex"
        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        corpus, errors, warnings = extract_all.build_corpus()
        assert corpus == {}
        assert errors == []
        assert warnings == []

    def test_copilot_settings_build_partial_corpus(
        self, extract_all, tmp_path, monkeypatch
    ):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_copilot.mkdir()
        (fake_copilot / "settings.json").write_text('{"theme": "dark"}')
        fake_codex = tmp_path / ".codex"

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        corpus, errors, warnings = extract_all.build_corpus()

        assert errors == []
        assert warnings == []
        assert corpus["metadata"]["runtimes"] == ["copilot-cli"]
        assert corpus["metadata"]["total_records"] == 1
        record = corpus["records"][0]
        assert record["runtime"] == "copilot-cli"
        assert record["source_kind"] == "project_config_signal"
        copilot_families = corpus["metadata"]["runtime_status"]["copilot-cli"]["families"]
        assert copilot_families["project_config_signal"]["status"] == "ok"
        assert copilot_families["instruction_document"]["status"] == "missing"
        assert copilot_families["history_prompt"]["status"] == "missing"
        assert copilot_families["conversation_turn"]["status"] == "missing"

    def test_copilot_settings_redacts_sensitive_values_in_corpus(
        self, extract_all, tmp_path, monkeypatch
    ):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_copilot.mkdir()
        (fake_copilot / "settings.json").write_text(
            '{"apiKey": "live-secret", "theme": "dark", '
            '"nested": {"token": "nested-secret"}, '
            '"plugins": [{"password": "list-secret"}]}'
        )
        fake_codex = tmp_path / ".codex"

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        corpus, errors, warnings = extract_all.build_corpus()

        assert errors == []
        assert warnings == []
        data = corpus["records"][0]["data"]
        joined = "\n".join(data["signals"])
        assert "live-secret" not in joined
        assert "nested-secret" not in joined
        assert "list-secret" not in joined
        assert "apiKey: [redacted]" in data["signals"]
        assert "theme: dark" in data["signals"]

    def test_copilot_source_ids_stable_across_extractions(
        self, extract_all, tmp_path, monkeypatch
    ):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_copilot.mkdir()
        (fake_copilot / "settings.json").write_text('{"theme": "dark"}')
        fake_codex = tmp_path / ".codex"

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        first, _, _ = extract_all.build_corpus()
        second, _, _ = extract_all.build_corpus()
        first_ids = [record["source_id"] for record in first["records"]]
        second_ids = [record["source_id"] for record in second["records"]]
        assert first_ids == second_ids
        assert len(first_ids) == len(set(first_ids))

    def test_partial_runtime_failure_keeps_bounded_status(
        self, extract_all, tmp_path, monkeypatch
    ):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        (fake_claude / "CLAUDE.md").write_text("# Test")
        fake_projects = fake_claude / "projects"
        fake_projects.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_codex = tmp_path / ".codex"
        fake_codex.mkdir()
        (fake_codex / "history.jsonl").write_text('{"prompt":"hello"}\n')

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_projects)
        monkeypatch.setattr(extract_all, "GIT_DIR", tmp_path / "git")
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)
        monkeypatch.setattr(extract_all, "extract_history", lambda: [{
            "timestamp": "2026-04-25T00:00:00Z",
            "project": "agentera",
            "prompt": "Should Claude history still count?",
            "session_id": "claude-session",
        }])

        def fail_codex_history():
            raise RuntimeError("codex history unreadable")

        monkeypatch.setattr(extract_all, "extract_codex_history", fail_codex_history)

        corpus, errors, warnings = extract_all.build_corpus()

        assert errors == []
        assert warnings == []
        assert corpus["metadata"]["families"]["history_prompt"]["status"] == "partial"
        assert corpus["metadata"]["errors"] == [
            "codex-cli.history_prompt: codex history unreadable"
        ]
        codex_history = corpus["metadata"]["runtime_status"]["codex-cli"]["families"]["history_prompt"]
        assert codex_history["status"] == "missing"
        assert codex_history["error"] == "codex history unreadable"
        assert codex_history["checked_surfaces"] == [str(fake_codex / "history.jsonl")]


class TestValidateCorpusEnvelope:
    def _record(self, extract_all, source_id="r1", runtime="claude-code"):
        return {
            "source_id": source_id,
            "timestamp": "2026-04-24T00:00:00Z",
            "project_id": "agentera",
            "source_kind": "history_prompt",
            "runtime": runtime,
            "adapter_version": extract_all.ADAPTER_VERSION,
            "data": {"prompt": "Should we validate envelopes?"},
        }

    def _envelope(self, extract_all, records, runtimes=None):
        runtimes = runtimes or sorted({record["runtime"] for record in records})
        runtime_status = {}
        families = {}
        for runtime in runtimes:
            runtime_status[runtime] = {
                "available": True,
                "checked_surfaces": [f"/tmp/{runtime}"],
                "families": {},
            }
            for family in extract_all._SOURCE_FAMILIES:
                count = sum(
                    1 for record in records
                    if record["runtime"] == runtime and record["source_kind"] == family
                )
                runtime_status[runtime]["families"][family] = {
                    "count": count,
                    "status": "ok" if count else "missing",
                }
        for family in extract_all._SOURCE_FAMILIES:
            by_runtime = {
                runtime: status["families"][family]
                for runtime, status in runtime_status.items()
            }
            count = sum(info["count"] for info in by_runtime.values())
            families[family] = {
                "count": count,
                "status": "ok" if count else "missing",
                "by_runtime": by_runtime,
            }
        return {
            "metadata": {
                "extracted_at": "2026-04-24T00:00:00Z",
                "runtimes": runtimes,
                "adapter_version": extract_all.ADAPTER_VERSION,
                "families": families,
                "runtime_status": runtime_status,
                "total_records": len(records),
            },
            "records": records,
        }

    def test_complete_envelope_passes(self, extract_all):
        corpus = self._envelope(
            extract_all,
            [
                self._record(extract_all, "r1", "claude-code"),
                self._record(extract_all, "r2", "copilot-cli"),
            ],
        )

        assert extract_all.validate_corpus_envelope(corpus) == ([], [])

    def test_partial_envelope_passes(self, extract_all):
        corpus = self._envelope(extract_all, [self._record(extract_all)])
        corpus["metadata"]["families"] = {
            family: dict(info)
            for family, info in corpus["metadata"]["families"].items()
        }
        corpus["metadata"]["families"]["history_prompt"]["status"] = "partial"

        assert extract_all.validate_corpus_envelope(corpus) == ([], [])

    def test_no_data_envelope_passes(self, extract_all):
        assert extract_all.validate_corpus_envelope({}) == ([], [])

    def test_duplicate_source_id_fails(self, extract_all):
        corpus = self._envelope(
            extract_all,
            [self._record(extract_all), self._record(extract_all)],
        )

        errors, warnings = extract_all.validate_corpus_envelope(corpus)

        assert "Record r1: duplicate source_id" in errors
        assert warnings == []

    def test_invalid_envelope_fails(self, extract_all):
        corpus = self._envelope(extract_all, [self._record(extract_all)])
        corpus["metadata"]["runtimes"] = []
        corpus["metadata"]["total_records"] = 2

        errors, warnings = extract_all.validate_corpus_envelope(corpus)

        assert "corpus.metadata.runtimes: must name contributing runtimes" in errors
        assert "corpus.metadata.total_records: must match records length" in errors
        assert warnings == []

    def test_missing_required_metadata_fields_fail(self, extract_all):
        corpus = self._envelope(extract_all, [self._record(extract_all)])
        del corpus["metadata"]["extracted_at"]
        del corpus["metadata"]["families"]

        errors, warnings = extract_all.validate_corpus_envelope(corpus)

        assert (
            "corpus.metadata: missing required fields: extracted_at, families"
            in errors
        )
        assert "corpus.metadata.families: must be an object" in errors
        assert warnings == []

    def test_invalid_family_status_and_count_fail(self, extract_all):
        corpus = self._envelope(extract_all, [self._record(extract_all)])
        family = corpus["metadata"]["families"]["history_prompt"]
        family["status"] = "ready"
        family["count"] = "one"

        errors, warnings = extract_all.validate_corpus_envelope(corpus)

        assert (
            "corpus.metadata.families.history_prompt.count: "
            "must be a non-negative integer"
        ) in errors
        assert (
            "corpus.metadata.families.history_prompt.status: "
            "must be one of missing, ok, partial"
        ) in errors
        assert warnings == []

    def test_per_runtime_family_consistency_failures_are_actionable(self, extract_all):
        records = [
            self._record(extract_all, "r1", "claude-code"),
            self._record(extract_all, "r2", "copilot-cli"),
        ]
        corpus = self._envelope(extract_all, records)
        corpus["metadata"]["runtime_status"]["copilot-cli"]["families"]["history_prompt"] = {
            "count": 0,
            "status": "missing",
        }
        corpus["metadata"]["families"]["history_prompt"]["by_runtime"]["copilot-cli"] = {
            "count": 1,
            "status": "ok",
        }
        corpus["metadata"]["families"]["history_prompt"]["count"] = 2

        errors, warnings = extract_all.validate_corpus_envelope(corpus)

        assert (
            "corpus.metadata.runtime_status.copilot-cli.families.history_prompt.count: "
            "must match 1 emitted records"
        ) in errors
        assert (
            "corpus.metadata.families.history_prompt.count: must equal per-runtime count 1"
            in errors
        )
        assert (
            "corpus.metadata.families.history_prompt.by_runtime.copilot-cli: "
            "must match runtime_status family data"
        ) in errors
        assert warnings == []

    def test_copilot_secondary_surfaces_stay_bounded(self, extract_all, tmp_path, monkeypatch):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        fake_copilot = tmp_path / ".copilot"
        skills = fake_copilot / "skills" / "local"
        plugin = fake_copilot / "installed-plugins" / "agentera"
        skills.mkdir(parents=True)
        plugin.mkdir(parents=True)
        (skills / "SKILL.md").write_text(
            "---\nname: local\ndescription: Local skill\n---\nUse local instruction."
        )
        (plugin / "plugin.json").write_text('{"name":"agentera","version":"1.0.0"}')
        fake_codex = tmp_path / ".codex"

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        corpus, errors, warnings = extract_all.build_corpus()

        assert errors == []
        assert warnings == []
        assert {record["source_kind"] for record in corpus["records"]} == {
            "instruction_document",
            "project_config_signal",
        }
        checked = corpus["metadata"]["runtime_status"]["copilot-cli"]["checked_surfaces"]
        assert checked == [
            str(fake_copilot / "installed-plugins"),
            str(fake_copilot / "settings.json"),
            str(fake_copilot / "skills"),
        ]

    def test_codex_secondary_surfaces_stay_bounded(self, extract_all, tmp_path, monkeypatch):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_codex = tmp_path / ".codex"
        fake_codex.mkdir()
        (fake_codex / "history.jsonl").write_text(
            '{"id":"hist-1","prompt":"Should history be covered?"}\n'
        )
        (fake_codex / "config.toml").write_text(
            'model = "gpt-5"\napi_key = "secret"\n[profiles.default]\n'
        )

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        corpus, errors, warnings = extract_all.build_corpus()

        assert errors == []
        assert warnings == []
        assert {record["source_kind"] for record in corpus["records"]} == {
            "history_prompt",
            "project_config_signal",
        }
        config_record = next(
            record for record in corpus["records"]
            if record["source_kind"] == "project_config_signal"
        )
        assert config_record["data"]["signals"] == ["model", "[profiles.default]"]
        checked = corpus["metadata"]["runtime_status"]["codex-cli"]["checked_surfaces"]
        assert checked == [
            str(fake_codex / "config.toml"),
            str(fake_codex / "history.jsonl"),
            str(fake_codex / "sessions"),
        ]

    def test_codex_sessions_build_partial_corpus(
        self, extract_all, tmp_path, monkeypatch
    ):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_codex = tmp_path / ".codex"
        sessions = fake_codex / "sessions" / "2026" / "04" / "24"
        sessions.mkdir(parents=True)
        (sessions / "session.jsonl").write_text(
            '{"session_id":"sess-1","id":"turn-1","timestamp":"2026-04-24T00:00:00Z",'
            '"role":"user","content":"Should we add Codex support?"}\n'
        )

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        corpus, errors, warnings = extract_all.build_corpus()

        assert errors == []
        assert warnings == []
        assert corpus["metadata"]["runtimes"] == ["codex-cli"]
        assert corpus["metadata"]["total_records"] == 1
        record = corpus["records"][0]
        assert record["runtime"] == "codex-cli"
        assert record["source_kind"] == "conversation_turn"
        assert record["data"]["runtime_session_id"] == "sess-1"
        codex_families = corpus["metadata"]["runtime_status"]["codex-cli"]["families"]
        assert codex_families["conversation_turn"]["status"] == "ok"
        assert codex_families["instruction_document"]["status"] == "missing"
        assert codex_families["history_prompt"]["status"] == "missing"
        assert codex_families["project_config_signal"]["status"] == "missing"

    def test_codex_source_ids_stable_across_extractions(
        self, extract_all, tmp_path, monkeypatch
    ):
        fake_claude = tmp_path / ".claude"
        fake_claude.mkdir()
        fake_copilot = tmp_path / ".copilot"
        fake_codex = tmp_path / ".codex"
        sessions = fake_codex / "sessions"
        sessions.mkdir(parents=True)
        (sessions / "session.jsonl").write_text(
            '{"session_id":"sess-1","id":"turn-1","role":"user",'
            '"content":"Stable identity please"}\n'
        )

        monkeypatch.setattr(extract_all, "CLAUDE_DIR", fake_claude)
        monkeypatch.setattr(extract_all, "PROJECTS_DIR", fake_claude / "projects")
        monkeypatch.setattr(extract_all, "COPILOT_DIR", fake_copilot)
        monkeypatch.setattr(extract_all, "CODEX_DIR", fake_codex)

        first, _, _ = extract_all.build_corpus()
        second, _, _ = extract_all.build_corpus()
        first_ids = [record["source_id"] for record in first["records"]]
        second_ids = [record["source_id"] for record in second["records"]]
        assert first_ids == second_ids
        assert len(first_ids) == len(set(first_ids))
