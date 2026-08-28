import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import buildInstructions from "../../../src/capabilities/build/instructions.js";
import discussInstructions from "../../../src/capabilities/discuss/instructions.js";
import planInstructions from "../../../src/capabilities/plan/instructions.js";
import { main } from "../../../src/cli/dispatch.js";

const sources = {
  discuss: discussInstructions,
  plan: planInstructions,
  build: buildInstructions,
};

function served(capability: keyof typeof sources): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentera-${capability}-contract-`));
  const previous = process.cwd();
  let output = "";
  try {
    fs.mkdirSync(path.join(root, ".agentera"));
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    process.chdir(root);
    const rc = main(
      ["node", "agentera", "prime", "--context", capability, "--format", "json"],
      { out: (text) => { output += text; }, err: (text) => { output += text; }, stdin: () => "" },
    );
    expect(rc, output).toBe(0);
    return (JSON.parse(output) as Record<string, any>).capability_context.instructions as string;
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function adviceViolations(capability: keyof typeof sources, text: string): string[] {
  const required = [
    `prime --context ${capability} --term-input <file|-> --format json`,
    "capability_context.glossary_advice",
    "report glossary-advice --term-input <file|-> --format json",
    "report glossary-advice --input <file|-> --format json",
    "do not issue a second initial glossary report",
  ];
  return required.filter((value) => !text.includes(value));
}

describe("capability advice and plan publication contracts", () => {
  it("keeps source and served consumers on one startup and distinct later advice routes", () => {
    for (const capability of Object.keys(sources) as Array<keyof typeof sources>) {
      for (const text of [sources[capability], served(capability)]) {
        expect(adviceViolations(capability, text), capability).toEqual([]);
        expect(
          adviceViolations(capability, text.replace(" --term-input <file|->", " --input <file|->")),
          `${capability} stale startup route`,
        ).toContain(`prime --context ${capability} --term-input <file|-> --format json`);
      }
    }
  });

  it("keeps unchanged, rendered, tool, and control-only events off both refresh routes", () => {
    for (const [capability, source] of Object.entries(sources)) {
      const text = `${source}\n${served(capability as keyof typeof sources)}`;
      expect(text).toMatch(/unchanged replay/);
      expect(text).toMatch(/rendering|artifact rendering/);
      expect(text).toContain("tool output");
      expect(text).toMatch(/control-only|Done-only control/);
      expect(text.replace(/control-only|Done-only control/g, "ordinary continuation")).not.toMatch(/control-only|Done-only control/);
    }
  });

  it("publishes normally once and reuses one explicit-preview input", () => {
    for (const text of [planInstructions, served("plan")]) {
      expect(text).toMatch(/exactly one `(?:agentera|npx -y agentera@next) state plan create --input PATH --format json` call/);
      expect(text).toContain("do not run standalone lint or dry-run first on the normal path");
      expect(text).toContain("run the same create command with `--dry-run`");
      expect(text).toContain("referencing that unchanged PATH without reserializing its content");
      const stale = text.replace("that unchanged PATH without reserializing its content", "newly serialized content");
      expect(stale).not.toContain("referencing that unchanged PATH without reserializing its content");
    }
  });
});
