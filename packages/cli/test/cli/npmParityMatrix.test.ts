import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const ORACLE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures/oracle/npm-cli-surface.json"), "utf8"),
) as {
  commands: Record<
    string,
    {
      argv: string[];
      exitCode: number;
      requiredKeys: string[];
      commandValue?: string;
      forbiddenSubstrings?: string[];
    }
  >;
};

function capture(fn: (io: { out: (t: string) => void; err: (t: string) => void }) => number): {
  rc: number;
  out: string;
  err: string;
} {
  let out = "";
  let err = "";
  const rc = fn({ out: (t) => (out += t), err: (t) => (err += t) });
  return { rc, out, err };
}

let prevProfilera: string | undefined;
let tmpProfile: string;

beforeEach(() => {
  tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "npm-parity-profile-"));
  prevProfilera = process.env.PROFILERA_PROFILE_DIR;
  process.env.PROFILERA_PROFILE_DIR = tmpProfile;
});

afterEach(() => {
  if (prevProfilera === undefined) delete process.env.PROFILERA_PROFILE_DIR;
  else process.env.PROFILERA_PROFILE_DIR = prevProfilera;
  fs.rmSync(tmpProfile, { recursive: true, force: true });
});

describe("npm CLI parity matrix (Python oracle envelopes)", () => {
  for (const [name, spec] of Object.entries(ORACLE.commands)) {
    it(`matches oracle envelope for ${name}`, () => {
      const { rc, out } = capture((io) => main(["node", "agentera", ...spec.argv], io));
      expect(rc).toBe(spec.exitCode);
      const payload = JSON.parse(out);
      for (const key of spec.requiredKeys) {
        expect(payload).toHaveProperty(key);
      }
      if (spec.commandValue !== undefined) {
        expect(payload.command).toBe(spec.commandValue);
      }
      if (name === "upgrade_development_dry_run") {
        expect(payload.channel.channel).toBe("development");
      }
      const serialized = JSON.stringify(payload);
      for (const forbidden of spec.forbiddenSubstrings ?? []) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  }

  it("does not treat uvx git feat/v3 as a development channel resolution", () => {
    const { out } = capture((io) =>
      main(["node", "agentera", "upgrade", "--channel", "development", "--dry-run", "--format", "json"], io),
    );
    const payload = JSON.parse(out);
    const planText = JSON.stringify(payload);
    expect(planText).not.toMatch(/uvx.*@feat\/v3/);
    expect(planText).not.toMatch(/git\+https:\/\/github\.com\/jgabor\/agentera@feat\/v3/);
  });

  it("runs from repo checkout with cwd at repository root", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "skills", "agentera", "SKILL.md"))).toBe(true);
  });
});
