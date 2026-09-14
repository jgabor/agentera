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
import profileInstructions, { servedInstructions as servedProfileInstructions } from "./profile/instructions.js";
import { instructions as designInstructions } from "./design/instructions.js";
import orchestrateInstructions from "./orchestrate/instructions.js";
import { preCutoverCommand, preCutoverInstructionBody } from "../cli/preCutoverCommand.js";
import { withHumanReferences } from "./humanReferences.js";
import { withOperatingRules } from "./operatingRules.js";

const canonicalInstructions: Record<string, string> = {
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

export const servedInstructions = (body: string): string =>
  withOperatingRules(withHumanReferences(preCutoverInstructionBody(body))) +
  `

## Current contract access

Follow startup guidance_details or \`npx -y agentera@next prime --context <capability> --detail instructions\` and its related actions for complete artifacts, validation, exit, worker and protocol sections before reliance. Read applicable sections and every required next_command part; an index is not complete guidance. Schema paths are provenance only, not required file reads: use \`npx -y agentera@next schema\` and its exact detail actions. Typed entity readers/writers override historical aggregate-path write advice; use \`npx -y agentera@next state <artifact> explain\` and its verb/section actions before an authorized mutation. Static completeness grants no permission or state readiness. Worker detail serves the governing delegation and evaluator contracts; read all applicable parts before constructing a handoff. Missing, stale, unrelated or insufficient worker evidence never establishes PASS or authorizes downstream execution: preserve the gap, request corrected attributed evidence, and verify only uncovered or invalidated scope plus mandatory gates.

If the CLI or required guidance is missing, malformed or incompatible, stop the affected workflow. For invalid selectors or stale cursors, follow the structured error's exact recovery/restart command, not guessed flags or a different capability. For runtime authority failures, use \`npx -y agentera@next doctor --explain\`, \`npx -y agentera@next app-home --explain\` and \`npx -y agentera@next upgrade --explain\`. If unavailable, report the bounded non-secret failure and ask the user to restore a compatible supported CLI, then retry discovery. Never fall back to checkout or installed companion reads, silently use older guidance, change installation or acquire history without explicit approval.
`;

export const CAPABILITY_INSTRUCTIONS: Record<string, string> = Object.fromEntries(Object.entries(canonicalInstructions).map(([capability, body]) => [capability, servedInstructions(body)]));

Object.defineProperty(CAPABILITY_INSTRUCTIONS, "profile", {
  enumerable: true,
  get: () => servedInstructions(servedProfileInstructions()),
});

export function capabilityInstructionModulePath(capability: string): string {
  return `packages/cli/src/capabilities/${capability}/instructions.ts`;
}

export function capabilityStartupCommand(capability: string): string {
  return preCutoverCommand(`prime --context ${capability}`);
}
