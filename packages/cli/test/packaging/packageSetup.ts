import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GlobalSetupContext } from "vitest/node";

export interface PackFile {
  path: string;
  size: number;
  mode: number;
}

export interface PackEntry {
  filename: string;
  files: PackFile[];
}

export interface PackageFixture {
  root: string;
  constructionRoot: string;
  packageRoot: string;
  manifest: PackEntry;
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("npm_config_")),
  );
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: scrubbedEnv() });
  if (result.status !== 0) {
    throw new Error(
      `package verification boundary failed during ${command} ${args.join(" ")}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function parseManifest(stdout: string): PackEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("package verification boundary failed: npm pack returned invalid JSON");
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? Object.values(parsed)
      : [];
  if (entries.length !== 1) {
    throw new Error(
      `package verification boundary failed: npm pack returned ${entries.length} entries; expected one`,
    );
  }
  const entry = entries[0] as Partial<PackEntry>;
  if (typeof entry.filename !== "string" || !Array.isArray(entry.files)) {
    throw new Error("package verification boundary failed: npm pack omitted its file manifest");
  }
  return entry as PackEntry;
}

export default function setup({ provide }: GlobalSetupContext): () => void {
  const packageRoot = path.resolve(import.meta.dirname, "../..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-package-verification-"));
  const constructionRoot = path.join(root, "construction");
  try {
    fs.mkdirSync(constructionRoot);
    for (const file of ["package.json", "README.md"]) {
      fs.copyFileSync(path.join(packageRoot, file), path.join(constructionRoot, file));
    }
    fs.copyFileSync(path.resolve(packageRoot, "../..", "LICENSE"), path.join(constructionRoot, "LICENSE"));
    run(
      process.execPath,
      ["scripts/build-package.mjs", "--output-root", constructionRoot],
      packageRoot,
    );
    const manifest = parseManifest(
      run(
        "npm",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", root],
        constructionRoot,
      ),
    );
    run("tar", ["-xzf", path.join(root, manifest.filename), "-C", root], root);
    const extractedPackage = path.join(root, "package");
    run(
      "npm",
      ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
      extractedPackage,
    );
    provide("packageFixture", { root, constructionRoot, packageRoot: extractedPackage, manifest });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return () => fs.rmSync(root, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    packageFixture: PackageFixture;
  }
}
