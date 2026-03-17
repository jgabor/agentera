"""Extract crystallized decisions from memory files, CLAUDE.md, and AGENTS.md."""

import json
import sys
from pathlib import Path

from . import utils


def extract_memory_files() -> list[dict]:
    """Read all memory .md files across projects (excluding MEMORY.md index files)."""
    results = []
    for md in sorted(utils.PROJECTS_DIR.glob("*/memory/*.md")):
        if md.name == "MEMORY.md":
            continue
        project = utils.project_name_from_dir(md.parent.parent.name)
        text = md.read_text(encoding="utf-8", errors="replace")
        fm, body = utils.parse_frontmatter(text)
        results.append(
            {
                "source": str(md),
                "project": project,
                "type": fm.get("type", "unknown"),
                "name": fm.get("name", md.stem),
                "description": fm.get("description", ""),
                "content": body,
            }
        )
    return results


def extract_claude_md_files() -> list[dict]:
    """Read CLAUDE.md and AGENTS.md from git projects and global config."""
    results = []

    # Global CLAUDE.md
    global_claude = utils.CLAUDE_DIR / "CLAUDE.md"
    if global_claude.exists():
        text = global_claude.read_text(encoding="utf-8", errors="replace")
        results.append(
            {
                "source": str(global_claude),
                "project": "global",
                "type": "claude_md",
                "name": "global-claude-md",
                "description": "Global Claude Code instructions",
                "content": text,
            }
        )

    # Per-project CLAUDE.md and AGENTS.md
    if utils.GIT_DIR.exists():
        for name in ("CLAUDE.md", "AGENTS.md"):
            for md in sorted(utils.GIT_DIR.glob(f"*/{name}")):
                project = md.parent.name
                text = md.read_text(encoding="utf-8", errors="replace")
                file_type = "claude_md" if name == "CLAUDE.md" else "agents_md"
                results.append(
                    {
                        "source": str(md),
                        "project": project,
                        "type": file_type,
                        "name": f"{project}-{name.lower().replace('.', '-')}",
                        "description": f"{name} for {project}",
                        "content": text,
                    }
                )

    return results


def run(output_path: Path) -> dict:
    """Run extraction and write results. Returns summary stats."""
    memory = extract_memory_files()
    claude_md = extract_claude_md_files()
    all_entries = memory + claude_md

    output_path.write_text(
        json.dumps(all_entries, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    return {
        "memory_files": len(memory),
        "claude_md_files": len(claude_md),
        "total": len(all_entries),
    }


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("crystallized.json")
    stats = run(out)
    print(json.dumps(stats, indent=2))
