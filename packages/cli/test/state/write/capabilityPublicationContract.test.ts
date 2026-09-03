import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import buildInstructions from "../../../src/capabilities/build/instructions.js";
import discussInstructions from "../../../src/capabilities/discuss/instructions.js";
import planInstructions from "../../../src/capabilities/plan/instructions.js";
import { main } from "../../../src/cli/dispatch.js";

const sources = {
  discuss: discussInstructions,
  plan: planInstructions,
  build: buildInstructions,
};

const servedCache = new Map<keyof typeof sources, string>();

type AdviceEvent = "initial_no_review" | "later_changed_no_review" | "host_review_clarification" | "unchanged" | "rendered" | "tool" | "control_only";

type AdviceRoute = "startup_advice" | "compact_term_input" | "structured_input" | "none" | "invalid_contract";

const adviceEvents: Array<{ event: AdviceEvent; route: AdviceRoute }> = [
  { event: "initial_no_review", route: "startup_advice" },
  { event: "later_changed_no_review", route: "compact_term_input" },
  { event: "host_review_clarification", route: "structured_input" },
  { event: "unchanged", route: "none" },
  { event: "rendered", route: "none" },
  { event: "tool", route: "none" },
  { event: "control_only", route: "none" },
];

function served(capability: keyof typeof sources): string {
  const cached = servedCache.get(capability);
  if (cached) return cached;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentera-${capability}-contract-`));
  const previous = process.cwd();
  let output = "";
  try {
    fs.mkdirSync(path.join(root, ".agentera"));
    fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
    process.chdir(root);
    const rc = main(["node", "agentera", "prime", "--context", capability, "--format", "json"], {
      out: (text) => {
        output += text;
      },
      err: (text) => {
        output += text;
      },
      stdin: () => "",
    });
    expect(rc, output).toBe(0);
    const instructions = (JSON.parse(output) as Record<string, any>).capability_context.instructions as string;
    servedCache.set(capability, instructions);
    return instructions;
  } finally {
    process.chdir(previous);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function adviceViolations(capability: keyof typeof sources, text: string): string[] {
  const required = [`prime --context ${capability} --term-input <file|->`, "capability_context.glossary_advice", "report glossary-advice --term-input <file|->", "report glossary-advice --input <file|->", "do not issue a second initial glossary report"];
  return required.filter((value) => !text.includes(value));
}

function selectedAdviceRoute(capability: keyof typeof sources, text: string, event: AdviceEvent): AdviceRoute {
  const contract = text.split("\n\n").find((paragraph) => paragraph.includes("capability_context.glossary_advice"));
  if (!contract) return "invalid_contract";

  if (event === "initial_no_review") {
    const clause = contract.match(/At initial meaning-sensitive[^.]*\./)?.[0] ?? "";
    return clause.includes(`prime --context ${capability} --term-input <file|->`) && contract.includes("do not issue a second initial glossary report") ? "startup_advice" : "invalid_contract";
  }
  if (event === "later_changed_no_review") {
    const clause = contract.match(/For a later user-authored[^.]*\./)?.[0] ?? "";
    return clause.includes("that can alter the affected meaning, refresh compact no-review advice") && clause.includes("report glossary-advice --term-input <file|->") ? "compact_term_input" : "invalid_contract";
  }
  if (event === "host_review_clarification") {
    const clause = contract.match(/When a clarification answer supplies structured host review[^.]*\./)?.[0] ?? "";
    return clause.includes("report glossary-advice --input <file|->") ? "structured_input" : "invalid_contract";
  }

  const exclusion = contract.match(/Do not invoke either refresh[^.]*\./)?.[0] ?? "";
  const excluded = {
    unchanged: /unchanged replay/.test(exclusion),
    rendered: /rendering/.test(exclusion),
    tool: /tool output/.test(exclusion),
    control_only: /control-only|Done-only control/.test(exclusion),
  }[event];
  return excluded ? "none" : "invalid_contract";
}

describe("capability advice and plan publication contracts", () => {
  it("keeps source and served consumers on one startup and distinct later advice routes", () => {
    for (const capability of Object.keys(sources) as Array<keyof typeof sources>) {
      for (const text of [sources[capability], served(capability)]) {
        expect(adviceViolations(capability, text), capability).toEqual([]);
        expect(adviceViolations(capability, text.replace(" --term-input <file|->", " --input <file|->")), `${capability} stale startup route`).toContain(`prime --context ${capability} --term-input <file|->`);
      }
    }
  });

  it("keeps unchanged, rendered, tool, and control-only events off both refresh routes", () => {
    for (const [capability, source] of Object.entries(sources)) {
      const text = `${source}\n${served(capability as keyof typeof sources)}`;
      expect(text).toMatch(/unchanged replay/);
      expect(text).toMatch(/rendering|artifact rendering/);
      expect(text).toContain("tool output");
      expect(text).toMatch(/control-only|Done-only control/);
      expect(text.replace(/control-only|Done-only control/g, "ordinary continuation")).not.toMatch(/control-only|Done-only control/);
    }
  });

  it.each(adviceEvents)("routes $event to $route for every source and served contract", ({ event, route }) => {
    for (const capability of Object.keys(sources) as Array<keyof typeof sources>) {
      for (const [surface, text] of [
        ["source", sources[capability]],
        ["served", served(capability)],
      ]) {
        expect(selectedAdviceRoute(capability, text, event), `${capability} ${surface}`).toBe(route);
      }
    }
  });

  it("rejects a stale host-review route on source and served contracts", () => {
    for (const [surface, text] of [
      ["source", planInstructions],
      ["served", served("plan")],
    ]) {
      const stale = text.replace("report glossary-advice --input <file|->", "report glossary-advice --term-input <file|->");
      expect(stale, `${surface} fixture changed`).not.toBe(text);
      expect(selectedAdviceRoute("plan", stale, "host_review_clarification"), surface).toBe("invalid_contract");
    }
  });

  it("publishes normally once and reuses one explicit-preview input", () => {
    for (const text of [planInstructions, served("plan")]) {
      expect(text).toContain("Normal publication is a one-call workflow");
      expect(text).toContain("Explicit preview or review is a reusable-input workflow");
      expect(text).toContain("Approval or effect confirmation is trust-boundary multi-phase");
      expect(text).toContain("Structured input remains required");
      expect(text).toMatch(/exactly one `(?:agentera|npx -y agentera@next) state plan create --input PATH` call/);
      expect(text).toContain("do not run standalone lint or dry-run first on the normal path");
      expect(text).toContain("run the same create command with `--dry-run`");
      expect(text).toContain("referencing that unchanged PATH without reserializing its content");
      const stale = text.replace("that unchanged PATH without reserializing its content", "newly serialized content");
      expect(stale).not.toContain("referencing that unchanged PATH without reserializing its content");
    }
  });

  it("keeps effect confirmation separate and bound to first-phase evidence", () => {
    for (const text of [buildInstructions, served("build")]) {
      expect(text).toMatch(/never call `(?:agentera|npx -y agentera@next) state glossary publish`/);
      expect(text).toContain("create or reuse an approval, replace proposal-digest confirmation");
      expect(text).toContain("separate Build-owned digest-confirmed operation");
    }
  });
});
