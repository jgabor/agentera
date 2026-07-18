import os from "node:os";

import { expanduser, resolvePath } from "../../core/paths.js";
import { resolveDoctorInstallRoot, resolveSourceRootStrict } from "../../upgrade/appModel.js";
import { APP_UP_TO_DATE, buildDoctorStatus } from "../../upgrade/doctor.js";
import { CAPABILITY_INSTRUCTIONS } from "../../capabilities/index.js";
import { buildPrimeCapabilityContextPayload } from "../capabilityContext.js";
import { collectOrientationState } from "./prime/collectOrientationState.js";
import { cmdPrime } from "./prime.js";
import type { JsonObject } from "../../core/jsonValue.js";
import { validateStatePayload } from "./validate.js";

export interface VerifyCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyResult {
  passed: boolean;
  checks: VerifyCheck[];
}

export interface VerifyContext {
  installRoot?: string | null;
  home?: string | null;
  project?: string | null;
  expectedVersion?: string | null;
}

export interface OneWayUpgradeVerification {
  state_validation: { status: "passed" | "failed"; entity_count: number; issue_count: number };
  startup_validation: { status: "passed" | "failed" };
}

function inProject<T>(project: string, action: () => T): T {
  const previous = process.cwd();
  process.chdir(project);
  try {
    return action();
  } finally {
    process.chdir(previous);
  }
}

/** Mandatory read-only checks for an activated v2-to-v3 project. */
export function verifyOneWayUpgrade(ctx: VerifyContext): OneWayUpgradeVerification {
  const project = resolvePath(expanduser(ctx.project ?? process.cwd()));
  let stateValidation: OneWayUpgradeVerification["state_validation"];
  try {
    const state = validateStatePayload(project);
    stateValidation = {
      status: state.valid === true ? "passed" : "failed",
      entity_count: Number(state.entity_count),
      issue_count: Number(state.issue_count),
    };
  } catch {
    stateValidation = { status: "failed", entity_count: 0, issue_count: 1 };
  }

  let startupPassed = false;
  try {
    startupPassed = inProject(project, () => cmdPrime({
      context: "status",
      format: "json",
      home: resolvePath(expanduser(ctx.home ?? os.homedir())),
      installRoot: ctx.installRoot ?? null,
      expectedVersion: ctx.expectedVersion ?? null,
    }, { out: () => {}, err: () => {} })) === 0;
  } catch {
    startupPassed = false;
  }

  return {
    state_validation: stateValidation,
    startup_validation: { status: startupPassed ? "passed" : "failed" },
  };
}

export function verifyUpgrade(ctx: VerifyContext): VerifyResult {
  const sourceRoot = resolveSourceRootStrict();
  const home = resolvePath(expanduser(ctx.home ?? os.homedir()));
  const project = resolvePath(expanduser(ctx.project ?? process.cwd()));
  const [installRoot, rootSource] = resolveDoctorInstallRoot(ctx.installRoot ?? null, {
    home,
    sourceRoot,
  });

  const checks: VerifyCheck[] = [];

  const status = buildDoctorStatus(installRoot, {
    rootSource,
    sourceRoot,
    home,
    project,
    expectedVersion: ctx.expectedVersion ?? null,
  });
  const doctorOk = status.status === APP_UP_TO_DATE && status.signals.length === 0;
  checks.push({
    name: "doctor",
    passed: doctorOk,
    detail: `status=${status.status}; signals=${status.signals.length}`,
  });

  const state = collectOrientationState({
    home,
    installRoot,
    expectedVersion: ctx.expectedVersion ?? null,
  });

  for (const capability of Object.keys(CAPABILITY_INSTRUCTIONS)) {
    const payload = buildPrimeCapabilityContextPayload(state, capability, "prime");
    const capabilityContext = payload.capability_context as JsonObject | undefined;
    const stateBlock = capabilityContext?.state as JsonObject | undefined;
    const schemaError = stateBlock?.schema_error ?? null;
    const passed = schemaError === null;
    checks.push({
      name: `prime --context ${capability}`,
      passed,
      detail: passed ? "schema_error: null" : `schema_error: ${String(schemaError)}`,
    });
  }

  return { passed: checks.every((c) => c.passed), checks };
}

export function renderVerifySummary(result: VerifyResult, json: boolean): string {
  if (json) {
    return (
      JSON.stringify(
        {
          command: "upgrade --verify",
          status: result.passed ? "passed" : "failed",
          checks: result.checks,
        },
        null,
        2,
      ) + "\n"
    );
  }
  const lines = [
    "Agentera verify",
    `status: ${result.passed ? "passed" : "failed"}`,
    "checks:",
  ];
  for (const check of result.checks) {
    lines.push(`  - ${check.name}: ${check.passed ? "passed" : "failed"}  (${check.detail})`);
  }
  return lines.join("\n") + "\n";
}
