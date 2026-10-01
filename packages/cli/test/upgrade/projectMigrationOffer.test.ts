import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { projectMigrationOffer, PROJECT_MIGRATION_APPROVAL } from "../../src/upgrade/projectMigrationOffer.js";
import { cmdUpgrade } from "../../src/cli/commands/upgrade.js";
import { gitCommitArgs } from "../helpers/git.js";
import { prepareEntityCutoverForUpgrade } from "../../src/state/entityCutover.js";
import { buildUpgradePlan, validateUpgradeApply } from "../../src/upgrade/upgradeOrchestrator.js";
import { classifyEntityCutoverProject } from "../../src/state/entityMigrationPreview.js";

const roots: string[] = [];
const authorizationOf = (offer: NonNullable<ReturnType<typeof projectMigrationOffer>>): string => offer.apply_command.match(/--authorization (project-migration:[a-f0-9]{64})/)![1];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-project-migration-offer-"));
  roots.push(root);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-project-migration-home-"));
  roots.push(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("AGENTERA_PROFILE", path.join(home, "missing-profile"));
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  fs.cpSync(path.join(import.meta.dirname, "fixtures/v2-yaml-project"), root, { recursive: true });
  for (const args of [["init", "--quiet"], ["add", "."], gitCommitArgs("--quiet", "-m", "synthetic v2 state")]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  }
  return root;
}
function apply(project: string, authorization: string, extra = {}) {
  let out = "",
    err = "";
  const code = cmdUpgrade(
    { project, channel: "development", yes: true, authorization, format: "json", ...extra },
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
  );
  return { code, out, err };
}
it("offers complete read-only scope, applies under one approval and verifies a retry", () => {
  const project = fixture();
  expect(classifyEntityCutoverProject(project)).toBe("legacy");
  expect(() => prepareEntityCutoverForUpgrade(project, path.resolve(import.meta.dirname, "../../../.."))).not.toThrow();
  const preview = buildUpgradePlan({ project, channel: "development", dryRun: true });
  expect(validateUpgradeApply({ project, channel: "development", yes: true }, preview)).toBeNull();
  expect(preview.summary.blocked, JSON.stringify(preview.phases)).toBe(0);
  const offer = projectMigrationOffer({ project, channel: "development", dryRun: true });
  expect(offer).not.toBeNull();
  expect(offer!.warning).toContain("return to v2");
  expect(offer!.apply_command).toContain(authorizationOf(offer!));
  expect(fs.existsSync(path.join(project, PROJECT_MIGRATION_APPROVAL))).toBe(false);
  const result = apply(project, authorizationOf(offer!));
  expect(result.code, result.err).toBe(0);
  expect(JSON.parse(result.out).status).toBe("success");
  const retry = apply(project, authorizationOf(offer!));
  expect(retry.code, retry.err).toBe(0);
  expect(JSON.parse(retry.out).status).toBe("success");
  expect(projectMigrationOffer({ project, channel: "development" })).toBeNull();
});
it("refuses source and scope drift before new project effects", () => {
  const project = fixture();
  const offer = projectMigrationOffer({ project, channel: "development" })!;
  fs.appendFileSync(path.join(project, ".agentera/progress.yaml"), "\n# owner change\n");
  const result = apply(project, authorizationOf(offer));
  expect(result.code).not.toBe(0);
  expect(fs.existsSync(path.join(project, PROJECT_MIGRATION_APPROVAL))).toBe(false);
  expect(fs.existsSync(path.join(project, ".agentera/state-mode.yaml"))).toBe(false);
  expect(apply(project, authorizationOf(offer), { force: true }).code).not.toBe(0);
});
it("does not claim completion when mandatory post-apply verification fails", () => {
  const project = fixture();
  const offer = projectMigrationOffer({ project, channel: "development" })!;
  let out = "",
    err = "";
  const code = cmdUpgrade(
    {
      project,
      channel: "development",
      yes: true,
      authorization: authorizationOf(offer),
      format: "json",
    },
    {
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
    },
    {
      verifyOneWayUpgrade: () => ({
        state_validation: { status: "failed", entity_count: 0, issue_count: 1 },
        startup_validation: { status: "failed" },
      }),
    },
  );
  expect(code).toBe(1);
  expect(JSON.parse(out).status).toBe("failed");
  expect(fs.existsSync(path.join(project, ".agentera/state-mode.yaml"))).toBe(true);
  expect(err).toContain("continue forward");
  expect(apply(project, authorizationOf(offer)).code).toBe(0);
});
