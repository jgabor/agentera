import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import {
  printCommandHelp,
  printStateHelp,
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
    expect(text).toContain("--runtime {all,opencode,codex,cursor,copilot}");
    expect(text).toContain("development dry-runs default to all, apply without it stays app-only");
    expect(text).toContain("--legacy-cleanup {claude}");
    expect(text).toContain("never native/trust actions");
    expect(text).toContain("ownership journals and malformed locks fail closed");
    expect(text).toContain("--format {text,json}");
    expect(text).toContain("--verify");
    expect(text).toContain("--restore");
  });

  it("points state help at the live writer discovery contract", () => {
    expect(printStateHelp()).toContain(
      "agentera state <artifact> explain --format json",
    );
    const decisions = printStateHelp("decisions");
    expect(decisions).toContain("{append,update,explain}");
    expect(decisions).toContain("agentera state decisions explain --format json");
    expect(decisions).toContain("agentera state decisions explain --verb VERB --format json");
  });

  it("declares plan and objective-scoped experiment retrieval grammar without claiming execution", () => {
    const plan = printStateHelp("plan");
    expect(plan).toContain("agentera state plan tasks list [--plan PLAN_ID]");
    expect(plan).toContain("agentera state plan get --plan PLAN_ID --format json");
    expect(plan).toContain("execution lands in later plan tasks");

    const experiments = printStateHelp("experiments");
    expect(experiments).toContain("agentera state experiments list --objective OBJECTIVE_ID");
    expect(experiments).toContain("experiment --number accepts 0");
    expect(experiments).toContain("structured ambiguous error");
  });

  it("documents optional preview and direct forced backfill without receipt flags", () => {
    const backfill = printStateHelp("backfill");
    expect(backfill).toContain("[--dry-run|--apply --force]");
    expect(backfill).toContain("Direct --apply --force publishes one immutable archive record after fresh checks.");
    expect(backfill).toContain("optional for inventory/preview, required for apply");
    expect(backfill).toContain("Result limit: 100; history limit: 500 units and 16777216 bytes (16 MiB).");
    expect(backfill).toContain("Reads only HEAD, refs/heads, refs/tags; excludes refs/remotes, custom_refs.");
    expect(backfill).toContain("Traceability: commit, path, blob_id, entry_id, content_hash, reachable.");
    expect(backfill).not.toContain("preview-token");
    expect(backfill).not.toContain("receipt");
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
    expect(out).toContain("artifact_writes discovery metadata");
    expect(out).not.toContain("app_home:");
  });

  it("routes capability --help through main", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "plan", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("agentera plan [-h]");
    expect(out).toContain("prime --context plan");
  });

  it("rejects help for unknown commands", () => {
    const { rc, err } = capture((io) => main(["node", "agentera", "bogus", "--help"], io));
    expect(rc).toBe(2);
    expect(err).toContain("What happened:");
    expect(err).toContain("unknown or not-yet-ported command: bogus");
  });

  it("routes report --help through main with runtime deselection flags", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "report", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("--no-codex");
    expect(out).toContain("Skip codex even if");
    expect(out).not.toContain("--no-claude");
    expect(out).toContain("--import-source claude");
    expect(out).toContain("secrets, file contents, and command output");
    expect(out).toContain("--accept-coverage-gap");
    expect(out).toContain("Coverage Audit");
  });

  it("returns null for unknown command help", () => {
    expect(printCommandHelp("bogus")).toBeNull();
  });

  it("returns null for removed top-level parser help aliases", () => {
    expect(printCommandHelp("status")).toBeNull();
    expect(printCommandHelp("describe")).toBeNull();
    expect(printCommandHelp("gate")).toBeNull();
  });
});

describe("cli dispatch: removed top-level parsers (T8)", () => {
  const removed = ["status", "describe", "gate"] as const;

  for (const command of removed) {
    it(`rejects agentera ${command} with rc 2 and the unknown-command envelope`, () => {
      const { rc, out, err } = capture((io) => main(["node", "agentera", command], io));
      expect(rc).toBe(2);
      expect(out).toBe("");
      expect(err).toContain("What happened:");
      expect(err).toContain(`unknown or not-yet-ported command: ${command}`);
    });
  }
});
