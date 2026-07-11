import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

import {
  LIFECYCLE_AUTHORITY_RELATIVE_PATH,
  buildRuntimeLifecycleState,
  loadLifecycleAuthority,
  validateLifecycleAuthorityData,
  validateLifecycleAuthorityRoot,
} from "../../src/runtime/lifecycleAuthority.js";
import {
  LIFECYCLE_APPLY_STATUSES,
  LIFECYCLE_PLAN_ACTIONS,
  LIFECYCLE_RESOURCE_STATES,
} from "../../src/runtime/lifecycleOperations.js";
import { validateLifecycleOperationContractRoot } from "../../src/runtime/lifecycleOperationContract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const AUTHORITY_PATH = path.join(REPO_ROOT, LIFECYCLE_AUTHORITY_RELATIVE_PATH);

function authorityFixture(): any {
  return YAML.parse(fs.readFileSync(AUTHORITY_PATH, "utf8"));
}

const readyEvidence = {
  host_present: true,
  installed: true,
  enabled: true,
  trusted: true,
} as const;

describe("runtime lifecycle authority", () => {
  it("owns exactly the four Decision 92 active identities", () => {
    const authority = loadLifecycleAuthority(AUTHORITY_PATH);

    expect(authority.runtimes.map((runtime) => runtime.id)).toEqual([
      "opencode",
      "codex",
      "cursor",
      "copilot",
    ]);
    expect(authority.canonicalSkillPath).toBe("~/.agents/skills/agentera");
    expect(authority.runtimes.find((runtime) => runtime.id === "cursor")?.surfaces).toEqual([
      { id: "cli", displayName: "Cursor Agent CLI", presence: "required" },
      { id: "ide", displayName: "Cursor IDE", presence: "conditional" },
    ]);
    expect(validateLifecycleAuthorityRoot(REPO_ROOT)).toEqual([]);
    expect(validateLifecycleOperationContractRoot(REPO_ROOT)).toEqual([]);
    expect(LIFECYCLE_RESOURCE_STATES).toContain("unowned");
    expect(LIFECYCLE_PLAN_ACTIONS).toContain("blocked_unowned");
    expect(LIFECYCLE_APPLY_STATUSES).toContain("skipped_dependency");
  });

  it.each(["claude", "cursor-agent"])(
    "rejects %s as an active identity with an authority location",
    (runtimeId) => {
      const fixture = authorityFixture();
      fixture.active_runtimes[0].id = runtimeId;

      const errors = validateLifecycleAuthorityData(
        fixture,
        "references/adapters/runtime-lifecycle-authority.yaml",
      );

      expect(errors).toContain(
        `references/adapters/runtime-lifecycle-authority.yaml:active_runtimes[0].id: ${runtimeId} cannot be an active runtime identity`,
      );
      expect(errors.some((error) => error.includes("active runtime IDs must be exactly"))).toBe(true);
    },
  );

  it("rejects a second active inventory with its file and line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-lifecycle-authority-"));
    const authorityPath = path.join(root, LIFECYCLE_AUTHORITY_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(authorityPath), { recursive: true });
    fs.copyFileSync(AUTHORITY_PATH, authorityPath);
    const duplicate = path.join(root, "references", "runtime-drift.yaml");
    fs.writeFileSync(duplicate, "schema_version: duplicate\nactive_runtimes:\n  - id: claude\n");

    expect(validateLifecycleAuthorityRoot(root)).toContain(
      "references/runtime-drift.yaml:2: duplicate active runtime inventory; authority is references/adapters/runtime-lifecycle-authority.yaml:active_runtimes",
    );
  });
});

describe("runtime lifecycle state", () => {
  it("keeps Cursor CLI and observed IDE beneath one degraded Cursor identity", () => {
    const authority = loadLifecycleAuthority(AUTHORITY_PATH);
    const state = buildRuntimeLifecycleState(authority, [
      {
        runtimeId: "cursor",
        canonicalSkillDetected: true,
        diagnosisComplete: true,
        surfaces: [
          { id: "cli", evidence: readyEvidence, diagnosisComplete: true },
          {
            id: "ide",
            evidence: { ...readyEvidence, installed: false },
            diagnosisComplete: true,
          },
        ],
      },
    ]);
    const cursor = state.runtimes.find((runtime) => runtime.runtimeId === "cursor");

    expect(state.activeRuntimeIds).toEqual(["opencode", "codex", "cursor", "copilot"]);
    expect(state.runtimes).toHaveLength(4);
    expect(cursor?.surfaces.map((surface) => [surface.id, surface.status])).toEqual([
      ["cli", "ready"],
      ["ide", "degraded"],
    ]);
    expect(cursor?.status).toBe("degraded");
    expect(cursor?.supportFloor).toEqual({ met: true, releaseBlocking: false, unmet: [], violations: [] });
    expect(state.runtimes.some((runtime) => runtime.runtimeId === "cursor-agent")).toBe(false);
  });

  it("does not block or degrade Cursor merely because the conditional IDE is absent", () => {
    const authority = loadLifecycleAuthority(AUTHORITY_PATH);
    const state = buildRuntimeLifecycleState(authority, [
      {
        runtimeId: "cursor",
        canonicalSkillDetected: true,
        diagnosisComplete: true,
        surfaces: [
          { id: "cli", evidence: readyEvidence, diagnosisComplete: true },
          {
            id: "ide",
            evidence: { host_present: false },
            diagnosisComplete: true,
          },
        ],
      },
    ]);
    const cursor = state.runtimes.find((runtime) => runtime.runtimeId === "cursor");

    expect(cursor?.surfaces.find((surface) => surface.id === "ide")?.status).toBe("not_applicable");
    expect(cursor?.status).toBe("ready");
    expect(cursor?.supportFloor.met).toBe(true);
  });

  it.each([
    {
      name: "known false presence",
      evidence: { ...readyEvidence, host_present: false },
      status: "degraded",
      met: true,
      code: null,
    },
    {
      name: "unknown mandatory trust",
      evidence: { ...readyEvidence, trusted: "unknown" as const },
      status: "unknown",
      met: false,
      code: "mandatory_evidence_unknown",
    },
    {
      name: "denied mandatory trust",
      evidence: { ...readyEvidence, trusted: "denied" as const },
      status: "blocked",
      met: false,
      code: "mandatory_trust_denied",
    },
    {
      name: "false mandatory trust",
      evidence: { ...readyEvidence, trusted: false },
      status: "blocked",
      met: false,
      code: "mandatory_trust_denied",
    },
    {
      name: "not_applicable mandatory trust",
      evidence: { ...readyEvidence, trusted: "not_applicable" as const },
      status: "blocked",
      met: false,
      code: "mandatory_evidence_not_applicable",
    },
  ])("applies the support-floor truth table for $name", ({ evidence, status, met, code }) => {
    const authority = loadLifecycleAuthority(AUTHORITY_PATH);
    const state = buildRuntimeLifecycleState(authority, [{
      runtimeId: "codex",
      canonicalSkillDetected: true,
      diagnosisComplete: true,
      surfaces: [{ id: "cli", evidence, diagnosisComplete: true }],
    }]);
    const codex = state.runtimes.find((runtime) => runtime.runtimeId === "codex")!;

    expect(codex.surfaces[0].status).toBe(status);
    expect(codex.supportFloor.met).toBe(met);
    expect(codex.supportFloor.releaseBlocking).toBe(!met);
    if (code) expect(codex.supportFloor.violations).toContainEqual(expect.objectContaining({ code }));
    else expect(codex.supportFloor.violations).toEqual([]);
  });

  it("does not promote an unobserved conditional surface into the mandatory floor", () => {
    const authority = loadLifecycleAuthority(AUTHORITY_PATH);
    const state = buildRuntimeLifecycleState(authority, [{
      runtimeId: "cursor",
      canonicalSkillDetected: true,
      diagnosisComplete: true,
      surfaces: [
        { id: "cli", evidence: readyEvidence, diagnosisComplete: true },
        {
          id: "ide",
          evidence: {
            host_present: "unknown",
            installed: "not_applicable",
            enabled: "not_applicable",
            trusted: "not_applicable",
          },
          diagnosisComplete: true,
        },
      ],
    }]);
    const cursor = state.runtimes.find((runtime) => runtime.runtimeId === "cursor")!;

    expect(cursor.surfaces.find((surface) => surface.id === "ide")).toMatchObject({
      expected: false,
      status: "not_applicable",
      releaseBlocking: false,
    });
    expect(cursor.supportFloor.met).toBe(true);
  });

  it("blocks release when canonical skill or mandatory diagnosis fields are unmet", () => {
    const authority = loadLifecycleAuthority(AUTHORITY_PATH);
    const state = buildRuntimeLifecycleState(authority, [
      {
        runtimeId: "cursor",
        canonicalSkillDetected: "unknown",
        diagnosisComplete: true,
        surfaces: [
          {
            id: "cli",
            evidence: {
              host_present: true,
              installed: true,
              enabled: true,
            },
            diagnosisComplete: true,
          },
        ],
      },
    ]);
    const cursor = state.runtimes.find((runtime) => runtime.runtimeId === "cursor");

    expect(cursor?.status).toBe("blocked");
    expect(cursor?.supportFloor.releaseBlocking).toBe(true);
    expect(cursor?.supportFloor.unmet).toEqual(
      expect.arrayContaining([
        "canonical_skill_unknown",
        "mandatory_evidence_missing:cli:trusted",
        "diagnosis_incomplete:cli",
      ]),
    );
    expect(cursor?.surfaces.find((surface) => surface.id === "cli")).toMatchObject({
      status: "unknown",
      releaseBlocking: true,
    });
  });

  it.each(["claude", "cursor-agent"])("rejects %s observations as active identities", (runtimeId) => {
    const authority = loadLifecycleAuthority(AUTHORITY_PATH);
    expect(() => buildRuntimeLifecycleState(authority, [{ runtimeId }])).toThrow(
      `unknown active runtime observation ${runtimeId}`,
    );
  });

  it("rejects duplicate Cursor surface observations that could conceal degradation", () => {
    const authority = loadLifecycleAuthority(AUTHORITY_PATH);
    expect(() =>
      buildRuntimeLifecycleState(authority, [
        {
          runtimeId: "cursor",
          surfaces: [
            { id: "ide", evidence: readyEvidence, diagnosisComplete: true },
            {
              id: "ide",
              evidence: { ...readyEvidence, installed: false },
              diagnosisComplete: true,
            },
          ],
        },
      ]),
    ).toThrow("cursor: duplicate lifecycle observations for surface ide");
  });
});
