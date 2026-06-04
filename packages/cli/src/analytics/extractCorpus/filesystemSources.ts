import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "../../core/paths.js";
import {
  type Dict,
  isPlainObject,
  isoFromMtime,
  record,
  splitLines,
} from "./core.js";

export function extractInstructionDocuments(projectRoots: string[], errors: string[]): Dict[] {
  const records: Dict[] = [];
  const docNames: Array<[string, string]> = [
    ["AGENTS.md", "agents_md"],
    ["CLAUDE.md", "claude_md"],
  ];
  for (const root of projectRoots) {
    for (const [filename, docType] of docNames) {
      const p = path.join(root, filename);
      if (!fs.existsSync(p)) continue;
      let content: string;
      try {
        content = fs.readFileSync(p, "utf-8");
      } catch (exc) {
        errors.push(`${p}: cannot read instruction document: ${(exc as Error).message}`);
        continue;
      }
      records.push(
        record({
          sourceKind: "instruction_document",
          timestamp: isoFromMtime(p),
          projectPath: root,
          runtime: "filesystem",
          sourceParts: [resolvePath(p)],
          data: { doc_type: docType, name: filename, content, scope: "project" },
        }),
      );
    }
  }
  return records;
}

function packageJsonSignals(p: string): string[] {
  const data = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (!isPlainObject(data)) return [];
  const signals: string[] = [];
  const name = data.name;
  if (typeof name === "string" && name) signals.push(`name=${name}`);
  for (const section of ["scripts", "dependencies", "devDependencies"]) {
    const sectionData = data[section];
    if (!isPlainObject(sectionData)) continue;
    for (const key of Object.keys(sectionData).sort().slice(0, 30)) {
      signals.push(`${section}:${key}`);
    }
  }
  return signals;
}

function textConfigSignals(p: string, configType: string): string[] {
  let lines: string[];
  try {
    lines = splitLines(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
  const signals: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    if (configType === "gomod" && (line.startsWith("module ") || line.startsWith("go ") || line.startsWith("require "))) {
      signals.push(line);
    } else if (
      configType === "pyproject" &&
      (line.startsWith("[") || line.startsWith("requires-python") || line.startsWith("dependencies") || line.startsWith("name"))
    ) {
      signals.push(line);
    } else if (configType === "cargo_toml" && (line.startsWith("[") || line.startsWith("name") || line.startsWith("edition"))) {
      signals.push(line);
    } else if (configType === "lefthook" && line.includes(":")) {
      signals.push(line);
    }
    if (signals.length >= 40) break;
  }
  return signals;
}

export function extractProjectConfigSignals(projectRoots: string[], errors: string[]): Dict[] {
  const records: Dict[] = [];
  const configFiles: Array<[string, string, (p: string) => string[]]> = [
    ["package.json", "package_json", packageJsonSignals],
    ["pyproject.toml", "pyproject", (p) => textConfigSignals(p, "pyproject")],
    ["go.mod", "gomod", (p) => textConfigSignals(p, "gomod")],
    ["Cargo.toml", "cargo_toml", (p) => textConfigSignals(p, "cargo_toml")],
    [".lefthook.yml", "lefthook", (p) => textConfigSignals(p, "lefthook")],
    ["lefthook.yml", "lefthook", (p) => textConfigSignals(p, "lefthook")],
  ];
  for (const root of projectRoots) {
    for (const [filename, configType, extractor] of configFiles) {
      const p = path.join(root, filename);
      if (!fs.existsSync(p)) continue;
      let signals: string[];
      try {
        signals = extractor(p);
      } catch (exc) {
        errors.push(`${p}: cannot extract config signals: ${(exc as Error).message}`);
        continue;
      }
      if (signals.length === 0) continue;
      records.push(
        record({
          sourceKind: "project_config_signal",
          timestamp: isoFromMtime(p),
          projectPath: root,
          runtime: "filesystem",
          sourceParts: [resolvePath(p), configType],
          data: { config_type: configType, file_path: path.relative(root, p), signals },
        }),
      );
    }
  }
  return records;
}
