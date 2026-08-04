import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertPreCutoverCommand,
  preCutoverCommand,
  preCutoverCommandFromBare,
  preCutoverInstructionBody,
} from "../../src/cli/preCutoverCommand.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("pre-cutover v3 command authority", () => {
  it("binds bootstrap and recovery commands to the development dist-tag", () => {
    expect(preCutoverCommand("prime --context status --format json"))
      .toBe("npx -y agentera@next prime --context status --format json");
    expect(preCutoverCommandFromBare("agentera doctor --format json"))
      .toBe("npx -y agentera@next doctor --format json");
  });

  it("binds every executable in a complete served instruction body", () => {
    const body = [
      "Start with `agentera prime --context build --format json`.",
      "Recover with `agentera doctor --format json`.",
      "Then run `agentera state progress list --format json`.",
    ].join("\n");
    const bound = preCutoverInstructionBody(body);
    expect(bound.match(/npx -y agentera@next/g)).toHaveLength(3);
    expect(bound).not.toMatch(/(?<![\w@-])agentera (?:prime|doctor|state)\b/);
  });

  it.each([
    "Run npx -y agentera@latest prime --context build --format json.",
    "Run npx agentera prime --context build --format json.",
  ])("rejects a complete instruction body that selects a wrong channel: %s", (body) => {
    expect(() => preCutoverInstructionBody(body)).toThrow(/bare or stable/);
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
