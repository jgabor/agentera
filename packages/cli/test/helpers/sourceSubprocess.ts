import path from "node:path";
import { pathToFileURL } from "node:url";

import { inject } from "vitest";

import { setGlossaryEvaluationRunnerForTest } from "../../src/eval/glossaryEvaluationProcess.js";

const sourceBuildRoot = inject("sourceBuildRoot");

export function sourceBuildOutputRoot(): string {
  return sourceBuildRoot;
}

export function sourceSubprocessEnv(env = process.env): NodeJS.ProcessEnv {
  return { ...env, AGENTERA_SOURCE_TEST_BUILD: sourceBuildRoot };
}

export function sourceModuleUrl(relativePath: string): string {
  return pathToFileURL(path.join(sourceBuildRoot, relativePath)).href;
}

export function sourceGlossaryEvaluationRunnerPath(): string {
  return path.join(sourceBuildRoot, "eval", "glossaryEvaluationRunner.js");
}

/** Use the transient source build for one test's subprocess-backed glossary gate. */
export function installSourceGlossaryEvaluationRunner(): () => void {
  return setGlossaryEvaluationRunnerForTest(sourceGlossaryEvaluationRunnerPath());
}
