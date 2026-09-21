import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { main } from "../../src/cli/dispatch.js";
import { loadHostSkillSource } from "../../src/setup/hostSkillLifecycle.js";
import { runSharedSkillUpgradeWorkflow } from "../helpers/sharedSkillUpgradeWorkflow.js";

it("upgrades the original OpenCode/canonical/legacy chain with one approval and no historical journal", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-upgrade-chain-"));
  const repo = path.resolve(import.meta.dirname, "../../../..");
  const before = process.cwd();
  try {
    const result = runSharedSkillUpgradeWorkflow(root, loadHostSkillSource(repo).content, (args, scope) => {
      process.chdir(scope.project);
      vi.stubEnv("HOME", scope.home);
      vi.stubEnv("AGENTERA_HOME", scope.app);
      vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", repo);
      vi.stubEnv("AGENTERA_PROFILE_DIR", path.join(root, "profile"));
      vi.stubEnv("PROFILERA_PROFILE_DIR", path.join(root, "profile"));
      let out = "",
        err = "";
      const code = main(["node", "agentera", ...args], {
        out: (text) => (out += text),
        err: (text) => (err += text),
      });
      return { code, out, err };
    });
    expect(result.result).toBe("pass");
  } finally {
    process.chdir(before);
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
