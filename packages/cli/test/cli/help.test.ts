import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import {
  printCommandHelp,
  printTopLevelHelp,
  printUpgradeHelp,
  wantsHelp,
} from "../../src/cli/help.js";

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

describe("cli help", () => {
  it("detects help flags", () => {
    expect(wantsHelp(["--help"])).toBe(true);
    expect(wantsHelp(["-h"])).toBe(true);
    expect(wantsHelp(["--format", "json"])).toBe(false);
  });

  it("prints audience-grouped top-level help", () => {
    const text = printTopLevelHelp();
    expect(text).toContain("Agent commands:");
    expect(text).toContain("User commands:");
    expect(text).toContain("Maintainer commands:");
    expect(text).toContain("prime");
    expect(text).toContain("upgrade");
    expect(text).toContain("check");
  });

  it("prints upgrade subcommand help with channel and dry-run flags", () => {
    const text = printUpgradeHelp();
    expect(text).toContain("--channel {stable,development}");
    expect(text).toContain("--dry-run");
    expect(text).toContain("--yes");
    expect(text).toContain("--only");
    expect(text).toContain("--format {text,json}");
  });

  it("routes top-level --help through main", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("usage: agentera [-h]");
    expect(out).toContain("Maintainer commands:");
  });

  it("routes top-level -h through main", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "-h"], io));
    expect(rc).toBe(0);
    expect(out).toContain("agentera prime");
  });

  it("routes upgrade --help through main", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "upgrade", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("agentera upgrade [-h]");
    expect(out).toContain("--channel {stable,development}");
  });

  it("routes doctor --help through main", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "doctor", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("--smoke");
  });

  it("routes prime --help through main without running prime", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "prime", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("agentera prime [-h]");
    expect(out).toContain("--context CAPABILITY");
    expect(out).not.toContain("app_home:");
  });

  it("routes capability --help through main", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "planera", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("agentera planera [-h]");
    expect(out).toContain("prime --context planera");
  });

  it("rejects help for unknown commands", () => {
    const { rc, err } = capture((io) => main(["node", "agentera", "bogus", "--help"], io));
    expect(rc).toBe(2);
    expect(err).toContain("What happened:");
    expect(err).toContain("unknown or not-yet-ported command: bogus");
  });

  it("returns null for unknown command help", () => {
    expect(printCommandHelp("bogus")).toBeNull();
  });
});
