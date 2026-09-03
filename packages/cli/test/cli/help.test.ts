import { describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import { printCommandHelp, stateCommandNames, printStateHelp, printTopLevelHelp, printUpgradeHelp, wantsHelp } from "../../src/cli/help.js";
import { describeRouteReceipt } from "../../src/registries/hybridRoute.js";

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
    expect(text).not.toContain("--runtime {all,opencode,codex,cursor,copilot}");
    expect(text).toContain("~/.agents/skills/agentera");
    expect(text).toContain("--legacy-cleanup RESOURCE_ID");
    expect(text).toContain("Current runtime selectors");
    expect(text).toContain("--format {text,json}");
    expect(text).toContain("--verify");
    expect(text).not.toContain("--restore");
  });

  it("points state help at the live writer discovery contract", () => {
    expect(printStateHelp()).toContain("agentera state <artifact> explain");
    const decisions = printStateHelp("decisions");
    expect(decisions).toContain("{append,update,amend,explain}");
    expect(decisions).toContain("agentera state decisions explain");
    expect(decisions).toContain("agentera state decisions explain --verb VERB");
  });

  it("documents singleton and strict effect-bound TODO create forms", () => {
    const text = printStateHelp("todo");
    expect(text).toContain("agentera state todo create --input TODO.yaml");
    expect(text).toContain("agentera state todo create --input TODO-CREATE-BATCH.yaml --dry-run");
    expect(text).toContain("agentera state todo create --input TODO-CREATE-BATCH.yaml --effect-sha256 SHA256 --yes");
    expect(text).toContain("strict agentera.todoCreateBatch.v1 envelope");
    expect(text).toContain("apply the same input with the returned --effect-sha256 and --yes");
  });

  it("makes the offline routing evaluation discoverable from canonical route help", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "route", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("npx -y agentera@next route evaluate");
    expect(out).toContain("frozen offline conformance corpus");
    expect(out).toContain("exits 1 when its report status is fail");
  });

  it("makes the nullable semantic receipt contract and stdin round trip discoverable", () => {
    const receipt = describeRouteReceipt();
    const { rc, out } = capture((io) => main(["node", "agentera", "route", "receipt", "--help"], io));
    const rendered = (value: unknown) =>
      JSON.stringify(value, null, 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n");

    expect(rc).toBe(0);
    expect(receipt.stdin_command).toBe("npx -y agentera@next route receipt --input -");
    expect(out).not.toMatch(/(^|\n)(?:usage:\s*)?agentera route/m);
    expect(out).toContain("agentera.route_receipt_contract.v1");
    expect(out).toContain(rendered(receipt.nullable_schema));
    expect(out).toContain(rendered(receipt.outcome_rules));
    expect(out).toContain(rendered(receipt.compound));
    expect(out).toContain(rendered(receipt.remainder_span));
    expect(out).toContain(`Runnable stdin round trip (run the command, write the JSON to stdin, then close stdin):\n  ${receipt.stdin_command}\n  ${JSON.stringify(receipt.stdin_example.input)}`);
  });

  it("documents executable plan and plan-task retrieval grammar", () => {
    const plan = printStateHelp("plan");
    expect(plan).toContain("agentera state plan tasks list [PLAN_ID] [--limit N]");
    expect(plan).toContain("agentera state plan tasks get --id ID");
    expect(plan).toContain("agentera state plan get --id ID");
    expect(plan).toContain("Plan and task reads use bare canonical IDs");
    expect(plan).toContain("Invalid historical archives remain non-fatal compatibility diagnostics unless selected");
    expect(plan).toContain("Plan create rejects an open predecessor unless --force");
    expect(plan).toContain("successor.previous_plan_archived");
    expect(plan).toContain("state plan replace --predecessor ID --successor ID");
    expect(plan).toContain("--predecessor ID --input PLAN.yaml");
    expect(plan).toContain("Archive an unfinished selected plan with --force");
    expect(plan).toContain("Task list accepts an optional bare plan ID");

    const experiments = printStateHelp("experiments");
    expect(experiments).toContain("agentera state experiments list --objective ID");
    expect(experiments).toContain("agentera state experiments publish --objective ID [--id ID] --input EXPERIMENT.yaml");
    expect(experiments).toContain("agentera state experiments explain --verb publish");
    const glossary = printStateHelp("glossary");
    expect(glossary).toContain("agentera state glossary publish --input REQUEST.yaml");
    expect(glossary).toContain("proposal-specific user confirmation");
    expect(glossary).toContain("Confirmed project variants are enforced by `agentera check validate state`");
    expect(glossary).not.toContain(["v1", "LegacyCruft"].join(""));
    expect(glossary).not.toContain("state glossary list");
    expect(experiments).toContain("byte-equivalent identity retry is idempotent");
    expect(experiments).toContain("get requires one bare experiment ID");
    expect(experiments).toContain("structured ambiguous error");
  });

  it("routes exact list help to the family-specific authority projection", () => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "state", "todo", "list", "--help"], io));
    expect({ rc, err }).toEqual({ rc: 0, err: "" });
    expect(out).toContain("Summary fields:");
    expect(out).toContain("queue_rank");
    expect(out).toContain("--queue-rank is not a filter");
    expect(out).toContain("minimum 1, default 20, maximum 100");
  });

  it("generates truthful artifact read help from authority bare behavior", () => {
    const progress = printStateHelp("progress");
    const health = printStateHelp("health");
    const docs = printStateHelp("docs");
    expect(progress).toContain("Bare: agentera state progress is a strict alias of List.");
    expect(health).toContain("Bare: rejected with recovery to agentera state health list");
    expect(docs).toContain("Bare: rejected with recovery to agentera state docs list");
    expect(health).not.toContain("usage: agentera state health [-h]");
    expect(docs).not.toContain("usage: agentera state docs [-h]");
  });

  it("keeps entity migration outside routine state help", () => {
    const backfill = printStateHelp("backfill");
    expect(stateCommandNames()).not.toContain("backfill");
    expect(backfill).not.toMatch(/--apply|--force/);
    const migrate = printStateHelp("migrate");
    expect(stateCommandNames()).not.toContain("migrate");
    expect(migrate).not.toContain("state migrate entities");
    expect(migrate).not.toMatch(/--apply|--force|--restore|--dry-run/);
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
    expect(out).toContain("npx -y agentera@next prime --context status");
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
    expect(out).toContain("--input FILE|-");
    expect(out).toContain("agentera.buildExecutionRequest.v1");
    expect(out).toContain("one availability projection and aggregate outcome");
    expect(out).toContain("bare prime is at most 12000 UTF-8 bytes");
    expect(out).toContain("status context at most 22500");
    expect(out).not.toContain("app_home:");
  });

  it("routes capability --help through main", () => {
    const { rc, out } = capture((io) => main(["node", "agentera", "plan", "--help"], io));
    expect(rc).toBe(0);
    expect(out).toContain("agentera plan [-h]");
    expect(out).toContain("prime --context plan");
  });

  it("rejects help for unknown commands", () => {
    const { rc, out, err } = capture((io) => main(["node", "agentera", "bogus", "--help"], io));
    expect(rc).toBe(2);
    expect(err).toBe("");
    expect(JSON.parse(out).error).toMatchObject({
      class: "unsupported_target",
      message: "unknown or not-yet-ported command: bogus",
    });
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
      expect(err).toBe("");
      expect(JSON.parse(out).error.message).toContain(`unknown or not-yet-ported command: ${command}`);
    });
  }
});
