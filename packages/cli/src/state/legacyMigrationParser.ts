import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { parseYaml } from "../core/yaml.js";
import {
  canonicalRecordJson,
  stateCurrentProjectionPath,
  validateStateRecord,
} from "./archiveDiscovery.js";
import { legacyIdentity } from "./legacyIdentity.js";
import type { StateMigrationContract } from "./migrationAuthority.js";

export type ArtifactId = "progress" | "decisions" | "health";
export type DetailAvailability = "full" | "summary" | "unavailable";
export type CandidateSource =
  | "legacy_full"
  | "legacy_summary"
  | "current_projection"
  | "unavailable";

export interface ParsedLegacyRecord {
  artifactId: ArtifactId;
  number: number | null;
  detail: DetailAvailability;
  source: CandidateSource;
  record?: JsonObject;
  summary?: string;
  hash?: string;
}

export interface ParsedCandidate {
  path: string;
  absolutePath: string;
  sourceBytes: Buffer;
  sourceHash: string;
  source: CandidateSource;
  requiresPin: boolean;
  records: ParsedLegacyRecord[];
  rejection?: { classification: string; reason: string; message: string };
  duplicateKeys: Set<string>;
}

const ARTIFACTS: ArtifactId[] = ["progress", "decisions", "health"];
const COLLECTIONS: Record<ArtifactId, string> = {
  progress: "cycles",
  decisions: "decisions",
  health: "audits",
};
const NUMBER_FIELDS: Record<ArtifactId, string> = {
  progress: "number",
  decisions: "number",
  health: "number",
};
const TYPES = new Set(["feat", "fix", "docs", "refactor", "chore", "test"]);
const CONFIDENCE = new Set(["firm", "provisional", "exploratory"]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): JsonObject | null {
  return object(value) ? (value as JsonObject) : null;
}

function positive(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function recordHash(value: JsonObject): string {
  return hash(canonicalRecordJson(value));
}

function field(section: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    new RegExp(`\\*\\*${escaped}\\*\\*\\s*:\\s*(.+?)(?=\\n\\*\\*|\\n##|$)`, "s")
      .exec(section)?.[1]
      ?.trim() || undefined
  );
}

function contextField(context: string, key: string): string | undefined {
  return new RegExp(`${key}\\s*(?:\\([^)]*\\))?\\s*(?::|·)\\s*([^·]+?)(?:\\s*·|$)`, "i")
    .exec(context)?.[1]
    ?.trim();
}

function parseMarkdownRecord(
  section: string,
  kind: string,
  entryNumber: number,
  date: string,
  title: string,
): JsonObject | null {
  if (kind === "Cycle") {
    const type = title.split(/[:\s]/, 1)[0];
    const phase = field(section, "Phase");
    const what = field(section, "What");
    const rawContext = field(section, "Context");
    const intent = rawContext ? contextField(rawContext, "intent") : undefined;
    if (!TYPES.has(type) || !phase || !what || !intent) return null;
    const context: JsonObject = { intent };
    for (const key of ["constraints", "unknowns", "scope"]) {
      const value = rawContext ? contextField(rawContext, key) : undefined;
      if (value) context[key] = value;
    }
    const result: JsonObject = {
      number: entryNumber,
      timestamp: date,
      type,
      phase: phase.toLowerCase(),
      what,
      context,
    };
    for (const [key, label] of [
      ["inspiration", "Inspiration"],
      ["discovered", "Discovered"],
      ["verified", "Verified"],
      ["next", "Next"],
    ] as const) {
      const value = field(section, label);
      if (value) result[key] = value;
    }
    return result;
  }
  if (kind === "Decision") {
    const block =
      /\*\*Alternatives\*\*\s*:\s*\n([\s\S]*?)(?=\n\*\*Choice\*\*|\n\*\*Reasoning\*\*|$)/.exec(
        section,
      )?.[1];
    if (!block) return null;
    const alternatives: JsonObject[] = [];
    for (const raw of block.split(/\r?\n/)) {
      const match = /^\s*-?\s*\[([^\]]+)\]\s*,?\s*(chosen|rejected)\s*:?(?:\s*(.*))?$/i.exec(raw);
      if (!match) {
        if (raw.trim()) return null;
        continue;
      }
      const alternative: JsonObject = { name: match[1].trim(), status: match[2].toLowerCase() };
      if (match[3]?.trim()) alternative.description = match[3].trim();
      alternatives.push(alternative);
    }
    const question = field(section, "Question");
    const context = field(section, "Context");
    const choice = field(section, "Choice");
    const reasoning = field(section, "Reasoning");
    const confidence = field(section, "Confidence");
    if (
      !question ||
      !context ||
      !choice ||
      !reasoning ||
      !confidence ||
      !CONFIDENCE.has(confidence) ||
      alternatives.length === 0 ||
      alternatives.filter((item) => item.status === "chosen").length !== 1
    )
      return null;
    const result: JsonObject = {
      number: entryNumber,
      date,
      question,
      context,
      alternatives,
      choice,
      reasoning,
      confidence,
    };
    const feedsInto = field(section, "Feeds into");
    if (feedsInto) result.feeds_into = feedsInto;
    return result;
  }
  const dimensions = field(section, "Dimensions assessed");
  const findings = field(section, "Findings");
  const trajectory = field(section, "Overall trajectory");
  const gradesText = field(section, "Grades");
  if (!dimensions || !findings || !trajectory || !gradesText) return null;
  const findingsSummary: JsonObject = {};
  for (const key of ["critical", "warning", "info"] as const) {
    const match = new RegExp(`([0-9]+)\\s+${key}`, "i").exec(findings);
    if (!match) return null;
    findingsSummary[key] = Number(match[1]);
  }
  findingsSummary.filtered_by_confidence = Number(/([0-9]+)\s+filtered/i.exec(findings)?.[1] ?? 0);
  const grades: JsonObject = {};
  for (const match of gradesText.matchAll(/([\w\s]+?)\s*\[([A-F])\]/g))
    grades[match[1].trim()] = match[2];
  if (Object.keys(grades).length === 0) return null;
  return {
    number: entryNumber,
    date,
    dimensions: dimensions
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    findings_summary: findingsSummary,
    trajectory,
    grades,
  };
}

function markdownRecords(text: string, forcedArtifact?: ArtifactId): ParsedLegacyRecord[] {
  const records: ParsedLegacyRecord[] = [];
  for (const section of text.split(/(?=^##\s+)/m)) {
    const heading =
      /^##\s+(?:[■□]\s*)?(Cycle|Decision|Audit)\s+([1-9][0-9]*)\s*·\s*([^·\n]+?)(?:\s*·\s*(.*))?$/m.exec(
        section.trim(),
      );
    if (!heading) continue;
    const artifactId: ArtifactId =
      heading[1] === "Cycle" ? "progress" : heading[1] === "Decision" ? "decisions" : "health";
    const entryNumber = Number(heading[2]);
    if (forcedArtifact && forcedArtifact !== artifactId) {
      records.push({
        artifactId,
        number: entryNumber,
        detail: "unavailable",
        source: "unavailable",
      });
      continue;
    }
    const parsed = parseMarkdownRecord(
      section,
      heading[1],
      entryNumber,
      heading[3].trim(),
      heading[4]?.trim() ?? "",
    );
    records.push(
      parsed
        ? {
            artifactId,
            number: entryNumber,
            detail: "full",
            source: "legacy_full",
            record: parsed,
            hash: recordHash(parsed),
          }
        : { artifactId, number: entryNumber, detail: "unavailable", source: "unavailable" },
    );
  }
  const archiveName =
    forcedArtifact === "progress"
      ? "Cycles"
      : forcedArtifact === "decisions"
        ? "Decisions"
        : forcedArtifact === "health"
          ? "Audits"
          : "(?:Cycles|Decisions|Audits)";
  const header = new RegExp(`^##\\s+Archived\\s+${archiveName}\\s*$`, "m").exec(text);
  if (!header) return records;
  const start = header.index + header[0].length;
  const nextHeading = /^##\s+/gm;
  nextHeading.lastIndex = start;
  const end = nextHeading.exec(text)?.index ?? text.length;
  for (const line of text.slice(start, end).split(/\r?\n/)) {
    const match =
      /\b(Cycle|Decision|Audit)\s+([1-9][0-9]*)\b/i.exec(line) ??
      /^\s*-\s*D([1-9][0-9]*)\b/i.exec(line);
    if (!match) continue;
    const artifactId: ArtifactId =
      match[1]?.toLowerCase() === "cycle"
        ? "progress"
        : match[1]?.toLowerCase() === "audit"
          ? "health"
          : "decisions";
    const identity = legacyIdentity(line.replace(/^\s*-\s*/, ""), artifactId, "number");
    const shorthand = /^\s*-\s*D[1-9]/i.test(line);
    records.push({
      artifactId,
      number: shorthand && identity.kind !== "ambiguous" ? Number(match[1]) : identity.number,
      detail: identity.kind === "ambiguous" ? "unavailable" : "summary",
      source: "legacy_summary",
      summary: line.trim(),
    });
  }
  return records;
}

function collectionArtifact(key: string): ArtifactId | null {
  return ARTIFACTS.find((artifact) => COLLECTIONS[artifact] === key) ?? null;
}

function yamlRecords(
  text: string,
  source: CandidateSource,
  sourceRoot: string,
  forcedArtifact?: ArtifactId,
): { records: ParsedLegacyRecord[]; rejection?: ParsedCandidate["rejection"] } {
  let root: Record<string, unknown>;
  try {
    const parsed = parseYaml(text);
    if (!object(parsed)) throw new Error("YAML root must be a mapping");
    root = parsed;
  } catch (error) {
    return {
      records: [],
      rejection: {
        classification: "corrupt",
        reason: "invalid_yaml",
        message: `candidate YAML cannot be parsed: ${(error as Error).message}`,
      },
    };
  }
  const artifacts = [
    ...new Set(
      Object.keys(root)
        .map(collectionArtifact)
        .filter((value): value is ArtifactId => value !== null),
    ),
  ];
  if (artifacts.length > 1)
    return {
      records: [],
      rejection: {
        classification: "ambiguous",
        reason: "multiple_artifact_identities",
        message: "candidate contains multiple supported artifact collections",
      },
    };
  if (forcedArtifact && artifacts.length > 0 && artifacts[0] !== forcedArtifact)
    return {
      records: [],
      rejection: {
        classification: "ambiguous",
        reason: "artifact_shape_conflict",
        message: `candidate does not contain the requested ${forcedArtifact} collection`,
      },
    };
  const artifact = forcedArtifact ?? artifacts[0];
  if (!artifact) {
    if (forcedArtifact) {
      const candidate = root as JsonObject;
      const entryNumber = positive(candidate[NUMBER_FIELDS[forcedArtifact]]);
      if (entryNumber !== null) {
        const violations = validateStateRecord(sourceRoot, forcedArtifact, candidate);
        if (violations.length === 0)
          return {
            records: [
              {
                artifactId: forcedArtifact,
                number: entryNumber,
                detail: "full",
                source,
                record: candidate,
                hash: recordHash(candidate),
              },
            ],
          };
        return {
          records: [],
          rejection: {
            classification: "corrupt",
            reason: "record_schema",
            message: violations.join("; "),
          },
        };
      }
    }
    return {
      records: [],
      rejection: {
        classification: "unsupported",
        reason: "unsupported_artifact_shape",
        message: "candidate does not contain one supported numbered artifact collection",
      },
    };
  }
  const values = root[COLLECTIONS[artifact]];
  if (!Array.isArray(values))
    return {
      records: [],
      rejection: {
        classification: "corrupt",
        reason: "collection_not_array",
        message: `candidate collection '${COLLECTIONS[artifact]}' must be an array`,
      },
    };
  const records: ParsedLegacyRecord[] = [];
  for (const value of values) {
    const item = record(value);
    if (!item) {
      const identity = legacyIdentity(value, artifact, NUMBER_FIELDS[artifact]);
      records.push({
        artifactId: artifact,
        number: identity.kind === "ambiguous" ? null : identity.number,
        detail: identity.kind === "ambiguous" ? "unavailable" : "summary",
        source: "legacy_summary",
        summary: typeof value === "string" ? value : undefined,
      });
      continue;
    }
    const entryNumber = positive(item[NUMBER_FIELDS[artifact]]);
    if (entryNumber === null) {
      const identity = legacyIdentity(item, artifact, NUMBER_FIELDS[artifact]);
      const summary = typeof item.summary === "string" ? item.summary : undefined;
      records.push({
        artifactId: artifact,
        number: identity.number,
        detail: summary ? "summary" : "unavailable",
        source: summary ? "legacy_summary" : "unavailable",
        summary,
      });
      continue;
    }
    const violations = validateStateRecord(sourceRoot, artifact, item);
    records.push(
      violations.length === 0
        ? {
            artifactId: artifact,
            number: entryNumber,
            detail: "full",
            source,
            record: item,
            hash: recordHash(item),
          }
        : {
            artifactId: artifact,
            number: entryNumber,
            detail: "unavailable",
            source: "unavailable",
          },
    );
  }
  if (Array.isArray(root.archive))
    for (const value of root.archive) {
      const identity = legacyIdentity(value, artifact, NUMBER_FIELDS[artifact]);
      const summary =
        typeof value === "string" ? value : (record(value)?.summary as string | undefined);
      records.push({
        artifactId: artifact,
        number: identity.kind === "ambiguous" ? null : identity.number,
        detail:
          identity.kind === "ambiguous" || identity.number === null ? "unavailable" : "summary",
        source: "legacy_summary",
        summary,
      });
    }
  return { records };
}

function sourceKind(
  relativePath: string,
  project: string,
  sourceRoot: string,
  contract: StateMigrationContract,
): CandidateSource {
  if (
    ARTIFACTS.some(
      (artifact) =>
        path
          .relative(project, stateCurrentProjectionPath(project, artifact, sourceRoot))
          .replaceAll(path.sep, "/") === relativePath,
    )
  )
    return "current_projection";
  return contract.fixedNames[relativePath] ? "legacy_full" : "legacy_full";
}

export function parseCandidate(
  project: string,
  relativePath: string,
  contract: StateMigrationContract,
  sourceRoot: string,
  forcedArtifact?: ArtifactId,
): ParsedCandidate {
  const absolutePath = path.join(project, relativePath);
  const source = sourceKind(relativePath, project, sourceRoot, contract);
  const requiresPin =
    source !== "current_projection" && !Boolean(contract.fixedNames[relativePath]);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absolutePath);
  } catch (error) {
    return {
      path: relativePath,
      absolutePath,
      sourceBytes: Buffer.alloc(0),
      sourceHash: "",
      source: "unavailable",
      requiresPin,
      records: [],
      duplicateKeys: new Set(),
      rejection: {
        classification: "corrupt",
        reason: "read_failure",
        message: `candidate cannot be read: ${(error as Error).message}`,
      },
    };
  }
  if (!Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes))
    return {
      path: relativePath,
      absolutePath,
      sourceBytes: bytes,
      sourceHash: hash(bytes),
      source: "unavailable",
      requiresPin,
      records: [],
      duplicateKeys: new Set(),
      rejection: {
        classification: "unsupported",
        reason: "invalid_encoding",
        message: "candidate is not valid UTF-8",
      },
    };
  const text = bytes.toString("utf8");
  const parsed =
    path.extname(relativePath).toLowerCase() === ".md"
      ? { records: markdownRecords(text, forcedArtifact) }
      : yamlRecords(text, source, sourceRoot, forcedArtifact);
  const duplicateKeys = new Set<string>();
  const seen = new Set<string>();
  for (const item of parsed.records)
    if (item.number !== null) {
      const key = `${item.artifactId}:${item.number}`;
      if (seen.has(key)) duplicateKeys.add(key);
      seen.add(key);
    }
  return {
    path: relativePath,
    absolutePath,
    sourceBytes: bytes,
    sourceHash: hash(bytes),
    source,
    requiresPin,
    records: parsed.records,
    duplicateKeys,
    ...(parsed.rejection ? { rejection: parsed.rejection } : {}),
  };
}

export function metadataRejectedCandidate(
  project: string,
  entry: Record<string, unknown>,
): ParsedCandidate {
  const relativePath = String(entry.path);
  const rejection = String(entry.rejection ?? "unsupported_candidate");
  const classification =
    rejection === "symlink_escape" || rejection === "outside_project" ? "blocked" : "unsupported";
  return {
    path: relativePath,
    absolutePath: path.join(project, relativePath),
    sourceBytes: Buffer.alloc(0),
    sourceHash: "",
    source: "unavailable",
    requiresPin: true,
    records: [],
    duplicateKeys: new Set(),
    rejection: {
      classification,
      reason: rejection,
      message: `candidate '${relativePath}' is rejected by the bounded inventory policy: ${rejection}`,
    },
  };
}
