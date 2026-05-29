import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  lifecycleMain,
  validateCodex,
  validateCopilot,
  validateHardGateDocs,
  validateOpencode,
} from "../../src/validate/lifecycleAdapters.js";
import { loadRegistry } from "../../src/registries/runtimeAdapterRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

describe("lifecycle adapter validation (real repo)", () => {
  it("reports the live runtime manifests + hard-gate docs as ok", () => {
    const lines: string[] = [];
    const code = lifecycleMain({ root: REPO_ROOT, out: (l) => lines.push(l) });
    expect(code, lines.join("\n")).toBe(0);
    expect(lines).toContain("lifecycle adapter metadata ok");
  });

  it("the live plugin/manifest validators return no errors", () => {
    const reg = loadRegistry(path.join(REPO_ROOT, "references/adapters/runtime-adapter-registry.yaml"));
    expect(validateHardGateDocs(REPO_ROOT, reg)).toEqual([]);
    expect(validateOpencode(REPO_ROOT, reg)).toEqual([]);
  });
});

describe("lifecycle adapter validators (negative)", () => {
  const reg = loadRegistry(path.join(REPO_ROOT, "references/adapters/runtime-adapter-registry.yaml"));

  it("flags copilot lifecycleHooks misuse and missing corpus description", () => {
    const errors = validateCopilot({ lifecycleHooks: {}, skills: "skills", hooks: "hooks" }, REPO_ROOT, reg);
    expect(errors).toContain("copilot: use supported hooks component field, not lifecycleHooks");
    expect(errors.some((e) => e.includes("description must expose bounded corpus metadata limits"))).toBe(true);
  });

  it("flags missing codex lifecycleHooks metadata", () => {
    expect(validateCodex({}, reg)).toEqual(["codex: missing lifecycleHooks limitation metadata"]);
  });
});
