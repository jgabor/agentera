import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import YAML from "yaml";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { main } from "../../src/cli/dispatch.js";
import { PRIME_MANUAL } from "../../src/cli/prime-blob.js";

const root = path.resolve(import.meta.dirname, "../../../..");
const skill = fs.readFileSync(path.join(root, "skills/agentera/SKILL.md"), "utf8");
const sources = import.meta.glob<string>("../../src/capabilities/*/instructions.ts", {
  import: "default",
  eager: true,
});
const originalDirectory = process.cwd();
let temporary: string | undefined;
afterEach(() => {
  process.chdir(originalDirectory);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = undefined;
});

interface SharedSkillBudget {
  source: string;
  max_lines: number;
  max_utf8_bytes: number;
}
function sharedSkillBudget(): SharedSkillBudget {
  return YAML.parse(fs.readFileSync(path.join(root, "references/artifacts/state-storage-authority.yaml"), "utf8")).budgets.shared_skill;
}
/** Newline-terminated lines and raw UTF-8 bytes, as budgets.shared_skill counts them. */
function skillSize(text: string) {
  return { lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), bytes: Buffer.byteLength(text, "utf8") };
}
function skillBudgetViolations(text: string, budget: SharedSkillBudget): string[] {
  const size = skillSize(text);
  return [...(size.lines > budget.max_lines ? ["lines"] : []), ...(size.bytes > budget.max_utf8_bytes ? ["bytes"] : [])];
}
function args(command: string) {
  expect(command).toMatch(/^npx -y agentera@next /);
  return (command.match(/'[^']*'|\S+/g) ?? []).slice(3).map((word) => (word.startsWith("'") ? word.slice(1, -1) : word));
}
function query(argv: string[]) {
  let out = "",
    err = "";
  const rc = main(["node", "agentera", ...argv], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  expect(err).toBe("");
  const payload = JSON.parse(out);
  if (payload.schemaVersion === "agentera.guidanceDetail.v1" || rc !== 0) expect(Buffer.byteLength(out)).toBeLessThanOrEqual(32_768);
  return { rc, payload, out };
}
function noCompanions() {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-one-file-"));
  fs.writeFileSync(path.join(temporary, "SKILL.md"), skill);
  process.chdir(temporary);
  vi.stubEnv("HOME", temporary);
  vi.stubEnv("AGENTERA_HOME", path.join(temporary, "absent-home"));
  vi.stubEnv("AGENTERA_BOOTSTRAP_SOURCE_ROOT", root);
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: any[]) => {
    const name = String(file);
    if (name.endsWith("SKILL.md") || name.includes("/.agentera/") || name.includes("PROFILE.md") || name.includes("/history/") || name.startsWith(temporary!)) throw new Error("Host companion/private read forbidden");
    return (read as any)(file, ...rest);
  }) as typeof fs.readFileSync);
}

describe("single-file host bootstrap", () => {
  it("serves the no-fallback recovery once, in the operating manual", () => {
    let out = "";
    expect(
      main(["node", "agentera", "prime", "--guidance"], {
        out: (text) => {
          out += text;
        },
      }),
    ).toBe(0);
    expect(out).toBe(`${PRIME_MANUAL}\n`);
    expect(out).not.toContain("managedAppRoot");
    expect(out).toContain("stop the affected workflow");
    expect(out).toContain("Never fall back to checkout or installed companion reads");
    for (const command of ["<doctor|app-home|upgrade> --explain", "<report|check|route> explain", "schema"]) expect(out).toContain(`npx -y agentera@next ${command}`);
  });
  it("keeps the shared skill within its declared line and byte budget", () => {
    const budget = sharedSkillBudget();
    expect(budget.source).toBe("skills/agentera/SKILL.md");
    expect(skillBudgetViolations(skill, budget), JSON.stringify(skillSize(skill))).toEqual([]);
    const tooLong = Array.from({ length: budget.max_lines + 1 }, () => "x").join("\n") + "\n";
    expect(skillSize(tooLong).lines).toBe(budget.max_lines + 1);
    expect(skillBudgetViolations(tooLong, budget)).toEqual(["lines"]);
    const tooLarge = `${"x".repeat(budget.max_utf8_bytes)}\n`;
    expect(skillBudgetViolations(tooLarge, budget)).toEqual(["bytes"]);
  });

  it("holds only the frontmatter, three prime rows, the rerun line and the stop rule", () => {
    const metadata = YAML.parse(skill.split("---")[1]);
    expect(metadata.name).toBe("agentera");
    expect(skill.match(/^name: agentera$/gm)).toHaveLength(1);
    expect(metadata.version).toBe("3.0.0");
    expect(metadata.capabilities.sort()).toEqual(Object.keys(CAPABILITY_INSTRUCTIONS).sort());
    expect(skill).not.toMatch(/\]\((?:\.\.\/|\.\/)|skills\/agentera\/|references\/|schemas\/|protocol\.yaml/);
    const rows = skill.split("\n").filter((line) => line.startsWith("| ") && !line.startsWith("| Request"));
    expect(rows.map((row) => row.split("|")[1].trim())).toEqual(["Bare `/agentera`", "`/agentera <capability> [topic]`", "Natural language"]);
    for (const row of rows) expect(row).toContain("`npx -y agentera@next prime --input -`");
    expect(skill).toContain('`{"version":"agentera.route_request.v1","request":"<original request>"}`, never in argv');
    expect(skill).toContain("follow its `manual`");
    expect(skill).toContain("Start nothing it does not return.");
    expect(skill).toContain("After context loss or compaction, rerun `npx -y agentera@next prime`");
    expect(skill).toContain("If the CLI is missing, fails or returns output that does not parse, stop and report");
    expect(skill).toContain("read checkout or installed companion files");
    // Rules the CLI serves stay out of the skill: the manual, the receipt
    // contract and the offers carry them.
    expect(skill).not.toMatch(/receipt|upgrade_offer|apply_command|explain|schema|state |--context|--dry-run/);
    expect(skill).not.toMatch(/npx -y agentera@next (?:install|upgrade[^`\n]*(?:--yes|--apply))/);
  });

  it("serves the rules moved out of the skill in the operating manual", () => {
    for (const text of [
      "Discovery grants no permission",
      "output is malformed or incompatible",
      "stop the affected workflow",
      "ask the user to restore the CLI",
      "use older guidance",
      "Never edit `.agentera/entities/`",
      "only the user confirms satisfaction",
      "explicit Yes",
      "on `semantic_required`, send every receipt field, null when unused",
      "copy both hashes unchanged",
      "`remainder_span` ends at the request's UTF-8 byte length",
    ])
      expect(PRIME_MANUAL).toContain(text);
  });

  it("runs every concrete static discovery command the manual names with only the host skill", () => {
    noCompanions();
    const examples: Record<string, string> = { name: "vision", capability: "build", kind: "instructions", artifact: "decisions" };
    const expand = (command: string): string[] => {
      const optional = /\[([^\]]+)\]/.exec(command);
      if (optional) return [command.replace(optional[0], ""), ...optional[1].split("|").map((choice) => command.replace(optional[0], choice))].flatMap(expand);
      const choice = /<([^>]+\|[^>]+)>/.exec(command);
      if (choice) return choice[1].split("|").flatMap((value) => expand(command.replace(choice[0], value)));
      const placeholder = /<(\w+)>/.exec(command);
      if (placeholder) return expand(command.replace(placeholder[0], examples[placeholder[1]]));
      return [command.replace(/\s+/g, " ").trim()];
    };
    const commands = [...PRIME_MANUAL.matchAll(/`(npx -y agentera@next [^`\n]+)`/g)].flatMap((match) => expand(match[1]));
    const staticCommands = [...new Set(commands.filter((command) => /(?: schema(?: |$)| explain(?: |$)| --explain$|--detail )/.test(command) && !/(?:--dry-run|--input)/.test(command)))];
    expect(staticCommands.length).toBeGreaterThanOrEqual(10);
    for (const command of staticCommands) {
      const result = query(args(command));
      expect(result.rc, `${command}\n${result.out}`).toBe(0);
    }
    expect(fs.readdirSync(temporary!)).toEqual(["SKILL.md"]);
  });

  it("removes mandatory companion lookup in source exports and every served instruction page", () => {
    noCompanions();
    const forbidden = /locate the active installed schema|Artifact path resolution is owned by SKILL\.md|Visual.token (?:IDs live|families.*by)|thresholds per protocol\.yaml|primitive from `references\/|schema:.* in `references\//;
    expect(Object.keys(sources)).toHaveLength(Object.keys(CAPABILITY_INSTRUCTIONS).length);
    for (const [name, prose] of Object.entries(sources)) expect(prose, name).not.toMatch(forbidden);
    for (const [capability, expected] of Object.entries(CAPABILITY_INSTRUCTIONS)) {
      let command = `npx -y agentera@next prime --context ${capability} --detail instructions --section instructions`;
      let prose = "",
        pages = 0;
      while (command) {
        expect(++pages).toBeLessThan(20);
        const result = query(args(command));
        expect(result.rc, result.out).toBe(0);
        expect(result.payload.schemaVersion).toBe("agentera.guidanceDetail.v1");
        expect(result.payload.completeness.mode).toBe("detail");
        prose += result.payload.items.map((item: { content: string }) => item.content).join("");
        command = result.payload.next_command;
      }
      expect(prose).toBe(expected);
      expect(prose, capability).not.toMatch(forbidden);
      // Recovery and discovery rules are served once, by the prime manual.
      expect(prose, capability).not.toContain("stop the affected workflow");
      expect(prose, capability).not.toContain("Never fall back to checkout or installed companion reads");
      expect(prose, capability).not.toContain("## Current contract access");
    }
    expect(CAPABILITY_INSTRUCTIONS.vision).toContain("npx -y agentera@next schema --artifact vision");
    expect(CAPABILITY_INSTRUCTIONS.profile).toContain("npx -y agentera@next schema --artifact glossary --section entry");
    expect(CAPABILITY_INSTRUCTIONS.profile).toContain("npx -y agentera@next report explain");
  });

  it("uses explicit bounded CLI recovery for missing and malformed capability selectors", () => {
    noCompanions();
    for (const argv of [
      ["prime", "--detail", "instructions"],
      ["prime", "--context", "unavailable", "--detail", "instructions"],
      ["prime", "--context", "vision", "--detail", "missing"],
      ["prime", "--context", "profile", "--detail", "instructions", "--cursor", "malformed"],
    ]) {
      const result = query(argv);
      expect(result.rc).toBe(64);
      expect(result.out).not.toMatch(/read.*(?:checkout|installed schema)|--yes|--apply/);
      expect(result.out).toContain("npx -y agentera@next prime");
      expect(result.out).not.toContain("capability_context");
    }
    expect(fs.readdirSync(temporary!)).toEqual(["SKILL.md"]);
  });
});
