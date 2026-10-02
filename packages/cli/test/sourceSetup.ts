import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GlobalSetupContext } from "vite-plus/test/node";

import { waitForVerificationBarrier } from "../scripts/verification-barrier.mjs";
import { writeSourceDiagnostic } from "../scripts/source-diagnostics.mjs";

export default function setup({ provide }: GlobalSetupContext): () => void {
  const started = performance.now();
  const emit = (phase: string, phaseStarted = started) =>
    writeSourceDiagnostic({
      file: "source-setup",
      phase,
      elapsedMs: performance.now() - started,
      durationMs: performance.now() - phaseStarted,
    });
  emit("barrier-start");
  waitForVerificationBarrier();
  emit("barrier-end");
  const packageRoot = path.resolve(import.meta.dirname, "..");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-source-verification-"));
  const compileStarted = performance.now();
  emit("compile-start", compileStarted);
  const result = spawnSync(process.execPath, [path.join(packageRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--outDir", root, "--sourceMap", "false"], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  emit("compile-end", compileStarted);
  if (result.status !== 0) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error(`source verification boundary failed during transient subprocess compilation:\n${result.stderr || result.stdout}`);
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
import "./gitSetup.ts";
