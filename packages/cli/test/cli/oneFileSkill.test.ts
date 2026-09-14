import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { CAPABILITY_INSTRUCTIONS } from "../../src/capabilities/index.js";
import { main } from "../../src/cli/dispatch.js";
import { PRIME_BLOB } from "../../src/cli/prime-blob.js";

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
  it("serves the same no-fallback recovery in the native-tools guide", () => {
    let out = "";
    expect(
      main(["node", "agentera", "prime", "--guidance"], {
        out: (text) => {
          out += text;
        },
      }),
    ).toBe(0);
    expect(out).toBe(PRIME_BLOB);
    expect(out).not.toContain("managedAppRoot");
    expect(out).toContain("Stop the affected workflow");
    expect(out).toContain("Never fall back to checkout or installed companion reads");
    for (const command of ["doctor --explain", "app-home --explain", "upgrade --explain", "report explain", "check explain"]) expect(out).toContain(`npx -y agentera@next ${command}`);
  });
  it("stays small, version-compatible and delegates rather than copying contracts", () => {
    const metadata = YAML.parse(skill.split("---")[1]);
    expect(metadata.version).toBe("3.0.0");
    expect(metadata.capabilities.sort()).toEqual(Object.keys(CAPABILITY_INSTRUCTIONS).sort());
    expect(Buffer.byteLength(skill)).toBeLessThan(11_000);
    expect(skill).not.toMatch(/\]\((?:\.\.\/|\.\/)|skills\/agentera\/|references\/|schemas\/|protocol\.yaml/);
    expect(skill).not.toContain("state plan create [--force]");
    for (const text of [
      "No sibling files or checkout",
      "output is malformed",
      "guidance is incompatible",
      "stop the affected workflow",
      "ask the user to restore a compatible supported CLI",
      "Do not",
      "change the installation",
      "not edit `.agentera/entities/` directly",
      "satisfaction is user-only",
      "explicit consent",
      "only through that returned authorization",
    ])
      expect(skill).toContain(text);
    expect(skill).not.toMatch(/npx -y agentera@next (?:install|upgrade[^`\n]*(?:--yes|--apply))/);
  });

  it("runs every concrete bootstrap static discovery example with only the host skill", () => {
    noCompanions();
    const commands = [...skill.matchAll(/`(npx -y agentera@next [^`\n]+)`/g)].map((match) => match[1]);
    const staticCommands = [...new Set(commands.filter((command) => !command.includes("<") && /(?: schema(?: |$)| explain(?: |$)| --explain$)/.test(command)))];
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
      expect(prose).toContain("stop the affected workflow");
      expect(prose).toContain("Never fall back to checkout or installed companion reads");
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
