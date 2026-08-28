import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AcquiredGlossaryInputs } from "../../src/analytics/glossaryInputAcquisition.js";
import { resolveStartupGlossaryAdvice } from "../../src/cli/capabilityContext/startupGlossaryAdvice.js";
import { loadSelectedTermInput, SelectedTermInputError } from "../../src/cli/commands/prime/selectedTermInput.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "startup-glossary-advice-"));
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("selected term startup input", () => {
  it("loads one UTF-8 scalar without transformation", () => {
    const input = path.join(tmp, "term");
    fs.writeFileSync(input, "bounded term");
    expect(loadSelectedTermInput(input, undefined)).toBe("bounded term");
  });

  it("rejects malformed UTF-8 without exposing its bytes", () => {
    const input = path.join(tmp, "term");
    fs.writeFileSync(input, Buffer.from([0xc3, 0x28]));
    expect(() => loadSelectedTermInput(input, undefined)).toThrow(SelectedTermInputError);
  });
});

describe("startup glossary advice composition", () => {
  const acquired: AcquiredGlossaryInputs = {
    project: {
      owner: "project",
      availability: "valid_present",
      entries: [{ term: "bounded term", meaning: "project meaning", owner: "project" }],
      gap_proving: false,
      diagnostic: null,
    },
    personal: { owner: "personal", availability: "absent", entries: [], gap_proving: false, diagnostic: null },
  };

  it("returns the shared no-review resolver outcome", () => {
    expect(resolveStartupGlossaryAdvice("plan", "bounded term", acquired)).toMatchObject({
      outcome: "project_only",
      applicable_meaning: "project meaning",
      applicable_owner: "project",
    });
  });

  it("rejects capabilities outside Discuss, Plan, and Build", () => {
    expect(() => resolveStartupGlossaryAdvice("audit", "bounded term", acquired)).toThrow(
      "unsupported startup advice capability",
    );
  });
});
