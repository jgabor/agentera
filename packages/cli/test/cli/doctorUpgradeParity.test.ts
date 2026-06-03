import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { cmdDoctor } from "../../src/cli/commands/doctor.js";
import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { runNpmSmokeChecks } from "../../src/setup/smokeChecks.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
  buildDoctorStatus,
  doctorParityJsonEnvelope,
  DOCTOR_PARITY_JSON_KEYS,
} from "../../src/upgrade/doctor.js";
import {
  STATUS_APPLIED,
  STATUS_MANUAL_REVIEW_NEEDED,
  STATUS_NO_CHANGES_NEEDED,
  STATUS_READY_TO_APPLY,
} from "../../src/upgrade/compatibility.js";
import {
  classifyDrift,
  expectedShapeLiteralPins,
  expectedShapeRequiredKeys,
  normalizeEnvelope,
} from "./parityOracle.js";
import { BUNDLE_MARKER } from "../../src/state/installRoot.js";
import { buildUpgradePlan } from "../../src/upgrade/upgradeOrchestrator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ORACLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/oracle/parity-remaining-families.json"), "utf8"),
) as {
  families: {
    doctor_upgrade_safety: {
      expectedShape: Record<string, unknown>;
      forbiddenSubstrings: string[];
    };
  };
};

const FORBIDDEN_REPAIR_PHRASES = [
  "bundle freshness",
  "bundle refresh",
  "app refresh required",
  "bundle freshness gap",
];

const CANONICAL_DOCTOR_STATUSES = new Set([
  APP_UP_TO_DATE,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_MANUAL_REVIEW_NEEDED,
]);

const CANONICAL_UPGRADE_LIFECYCLE = new Set([
  STATUS_READY_TO_APPLY,
  STATUS_APPLIED,
  STATUS_NO_CHANGES_NEEDED,
  STATUS_MANUAL_REVIEW_NEEDED,
]);

let tmp: string;
let home: string;

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

function managed(appHome: string, marker: string): void {
  const app = path.join(appHome, "app");
  fs.mkdirSync(path.join(app, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(app, "scripts", "agentera"), "#!/usr/bin/env node\n");
  fs.mkdirSync(path.join(app, "skills", "agentera"), { recursive: true });
  fs.writeFileSync(path.join(app, "skills", "agentera", "SKILL.md"), "x");
  fs.writeFileSync(
    path.join(app, "registry.json"),
    JSON.stringify({ skills: [{ name: "agentera", version: marker }] }),
  );
  fs.writeFileSync(
    path.join(app, BUNDLE_MARKER),
    JSON.stringify({ schemaVersion: "agentera.bundle.v1", version: marker }),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-upgrade-parity-"));
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT = REPO_ROOT;
  process.env.HOME = home;
});

afterEach(() => {
  delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  delete process.env.HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("doctor upgrade safety parity (D56 T4)", () => {
  const doctorSpec = ORACLE.families.doctor_upgrade_safety;
  const requiredKeys = expectedShapeRequiredKeys(doctorSpec.expectedShape);
  const literalPins = expectedShapeLiteralPins(doctorSpec.expectedShape);

  it("doctorParityJsonEnvelope emits oracle structural keys only", () => {
    const appHome = path.join(tmp, "fresh");
    managed(appHome, "3.0.0");
    const status = buildDoctorStatus(appHome, {
      rootSource: "explicit --install-root",
      sourceRoot: REPO_ROOT,
      home,
      project: path.join(tmp, "proj"),
      expectedVersion: "3.0.0",
      probeCli: false,
    });
    const envelope = doctorParityJsonEnvelope(status);
    expect(envelope.command).toBe("doctor");
    expect(Object.keys(envelope).sort()).toEqual(["command", ...DOCTOR_PARITY_JSON_KEYS].sort());
    const cls = classifyDrift(
      normalizeEnvelope(envelope) as Record<string, unknown>,
      requiredKeys,
      literalPins,
      doctorSpec.forbiddenSubstrings,
    );
    expect(cls.direction).toBe("equal");
  });

  it("fails parity classification when the doctor command label is missing", () => {
    const envelope = { status: APP_UP_TO_DATE, expectedVersion: "3.0.0" };
    const cls = classifyDrift(
      normalizeEnvelope(envelope) as Record<string, unknown>,
      requiredKeys,
      literalPins,
      doctorSpec.forbiddenSubstrings,
    );
    expect(cls.direction).toBe("ts_smaller");
    expect(cls.missingKeys).toContain("command");
  });

  it("runNpmSmokeChecks stays bounded without live model calls", () => {
    const report = runNpmSmokeChecks(REPO_ROOT, process.env);
    expect(report.enabled).toBe(true);
    expect(report.modelCallsAttempted).toBe(false);
    expect((report.summary as { fail: number }).fail).toBe(0);
  });

  it("doctor --smoke --format json attaches a smoke block", () => {
    const { out } = capture((io) => main(["node", "agentera", "doctor", "--smoke", "--format", "json"], io));
    const payload = JSON.parse(out);
    expect(payload.smoke.enabled).toBe(true);
    expect(payload.smoke.modelCallsAttempted).toBe(false);
  });

  it("upgrade --dry-run emits canonical lifecycleStatus metadata", () => {
    const appHome = path.join(home, "agentera");
    managed(appHome, "2.7.0");
    let stdout = "";
    cmdUpgrade(
      { installRoot: appHome, home, dryRun: true, format: "json", channel: "development" },
      { out: (t) => { stdout += t; } },
    );
    const payload = JSON.parse(stdout);
    expect(CANONICAL_UPGRADE_LIFECYCLE.has(payload.lifecycleStatus)).toBe(true);
    expect(payload.schemaVersion).toBeTruthy();
  });

  const DEPRECATED_STATUS_ALIASES: Record<string, string> = {
    outdated: "stale",
    repair_needed: "refresh_required",
    manual_review_needed: "blocked",
    ready_to_apply: "pending",
    no_changes_needed: "noop",
  };

  const lifecycleTransitions: Array<{
    name: string;
    pass: () => { status: string; serialized: string };
  }> = [
    {
      name: "outdated",
      pass: () => {
        const appHome = path.join(tmp, "stale");
        managed(appHome, "old");
        const status = buildDoctorStatus(appHome, {
          rootSource: "explicit --install-root",
          sourceRoot: REPO_ROOT,
          home,
          project: path.join(tmp, "proj"),
          expectedVersion: "3.0.0",
          probeCli: false,
        });
        return { status: status.status, serialized: JSON.stringify(doctorParityJsonEnvelope(status)) };
      },
    },
    {
      name: "repair_needed",
      pass: () => {
        const appHome = path.join(tmp, "missing");
        const status = buildDoctorStatus(appHome, {
          rootSource: "default app home",
          sourceRoot: REPO_ROOT,
          home,
          project: path.join(tmp, "proj"),
          expectedVersion: "3.0.0",
          probeCli: false,
        });
        return { status: status.status, serialized: JSON.stringify(doctorParityJsonEnvelope(status)) };
      },
    },
    {
      name: "manual_review_needed",
      pass: () => {
        const appHome = path.join(tmp, "blocked");
        const status = buildDoctorStatus(appHome, {
          rootSource: "explicit --install-root",
          sourceRoot: REPO_ROOT,
          home,
          project: path.join(tmp, "proj"),
          expectedVersion: "3.0.0",
          probeCli: false,
        });
        return { status: status.status, serialized: JSON.stringify(doctorParityJsonEnvelope(status)) };
      },
    },
    {
      name: "ready_to_apply",
      pass: () => {
        const appHome = path.join(home, "v2");
        managed(appHome, "2.7.0");
        const project = path.join(tmp, "project");
        fs.cpSync(path.join(__dirname, "../upgrade/fixtures/v2-yaml-project"), project, { recursive: true });
        const plan = buildUpgradePlan({
          installRoot: appHome,
          home,
          project,
          channel: "development",
          dryRun: true,
        });
        return { status: plan.lifecycleStatus, serialized: JSON.stringify(plan) };
      },
    },
    {
      name: "no_changes_needed",
      pass: () => {
        const bundle = path.join(tmp, "npx-bundle");
        fs.mkdirSync(path.join(bundle, "skills", "agentera"), { recursive: true });
        fs.writeFileSync(path.join(bundle, "skills", "agentera", "SKILL.md"), "x");
        fs.writeFileSync(
          path.join(bundle, "registry.json"),
          JSON.stringify({ skills: [{ name: "agentera", version: "3.0.0-dev.1" }] }),
        );
        fs.writeFileSync(
          path.join(bundle, ".agentera-npx-bundle.json"),
          JSON.stringify({ kind: "agentera-npx-bundle", suiteVersion: "3.0.0-dev.1" }),
        );
        const plan = buildUpgradePlan({
          installRoot: bundle,
          home,
          project: bundle,
          channel: "stable",
          dryRun: true,
        });
        return { status: plan.lifecycleStatus, serialized: JSON.stringify(plan) };
      },
    },
  ];

  for (const transition of lifecycleTransitions) {
    it(`emits canonical ${transition.name} lifecycle metadata (pass)`, () => {
      const { status, serialized } = transition.pass();
      if (transition.name === "outdated" || transition.name === "repair_needed" || transition.name === "manual_review_needed") {
        expect(CANONICAL_DOCTOR_STATUSES.has(status)).toBe(true);
        expect(status).toBe(
          transition.name === "outdated"
            ? APP_OUTDATED
            : transition.name === "repair_needed"
              ? APP_REPAIR_NEEDED
              : APP_MANUAL_REVIEW_NEEDED,
        );
      } else {
        expect(CANONICAL_UPGRADE_LIFECYCLE.has(status)).toBe(true);
        expect(status).toBe(
          transition.name === "ready_to_apply" ? STATUS_READY_TO_APPLY : STATUS_NO_CHANGES_NEEDED,
        );
      }
      for (const phrase of FORBIDDEN_REPAIR_PHRASES) {
        expect(serialized).not.toContain(phrase);
      }
    });

    it(`does not emit deprecated status alias for ${transition.name} (fail)`, () => {
      const { status } = transition.pass();
      expect(status).not.toBe(DEPRECATED_STATUS_ALIASES[transition.name]);
    });
  }

  it("cmdDoctor JSON uses the parity envelope shape", () => {
    const { out } = capture((io) => cmdDoctor({ format: "json" }, io));
    const payload = JSON.parse(out);
    expect(payload.command).toBe("doctor");
    for (const key of DOCTOR_PARITY_JSON_KEYS) {
      expect(payload).toHaveProperty(key);
    }
  });
});
