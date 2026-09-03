import crypto from "node:crypto";

import type { JsonObject } from "../../core/jsonValue.js";

export const TRANSCRIPT_KEYS = new Set(["content", "text", "prompt", "message", "preceding_context", "input_text", "output_text", "transcript"]);
export const SESSION_KEYS = new Set(["session_id", "sessionID", "sessionId", "conversation_id"]);
export const PATH_KEYS = new Set(["path", "project_path", "store_path", "file_path", "cwd", "report_path"]);

const DEFAULT_CONTRACT: JsonObject = {
  version: "startup-state-analysis-v1",
  boundary: {
    source: "git tag evidence",
    commit: "b18e3dc7d768d4ad2726880916e7cfe6bd8617d3",
    committed_at: "2026-05-12T17:50:13+02:00",
  },
  degradation_reasons: ["pre_boundary_record", "missing_timestamp", "malformed_record", "missing_conversation_key", "no_agentera_state_sequence", "privacy_redaction_required"],
  privacy_boundary: {
    canonical_artifact_labels: {
      ".agentera/plan.yaml": "plan",
      ".agentera/progress.yaml": "progress",
      ".agentera/docs.yaml": "docs",
      ".agentera/decisions.yaml": "decisions",
      ".agentera/health.yaml": "health",
      ".agentera/vision.yaml": "vision",
      ".agentera/objective.yaml": "objective",
      ".agentera/experiments.yaml": "experiments",
      plan: "plan",
      progress: "progress",
      docs: "docs",
      decisions: "decisions",
      health: "health",
      vision: "vision",
      objective: "objective",
      experiments: "experiments",
      "AGENTS.md": "AGENTS.md",
      "SKILL.md": "SKILL.md",
    },
  },
};

/** Legacy diagnostic label; startup analysis no longer loads a reference file. */
export function contractPath(): string {
  return "built-in:startup-state-analysis-v1";
}

/** Startup analysis is source-only compatibility code with fixed redaction defaults. */
export function loadContract(): JsonObject {
  return DEFAULT_CONTRACT;
}

export function hashLabel(kind: string, value: unknown, salt: string): string {
  if (!salt) {
    throw new Error("salt is required for private labels");
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${salt}\0${pyStr(value)}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${kind}:${digest}`;
}

/** Approximate Python str() for the scalar/id values hashLabel receives. */
function pyStr(value: unknown): string {
  if (value === null) return "None";
  if (value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

const FALLBACK_ARTIFACT_LABELS: Array<[string, string]> = [
  [".agentera/plan.yaml", "plan"],
  [".agentera/progress.yaml", "progress"],
  [".agentera/docs.yaml", "docs"],
  [".agentera/decisions.yaml", "decisions"],
  [".agentera/health.yaml", "health"],
  [".agentera/vision.yaml", "vision"],
  [".agentera/objective.yaml", "objective"],
  [".agentera/experiments.yaml", "experiments"],
];

export function canonicalArtifactLabel(value: unknown, contract: JsonObject | null = null): string | null {
  const text = String(value).replace(/\\/g, "/");
  const loaded = contract ?? loadContract();
  const privacyBoundary = loaded.privacy_boundary && typeof loaded.privacy_boundary === "object" && !Array.isArray(loaded.privacy_boundary) ? loaded.privacy_boundary : {};
  const labels = privacyBoundary.canonical_artifact_labels;
  if (labels && typeof labels === "object" && !Array.isArray(labels)) {
    for (const [suffix, label] of Object.entries(labels)) {
      const normalized = String(suffix).replace(/\\/g, "/");
      if (text === normalized || text.endsWith("/" + normalized) || text.includes(normalized)) {
        return String(label);
      }
    }
  }
  for (const [suffix, label] of FALLBACK_ARTIFACT_LABELS) {
    if (text === suffix || text.endsWith("/" + suffix) || text.includes(suffix)) {
      return label;
    }
  }
  if (text.includes(".agentera/")) {
    return "AGENTERA_ARTIFACTS";
  }
  return null;
}

export function redactForStartupOutput(value: any, salt: string, contract: JsonObject | null = null): any {
  const loaded = contract ?? loadContract();
  if (Array.isArray(value)) {
    return value.map((item) => redactForStartupOutput(item, salt, loaded));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const redacted: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const keyText = String(key);
    if (TRANSCRIPT_KEYS.has(keyText)) {
      redacted[keyText] = "<redacted:transcript_text>";
    } else if (SESSION_KEYS.has(keyText)) {
      redacted[keyText] = hashLabel("session", item, salt);
    } else if (PATH_KEYS.has(keyText)) {
      const label = canonicalArtifactLabel(item, loaded);
      redacted[keyText] = label || hashLabel("path", item, salt);
    } else {
      redacted[keyText] = redactForStartupOutput(item, salt, loaded);
    }
  }
  return redacted;
}

// --- Timestamp helpers -----------------------------------------------------

export function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const text = value.replace("Z", "+00:00");
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function formatTimestamp(value: Date | null): string | null {
  if (value === null) {
    return null;
  }
  // ISO 8601 UTC, seconds precision (mirrors Python isoformat(timespec="seconds")).
  return value.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}
