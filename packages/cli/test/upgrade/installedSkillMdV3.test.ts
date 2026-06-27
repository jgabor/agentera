import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";

import { cmdPrime } from "../../src/cli/commands/prime.js";
import { applyAppContentRefresh, skillMdLooksV2 } from "../../src/upgrade/appContentRefresh.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const REPO_SKILL = path.join(REPO_ROOT, "skills", "agentera", "SKILL.md");

/** v2 Swedish capability IDs (defect #4); kept in sync with appContentRefresh.ts V2_CAPABILITY_VERBS. */
const V2_SWEDISH_CAPABILITY_VERBS = [
  "hej",
  "visionera",
  "resonera",
  "inspirera",
  "planera",
  "realisera",
  "optimera",
  "inspektera",
  "dokumentera",
  "profilera",
  "visualisera",
  "orkestrera",
] as const;

const V3_ENGLISH_CAPABILITIES = [
  "status",
  "vision",
  "discuss",
  "research",
  "plan",
  "build",
  "optimize",
  "audit",
  "document",
  "profile",
  "design",
  "orchestrate",
] as const;

function seedV2SkillMd(appHome: string): void {
  const skillPath = path.join(appHome, "skills", "agentera", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(
    skillPath,
    [
      "---",
      "name: agentera",
      "capabilities:",
      "  - planera",
      "  - inspektera",
      "---",
      "",
      "# hej",
      "",
      "Route /agentera planera to the planera capability.",
      "Read capabilities/plan/instructions.md for prose.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function assertV3EnglishSkillMd(text: string, label: string): void {
  expect(skillMdLooksV2(text), `${label}: must not look like v2 Swedish routing`).toBe(false);
  for (const cap of V3_ENGLISH_CAPABILITIES) {
    expect(text, `${label}: frontmatter lists English capability ${cap}`).toMatch(
      new RegExp(`^\\s+- ${cap}\\s*$`, "m"),
    );
  }
  for (const verb of V2_SWEDISH_CAPABILITY_VERBS) {
    expect(text, `${label}: must not route /agentera ${verb}`).not.toMatch(
      new RegExp(`/agentera ${verb}\\b`),
    );
  }
}

function capturePrime(context: string, env: Record<string, string>): { rc: number; out: string; err: string } {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    process.env[key] = env[key];
  }
  let out = "";
  let err = "";
  let rc = 1;
  try {
    rc = cmdPrime(
      { command: "prime", context, format: "json" },
      {
        out: (chunk: string) => {
          out += chunk;
        },
        err: (chunk: string) => {
          err += chunk;
        },
      },
    );
    return { rc, out, err };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("installed SKILL.md v3 English routing (B6-2, defect #4)", () => {
  describe("repo source invariant (D70)", () => {
    it("routes English capability names and exposes no Swedish /agentera routes", () => {
      const text = fs.readFileSync(REPO_SKILL, "utf8");
      assertV3EnglishSkillMd(text, "repo SKILL.md");
      expect(text).toContain("packages/cli/src/capabilities");
      expect(text).toContain("/agentera plan");
      expect(text).not.toContain("/agentera planera");
    });
  });

  describe("upgrade refresh into managed app home", () => {
    let tmp: string;
    let appHome: string;
    let home: string;

    beforeAll(() => {
      const result = spawnSync("pnpm", ["-C", "packages/cli", "build"], {
        cwd: REPO_ROOT,
        stdio: "pipe",
        encoding: "utf8",
      });
      if (result.status !== 0) {
        throw new Error(`pre-test cli build failed: ${result.stderr ?? result.stdout}`);
      }
    });

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "installed-skill-md-v3-"));
      home = path.join(tmp, "home");
      appHome = path.join(tmp, "app-home");
      fs.mkdirSync(home, { recursive: true });
      seedV2SkillMd(appHome);
    });

    afterEach(() => {
      delete process.env.AGENTERA_HOME;
      delete process.env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
      delete process.env.HOME;
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("copies repo SKILL.md byte-identically with no Swedish routing verbs", () => {
      applyAppContentRefresh(appHome, REPO_ROOT);

      const installedSkill = path.join(appHome, "skills", "agentera", "SKILL.md");
      const repoBytes = fs.readFileSync(REPO_SKILL);
      const installedBytes = fs.readFileSync(installedSkill);
      expect(installedBytes.equals(repoBytes)).toBe(true);

      const installedText = installedBytes.toString("utf8");
      assertV3EnglishSkillMd(installedText, "installed SKILL.md");
    });

    it("accepts English prime --context plan and rejects Swedish planera on the installed app home", () => {
      applyAppContentRefresh(appHome, REPO_ROOT);

      const env = {
        HOME: home,
        AGENTERA_HOME: appHome,
        AGENTERA_BOOTSTRAP_SOURCE_ROOT: appHome,
      };

      const swedish = capturePrime("planera", env);
      expect(swedish.rc).toBe(2);
      expect(swedish.err).toContain("unsupported capability 'planera'");

      const english = capturePrime("plan", env);
      expect(english.rc).toBe(0);
      const payload = JSON.parse(english.out) as Record<string, unknown>;
      const capabilityContext = payload.capability_context as Record<string, unknown>;
      expect(capabilityContext.capability).toBe("plan");
    });
  });
});
