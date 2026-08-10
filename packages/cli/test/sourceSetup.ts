import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GlobalSetupContext } from "vitest/node";

import { waitForVerificationBarrier } from "../scripts/verification-barrier.mjs";

export default function setup({ provide }: GlobalSetupContext): () => void {
  waitForVerificationBarrier();
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-source-verification-"));
  const result = spawnSync(
    process.execPath,
    [path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", root, "--sourceMap", "false"],
    { cwd: packageRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(
      `source verification boundary failed during transient subprocess compilation:\n${result.stderr || result.stdout}`,
    );
  }
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  provide("sourceBuildRoot", root);
  return () => fs.rmSync(root, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    sourceBuildRoot: string;
  }
}
