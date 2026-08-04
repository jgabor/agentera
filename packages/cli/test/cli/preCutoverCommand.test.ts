import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertPreCutoverCommand,
  preCutoverCommand,
  preCutoverCommandFromBare,
} from "../../src/cli/preCutoverCommand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("pre-cutover v3 command authority", () => {
  it("binds bootstrap and recovery commands to the development dist-tag", () => {
    expect(preCutoverCommand("prime --context status --format json"))
      .toBe("npx -y agentera@next prime --context status --format json");
    expect(preCutoverCommandFromBare("agentera doctor --format json"))
      .toBe("npx -y agentera@next doctor --format json");
  });

  it.each([
    "agentera prime --context status --format json",
    "npx -y agentera@latest prime --context status --format json",
  ])("rejects the wrong pre-cutover channel: %s", (command) => {
    expect(() => assertPreCutoverCommand(command)).toThrow(/must use npx -y agentera@next/);
  });

  it("keeps active bootstrap, routing, and recovery authorities free of bare executable commands", () => {
    for (const relative of [
      "README.md",
      "packages/cli/README.md",
      "skills/agentera/SKILL.md",
      "references/cli/hybrid-route-contract.yaml",
      "references/cli/capability-instruction-contract.yaml",
      "references/cli/routing-model.md",
      "references/cli/vocabulary.md",
    ]) {
      const content = fs.readFileSync(path.join(ROOT, relative), "utf8");
      expect(content, relative).not.toMatch(/(^|[^@\w])agentera (?:prime --context|route (?:request|receipt))/m);
    }
  });
});
