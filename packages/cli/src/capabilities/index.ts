// Capability instruction barrel (D65).
// Re-exports each capability's prose constant as a named export plus a
// CAPABILITY_INSTRUCTIONS lookup keyed by capability name. The CLI loader
// imports this barrel from `../capabilities/index.js` so source-mode (vitest)
// and dist-mode (npm install) resolve the same path.
import { instructions as hejInstructions } from "./hej/instructions.js";
import { instructions as visioneraInstructions } from "./visionera/instructions.js";
import { instructions as resoneraInstructions } from "./resonera/instructions.js";
import { instructions as inspireraInstructions } from "./inspirera/instructions.js";
import { instructions as planeraInstructions } from "./planera/instructions.js";
import { instructions as realiseraInstructions } from "./realisera/instructions.js";
import { instructions as optimeraInstructions } from "./optimera/instructions.js";
import { instructions as inspekteraInstructions } from "./inspektera/instructions.js";
import { instructions as dokumenteraInstructions } from "./dokumentera/instructions.js";
import { instructions as profileraInstructions } from "./profilera/instructions.js";
import { instructions as visualiseraInstructions } from "./visualisera/instructions.js";
import { instructions as orkestreraInstructions } from "./orkestrera/instructions.js";

export const CAPABILITY_INSTRUCTIONS: Record<string, string> = {
  hej: hejInstructions,
  visionera: visioneraInstructions,
  resonera: resoneraInstructions,
  inspirera: inspireraInstructions,
  planera: planeraInstructions,
  realisera: realiseraInstructions,
  optimera: optimeraInstructions,
  inspektera: inspekteraInstructions,
  dokumentera: dokumenteraInstructions,
  profilera: profileraInstructions,
  visualisera: visualiseraInstructions,
  orkestrera: orkestreraInstructions,
};

export function capabilityInstructionModulePath(capability: string): string {
  return `packages/cli/src/capabilities/${capability}/instructions.ts`;
}

export function capabilityStartupCommand(capability: string): string {
  return `agentera prime --context ${capability} --format json`;
}
