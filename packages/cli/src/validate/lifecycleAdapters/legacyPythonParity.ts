import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { isDir, isFile } from "./shared.js";

/** Maintainer-only seam: opt in via CLI flag or env for Python oracle parity. */
export const LEGACY_PYTHON_PARITY_ENV = "AGENTERA_LEGACY_PYTHON_PARITY";

export const LEGACY_PYTHON_PARITY_FLAG = "--legacy-python-parity";

const UV_SCRIPT_SHEBANG = "#!/usr/bin/env -S uv run --script";

const UV_INSTALL_GUIDANCE =
  "uv is required to run packaged Agentera Python scripts; install it from " +
  "https://docs.astral.sh/uv/getting-started/installation/ and then rerun the check";

export interface LegacyPythonParityOptions {
  legacyPythonParity?: boolean;
  /** @deprecated Use legacyPythonParity — retained for direct lifecycleMain callers. */
  checkUvRuntime?: boolean;
}

export function legacyPythonParityEnabled(opts: LegacyPythonParityOptions = {}): boolean {
  if (opts.legacyPythonParity || opts.checkUvRuntime) return true;
  const env = process.env[LEGACY_PYTHON_PARITY_ENV];
  return env === "1" || env === "true";
}

function isPackagedPythonScript(p: string): boolean {
  if (!isFile(p)) return false;
  const suffix = path.extname(p);
  if (suffix === ".py") return true;
  if (suffix) return false;
  const firstLine = fs.readFileSync(p, "utf8").split(/\r\n|\r|\n/)[0] ?? "";
  return Boolean(firstLine) && (firstLine.includes("python") || firstLine.includes("uv run --script"));
}

function packagedPythonScripts(root: string): string[] {
  const paths: string[] = [];
  for (const directory of ["scripts", "hooks"]) {
    const scriptRoot = path.join(root, directory);
    if (!isDir(scriptRoot)) continue;
    for (const name of fs.readdirSync(scriptRoot)) {
      const p = path.join(scriptRoot, name);
      if (isPackagedPythonScript(p)) paths.push(p);
    }
  }
  return paths.sort();
}

function extractInlineScriptMetadata(text: string): string[] | null {
  const lines = text.split(/\r\n|\r|\n/);
  const start = lines.indexOf("# /// script");
  if (start === -1) return null;
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index] === "# ///") {
      return lines.slice(start + 1, index);
    }
  }
  return null;
}

function metadataDeclaresRequiresPython(metadata: string[]): boolean {
  return metadata.some((line) => line.trim().startsWith("# requires-python = "));
}

function metadataDeclaresDependencies(metadata: string[]): boolean {
  return metadata.some((line) => line.trim().startsWith("# dependencies = ["));
}

export function validatePackagedPythonScripts(root: string): string[] {
  const errors: string[] = [];
  for (const p of packagedPythonScripts(root)) {
    const relative = path.relative(root, p);
    const text = fs.readFileSync(p, "utf8");
    const lines = text.split(/\r\n|\r|\n/);
    const firstLine = lines.length > 0 ? lines[0] : "";
    if (firstLine !== UV_SCRIPT_SHEBANG) {
      errors.push(`${relative}: packaged Python script must use uv script shebang`);
    }
    const metadata = extractInlineScriptMetadata(text);
    if (metadata === null) {
      errors.push(`${relative}: packaged Python script must declare inline script metadata`);
      continue;
    }
    if (!metadataDeclaresRequiresPython(metadata)) {
      errors.push(`${relative}: packaged Python script must declare requires-python`);
    }
    if (!metadataDeclaresDependencies(metadata)) {
      errors.push(`${relative}: packaged Python script must declare dependencies`);
    }
  }
  return errors;
}

export function validateUvRuntime(): string[] {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", ["uv"], { encoding: "utf8" });
  if (result.status !== 0) return [UV_INSTALL_GUIDANCE];
  return [];
}

export function runLegacyPythonParityChecks(root: string): string[] {
  return [...validatePackagedPythonScripts(root), ...validateUvRuntime()];
}
