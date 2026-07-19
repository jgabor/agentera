import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import {
  printCommandHelp,
  stateCommandNames,
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
    expect(text).toContain("Explicitly select all or one runtime; without it preview and apply stay app-only");
    expect(text).toContain("--legacy-cleanup {claude}");
    expect(text).toContain("never native/trust actions");
    expect(text).toContain("ownership journals and malformed locks fail closed");
    expect(text).toContain("--format {text,json}");
    expect(text).toContain("--verify");
    expect(text).not.toContain("--restore");
  });

  it("points state help at the live writer discovery contract", () => {
    expect(printStateHelp()).toContain(
      "agentera state <artifact> explain --format json",
    );
    const decisions = printStateHelp("decisions");
    expect(decisions).toContain("{append,update,amend,explain}");
    expect(decisions).toContain("agentera state decisions explain --format json");
    expect(decisions).toContain("agentera state decisions explain --verb VERB --format json");
  });

  it("documents executable plan and plan-task retrieval grammar", () => {
    const plan = printStateHelp("plan");
    expect(plan).toContain("agentera state plan tasks list [--limit N]");
    expect(plan).toContain("agentera state plan tasks get --id ID");
    expect(plan).toContain("agentera state plan get --id ID --format json");
    expect(plan).toContain("Plan and task reads use bare canonical IDs");
    expect(plan).toContain("Invalid historical archives remain non-fatal compatibility diagnostics unless selected");
    expect(plan).toContain("Task list defaults to the sole open plan");

    const experiments = printStateHelp("experiments");
    expect(experiments).toContain("agentera state experiments list --objective ID");
    expect(experiments).toContain("agentera state experiments publish --objective ID [--id ID] --input EXPERIMENT.yaml");
    expect(experiments).toContain("agentera state experiments explain --verb publish --format json");
    expect(experiments).toContain("byte-equivalent identity retry is idempotent");
    expect(experiments).toContain("get requires one bare experiment ID");
    expect(experiments).toContain("structured ambiguous error");
  });

  it("documents only the read-only entity migration diagnostic", () => {
    const backfill = printStateHelp("backfill");
    expect(stateCommandNames()).not.toContain("backfill");
    expect(backfill).not.toMatch(/--apply|--force/);
    const migrate = printStateHelp("migrate");
    expect(migrate).toContain("state migrate entities");
    expect(migrate).toContain("--dry-run");
    expect(migrate).toContain("Entity publication is available only through one full development-channel upgrade --yes.");
    expect(migrate).not.toMatch(/--apply|--force|--restore/);
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
    expect(out).toContain("bare prime is at most 12000 UTF-8 bytes");
    expect(out).toContain("status context at most 25000");
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
