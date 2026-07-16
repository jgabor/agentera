import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CAPABILITY_NAMES } from "../../src/cli/capabilityContext/types.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const SOURCE_ROOT = path.join(REPO_ROOT, "skills/agentera/agents");
const BUNDLE_ROOT = path.join(REPO_ROOT, "packages/cli/bundle/skills/agentera/agents");

function descriptorNames(root: string): string[] {
  return fs.readdirSync(root).filter((name) => name.endsWith(".toml")).sort();
}

describe("shipped capability descriptor vocabulary", () => {
  it("uses capability_context.instructions in every source and bundled descriptor", () => {
    const expected = [...CAPABILITY_NAMES].sort().map((name) => `${name}.toml`);
    const sourceNames = descriptorNames(SOURCE_ROOT);
    const bundleNames = descriptorNames(BUNDLE_ROOT);

    expect(sourceNames).toEqual(expected);
    expect(bundleNames).toEqual(expected);

    for (const name of expected) {
      const source = fs.readFileSync(path.join(SOURCE_ROOT, name), "utf8");
      const bundled = fs.readFileSync(path.join(BUNDLE_ROOT, name), "utf8");
      expect(source, `${name} source descriptor`).toContain("capability_context.instructions");
      expect(source, `${name} source descriptor`).not.toMatch(/\bprose\b/);
      expect(bundled, `${name} bundle descriptor`).toBe(source);
    }
  });
});
