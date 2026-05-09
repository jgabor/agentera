#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [ "pyyaml" ]
# ///
"""Generate or verify the JS install-root contract from the shared YAML fixture.

Reads `.agentera/install_root_interface_model.yaml` and either verifies that
``.opencode/plugins/agentera.js`` embeds a matching ``INSTALL_ROOT_CONTRACT``
export (default, exit code 0 on match, 1 on mismatch) or writes the generated
contract into the JS file with ``--write``.

Usage::

    uv run scripts/generate_js_install_root_contract.py              # verify
    uv run scripts/generate_js_install_root_contract.py --verify     # verify
    uv run scripts/generate_js_install_root_contract.py --write       # write
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:
    yaml = None  # type: ignore[assignment]


REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL = REPO_ROOT / ".agentera" / "install_root_interface_model.yaml"
PLUGIN = REPO_ROOT / ".opencode" / "plugins" / "agentera.js"

BEGIN_MARKER = "// --- BEGIN GENERATED: INSTALL_ROOT_CONTRACT ---"
END_MARKER = "// --- END GENERATED: INSTALL_ROOT_CONTRACT ---"


def _read_model() -> dict[str, Any]:
    if yaml is None:
        raise ImportError("PyYAML is required (pip install pyyaml)")
    return yaml.safe_load(MODEL.read_text(encoding="utf-8"))


def _read_plugin() -> str:
    return PLUGIN.read_text(encoding="utf-8")


def _py_to_js(value: object, indent: int = 0) -> str:
    """Convert a Python/YAML value (dict, list, str, bool, int, None) to JS syntax."""
    pad = "  " * indent
    inner_pad = "  " * (indent + 1)

    if isinstance(value, dict):
        items = []
        for k, v in value.items():
            js_val = _py_to_js(v, indent + 1)
            items.append(f"{inner_pad}{json_quote(k)}: {js_val}")
        if not items:
            return "{}"
        return "{\n" + ",\n".join(items) + f"\n{pad}}}"

    if isinstance(value, list):
        elements = [_py_to_js(v, indent + 1) for v in value]
        if not elements:
            return "[]"
        if all(len(e) < 80 and "\n" not in e for e in elements):
            return "[" + ", ".join(elements) + "]"
        joined = ",\n".join(f"{inner_pad}{e}" for e in elements)
        return "[\n" + joined + f"\n{pad}]"

    if isinstance(value, bool):
        return "true" if value else "false"

    if isinstance(value, int):
        return str(value)

    if isinstance(value, float):
        return str(value)

    if value is None:
        return "null"

    return json_quote(str(value))


def json_quote(s: str) -> str:
    escaped = s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")
    return f'"{escaped}"'


def generate_contract_code(model: dict[str, Any]) -> str:
    """Produce the JS export source for the install-root contract."""
    obj = _py_to_js(model, indent=1)
    return f"export const INSTALL_ROOT_CONTRACT = {obj};"


def extract_contract(plugin_text: str) -> str | None:
    """Extract the generated contract block from plugin JS text."""
    m = re.search(re.escape(BEGIN_MARKER) + "\n(.+?)\n" + re.escape(END_MARKER), plugin_text, re.DOTALL)
    return m.group(1).strip() if m else None


def check_contract(plugin_text: str, expected_js: str) -> list[str]:
    """Return list of mismatch errors, or empty list if contract matches."""
    existing = extract_contract(plugin_text)
    if existing is None:
        return [
            f"Missing generated contract section in {PLUGIN.name}",
            f"  expected markers: {BEGIN_MARKER} / {END_MARKER}",
        ]
    if existing.strip() != expected_js.strip():
        return ["Generated contract section in plugin does not match model"]
    return []


def write_contract(plugin_text: str, contract_code: str) -> str:
    """Replace the generated contract block in plugin text, or append it."""
    block = f"{BEGIN_MARKER}\n{contract_code}\n{END_MARKER}"
    if BEGIN_MARKER in plugin_text:
        return re.sub(
            re.escape(BEGIN_MARKER) + "\n.*?\n" + re.escape(END_MARKER),
            lambda _m: block,
            plugin_text,
            flags=re.DOTALL,
        )
    return plugin_text.rstrip() + "\n\n" + block + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--write",
        action="store_true",
        help="Write the generated contract into the JS plugin file",
    )
    mode.add_argument(
        "--verify",
        action="store_true",
        help="Verify the JS plugin contract matches the model (default)",
    )
    opts = parser.parse_args()

    model = _read_model()
    contract_js = generate_contract_code(model)
    plugin_text = _read_plugin()

    if opts.write:
        updated = write_contract(plugin_text, contract_js)
        PLUGIN.write_text(updated, encoding="utf-8")
        print(f"Wrote contract to {PLUGIN}")
        sys.exit(0)

    errors = check_contract(plugin_text, contract_js)
    if errors:
        print("MISMATCH: JS install-root contract does not match model:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)

    print("OK: JS install-root contract matches model")
    sys.exit(0)


if __name__ == "__main__":
    main()
