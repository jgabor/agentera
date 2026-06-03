import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  EVALUATOR_HANDOFF_REPORT_SCHEMA_VERSION,
  isValidCitation,
  loadEvaluatorHandoffContract,
  validateEvaluationReport,
  verifyWarnCitationAtLine,
} from "../../src/registries/evaluatorHandoffContract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const CONTRACT_PATH = path.join(REPO_ROOT, "references", "cli", "capability-instruction-contract.yaml");
const SAMPLE_REPORT_PATH = path.join(
  REPO_ROOT,
  "packages/cli/test/cli/fixtures/oracle/inspektera-evaluation-report.json",
);

describe("evaluator handoff contract loader", () => {
  const contract = loadEvaluatorHandoffContract(CONTRACT_PATH);

  it("loads citation requirements from capability-instruction-contract.yaml", () => {
    expect(contract.status).toBe("implemented");
    expect(contract.reportSchemaVersion).toBe(EVALUATOR_HANDOFF_REPORT_SCHEMA_VERSION);
    expect(contract.citationRequiredFor).toEqual(["WARN", "FAIL"]);
    expect(contract.warnVerifyCommandRequired).toBe(true);
    expect(contract.warnVerifyCommandPrefixes).toEqual(["grep", "git show"]);
  });

  it("accepts file:line and not-applicable citations", () => {
    expect(isValidCitation("TODO.md:5", contract)).toBe(true);
    expect(isValidCitation("not-applicable: runtime-only metric with no file anchor", contract)).toBe(true);
    expect(isValidCitation("prose only", contract)).toBe(false);
    expect(isValidCitation("not-applicable: short", contract)).toBe(false);
  });

  it("fails validation when WARN/FAIL rows lack citation", () => {
    const errors = validateEvaluationReport(
      {
        schemaVersion: EVALUATOR_HANDOFF_REPORT_SCHEMA_VERSION,
        rows: [
          { criterion: "test", status: "WARN", evidence: "missing citation" },
          { criterion: "test2", status: "FAIL", evidence: "also missing" },
        ],
      },
      contract,
    );
    expect(errors.some((e) => e.includes("missing citation"))).toBe(true);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("fails validation when WARN row with file:line citation lacks verify_command", () => {
    const errors = validateEvaluationReport(
      {
        rows: [
          {
            criterion: "test",
            status: "WARN",
            evidence: "found issue",
            citation: "TODO.md:1",
          },
        ],
      },
      contract,
    );
    expect(errors.some((e) => e.includes("missing verify_command"))).toBe(true);
  });

  it("passes validation for the sample inspektera evaluation report fixture", () => {
    const report = JSON.parse(fs.readFileSync(SAMPLE_REPORT_PATH, "utf8"));
    const errors = validateEvaluationReport(report, contract);
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });
});

describe("inspektera evaluation report citation regression", () => {
  const contract = loadEvaluatorHandoffContract(CONTRACT_PATH);
  const report = JSON.parse(fs.readFileSync(SAMPLE_REPORT_PATH, "utf8"));

  it("every WARN/FAIL entry in the sample report carries a valid citation", () => {
    const warnFailRows = report.rows.filter((row: { status: string }) =>
      ["WARN", "FAIL"].includes(String(row.status).toUpperCase()),
    );
    expect(warnFailRows.length).toBeGreaterThan(0);
    for (const row of warnFailRows) {
      expect(isValidCitation(String(row.citation), contract), JSON.stringify(row)).toBe(true);
    }
  });

  it("re-verifies WARN file:line citations with the fixture verify_command", () => {
    const warnRows = report.rows.filter(
      (row: { status: string; citation?: string; verify_command?: string }) =>
        String(row.status).toUpperCase() === "WARN" && row.citation?.includes(":") && row.verify_command,
    );
    expect(warnRows.length).toBeGreaterThan(0);
    for (const row of warnRows) {
      const result = verifyWarnCitationAtLine(row, REPO_ROOT);
      expect(result.ok, result.message).toBe(true);
    }
  });
});
