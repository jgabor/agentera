import fs from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

import { loadYamlMapping } from "../core/yaml.js";

/**
 * Evaluator-handoff contract loader and inspektera evaluation report validator.
 * Authority: references/cli/capability-instruction-contract.yaml#evaluator_handoff
 */

export const EVALUATOR_HANDOFF_REPORT_SCHEMA_VERSION = "agentera.inspekteraEvaluationReport.v1";

export interface EvaluatorHandoffContract {
  path: string;
  status: string;
  reportSchemaVersion: string;
  citationRequiredFor: string[];
  fileLinePattern: RegExp;
  notApplicablePrefix: string;
  minNotApplicableReasonLength: number;
  warnVerifyCommandRequired: boolean;
  warnVerifyCommandPrefixes: string[];
}

export interface EvaluationReportRow {
  criterion?: string;
  status?: string;
  evidence?: string;
  citation?: string;
  verify_command?: string;
}

export interface EvaluationReport {
  schemaVersion?: string;
  overall_verdict?: string;
  verification_evidence_audit?: string;
  rows?: EvaluationReportRow[];
}

type Dict = Record<string, unknown>;

function isMapping(value: unknown): value is Dict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function defaultEvaluatorHandoffContractPath(repoRoot: string): string {
  return path.join(repoRoot, "references", "cli", "capability-instruction-contract.yaml");
}

export function loadEvaluatorHandoffContract(contractPath: string): EvaluatorHandoffContract {
  const data = loadYamlMapping(fs.readFileSync(contractPath, "utf8")) as Dict;
  const handoff = data.evaluator_handoff;
  if (!isMapping(handoff)) {
    throw new Error(`evaluator_handoff section missing in ${contractPath}`);
  }
  const rowSchema = isMapping(handoff.row_schema) ? handoff.row_schema : {};
  const citationFormats = isMapping(rowSchema.citation_formats) ? rowSchema.citation_formats : {};
  const fileLine = isMapping(citationFormats.file_line) ? citationFormats.file_line : {};
  const notApplicable = isMapping(citationFormats.not_applicable) ? citationFormats.not_applicable : {};
  const warnVerify = isMapping(rowSchema.warn_verify_command) ? rowSchema.warn_verify_command : {};
  const patternSource = asString(fileLine.pattern) || "^[^:\\s]+:\\d+$";
  return {
    path: contractPath,
    status: asString(handoff.status) || "unknown",
    reportSchemaVersion: asString(handoff.report_schema_version) || EVALUATOR_HANDOFF_REPORT_SCHEMA_VERSION,
    citationRequiredFor: Array.isArray(rowSchema.citation_required_for)
      ? rowSchema.citation_required_for.map((v) => String(v))
      : ["WARN", "FAIL"],
    fileLinePattern: new RegExp(patternSource),
    notApplicablePrefix: asString(notApplicable.prefix) || "not-applicable:",
    minNotApplicableReasonLength: Number(notApplicable.min_reason_length) || 8,
    warnVerifyCommandRequired: warnVerify.required_when === "file_line_citation",
    warnVerifyCommandPrefixes: Array.isArray(warnVerify.allowed_prefixes)
      ? warnVerify.allowed_prefixes.map((v) => String(v))
      : ["grep", "git show"],
  };
}

export function isFileLineCitation(citation: string, contract: EvaluatorHandoffContract): boolean {
  return contract.fileLinePattern.test(citation);
}

export function isNotApplicableCitation(citation: string, contract: EvaluatorHandoffContract): boolean {
  if (!citation.startsWith(contract.notApplicablePrefix)) return false;
  const reason = citation.slice(contract.notApplicablePrefix.length).trim();
  return reason.length >= contract.minNotApplicableReasonLength;
}

export function isValidCitation(citation: string, contract: EvaluatorHandoffContract): boolean {
  const trimmed = citation.trim();
  if (!trimmed) return false;
  return isFileLineCitation(trimmed, contract) || isNotApplicableCitation(trimmed, contract);
}

export function parseFileLineCitation(citation: string): { file: string; line: number } | null {
  const match = /^([^:\s]+):(\d+)$/.exec(citation.trim());
  if (!match) return null;
  return { file: match[1], line: Number(match[2]) };
}

export function isAllowedVerifyCommand(command: string, contract: EvaluatorHandoffContract): boolean {
  const trimmed = command.trim();
  return contract.warnVerifyCommandPrefixes.some((prefix) => trimmed.startsWith(prefix));
}

export function validateEvaluationReportRow(
  row: EvaluationReportRow,
  index: number,
  contract: EvaluatorHandoffContract,
): string[] {
  const errors: string[] = [];
  const label = `rows[${index}]`;
  const status = asString(row.status).toUpperCase();
  const criterion = asString(row.criterion);
  const evidence = asString(row.evidence);

  if (!criterion) errors.push(`${label}: missing criterion`);
  if (!status) errors.push(`${label}: missing status`);
  if (!evidence) errors.push(`${label}: missing evidence`);

  if (!contract.citationRequiredFor.includes(status)) return errors;

  const citation = asString(row.citation);
  if (!citation) {
    errors.push(`${label}: WARN/FAIL row missing citation`);
    return errors;
  }
  if (!isValidCitation(citation, contract)) {
    errors.push(
      `${label}: citation must be file:line (e.g. TODO.md:15) or not-applicable: <reason> (min ${contract.minNotApplicableReasonLength} chars)`,
    );
    return errors;
  }

  if (status === "WARN" && contract.warnVerifyCommandRequired && isFileLineCitation(citation, contract)) {
    const verifyCommand = asString(row.verify_command);
    if (!verifyCommand) {
      errors.push(`${label}: WARN row with file:line citation missing verify_command`);
    } else if (!isAllowedVerifyCommand(verifyCommand, contract)) {
      errors.push(`${label}: verify_command must start with grep or git show`);
    }
  }

  return errors;
}

export function validateEvaluationReport(
  report: EvaluationReport,
  contract: EvaluatorHandoffContract,
): string[] {
  const errors: string[] = [];
  const schemaVersion = asString(report.schemaVersion);
  if (schemaVersion && schemaVersion !== contract.reportSchemaVersion) {
    errors.push(`schemaVersion must be ${contract.reportSchemaVersion}`);
  }
  const rows = Array.isArray(report.rows) ? report.rows : null;
  if (!rows || rows.length === 0) {
    errors.push("rows must be a non-empty array");
    return errors;
  }
  rows.forEach((row, index) => {
    errors.push(...validateEvaluationReportRow(row, index, contract));
  });
  return errors;
}

function readCitedLine(repoRoot: string, file: string, line: number): string {
  const absPath = path.isAbsolute(file) ? file : path.join(repoRoot, file);
  if (!fs.existsSync(absPath)) return "";
  const lines = fs.readFileSync(absPath, "utf8").split(/\r?\n/);
  return (lines[line - 1] ?? "").trim();
}

export function verifyWarnCitationAtLine(
  row: EvaluationReportRow,
  repoRoot: string,
): { ok: boolean; message: string } {
  const citation = asString(row.citation);
  const verifyCommand = asString(row.verify_command);
  const parsed = parseFileLineCitation(citation);
  if (!parsed) {
    return { ok: true, message: "not-applicable citation skips line verification" };
  }
  const citedLine = readCitedLine(repoRoot, parsed.file, parsed.line);
  if (!citedLine) {
    return { ok: false, message: `cited line ${parsed.line} is missing or empty in ${parsed.file}` };
  }
  if (!verifyCommand) {
    return { ok: false, message: "missing verify_command for file:line citation" };
  }
  try {
    const output = execSync(verifyCommand, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      .trim();
    if (output.includes(citedLine)) {
      return { ok: true, message: "verify_command output includes cited line text" };
    }
    return {
      ok: false,
      message: `verify_command output does not reproduce cited line ${parsed.line} in ${parsed.file}`,
    };
  } catch (exc) {
    return { ok: false, message: `verify_command failed: ${(exc as Error).message}` };
  }
}

export function evaluatorHandoffOutputRequirements(contract: EvaluatorHandoffContract): Dict {
  return {
    citation_required_for: contract.citationRequiredFor,
    warn_verify_command_required: contract.warnVerifyCommandRequired,
    citation_formats: {
      file_line: "path/to/file:line",
      not_applicable: `${contract.notApplicablePrefix}<reason>`,
    },
    verify_command_prefixes: contract.warnVerifyCommandPrefixes,
    report_schema_version: contract.reportSchemaVersion,
    schema_authority: "references/cli/capability-instruction-contract.yaml#evaluator_handoff",
  };
}
