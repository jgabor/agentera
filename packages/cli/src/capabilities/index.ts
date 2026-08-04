// Capability instruction barrel (D65).
// Re-exports each capability's prose constant as a named export plus a
// CAPABILITY_INSTRUCTIONS lookup keyed by capability name. The CLI loader
// imports this barrel from `../capabilities/index.js` so source-mode (vitest)
// and dist-mode (npm install) resolve the same path.
import statusInstructions from "./status/instructions.js";
import { statusStartupInstructions } from "./status/startupInstructions.js";
import visionInstructions from "./vision/instructions.js";
import discussInstructions from "./discuss/instructions.js";
import { instructions as researchInstructions } from "./research/instructions.js";
import planInstructions from "./plan/instructions.js";
import buildInstructions from "./build/instructions.js";
import optimizeInstructions from "./optimize/instructions.js";
import auditInstructions from "./audit/instructions.js";
import documentInstructions from "./document/instructions.js";
import profileInstructions from "./profile/instructions.js";
import { instructions as designInstructions } from "./design/instructions.js";
import orchestrateInstructions from "./orchestrate/instructions.js";
import { preCutoverCommand } from "../cli/preCutoverCommand.js";

export const CAPABILITY_INSTRUCTIONS: Record<string, string> = {
  status: statusStartupInstructions(statusInstructions),
  vision: visionInstructions,
  discuss: discussInstructions,
  research: researchInstructions,
  plan: planInstructions,
  build: buildInstructions,
  optimize: optimizeInstructions,
  audit: auditInstructions,
  document: documentInstructions,
  profile: profileInstructions,
  design: designInstructions,
  orchestrate: orchestrateInstructions,
};

export function capabilityInstructionModulePath(capability: string): string {
  return `packages/cli/src/capabilities/${capability}/instructions.ts`;
}

export function capabilityStartupCommand(capability: string): string {
  return preCutoverCommand(`prime --context ${capability} --format json`);
}
