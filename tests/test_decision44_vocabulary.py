"""Decision 44 plain-English vocabulary coverage.

The scanner fails on deprecated preferred wording unless the use is protected by
the boundary in docs/vocabulary.md. Each exception rule carries its rationale so
reviewers can distinguish stable compatibility terms from current prose.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re


REPO_ROOT = Path(__file__).resolve().parent.parent

SCANNED_FILES = (
    "README.md",
    "UPGRADE.md",
    "CHANGELOG.md",
    "TODO.md",
    "ROADMAP.md",
    "docs/vocabulary.md",
    ".agentera/docs.yaml",
    ".agentera/plan.yaml",
    ".agentera/progress.yaml",
    ".agentera/health.yaml",
)

SCANNED_DIRS = (
    "skills/agentera",
    "scripts",
    "tests",
    "references/adapters",
    "references/v1-section-mapping.md",
)

DEPRECATED_PREFERRED_RE = re.compile(
    r"freshness|\bcheckpoint\b|\bguard\b|Reality Verification Gate|"
    r"conductor protocol|memory layer|operating record|\bdrift\b|drifts|"
    r"drifted|drifting|DTC-first|\bDTC\b",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class AllowedUse:
    path_pattern: str
    text_pattern: str
    reason: str

    def matches(self, relative_path: str, text: str) -> bool:
        return re.search(self.path_pattern, relative_path) is not None and re.search(
            self.text_pattern,
            text,
            re.IGNORECASE,
        ) is not None


ALLOWED_USES = (
    AllowedUse(
        r"^docs/vocabulary\.md$",
        r"Decision 44|Deprecated preferred wording|Allowed use|Protected compatibility|Avoid|"
        r"Bare |Non-Git|Git-only|checkpoint commit|pre-dispatch checkpoint commit|"
        r"sounds like a branded synonym|Use instead|bundle freshness gap detected|"
        r"bundle freshness guard failed|upgrade guard triggered|artifact freshness failed|"
        r"Reality Verification Gate|Conductor protocol|Memory layer|operating record|"
        r"freshness|drift|DTC|guard|checkpoint",
        "Vocabulary authority records deprecated forms, replacements, and allowed/protected boundaries; it must not make them the recommended wording.",
    ),
    AllowedUse(
        r"^TODO\.md$",
        r"agentera-plain-prose-vocabulary|^[-] \[x\] ~~",
        "TODO either states the active Decision 44 removal scope or preserves resolved historical items.",
    ),
    AllowedUse(
        r"^CHANGELOG\.md$",
        r".",
        "Changelog entries are historical release evidence and are protected from vocabulary-only rewrites.",
    ),
    AllowedUse(
        r"^\.agentera/(docs|progress|health)\.yaml$",
        r".",
        "Project-state history is protected; entries may cite old terms as evidence, not recommended prose.",
    ),
    AllowedUse(
        r"^\.agentera/plan\.yaml$",
        r"Decision 44|Git-only checkpoint language|checkpoint wording is limited to Git commit contexts",
        "The active plan quotes the Decision 44 task scope and acceptance criteria for removing or bounding these terms.",
    ),
    AllowedUse(
        r"^skills/agentera/.*/schemas/.*\.yaml$|^skills/agentera/schemas/artifacts/.*\.yaml$|^references/adapters/.*\.yaml$|^scripts/runtime_adapter_registry\.py$",
        r".",
        "Schema fields, stable IDs, persisted shapes, and compatibility labels are protected surfaces.",
    ),
    AllowedUse(
        r"^skills/agentera/references/contract\.md$|^references/v1-section-mapping\.md$",
        r".",
        "Generated or legacy contract references preserve historical and compatibility vocabulary.",
    ),
    AllowedUse(
        r"^skills/agentera/capabilities/(realisera|optimera)/prose\.md$",
        r"checkpoint before worktree dispatch|checkpoint commit",
        "Git checkpoint commit wording is explicitly allowed by Decision 44.",
    ),
    AllowedUse(
        r"^skills/agentera/capabilities/inspektera/prose\.md$",
        r"protected health dimension label|persisted health dimension label remains `Artifact freshness`|protected Artifact freshness health dimension",
        "Artifact freshness is preserved only as a persisted health dimension label with an inline rationale.",
    ),
    AllowedUse(
        r"^tests/test_decision44_vocabulary\.py$",
        r".",
        "This regression test names deprecated terms only to detect and classify them.",
    ),
    AllowedUse(
        r"^tests/test_query_cli\.py$",
        r"Freshness",
        "Health fixture labels preserve existing CLI output behavior.",
    ),
    AllowedUse(
        r"^tests/test_schema_backed_routing_interface\.py$",
        r"drifted_routes|alias_target_drift",
        "Decision 43 alias mismatch fixture proves routing validation fails on changed mappings.",
    ),
    AllowedUse(
        r"^tests/test_runtime_adapters\.py$|^references/adapters/.*\.md$",
        r"drift|known_drifts|Drift Inventory",
        "Package/runtime drift inventories are stable compatibility labels from pre-Decision 44 adapter work.",
    ),
    AllowedUse(
        r"^tests/test_self_audit\.py$",
        r"verbosity drift",
        "Self-audit CLI fixture preserves installed-bundle diagnostic wording until the app-home bundle is refreshed.",
    ),
    AllowedUse(
        r"^tests/test_migration\.py$",
        r"Version and freshness remain green",
        "Migration fixture text preserves historical v1 expected output.",
    ),
    AllowedUse(
        r"^scripts/eval_skills\.py$",
        r"guard here for safety",
        "Ordinary code comment uses guard as a conventional safety phrase, not Agentera preferred vocabulary.",
    ),
)


def _iter_scanned_paths() -> list[Path]:
    paths = {REPO_ROOT / path for path in SCANNED_FILES}
    for entry in SCANNED_DIRS:
        root = REPO_ROOT / entry
        if root.is_file():
            paths.add(root)
            continue
        paths.update(
            path
            for path in root.rglob("*")
            if path.is_file()
            and "__pycache__" not in path.parts
            and ".pytest_cache" not in path.parts
        )
    return sorted(path for path in paths if path.exists())


def _matches() -> list[tuple[str, int, str, str]]:
    found: list[tuple[str, int, str, str]] = []
    for path in _iter_scanned_paths():
        relative_path = path.relative_to(REPO_ROOT).as_posix()
        for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if match := DEPRECATED_PREFERRED_RE.search(line):
                found.append((relative_path, line_number, match.group(0), line.strip()))
    return found


def _allowed_reason(relative_path: str, line: str) -> str | None:
    for allowed in ALLOWED_USES:
        if allowed.matches(relative_path, line):
            return allowed.reason
    return None


def test_decision_44_deprecated_preferred_vocabulary_is_bounded():
    unprotected = [
        f"{path}:{line_number}: {term!r}: {text}"
        for path, line_number, term, text in _matches()
        if _allowed_reason(path, text) is None
    ]

    assert unprotected == []


def test_decision_44_allowed_uses_are_reasoned_exceptions():
    for allowed in ALLOWED_USES:
        assert allowed.reason.strip()
        assert "preferred current language" not in allowed.reason.lower()

    reasoned_matches = [
        (path, line_number, _allowed_reason(path, text))
        for path, line_number, _term, text in _matches()
        if _allowed_reason(path, text) is not None
    ]

    assert reasoned_matches
    assert all(reason for _path, _line_number, reason in reasoned_matches)


def test_decision_44_current_vocabulary_boundary_is_present():
    vocabulary = (REPO_ROOT / "docs/vocabulary.md").read_text(encoding="utf-8")

    assert "## Decision 44 replacement boundary" in vocabulary
    assert "behavioral verification gate" in vocabulary
    assert "orchestration loop" in vocabulary
    assert "saved project context" in vocabulary
    assert "docs-first workflow" in vocabulary
    assert "Stable identifiers, enums, persisted state shapes" in vocabulary
