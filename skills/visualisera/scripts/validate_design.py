#!/usr/bin/env python3
"""Validate a DESIGN.md file and output structured results for visualisera.

Usage:
    python3 -m scripts.validate_design --design DESIGN.md [--pretty]

Parses ``<!-- design:X -->`` markers followed by fenced YAML code blocks,
validates structure and internal consistency, and outputs JSON with:
- Sections found / missing
- Parse errors per section
- Theme reference resolution
- Typography / tw-merge-preserve consistency
- Token count summary
"""

import argparse
import json
import re
import sys
from pathlib import Path

STANDARD_SECTIONS = [
    "colors", "font-sizes", "fonts", "typography", "spacing",
    "radius", "shadows", "theme", "constraints", "components",
    "tw-merge-preserve",
]

# Marker followed by fenced yaml block (allows whitespace between).
BLOCK_RE = re.compile(
    r"<!--\s*design:(\w[\w-]*)\s*-->\s*\n\s*```ya?ml\n([\s\S]*?)```",
)


def _strip_comment(line: str) -> str:
    """Remove inline ``# comment`` (space-preceded) outside quotes."""
    in_quote = None
    for i, ch in enumerate(line):
        if ch in ('"', "'") and in_quote is None:
            in_quote = ch
        elif ch == in_quote:
            in_quote = None
        elif ch == "#" and in_quote is None and i > 0 and line[i - 1] == " ":
            return line[:i].rstrip()
    return line


def parse_yaml_subset(text: str) -> dict | list:
    """Parse the YAML subset used by DESIGN.md token blocks.

    Handles flat ``key: value``, one level nesting, ``- item`` arrays,
    and ``# comment`` lines.  Raises ``ValueError`` on malformed input.
    """
    result: dict = {}
    current_key: str | None = None
    current_value: dict | list | None = None
    top_level_list: list | None = None

    for lineno, raw in enumerate(text.splitlines(), 1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())

        # Top-level array item
        if indent == 0 and stripped.startswith("- "):
            if top_level_list is None:
                top_level_list = []
            top_level_list.append(_strip_comment(stripped[2:].strip()))
            continue

        # Top-level key
        if indent == 0:
            if current_key is not None and current_value is not None:
                result[current_key] = current_value
                current_value = None
            colon = stripped.find(":")
            if colon == -1:
                raise ValueError(f"line {lineno}: expected 'key: value', got: {stripped!r}")
            key = stripped[:colon].strip()
            rest = _strip_comment(stripped[colon + 1:].strip())
            if rest:
                result[key] = rest
                current_key = current_value = None
            else:
                current_key, current_value = key, None
            continue

        # Indented content under current_key
        if current_key is not None:
            if stripped.startswith("- "):
                item_text = _strip_comment(stripped[2:].strip())
                colon = item_text.find(":")
                if colon != -1 and not item_text.startswith('"'):
                    obj = {item_text[:colon].strip(): _strip_comment(item_text[colon + 1:].strip())}
                    if current_value is None:
                        current_value = []
                    if isinstance(current_value, list):
                        current_value.append(obj)
                    continue
                if current_value is None:
                    current_value = []
                if isinstance(current_value, list):
                    current_value.append(item_text)
                continue
            colon = stripped.find(":")
            if colon != -1:
                if current_value is None:
                    current_value = {}
                if isinstance(current_value, dict):
                    current_value[stripped[:colon].strip()] = _strip_comment(stripped[colon + 1:].strip())
                continue
            raise ValueError(f"line {lineno}: unexpected indented content: {stripped!r}")

        raise ValueError(f"line {lineno}: unexpected content: {stripped!r}")

    if current_key is not None and current_value is not None:
        result[current_key] = current_value
    return top_level_list if (top_level_list is not None and not result) else result


def extract_sections(text: str) -> list[dict]:
    """Find all ``<!-- design:X -->`` + yaml blocks, parse each."""
    sections = []
    for m in BLOCK_RE.finditer(text):
        entry: dict = {"name": m.group(1), "raw": m.group(2)}
        try:
            entry["data"], entry["error"] = parse_yaml_subset(m.group(2)), None
        except ValueError as exc:
            entry["data"], entry["error"] = None, str(exc)
        sections.append(entry)
    return sections


def _keys(data) -> set[str]:
    return set(data.keys()) if isinstance(data, dict) else set()


def _count_tokens(sections: list[dict]) -> int:
    return sum(len(s["data"]) for s in sections if isinstance(s.get("data"), (dict, list)))


def validate(file_path: str, sections: list[dict]) -> dict:
    """Run all validation checks and return the result envelope."""
    found_names = [s["name"] for s in sections]
    found_set = set(found_names)
    by_name = {s["name"]: s for s in sections}
    errors: list[dict] = []
    warnings: list[dict] = []

    # YAML parse errors
    for sec in sections:
        if sec["error"]:
            errors.append({"section": sec["name"], "type": "yaml_parse_error", "message": sec["error"]})

    # Duplicate sections (spec: at most one per file)
    seen: set[str] = set()
    for name in found_names:
        if name in seen:
            errors.append({
                "section": name, "type": "duplicate_section",
                "message": f"Section '{name}' appears more than once (spec requires at most one per file)",
            })
        seen.add(name)

    # Theme reference resolution
    theme, colors = by_name.get("theme"), by_name.get("colors")
    if theme and theme["data"] and colors and colors["data"]:
        color_keys = _keys(colors["data"])
        if isinstance(theme["data"], dict):
            for mode, mapping in theme["data"].items():
                if isinstance(mapping, dict):
                    for semantic, ref in mapping.items():
                        if ref and ref not in color_keys:
                            errors.append({
                                "section": "theme", "type": "unresolved_reference",
                                "message": f"Theme mode '{mode}' key '{semantic}' references '{ref}' which is not defined in colors",
                            })
    elif theme and theme["data"] and not colors:
        warnings.append({
            "section": "theme", "type": "missing_dependency",
            "message": "Theme section exists but no colors section found to resolve references against",
        })

    # tw-merge-preserve vs typography consistency
    preserve, typo = by_name.get("tw-merge-preserve"), by_name.get("typography")
    if preserve and typo and preserve["data"] and typo["data"]:
        typo_keys = _keys(typo["data"])
        pdata = preserve["data"]
        preserve_items = {str(i) for i in pdata} if isinstance(pdata, list) else set(pdata.keys()) if isinstance(pdata, dict) else set()
        for tk in typo_keys - preserve_items:
            warnings.append({"section": "typography", "type": "preserve_mismatch", "message": f"Typography key '{tk}' not in tw-merge-preserve"})
        for pk in preserve_items - typo_keys:
            warnings.append({"section": "tw-merge-preserve", "type": "preserve_mismatch", "message": f"Preserve entry '{pk}' has no matching typography key"})

    # Constraints references (informational)
    cons = by_name.get("constraints")
    if cons and isinstance(cons.get("data"), dict):
        for cat, rules in cons["data"].items():
            if isinstance(rules, list):
                for rule in rules:
                    if isinstance(rule, dict):
                        prop = rule.get("property") or rule.get("pattern")
                        if prop:
                            warnings.append({
                                "section": "constraints", "type": "constraint_reference",
                                "message": f"Constraint category '{cat}' references property/pattern '{prop}'",
                            })

    return {
        "file": file_path,
        "valid": len(errors) == 0,
        "sections_found": sorted(found_set),
        "sections_missing": [s for s in STANDARD_SECTIONS if s not in found_set],
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "total_sections": len(found_set),
            "total_tokens": _count_tokens(sections),
            "has_theme": "theme" in found_set,
            "has_constraints": "constraints" in found_set,
        },
    }


def main():
    parser = argparse.ArgumentParser(description="Validate DESIGN.md for visualisera")
    parser.add_argument("--design", required=True, help="Path to DESIGN.md file")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = parser.parse_args()

    design_path = Path(args.design)
    if not design_path.exists():
        print(json.dumps({"file": str(design_path), "valid": False, "error": f"{design_path} not found"}, indent=2 if args.pretty else None))
        sys.exit(1)

    text = design_path.read_text(encoding="utf-8")
    sections = extract_sections(text)
    result = validate(str(design_path), sections)
    print(json.dumps(result, indent=2 if args.pretty else None))
    sys.exit(0 if result["valid"] else 1)


if __name__ == "__main__":
    main()
