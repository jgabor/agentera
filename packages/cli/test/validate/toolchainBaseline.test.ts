import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../../..");
const baseline = YAML.parse(
  fs.readFileSync(path.join(ROOT, "references/analysis/toolchain-baseline.yaml"), "utf8"),
);

function validate(contract: typeof baseline): string[] {
  const errors: string[] = [];
  if (contract.selection.vite_plus.version !== "0.3.0") errors.push("Vite+ must stay exact");
  if (contract.selection.setup_vp.action_commit.length !== 40) errors.push("setup-vp must use a full SHA");
  if (contract.project_contract.package_manager !== "pnpm@10.30.3") errors.push("pnpm pin drifted");
  if (!contract.project_contract.frozen_install_args.includes("--frozen-lockfile")) errors.push("frozen install missing");
  if (contract.project_contract.dependency_script_policy.allow_only.join(",") !== "esbuild") errors.push("script allowlist drifted");
  if (contract.selection.setup_vp.conclusion !== "rejected for Agentera's exact setup boundary") errors.push("unsafe setup accepted");
  return errors;
}

describe("toolchain baseline", () => {
  it("retains the selected candidate and blocked setup boundary", () => {
    expect(validate(baseline)).toEqual([]);
  });

  it.each([
    ["pnpm pin", (value: any) => (value.project_contract.package_manager = "pnpm@latest")],
    ["frozen install", (value: any) => (value.project_contract.frozen_install_args = [])],
    ["script allowlist", (value: any) => value.project_contract.dependency_script_policy.allow_only.push("*")],
    ["unsafe setup", (value: any) => (value.selection.setup_vp.conclusion = "accepted")],
  ])("rejects %s drift", (_name, mutate) => {
    const changed = structuredClone(baseline);
    mutate(changed);
    expect(validate(changed)).not.toEqual([]);
  });
});
