import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { resolveSourceRoot } from "../core/sourceRoot.js";

export interface GlossaryEvaluationProcessResult {
  returncode: number;
  stdout: string;
  stderr: string;
}

let testRunnerPath: string | null = null;

/** Source tests supply their transient compiled runner without changing CLI input. */
export function setGlossaryEvaluationRunnerForTest(path: string | null): () => void {
  const previous = testRunnerPath;
  testRunnerPath = path;
  return () => {
    testRunnerPath = previous;
  };
}

function runnerPath(): string {
  if (testRunnerPath !== null) return testRunnerPath;
  return fileURLToPath(new URL("./glossaryEvaluationRunner.js", import.meta.url));
}

/** Run the heavyweight frozen evaluator only for a request that needs its gate. */
export function runGlossaryEvaluationProcess(sourceRoot: string = resolveSourceRoot()): GlossaryEvaluationProcessResult {
  const result = spawnSync(process.execPath, [runnerPath(), sourceRoot], {
    encoding: "utf8",
    maxBuffer: 1_048_576,
  });
  return {
    returncode: result.status ?? 1,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? result.error?.message ?? ""),
  };
}
