import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { validate } from "../../src/validate/appHomeContract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ahc-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("app-home contract validator (text surfaces)", () => {
  it("passes the current repository text surfaces", () => {
    // Text-surface scan only; CLI-surface scanning is wired in Phase 7.
    expect(validate(REPO_ROOT)).toEqual([]);
  });

  it("reports an offending surface and line", () => {
    fs.writeFileSync(path.join(tmp, "README.md"), "AGENTERA_HOME points at the live bundle root\n");
    const errors = validate(tmp);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("README.md:1"))).toBe(true);
    expect(errors.some((e) => e.includes("live-bundle wording"))).toBe(true);
  });

  it("rejects recovery jargon", () => {
    fs.writeFileSync(
      path.join(tmp, "README.md"),
      "Agentera-managed bundle install is blocked; use the platform app-home recovery path\n",
    );
    const errors = validate(tmp);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes("README.md:1"))).toBe(true);
    expect(errors.some((e) => e.includes("jargon in recovery wording"))).toBe(true);
  });

  it("inspects the authoritative contract reference", () => {
    const contract = path.join(tmp, "skills", "agentera", "references", "contract.md");
    fs.mkdirSync(path.dirname(contract), { recursive: true });
    fs.writeFileSync(contract, "AGENTERA_HOME names the agentera install root where helper scripts live\n");
    const errors = validate(tmp);
    expect(errors.some((e) => e.includes("skills/agentera/references/contract.md:1"))).toBe(true);
    expect(errors.some((e) => e.includes("AGENTERA_HOME named as install root"))).toBe(true);
  });
});
