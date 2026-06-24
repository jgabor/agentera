// Capability instruction barrel (D65).
// Re-exports each capability's prose constant as a named export plus a
// CAPABILITY_INSTRUCTIONS lookup keyed by capability name. The CLI loader
// imports this barrel from `../capabilities/index.js` so source-mode (vitest)
// and dist-mode (npm install) resolve the same path.
import { instructions as statusInstructions } from "./status/instructions.js";
import { instructions as visionInstructions } from "./vision/instructions.js";
import { instructions as discussInstructions } from "./discuss/instructions.js";
import { instructions as researchInstructions } from "./research/instructions.js";
import { instructions as planInstructions } from "./plan/instructions.js";
import { instructions as buildInstructions } from "./build/instructions.js";
import { instructions as optimizeInstructions } from "./optimize/instructions.js";
import { instructions as auditInstructions } from "./audit/instructions.js";
import { instructions as documentInstructions } from "./document/instructions.js";
import { instructions as profileInstructions } from "./profile/instructions.js";
import { instructions as designInstructions } from "./design/instructions.js";
import { instructions as orchestrateInstructions } from "./orchestrate/instructions.js";

export const CAPABILITY_INSTRUCTIONS: Record<string, string> = {
  status: statusInstructions,
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
  return `agentera prime --context ${capability} --format json`;
}
