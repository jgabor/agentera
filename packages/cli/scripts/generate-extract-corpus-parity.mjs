#!/usr/bin/env node
/**
 * Sync extract-corpus parity surfaces from the TypeScript source of truth.
 *
 * Writes:
 *   - packages/cli/test/analytics/fixtures/extract-corpus-parity-manifest.json
 *   - packages/cli/bundle/extract-corpus-parity.json (when bundle dir exists)
 *   - scripts/extract_corpus.py (generated Python-visible wrapper)
 *
 * Exits non-zero when the committed manifest would drift without an intentional
 * regen (`node packages/cli/scripts/generate-extract-corpus-parity.mjs --write`).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const repoRoot = path.resolve(pkgRoot, "..", "..");
const fixturePath = path.join(pkgRoot, "test/analytics/fixtures/extract-corpus-parity-manifest.json");
const bundleManifestPath = path.join(pkgRoot, "bundle/extract-corpus-parity.json");
const pythonPath = path.join(repoRoot, "scripts/extract_corpus.py");
const distParity = path.join(pkgRoot, "dist/analytics/extractCorpus/extractCorpusParity.js");
const writeMode = process.argv.includes("--write");

function stableJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function ensureBuilt() {
  if (fs.existsSync(distParity)) return;
  const build = spawnSync("pnpm", ["-C", pkgRoot, "run", "build"], { stdio: "inherit" });
  if (build.status !== 0) {
    console.error("generate-extract-corpus-parity: build failed");
    process.exit(build.status ?? 1);
  }
}

function loadManifest() {
  ensureBuilt();
  return import(pathToFileUrl(distParity)).then((mod) => mod.buildExtractCorpusParityManifest());
}

function pathToFileUrl(p) {
  return new URL(`file://${p.split(path.sep).join("/")}`).href;
}

function renderPythonWrapper(manifest) {
  const probeScript = path.relative(repoRoot, path.join(pkgRoot, "scripts/extract-corpus-parity-probe.mjs"));
  return `#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Generated extract-corpus wrapper — TypeScript is authoritative.

DO NOT EDIT. Regenerate with:
  node packages/cli/scripts/generate-extract-corpus-parity.mjs --write
  pnpm -C packages/cli run bundle:data
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

# GENERATED constants synced from packages/cli/src/analytics/extractCorpus/core.ts
ADAPTER_VERSION = ${JSON.stringify(manifest.adapter_version)}
MAX_SQLITE_ROWS = ${manifest.max_sqlite_rows}
MAX_SQLITE_SESSIONS = ${manifest.max_sqlite_sessions}
MAX_TOOL_ARG_TEXT = ${manifest.max_tool_arg_text}
COPILOT_SPARSE_REMEDIATION = ${JSON.stringify(manifest.copilot_sparse_remediation)}
RUNTIME_STORE_GLOBS = ${JSON.stringify(manifest.runtime_store_globs, null, 4).replaceAll("\n", "\n")}
FAMILIES = ${JSON.stringify(manifest.families)}

REPO_ROOT = Path(__file__).resolve().parents[1]
PROBE_SCRIPT = REPO_ROOT / ${JSON.stringify(probeScript)}


def _run_ts_probe(db_path: Path) -> dict:
    proc = subprocess.run(
        ["node", str(PROBE_SCRIPT), "--opencode", str(db_path)],
        cwd=str(REPO_ROOT),
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or proc.stdout.strip() or "extract-corpus parity probe failed")
    return json.loads(proc.stdout)


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) >= 2 and args[0] == "--parity-probe-opencode":
        snapshot = _run_ts_probe(Path(args[1]))
        print(json.dumps(snapshot, indent=2, sort_keys=True))
        return 0
    sys.stderr.write(
        "extract_corpus.py is a generated TypeScript wrapper. "
        "Use 'agentera report refresh --consent local-history' for extraction, "
        "or --parity-probe-opencode <opencode.db> for parity probes.\\n"
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
`;
}

async function main() {
  const manifest = await loadManifest();
  const rendered = stableJson(manifest);
  const python = renderPythonWrapper(manifest);

  if (writeMode) {
    fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
    fs.writeFileSync(fixturePath, rendered, "utf8");
    fs.mkdirSync(path.dirname(pythonPath), { recursive: true });
    fs.writeFileSync(pythonPath, python, "utf8");
    fs.chmodSync(pythonPath, 0o755);
    if (fs.existsSync(path.dirname(bundleManifestPath))) {
      fs.writeFileSync(bundleManifestPath, rendered, "utf8");
    }
    console.log("generate-extract-corpus-parity: wrote manifest, bundle copy, and scripts/extract_corpus.py");
    return;
  }

  const errors = [];
  if (!fs.existsSync(fixturePath)) {
    errors.push(`missing committed manifest at ${path.relative(repoRoot, fixturePath)}; run with --write`);
  } else {
    const committed = fs.readFileSync(fixturePath, "utf8");
    if (committed !== rendered) {
      errors.push(
        `extract-corpus parity manifest drift: ${path.relative(repoRoot, fixturePath)} is stale; ` +
          "run `node packages/cli/scripts/generate-extract-corpus-parity.mjs --write`",
      );
    }
  }

  if (!fs.existsSync(pythonPath)) {
    errors.push(`missing generated Python wrapper at ${path.relative(repoRoot, pythonPath)}; run with --write`);
  } else {
    const currentPy = fs.readFileSync(pythonPath, "utf8");
    if (currentPy !== python) {
      errors.push(
        `extract-corpus Python wrapper drift: ${path.relative(repoRoot, pythonPath)} is stale; ` +
          "run `node packages/cli/scripts/generate-extract-corpus-parity.mjs --write`",
      );
    }
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`generate-extract-corpus-parity: ${err}`);
    process.exit(1);
  }
  console.log("generate-extract-corpus-parity: manifest and Python wrapper are in sync with TypeScript");
}

main().catch((err) => {
  console.error(`generate-extract-corpus-parity: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
