import path from "node:path";
import { pathToFileURL } from "node:url";

import { inject } from "vitest";

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
