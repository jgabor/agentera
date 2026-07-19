import path from "node:path";

import { CAPABILITY_INSTRUCTIONS } from "../capabilities/index.js";
import { isFile } from "../core/paths.js";

const INSTRUCTION_MODULE_ROOT = path.join("packages", "cli", "src", "capabilities");

/**
 * v3 repo signal (D65): all twelve capability instruction modules live under
 * packages/cli/src/capabilities/<name>/instructions.ts. When present, in-tree
 * .cursor/agents/ uses prime --context and must not be overwritten from a v2
 * app-home bundle during runtime rewiring.
 */
export function projectUsesV3CapabilityInstructionModules(projectRoot: string): boolean {
  const root = path.resolve(projectRoot);
  return Object.keys(CAPABILITY_INSTRUCTIONS).every((name) =>
    isFile(path.join(root, INSTRUCTION_MODULE_ROOT, name, "instructions.ts")),
  );
}
