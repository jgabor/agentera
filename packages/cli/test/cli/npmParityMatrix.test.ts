import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { isParityFamilyClosed } from "../upgrade/gapRegistry.js";
import {
  classifyDrift,
  DriftDirection,
  effectiveDriftDirection,
  expectedShapeLiteralPins,
  expectedShapeRequiredKeys,
  normalizeEnvelope,
  NormalizeRules,
  ParityRow,
} from "./parityOracle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ORACLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/oracle/npm-cli-surface.json"), "utf8"),
) as {
  commands: Record<
    string,
    {
      argv: string[];
      exitCode: number;
      requiredKeys: string[];
      commandValue?: string;
      forbiddenSubstrings?: string[];
    }
  >;
};
const REMAINING_FAMILIES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/oracle/parity-remaining-families.json"), "utf8"),
) as {
  python_commit: string;
  normalizeEnvelope: { rules: NormalizeRules };
  families: Record<
    string,
    {
      argv: string[];
      exitCode: number;
      expectedShape: Record<string, unknown>;
      forbiddenSubstrings: string[];
    }
  >;
};

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

let prevProfilera: string | undefined;
let tmpProfile: string;

beforeEach(() => {
  tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "npm-parity-profile-"));
  prevProfilera = process.env.AGENTERA_PROFILE_DIR;
  process.env.AGENTERA_PROFILE_DIR = tmpProfile;
});

afterEach(() => {
  if (prevProfilera === undefined) delete process.env.AGENTERA_PROFILE_DIR;
  else process.env.AGENTERA_PROFILE_DIR = prevProfilera;
  fs.rmSync(tmpProfile, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * The matrix: every row carries drift_direction and version_break.   *
 * The 6 original npm-cli-surface rows are equal-pass at T1; the 6    *
 * v3-remaining family rows are intentional_version_break until T2-  *
 * T7 close them. Each row is exercised once via the matrix helper.  *
 * ------------------------------------------------------------------ */

const ORIGINAL_ROWS: ParityRow[] = Object.entries(ORACLE.commands).map(([name, spec]) => ({
  family: name,
  argv: spec.argv,
  exitCode: spec.exitCode,
  requiredKeys: spec.requiredKeys,
  commandValue: spec.commandValue,
  forbiddenSubstrings: spec.forbiddenSubstrings ?? [],
  python_commit: REMAINING_FAMILIES.python_commit,
  version_break: false,
}));

const REMAINING_FAMILY_ROWS: ParityRow[] = Object.entries(REMAINING_FAMILIES.families).map(
  ([family, spec]) => ({
    family: `remaining:${family}`,
    argv: spec.argv,
    exitCode: spec.exitCode,
    requiredKeys: expectedShapeRequiredKeys(spec.expectedShape),
    literalPins: expectedShapeLiteralPins(spec.expectedShape),
    forbiddenSubstrings: spec.forbiddenSubstrings,
    python_commit: spec.python_commit,
    version_break: !isParityFamilyClosed(family),
  }),
);

interface MatrixResult {
  rc: number;
  out: string;
  err: string;
  payload: Record<string, unknown> | null;
  normalized: Record<string, unknown> | null;
  classification: ReturnType<typeof classifyDrift> | null;
  drift_direction: DriftDirection;
}

function seedDoctorParityBundle(root: string): void {
  fs.mkdirSync(path.join(root, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "agentera", "SKILL.md"), "# Agentera\n");
  fs.writeFileSync(
    path.join(root, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: "3.0.0" }] }),
  );
  fs.writeFileSync(
    path.join(root, ".agentera-npx-bundle.json"),
    JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "3.0.0" }),
  );
  const references = path.join(REPO_ROOT, "references");
  if (fs.existsSync(references)) {
    fs.cpSync(references, path.join(root, "references"), { recursive: true });
  }
}

function runMatrixRow(row: ParityRow): MatrixResult {
  const familyId = row.family.replace(/^remaining:/, "");
  const doctorParity =
    row.argv[0] === "doctor" && !row.argv.includes("--smoke") && isParityFamilyClosed(familyId);
  const envRestore: Array<[string, string | undefined]> = [];
  let bundleTmp: string | null = null;
  if (doctorParity) {
    bundleTmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-parity-bundle-"));
    seedDoctorParityBundle(bundleTmp);
    for (const key of ["AGENTERA_BOOTSTRAP_SOURCE_ROOT", "AGENTERA_HOME"]) {
      envRestore.push([key, process.env[key]]);
      delete process.env[key];
    }
    process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = bundleTmp;
  }
  try {
    return runMatrixRowInner(row);
  } finally {
    if (bundleTmp) {
      fs.rmSync(bundleTmp, { recursive: true, force: true });
    }
    for (const [key, value] of envRestore) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runMatrixRowInner(row: ParityRow): MatrixResult {
  const { rc, out, err } = capture((io) => main(["node", "agentera", ...row.argv], io));
  let payload: Record<string, unknown> | null = null;
  let normalized: Record<string, unknown> | null = null;
  let classification: ReturnType<typeof classifyDrift> | null = null;
  let drift_direction: DriftDirection;
  try {
    payload = JSON.parse(out) as Record<string, unknown>;
    normalized = normalizeEnvelope(payload) as Record<string, unknown>;
    const literalPins = {
      ...(row.literalPins ?? {}),
      ...(row.commandValue !== undefined ? { command: row.commandValue } : {}),
    };
    classification = classifyDrift(normalized, row.requiredKeys, literalPins, row.forbiddenSubstrings);
    drift_direction = effectiveDriftDirection(row, classification);
  } catch {
    // Envelope is not JSON (e.g., text-mode error from a not-yet-ported
    // family). Classify as ts_smaller so the row is reported; if
    // version_break is set, the matrix helper treats it as
    // intentional_version_break.
    classification = {
      direction: "ts_smaller",
      missingKeys: row.requiredKeys,
      extraKeys: [],
      forbiddenHits: [],
      literalMismatches: [],
    };
    drift_direction = row.version_break ? "intentional_version_break" : "ts_smaller";
  }
  return { rc, out, err, payload, normalized, classification, drift_direction };
}

function assertRowPassesOrDocumentsBreak(
  row: ParityRow,
  classification: ReturnType<typeof classifyDrift>,
  rc: number,
): void {
  if (classification.direction === "equal") return;
  if (row.version_break) {
    // Intentional break: the row passes as long as it doesn't crash
    // catastrophically (rc 0 or rc 2 is acceptable for not-yet-ported
    // families that emit a text-mode Error envelope).
    if (rc !== 0 && rc !== 2) {
      throw new Error(
        `npmParityMatrix: row '${row.family}' (intentional_version_break) exited with rc=${rc}; expected 0 or 2.`,
      );
    }
    return;
  }
  // Not equal, not version_break, not intentional: must fail.
  const lines = [
    `npmParityMatrix: row '${row.family}' reports drift_direction='${classification.direction}'.`,
    `  pinned python_commit: ${row.python_commit}`,
    `  argv: ${row.argv.join(" ")}`,
  ];
  if (classification.missingKeys.length > 0) {
    lines.push(`  missing keys (ts_smaller): ${classification.missingKeys.join(", ")}`);
  }
  if (classification.extraKeys.length > 0) {
    lines.push(`  extra keys (python_smaller): ${classification.extraKeys.join(", ")}`);
  }
  if (classification.forbiddenHits.length > 0) {
    lines.push(`  forbidden substrings (python_smaller): ${classification.forbiddenHits.join(", ")}`);
  }
  if (classification.literalMismatches.length > 0) {
    lines.push(`  literal mismatches: ${classification.literalMismatches.join("; ")}`);
  }
  lines.push(
    "  Set version_break: true on this row to mark as intentional_version_break, or update the live CLI to match the oracle pin.",
  );
  throw new Error(lines.join("\n"));
}

describe("npm CLI parity matrix (Python oracle envelopes)", () => {
  for (const [name, spec] of Object.entries(ORACLE.commands)) {
    it(`matches oracle envelope for ${name}`, () => {
      const envRestore: Array<[string, string | undefined]> = [];
      let appHomeTmp: string | null = null;
      if (name === "upgrade_development_dry_run") {
        appHomeTmp = fs.mkdtempSync(path.join(os.tmpdir(), "npm-parity-apphome-"));
        fs.mkdirSync(path.join(appHomeTmp, "app", "skills", "agentera"), { recursive: true });
        fs.mkdirSync(path.join(appHomeTmp, "app", "scripts"), { recursive: true });
        fs.writeFileSync(path.join(appHomeTmp, "app", "skills", "agentera", "SKILL.md"), "# Agentera\n");
        fs.writeFileSync(path.join(appHomeTmp, "app", "scripts", "agentera"), "#!/usr/bin/env node\n");
        fs.writeFileSync(
          path.join(appHomeTmp, "app", ".agentera-bundle.json"),
          JSON.stringify({ kind: "agentera-bundle", version: "2.7.9" }),
        );
        envRestore.push(["AGENTERA_HOME", process.env.AGENTERA_HOME]);
        process.env.AGENTERA_HOME = appHomeTmp;
      }
      let rc: number;
      let out: string;
      try {
        const captured = capture((io) => main(["node", "agentera", ...spec.argv], io));
        rc = captured.rc;
        out = captured.out;
      } finally {
        for (const [key, value] of envRestore) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        if (appHomeTmp) fs.rmSync(appHomeTmp, { recursive: true, force: true });
      }
      expect(rc).toBe(spec.exitCode);
      const payload = JSON.parse(out);
      for (const key of spec.requiredKeys) {
        expect(payload).toHaveProperty(key);
      }
      if (spec.commandValue !== undefined) {
        expect(payload.command).toBe(spec.commandValue);
      }
      if (name === "upgrade_development_dry_run") {
        expect(payload.channel.channel).toBe("development");
      }
      const serialized = JSON.stringify(payload);
      for (const forbidden of spec.forbiddenSubstrings ?? []) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  }

  it.each(REMAINING_FAMILY_ROWS.map((row) => [row.family, row] as const))(
    "remaining-family row '%s' is registered in the parity matrix (V5: one pass + one fail per testable unit)",
    (_familyName, row) => {
      const familyId = row.family.replace(/^remaining:/, "");
      const result = runMatrixRow(row);
      // ---- V5 pass case (per family) ----
      //   - family is registered in the fixture
      //   - python_commit is pinned to the current main HEAD
      //   - version_break lifts to intentional_version_break until T2-T7 close
      //     the gap; closed families must report drift_direction === 'equal'.
      expect(row.python_commit, `row '${row.family}' python_commit`).toBe(REMAINING_FAMILIES.python_commit);
      expect(row.version_break, `row '${row.family}' version_break`).toBe(!isParityFamilyClosed(familyId));
      if (isParityFamilyClosed(familyId)) {
        expect(result.rc, `row '${row.family}' exit code`).toBe(row.exitCode);
        assertRowPassesOrDocumentsBreak(row, result.classification!, result.rc);
        expect(
          result.drift_direction,
          `row '${row.family}' drift_direction`,
        ).toBe("equal");
      } else {
        expect(
          result.drift_direction === "equal" || result.drift_direction === "intentional_version_break",
          `row '${row.family}' drift_direction='${result.drift_direction}' must be equal or intentional_version_break until the gap closes`,
        ).toBe(true);
      }
      // ---- V5 fail case (per family) ----
      //   - the live envelope MUST NOT emit any of the forbidden
      //     substrings (the per-family sentinels). If it does, the
      //     matrix classifies the row as `python_smaller` and the test
      //     fails with a clear error.
      if (result.classification?.forbiddenHits && result.classification.forbiddenHits.length > 0) {
        throw new Error(
          `npmParityMatrix: row '${row.family}' emitted a forbidden-shape sentinel: ${result.classification.forbiddenHits.join(", ")}.`,
        );
      }
    },
  );

  it("does not treat uvx git feat/v3 as a development channel resolution", () => {
    const { out } = capture((io) =>
      main(["node", "agentera", "upgrade", "--channel", "development", "--dry-run", "--format", "json"], io),
    );
    const payload = JSON.parse(out);
    const planText = JSON.stringify(payload);
    expect(planText).not.toMatch(/uvx.*@feat\/v3/);
    expect(planText).not.toMatch(/git\+https:\/\/github\.com\/jgabor\/agentera@feat\/v3/);
  });

  it("runs from repo checkout with cwd at repository root", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "skills", "agentera", "SKILL.md"))).toBe(true);
  });
});

// Silence the "imports are unused" linter for the type-only exports that
// the test file relies on for type inference from the parity-oracle module.
void REMAINING_FAMILIES;
void ORIGINAL_ROWS;
void assertRowPassesOrDocumentsBreak;
