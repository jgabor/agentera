"""Extract recurring patterns from project configuration files."""

import json
import re
import sys
from pathlib import Path

from . import utils

# Config files to look for and how to extract signals from each
CONFIG_TYPES = {
    "go.mod": "gomod",
    ".golangci.yml": "golangci",
    ".golangci.yaml": "golangci",
    "lefthook.yml": "lefthook",
    "lefthook.yaml": "lefthook",
    "magefile.go": "magefile",
    ".goreleaser.yaml": "goreleaser",
    ".goreleaser.yml": "goreleaser",
    "package.json": "package_json",
    "tsconfig.json": "tsconfig",
    "biome.json": "biome",
    ".editorconfig": "editorconfig",
}


def _extract_gomod(text: str) -> list[str]:
    """Extract module path and key dependencies from go.mod."""
    signals = []
    for line in text.split("\n"):
        line = line.strip()
        if line.startswith("module "):
            signals.append(f"module: {line[7:]}")
        elif line.startswith("go "):
            signals.append(f"go version: {line[3:]}")
        elif "/" in line and not line.startswith("//"):
            # Dependency line
            dep = line.split()[0] if line.split() else ""
            if dep and not dep.startswith("(") and not dep.startswith(")"):
                signals.append(f"dep: {dep}")
    return signals


def _extract_golangci(text: str) -> list[str]:
    """Extract enabled linters and key settings from golangci-lint config."""
    signals = []
    in_enable = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("enable:"):
            in_enable = True
            continue
        if in_enable:
            if stripped.startswith("- "):
                signals.append(f"linter: {stripped[2:]}")
            elif not stripped.startswith("#") and stripped and not stripped.startswith("-"):
                in_enable = False

    # Check for formatter
    if "gofumpt" in text:
        signals.append("formatter: gofumpt")
    elif "gofmt" in text:
        signals.append("formatter: gofmt")

    return signals


def _extract_lefthook(text: str) -> list[str]:
    """Extract hook names and commands from lefthook config."""
    signals = []
    for match in re.finditer(r"^(\w[\w-]*):", text, re.MULTILINE):
        hook_name = match.group(1)
        if hook_name not in ("min_version", "output", "skip_output", "colors"):
            signals.append(f"hook: {hook_name}")

    for match in re.finditer(r"run:\s*(.+)", text):
        signals.append(f"run: {match.group(1).strip()}")

    return signals


def _extract_magefile(text: str) -> list[str]:
    """Extract build targets (exported functions) from magefile.go."""
    signals = []
    for match in re.finditer(r"^func\s+([A-Z]\w*)\b", text, re.MULTILINE):
        signals.append(f"target: {match.group(1)}")
    return signals


def _extract_package_json(text: str) -> list[str]:
    """Extract key info from package.json."""
    signals = []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return signals

    if "name" in data:
        signals.append(f"name: {data['name']}")

    for dep_key in ("dependencies", "devDependencies"):
        for dep in data.get(dep_key, {}):
            signals.append(f"dep: {dep}")

    for script_name in data.get("scripts", {}):
        signals.append(f"script: {script_name}")

    return signals


def _extract_generic(text: str) -> list[str]:
    """For configs without specific parsers, include a truncated version."""
    return [utils.truncate(text, 1000)]


EXTRACTORS = {
    "gomod": _extract_gomod,
    "golangci": _extract_golangci,
    "lefthook": _extract_lefthook,
    "magefile": _extract_magefile,
    "goreleaser": _extract_generic,
    "package_json": _extract_package_json,
    "tsconfig": _extract_generic,
    "biome": _extract_generic,
    "editorconfig": _extract_generic,
}


def extract(git_dir: Path | None = None) -> list[dict]:
    """Scan git projects for config files and extract signals."""
    if git_dir is None:
        git_dir = utils.GIT_DIR

    if not git_dir.exists():
        return []

    results = []

    for project_dir in sorted(git_dir.iterdir()):
        if not project_dir.is_dir():
            continue

        project = project_dir.name

        for config_name, config_type in CONFIG_TYPES.items():
            config_path = project_dir / config_name
            if not config_path.exists():
                continue

            text = config_path.read_text(encoding="utf-8", errors="replace")
            extractor = EXTRACTORS.get(config_type, _extract_generic)
            signals = extractor(text)

            if signals:
                results.append(
                    {
                        "project": project,
                        "config_type": config_type,
                        "file_path": str(config_path),
                        "signals": signals,
                    }
                )

    return results


def run(output_path: Path, git_dir: Path | None = None) -> dict:
    """Run extraction and write results. Returns summary stats."""
    results = extract(git_dir)

    output_path.write_text(
        json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    # Stats
    by_type = {}
    by_project = {}
    for r in results:
        ct = r["config_type"]
        by_type[ct] = by_type.get(ct, 0) + 1
        p = r["project"]
        by_project[p] = by_project.get(p, 0) + 1

    return {
        "total_configs": len(results),
        "by_config_type": by_type,
        "projects_with_configs": len(by_project),
    }


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("project_configs.json")
    stats = run(out)
    print(json.dumps(stats, indent=2))
