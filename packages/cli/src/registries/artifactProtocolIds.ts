/**
 * Decision 58 artifact protocol names: one `artifact_id` per artifact in CLI,
 * hooks, validators, and JSON envelopes. Storage paths live here only.
 */

export const ARTIFACT_PROTOCOL_PATHS: Readonly<Record<string, string>> = {
  vision: ".agentera/vision.yaml",
  decisions: ".agentera/decisions.yaml",
  plan: ".agentera/plan.yaml",
  progress: ".agentera/progress.yaml",
  health: ".agentera/health.yaml",
  docs: ".agentera/docs.yaml",
  objective: ".agentera/objective.yaml",
  experiments: ".agentera/experiments.yaml",
  todo: "TODO.md",
  changelog: "CHANGELOG.md",
  design: "DESIGN.md",
};

export const HUMAN_FACING_ARTIFACT_IDS = new Set(["todo", "changelog", "design"]);

export const TRACKED_ARTIFACT_IDS: readonly string[] = [
  "progress",
  "decisions",
  "plan",
  "health",
  "design",
  "docs",
  "vision",
  "todo",
  "changelog",
];

export const VALIDATE_ARTIFACT_PROTOCOL_IDS: readonly string[] = [
  "changelog",
  "decisions",
  "design",
  "docs",
  "health",
  "plan",
  "progress",
  "todo",
  "vision",
];

function artifactProtocolStem(input: string): string {
  const lower = input.trim().toLowerCase();
  return lower.endsWith(".md") ? lower.slice(0, -3) : lower;
}

export function normalizeArtifactProtocolId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed in ARTIFACT_PROTOCOL_PATHS) {
    return trimmed;
  }
  const lower = trimmed.toLowerCase();
  if (lower in ARTIFACT_PROTOCOL_PATHS) {
    return lower;
  }
  const stem = artifactProtocolStem(trimmed);
  if (stem in ARTIFACT_PROTOCOL_PATHS) {
    return stem;
  }
  return null;
}

export function requireArtifactProtocolId(input: string, context: string): string {
  const id = normalizeArtifactProtocolId(input);
  if (id === null) {
    const valid = VALIDATE_ARTIFACT_PROTOCOL_IDS.join(", ");
    throw new Error(`unsupported artifact ${JSON.stringify(input)} in ${context}; valid artifact_id values: ${valid}`);
  }
  return id;
}

/** Normalize docs.yaml mapping keys to artifact_id. */
export function normalizeArtifactMappingKeys(mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(mapping)) {
    const id = normalizeArtifactProtocolId(key);
    out[id ?? key] = value;
  }
  return out;
}
