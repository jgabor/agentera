import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { evaluateFixture } from "../../src/eval/semanticEval.js";
import { loadFixture, type SemanticFixture } from "../../src/eval/semanticFixtures.js";

const ROOT = path.resolve(import.meta.dirname, "../../../..");

const cases = [
  ["initial terminology startup", "initial-terminology-startup.md", "report glossary-advice"],
  ["normal Plan publication", "plan-normal-publication.md", "--dry-run"],
  ["explicit Plan preview", "plan-explicit-preview.md", "/tmp/approved-plan-copy.yaml"],
] as const;

function validFixture(fixturePath: string): SemanticFixture {
  const [fixture, errors] = loadFixture(fixturePath);
  expect(errors).toEqual([]);
  expect(fixture).not.toBeNull();
  return fixture!;
}

describe.each(cases)("host workflow fixture: %s", (_name, filename, forbidden) => {
  const fixturePath = path.join(ROOT, "fixtures/semantic", filename);

  it("records the contracted command workflow", () => {
    expect(evaluateFixture(validFixture(fixturePath), filename).status).toBe("pass");
  });

  it("fails when the forbidden workflow is recorded", () => {
    const text = fs.readFileSync(fixturePath, "utf8").replace('"calls":[', `"calls":["${forbidden}",`);
    const temporary = path.join(ROOT, "fixtures/semantic", `.invalid-${filename}`);
    fs.writeFileSync(temporary, text);
    try {
      expect(evaluateFixture(validFixture(temporary), filename).status).toBe("fail");
    } finally {
      fs.rmSync(temporary);
    }
  });
});
