import fs from "node:fs";
import path from "node:path";

import { assessTerminologyConcept, type AssessedTerminologyConcept, type FindingSeverity } from "../../audit/terminologyDrift.js";
import { loadYamlMapping } from "../../core/yaml.js";
import { validateRealProjectRoot } from "../../state/projectRoot.js";
import type { Io } from "../dispatch/shared.js";
import { emitInvalidInput, type InvalidInputErrorBody } from "../errors.js";
import { emitStructured } from "../structured.js";

type Mapping = Record<string, unknown>;

const REQUEST_FIELDS = ["schema_version", "concept", "confidence", "severity", "terms", "personal_term"] as const;
export const TERMINOLOGY_DRIFT_STRUCTURED_INPUT_OPTIONS = ["--input"] as const;
const SEVERITIES: readonly FindingSeverity[] = ["critical", "warning", "info"];

export const TERMINOLOGY_DRIFT_CONTRACT = {
  schemaVersion: "agentera.terminologyDriftReport.v1",
  requestSchemaVersion: "agentera.terminologyDriftRequest.v1",
  command: "npx -y agentera@next report terminology-drift --input REQUEST",
  syntax: "npx -y agentera@next report terminology-drift --input FILE_OR_DASH [--project PATH] [--format json]",
  maxRequestUtf8Bytes: 32768,
  maxTerms: 32,
  maxEvidencePerTerm: 64,
  scope: "Audit's read-only terminology-drift finding for one concept in the current directory, or --project PATH, resolved like state glossary publish. Reads only the cited project-file lines. Never writes project, glossary, profile, or docs state, and never approves a proposal.",
  input:
    "One YAML or JSON mapping: schema_version agentera.terminologyDriftRequest.v1; concept (the shared meaning); confidence (integer, protocol CS3 floor through 100); severity critical|warning|info; terms, at least two of {term, evidence: [{source_path, line}]} with project-relative paths whose cited line contains the term; optional personal_term from personal glossary advice. Apply the deliberate-decision and tracked-TODO filters before calling.",
  output: "status finding returns the complete canonical finding, including proposal_digest, for verbatim reuse as the publication request proposal. status no_finding returns finding null and reason confidence_out_of_range, unverified_evidence, or no_drift.",
  next: "Show the user the proposed canonical term, variants, cited lines, and proposal_digest. Only after the user confirms that exact digest does Build publish through npx -y agentera@next state glossary publish --input REQUEST.",
};

const RECOVERY = `Correct the bounded request and retry ${TERMINOLOGY_DRIFT_CONTRACT.syntax}; no state was changed.`;

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(io: Io, body: InvalidInputErrorBody): number {
  return emitInvalidInput(io, { format: "json", body: { ...body, recovery: RECOVERY } });
}

function parseArgs(argv: string[]): { input: string; project?: string } | InvalidInputErrorBody {
  let input: string | undefined;
  let project: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index]!.split("=", 2);
    if (name !== "--input" && name !== "--format" && name !== "--project") {
      return { class: "unrecognized_argument", message: `unrecognized arguments: ${name}`, syntax: TERMINOLOGY_DRIFT_CONTRACT.syntax };
    }
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) return { class: "missing_argument", message: `${name} requires a value`, syntax: `${name} VALUE` };
    if (name === "--format") {
      if (value !== "json") return { class: "invalid_choice", message: "terminology-drift supports only --format json", valid_values: ["json"] };
    } else if (name === "--project") {
      if (project !== undefined) return { class: "mutually_exclusive", message: "--project may only be supplied once" };
      project = value;
    } else {
      if (input !== undefined) return { class: "mutually_exclusive", message: "--input may only be supplied once" };
      input = value;
    }
  }
  if (input === undefined) return { class: "missing_argument", message: "--input is required", syntax: TERMINOLOGY_DRIFT_CONTRACT.syntax };
  return project === undefined ? { input } : { input, project };
}

function readRequest(source: string, io: Io): Mapping {
  const bytes = source === "-" ? Buffer.from(io.stdin ? io.stdin() : fs.readFileSync(0)) : fs.readFileSync(source);
  if (bytes.length > TERMINOLOGY_DRIFT_CONTRACT.maxRequestUtf8Bytes) throw new Error("over bound");
  const request = loadYamlMapping(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!mapping(request)) throw new Error("not a mapping");
  return request;
}

function validatedRequest(request: Mapping): { concept: AssessedTerminologyConcept; personalTerm?: string } | InvalidInputErrorBody {
  const violations: string[] = [];
  const undeclared = Object.keys(request).filter((key) => !(REQUEST_FIELDS as readonly string[]).includes(key));
  if (undeclared.length > 0) violations.push(`undeclared fields: ${undeclared.join(", ")}`);
  if (request.schema_version !== TERMINOLOGY_DRIFT_CONTRACT.requestSchemaVersion) violations.push(`schema_version must be ${TERMINOLOGY_DRIFT_CONTRACT.requestSchemaVersion}`);
  if (typeof request.concept !== "string" || request.concept.trim() === "") violations.push("concept must be a non-empty string");
  if (!Number.isInteger(request.confidence)) violations.push("confidence must be an integer");
  if (!SEVERITIES.includes(request.severity as FindingSeverity)) violations.push("severity must be critical, warning, or info");
  if (request.personal_term !== undefined && request.personal_term !== null && typeof request.personal_term !== "string") violations.push("personal_term must be a string when present");
  const terms = request.terms;
  if (!Array.isArray(terms) || terms.length < 2 || terms.length > TERMINOLOGY_DRIFT_CONTRACT.maxTerms) {
    violations.push(`terms must list 2 through ${TERMINOLOGY_DRIFT_CONTRACT.maxTerms} cited terms`);
  } else {
    terms.forEach((term, index) => {
      if (!mapping(term) || Object.keys(term).some((key) => key !== "term" && key !== "evidence") || typeof term.term !== "string") {
        violations.push(`terms[${index}] must contain only a string term and evidence`);
        return;
      }
      const evidence = term.evidence;
      if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > TERMINOLOGY_DRIFT_CONTRACT.maxEvidencePerTerm) {
        violations.push(`terms[${index}].evidence must list 1 through ${TERMINOLOGY_DRIFT_CONTRACT.maxEvidencePerTerm} cited lines`);
        return;
      }
      evidence.forEach((item, itemIndex) => {
        if (!mapping(item) || Object.keys(item).some((key) => key !== "source_path" && key !== "line") || typeof item.source_path !== "string" || !Number.isInteger(item.line)) {
          violations.push(`terms[${index}].evidence[${itemIndex}] must contain only a string source_path and an integer line`);
        }
      });
    });
  }
  if (violations.length > 0) return { class: "schema_violation", message: violations[0]!, violations };
  return {
    concept: {
      concept: request.concept as string,
      confidence: request.confidence as number,
      severity: request.severity as FindingSeverity,
      terms: request.terms as AssessedTerminologyConcept["terms"],
    },
    ...(typeof request.personal_term === "string" ? { personalTerm: request.personal_term } : {}),
  };
}

export function runTerminologyDriftCommand(argv: string[], io: Io): number {
  const parsedArgs = parseArgs(argv);
  if ("class" in parsedArgs) return invalid(io, parsedArgs);
  let request: Mapping;
  try {
    request = readRequest(parsedArgs.input, io);
  } catch {
    return invalid(io, { class: "invalid_format", message: "--input must be one readable bounded UTF-8 YAML or JSON mapping" });
  }
  const parsed = validatedRequest(request);
  if ("class" in parsed) return invalid(io, parsed);
  let root: string;
  try {
    root = validateRealProjectRoot(path.resolve(parsedArgs.project ?? process.cwd())).path;
  } catch (error) {
    return invalid(io, { class: "invalid_request", message: (error as Error).message });
  }
  const assessment = assessTerminologyConcept(root, parsed.concept, parsed.personalTerm);
  emitStructured(
    {
      schemaVersion: TERMINOLOGY_DRIFT_CONTRACT.schemaVersion,
      command: "report terminology-drift",
      status: "finding" in assessment ? "finding" : "no_finding",
      finding: "finding" in assessment ? assessment.finding : null,
      reason: "reason" in assessment ? assessment.reason : null,
      next: "finding" in assessment ? TERMINOLOGY_DRIFT_CONTRACT.next : null,
      effects: { writes: false },
    },
    "json",
    io.out ?? ((text) => process.stdout.write(text)),
  );
  return 0;
}
