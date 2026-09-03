import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { printTopLevelHelp, printCommandHelp } from "../../src/cli/help.js";

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

describe("cli dispatch: --version / version command", () => {
  it("prints version for --version flag", () => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "--version"], io));
    expect(rc).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
    expect(err).toBe("");
  });

  it("prints JSON for the operational version subcommand", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "version"], io));
    expect(rc).toBe(0);
    expect(JSON.parse(out).version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints version as JSON with", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "version", "--format", "json"], io));
    expect(rc).toBe(0);
    const parsed = JSON.parse(out.trim());
    expect(parsed).toHaveProperty("version");
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("rejects unknown arguments after --version", () => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "--version", "--bogus"], io));
    expect(rc).toBe(2);
    expect(err).toBe("");
    expect(JSON.parse(out).error).toMatchObject({ class: "unrecognized_argument" });
  });

  it.each(["json", "text", "yaml"])("rejects --format %s after --version as JSON", (format) => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "--version", "--format", format], io));
    expect(rc).toBe(2);
    expect(err).toBe("");
    expect(JSON.parse(out).error).toMatchObject({ class: "unrecognized_argument" });
  });

  it("rejects invalid --format value as JSON", () => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "version", "--format", "yaml"], io));
    expect(rc).toBe(2);
    expect(err).toBe("");
    expect(JSON.parse(out).error).toMatchObject({
      class: "invalid_choice",
      valid_values: ["json"],
    });
  });

  it("shows help for version --help", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "version", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("Print the installed Agentera CLI version");
  });
});

describe("cli help: --version in top-level help", () => {
  it("includes --version in usage line", () => {
    const text = printTopLevelHelp();
    expect(text).toContain("[--version]");
  });

  it("includes --version in options section", () => {
    const text = printTopLevelHelp();
    expect(text).toContain("--version");
    expect(text).toContain("print the installed Agentera CLI version and exit");
  });

  it("returns help text for printCommandHelp('--version')", () => {
    const text = printCommandHelp("--version");
    expect(text).not.toBeNull();
    expect(text).toContain("Print the installed Agentera CLI version");
  });
});
