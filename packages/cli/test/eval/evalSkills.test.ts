import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PARALLEL,
  DEFAULT_TIMEOUT,
  ExitError,
  TRIGGER_PROMPTS,
  buildDryRun,
  buildReport,
  detectRuntime,
  discoverSkills,
  invokeSkill,
  main,
  parseArgs,
  parseFrontmatterName,
} from "../../src/eval/evalSkills.js";

const ALL_SKILL_NAMES = [
  "dokumentera",
  "hej",
  "inspektera",
  "inspirera",
  "optimera",
  "orkestrera",
  "planera",
  "profilera",
  "realisera",
  "resonera",
  "visionera",
  "visualisera",
].sort();

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eval-skills-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("TRIGGER_PROMPTS", () => {
  it("has all twelve skills with non-empty prompts", () => {
    expect(Object.keys(TRIGGER_PROMPTS).sort()).toEqual(ALL_SKILL_NAMES);
    for (const [name, prompt] of Object.entries(TRIGGER_PROMPTS)) {
      expect(typeof prompt, name).toBe("string");
      expect(prompt.length, name).toBeGreaterThan(0);
    }
  });
});

describe("parseFrontmatterName", () => {
  it("reads the name field", () => {
    expect(parseFrontmatterName("---\nname: realisera\ndescription: x\n---\n# C\n")).toBe("realisera");
  });
  it("returns null without frontmatter", () => {
    expect(parseFrontmatterName("# Just markdown")).toBeNull();
  });
  it("returns null without a name field", () => {
    expect(parseFrontmatterName("---\ndescription: no name here\n---\n")).toBeNull();
  });
});

describe("discoverSkills", () => {
  it("discovers skills with frontmatter names", () => {
    const skillsDir = path.join(tmp, "skills");
    for (const name of ["alpha", "beta"]) {
      fs.mkdirSync(path.join(skillsDir, name), { recursive: true });
      fs.writeFileSync(path.join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\n---\n# ${name}\n`);
    }
    const result = discoverSkills(tmp);
    expect(result.length).toBe(2);
    expect(result[0].name).toBe("alpha");
    expect(result[1].name).toBe("beta");
  });

  it("falls back to the directory name", () => {
    const d = path.join(tmp, "skills", "gamma");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "SKILL.md"), "# No frontmatter\n");
    const result = discoverSkills(tmp);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe("gamma");
  });

  it("returns empty for an empty skills dir", () => {
    fs.mkdirSync(path.join(tmp, "skills"));
    expect(discoverSkills(tmp)).toEqual([]);
  });
});

describe("buildReport / buildDryRun / parseArgs", () => {
  it("builds a report", () => {
    const results = [
      { skill: "a", status: "pass", duration_s: 1.0, error: null },
      { skill: "b", status: "fail", duration_s: 2.0, error: "boom" },
    ];
    const report = buildReport(results);
    expect(report.skills_tested).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.results).toBe(results);
    expect("timestamp" in report).toBe(true);
  });

  it("builds a dry run", () => {
    const skills = [
      { name: "a", prompt: "Do A." },
      { name: "b", prompt: "Do B." },
    ];
    const result = buildDryRun(skills);
    expect(result.mode).toBe("dry-run");
    expect(result.skills).toEqual(skills);
  });

  it("parses args with defaults and overrides", () => {
    const def = parseArgs([]);
    expect(def.skill).toBeNull();
    expect(def.dry_run).toBe(false);
    expect(def.parallel).toBe(DEFAULT_PARALLEL);
    expect(def.timeout).toBe(DEFAULT_TIMEOUT);
    expect(def.runtime).toBe("auto");
    expect(parseArgs(["--skill", "realisera"]).skill).toBe("realisera");
    expect(parseArgs(["--runtime", "opencode"]).runtime).toBe("opencode");
    expect(parseArgs(["--runtime", "cursor-agent"]).runtime).toBe("cursor-agent");
  });
});

describe("detectRuntime", () => {
  const which = (table: Record<string, boolean>) => (name: string) =>
    table[name] ? `/usr/bin/${name}` : null;

  it("prefers claude", () => {
    expect(detectRuntime(null, { which: which({ claude: true, opencode: true }) })).toBe("claude");
  });
  it("falls back to opencode", () => {
    expect(detectRuntime(null, { which: which({ opencode: true }) })).toBe("opencode");
  });
  it("honors an explicit override without PATH", () => {
    expect(detectRuntime("opencode", { which: which({}) })).toBe("opencode");
  });
  it("accepts explicit cursor-agent when present", () => {
    expect(detectRuntime("cursor-agent", { which: which({ "cursor-agent": true }) })).toBe("cursor-agent");
  });
  it("throws ExitError(1) when cursor-agent is unavailable", () => {
    expect(() => detectRuntime("cursor-agent", { which: which({}), err: () => {} })).toThrow(ExitError);
  });
  it("throws ExitError(1) when nothing is available", () => {
    try {
      detectRuntime(null, { which: which({}), err: () => {} });
      throw new Error("expected ExitError");
    } catch (err) {
      expect(err).toBeInstanceOf(ExitError);
      expect((err as ExitError).code).toBe(1);
    }
  });
});

describe("invokeSkill command selection", () => {
  it("uses the opencode command", () => {
    let captured: string[] = [];
    const run = (cmd: string[]) => {
      captured = cmd;
      return { status: 0, stdout: "", stderr: "" };
    };
    invokeSkill("realisera", "test prompt", 5, "opencode", { run, repoRoot: tmp });
    expect(captured).toEqual(["opencode", "run", "--prompt"]);
  });

  it("uses the cursor-agent command", () => {
    let captured: string[] = [];
    const which = (name: string) => (name === "cursor-agent" ? "/usr/bin/cursor-agent" : null);
    const run = (cmd: string[]) => {
      captured = cmd;
      return { status: 0, stdout: "{}", stderr: "" };
    };
    invokeSkill("hej", "status briefing", 5, "cursor-agent", { which, run, repoRoot: tmp });
    expect(captured).toEqual([
      "cursor-agent",
      "-p",
      "--output-format",
      "json",
      "--force",
      "status briefing",
    ]);
  });
});

describe("main --dry-run", () => {
  it("stays smoke-compatible", () => {
    const lines: string[] = [];
    const code = main(["--dry-run"], {
      detectRuntime: () => "claude",
      discoverSkills: () => [{ name: "hej", prompt: "Start a new session." }],
      out: (l) => lines.push(l),
    });
    expect(code).toBe(0);
    expect(JSON.parse(lines.join("\n"))).toEqual({
      mode: "dry-run",
      runtime: "claude (auto-detected)",
      skills: [{ name: "hej", prompt: "Start a new session." }],
    });
  });
});
