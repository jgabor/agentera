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

const profileRuntimeSourcePolicy = `#### Step 1: Coverage and extraction

Run the active-runtime Coverage Audit as the first user-visible output of every Full-mode run:

\`\`\`bash
agentera report refresh --consent local-history --coverage-audit-only
\`\`\`

The active runtime IDs are exactly \`opencode\`, \`codex\`, \`cursor\`, and \`copilot\`. Cursor Agent CLI storage is a Cursor source product, never a separate runtime identity. Apply \`--no-codex\`, \`--no-opencode\`, \`--no-copilot\`, or \`--no-cursor\` only when the user selects a partial active-runtime corpus; available skipped sources require \`--accept-coverage-gap\`.

Claude Code is not a supported runtime. Its transcript parser is available only as an explicit historical importer:

\`\`\`bash
agentera report refresh --consent local-history --import-source claude
\`\`\`

Before that opt-in, warn that transcripts can contain secrets, file contents, and command output. The import is local and read-only. Every imported record is labeled \`source_class=historical_import\`, \`source_product=claude-code\`, and \`active_runtime=false\`; default active analytics exclude it. Never describe imported records as Claude support, health, installation, or active-runtime coverage. Use \`agentera report --sources all\` only when the user explicitly asks for historical/all-source analysis, and keep provenance visible.

The extractor writes instruction documents, history prompts, conversation turns, tool calls, and project config signals. Read the corpus metadata to confirm bounded source-family counts without displaying transcript contents. If an active source fails, proceed with bounded degradation evidence; if historical import fails, report only the importer failure and do not turn it into runtime health.

`;

const servedProfileInstructions = profileInstructions.replace(
  /#### Step 1: Coverage and extraction[\s\S]*?(?=#### Step 2: Read corpus data)/,
  profileRuntimeSourcePolicy,
);

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
  profile: servedProfileInstructions,
  design: designInstructions,
  orchestrate: orchestrateInstructions,
};

export function capabilityInstructionModulePath(capability: string): string {
  return `packages/cli/src/capabilities/${capability}/instructions.ts`;
}

export function capabilityStartupCommand(capability: string): string {
  return `agentera prime --context ${capability} --format json`;
}
