import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, inject, it } from "vitest";
import { runSharedSkillUpgradeWorkflow } from "../helpers/sharedSkillUpgradeWorkflow.js";

const fixture = inject("packageFixture");
it("runs the complete one-confirmation legacy link-chain workflow from the extracted package outside the checkout", () => {
  const root = path.join(fixture.root, "shared-skill-upgrade-chain");
  const current = fs.readFileSync(path.join(fixture.packageRoot, "bundle/host/agentera/SKILL.md"), "utf8");
  const result = runSharedSkillUpgradeWorkflow(root, current, (args, scope) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AGENTERA_") && !key.startsWith("PROFILERA_")));
    Object.assign(env, {
      HOME: scope.home,
      XDG_DATA_HOME: path.join(scope.home, ".local/share"),
      XDG_CONFIG_HOME: path.join(scope.home, ".config"),
      XDG_CACHE_HOME: path.join(scope.home, ".cache"),
    });
    const child = spawnSync(process.execPath, [path.join(fixture.packageRoot, "dist/bin/agentera.js"), ...args], { cwd: scope.project, env, encoding: "utf8", timeout: 30000 });
    return { code: child.status, out: child.stdout, err: child.stderr };
  });
  expect(result.result).toBe("pass");
});
