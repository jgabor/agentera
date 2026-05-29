import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { main } from "../../src/setup/copilot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-copilot-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function capture(argv: string[], env: Record<string, string | undefined>): {
  code: number;
  out: string;
  err: string;
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const code = main(argv, {
    env,
    out: (l) => outLines.push(l),
    err: (l) => errLines.push(l),
  });
  return { code, out: outLines.join("\n") + "\n", err: errLines.join("\n") + "\n" };
}

describe("setup copilot (diagnostic-only)", () => {
  it.each([
    ["/bin/bash", ".bashrc"],
    ["/usr/bin/zsh", ".zshrc"],
    ["/usr/local/bin/fish", ".config/fish/config.fish"],
  ])("supported shell %s is diagnostic only", (shell, relativeTarget) => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const { code, out } = capture(["--install-root", REPO_ROOT], { SHELL: shell, HOME: home });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, relativeTarget))).toBe(false);
    expect(out).toContain("Agentera will not edit shell startup files");
    expect(out).toContain("AGENTERA_HOME");
  });

  it("leaves an existing legacy marker block byte-identical", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const target = path.join(home, ".bashrc");
    const preExisting =
      "# user setup\n" +
      "# agentera: AGENTERA_HOME (managed)\n" +
      'export AGENTERA_HOME="/old/stale/path"\n' +
      'alias ll="ls -la"\n';
    fs.writeFileSync(target, preExisting);
    const before = fs.readFileSync(target);

    const { code, out } = capture(["--install-root", REPO_ROOT], { SHELL: "/bin/bash", HOME: home });
    expect(code).toBe(0);
    expect(fs.readFileSync(target).equals(before)).toBe(true);
    expect(out).toContain("Legacy Agentera shell startup line detected");
    expect(out).toContain("cleanup is a user-owned manual boundary");
  });

  it("leaves an existing bare AGENTERA_HOME line byte-identical", () => {
    const target = path.join(tmp, "custom.rc");
    const preExisting = 'export AGENTERA_HOME="/user/wrote/this"\n';
    fs.writeFileSync(target, preExisting);
    const before = fs.readFileSync(target);

    const { code, out } = capture(
      ["--install-root", REPO_ROOT, "--rc-file", target, "--dry-run"],
      { HOME: path.join(tmp, "home") },
    );
    expect(code).toBe(0);
    expect(fs.readFileSync(target).equals(before)).toBe(true);
    expect(out).not.toContain("Legacy Agentera shell startup line detected");
    expect(out).toContain("No Agentera shell startup line was detected");
  });

  it("infers fish syntax from --rc-file and is inspection-only", () => {
    const target = path.join(tmp, "custom.fish");
    const { code, out } = capture(["--install-root", REPO_ROOT, "--rc-file", target], {
      SHELL: "/bin/bash",
      HOME: path.join(tmp, "home"),
    });
    expect(code).toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(out).toContain(`target: ${target}`);
    expect(out).toContain("syntax=fish");
  });

  it("prints per-invocation guidance for an unsupported shell", () => {
    const home = path.join(tmp, "home");
    fs.mkdirSync(home, { recursive: true });
    const { code, err } = capture(["--install-root", REPO_ROOT], { SHELL: "/bin/csh", HOME: home });
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(home, ".bashrc"))).toBe(false);
    expect(err).toContain("csh");
    expect(err).toContain("Agentera will not edit shell startup files");
    expect(err).toContain("AGENTERA_HOME=<agentera-directory> copilot");
  });

  it("rejects an invalid install root", () => {
    const bogus = path.join(tmp, "not-an-install");
    fs.mkdirSync(bogus);
    const target = path.join(tmp, "rc");
    const { code, err } = capture(["--install-root", bogus, "--rc-file", target], {
      HOME: path.join(tmp, "home"),
    });
    expect(code).toBe(2);
    expect(err).toContain("scripts/validate_capability.py");
    expect(err).toContain("skills/agentera/SKILL.md");
    expect(fs.existsSync(target)).toBe(false);
  });
});
