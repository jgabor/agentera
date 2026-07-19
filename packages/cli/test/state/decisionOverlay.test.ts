import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { main } from "../../src/cli/dispatch.js";
import {
  decisionContextEntry,
  decisionSatisfactionContext,
  hydrateDecisionEntries,
} from "../../src/cli/commands/state/decisions.js";
import { dumpYamlMapping, loadYamlMapping } from "../../src/core/yaml.js";
import {
  composeDecisionOverlay,
  decisionOverlayPath,
  decisionOverlayViolations,
  loadDecisionOverlay,
} from "../../src/state/decisionOverlay.js";
import { InjectedMutationFailure } from "../../src/state/write/mutation.js";
import { executeStateWrite, type StateWriteRequest } from "../../src/state/write/transaction.js";
import { operationSpec } from "../../src/state/write/operations.js";
import { checkCompaction } from "../../src/hooks/compaction/status.js";
import { compactYamlFile } from "../../src/hooks/compaction/apply.js";

interface Captured {
  rc: number;
  out: string;
  err: string;
  json: Record<string, any> | null;
}

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-decision-overlay-"));
  fs.mkdirSync(path.join(root, ".agentera"));
  fs.writeFileSync(path.join(root, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function run(root: string, args: string[]): Captured {
  let out = "";
  let err = "";
  const rc = main(["node", "agentera", "state", ...args, "--project", root], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { rc, out, err, json: out.trim().startsWith("{") ? JSON.parse(out) : null };
}

function appendDecision(root: string, suffix = ""): Captured {
  const result = run(root, [
      "decisions",
      "append",
      "--question",
      `Where should review state live${suffix}?`,
      "--context",
      "The immutable archive must remain unchanged.",
      "--alternative-chosen",
      "An ID-keyed overlay",
      "--alternative-rejected",
      "The archive record",
      "--choice",
      "An ID-keyed overlay",
      "--reasoning",
      "Current satisfaction is mutable review state.",
      "--confidence",
      "firm",
      "--format",
      "json",
    ]);
  expect(result.rc).toBe(0);
  return result;
}

function update(root: string, state: string, ...extra: string[]): Captured {
  const id = fs.readdirSync(path.join(root, ".agentera/entities/decisions/decision"), { withFileTypes: true })
    .find((entry) => entry.isFile() && entry.name.endsWith(".yaml"))!.name.slice(0, -5);
  return run(root, [
    "decisions",
    "update",
    "--id",
    id,
    "--satisfaction-state",
    state,
    ...extra,
    "--format",
    "json",
  ]);
}

function updateRequest(root: string, state: string): StateWriteRequest {
  const spec = operationSpec("decisions", "update");
  if (!spec) throw new Error("decision update operation is unavailable");
  const id = fs.readdirSync(path.join(root, ".agentera/entities/decisions/decision"))[0].slice(0, -5);
  const satisfaction = state === "provisionally_satisfied" ? { state, evidence: "atomic evidence" } : { state };
  return {
    artifact: "decisions",
    spec,
    projectRoot: root,
    dryRun: false,
    force: false,
    values: { id, satisfaction },
    callerPayload: { id, satisfaction },
    input: null,
  };
}

describe("decision review overlays", () => {
  it("publishes satisfaction separately without changing the immutable decision base", () => {
    const root = project();
    appendDecision(root);
    const basePath = path.join(root, ".agentera/entities/decisions/decision", fs.readdirSync(path.join(root, ".agentera/entities/decisions/decision"))[0]);
    const baseBefore = fs.readFileSync(basePath, "utf8");

    const result = update(root, "provisionally_satisfied", "--satisfaction-evidence", "tests passed");
    expect(result).toMatchObject({ rc: 0 });
    expect(result.json?.record).toMatchObject({ state: "provisionally_satisfied", evidence: "tests passed" });
    expect(fs.readFileSync(basePath, "utf8")).toBe(baseBefore);
    expect(String(result.json?.path)).toContain(".agentera/entities/decisions/decision_satisfaction/");
    expect(fs.existsSync(path.join(root, ".agentera/decisions.yaml"))).toBe(false);
  });

  it("rejects an invalid satisfaction replacement without changing published bytes", () => {
    const root = project();
    appendDecision(root);
    expect(update(root, "open").rc).toBe(0);
    const satisfactionDir = path.join(root, ".agentera/entities/decisions/decision_satisfaction");
    const satisfactionPath = path.join(satisfactionDir, fs.readdirSync(satisfactionDir)[0]);
    const before = fs.readFileSync(satisfactionPath, "utf8");
    const rejected = update(root, "provisionally_satisfied");
    expect(rejected.rc).toBe(2);
    expect(rejected.json?.error.class).toBe("schema_violation");
    expect(fs.readFileSync(satisfactionPath, "utf8")).toBe(before);
    expect(fs.readdirSync(satisfactionDir).some((name) => name.includes(".tmp") || name.includes(".rollback"))).toBe(false);
  });

  it("rejects non-mutable and derived overlay fields and unsafe overlay paths", () => {
    const root = project();
    const violations = decisionOverlayViolations({
      "decisions:1": {
        satisfaction: {
          state: "open",
          review_needed: false,
          question: "must not be stored",
        },
      },
    });
    expect(violations).toEqual(
      expect.arrayContaining([
        "satisfaction.review_needed is not an authority-declared mutable overlay field",
        "satisfaction.question is not an authority-declared mutable overlay field",
      ]),
    );

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-overlay-outside-"));
    fs.mkdirSync(path.join(outside, "overlays"));
    fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
    fs.symlinkSync(path.join(outside, "overlays"), path.join(root, ".agentera", "overlays"));
    expect(() => decisionOverlayPath(root)).toThrow(/project boundary/);
  });

  it("preserves missing, open, provisional, confirmed, and invalid Decision 53 states", () => {
    const missing = decisionSatisfactionContext({ number: 53 });
    expect(missing).toMatchObject({ state: null, review_needed: true, source: "missing_legacy_state" });

    const open = decisionSatisfactionContext({ satisfaction: { state: "open" } });
    expect(open).toMatchObject({ state: "open", review_needed: true });

    const provisional = decisionSatisfactionContext({
      satisfaction: { state: "provisionally_satisfied", evidence: "observed" },
    });
    expect(provisional).toMatchObject({ state: "provisionally_satisfied", review_needed: true });

    const confirmed = decisionSatisfactionContext({
      satisfaction: {
        state: "user_confirmed_satisfied",
        user_confirmation: { confirmed_by: "user", confirmed_at: "2026-07-13T12:00:00Z" },
      },
    });
    expect(confirmed).toMatchObject({ state: "user_confirmed_satisfied", review_needed: false });

    const invalid = decisionSatisfactionContext({ satisfaction: { state: "invented" } });
    expect(invalid).toMatchObject({ state: "invented", review_needed: true });
    expect(invalid.caveats).toContain("Satisfaction state is missing or unrecognized and requires review.");
    const malformedConfirmation = decisionSatisfactionContext({
      satisfaction: { state: "user_confirmed_satisfied", user_confirmation: { confirmed_by: "user" } },
    });
    expect(malformedConfirmation.review_needed).toBe(true);
  });

  it("enforces every satisfaction transition without inferring user confirmation", () => {
    const root = project();
    appendDecision(root);
    expect(update(root, "open").rc).toBe(0);
    expect(update(root, "provisionally_satisfied").json?.error.class).toBe("schema_violation");
    expect(update(root, "provisionally_satisfied", "--satisfaction-evidence", "evidence").rc).toBe(0);
    expect(update(root, "user_confirmed_satisfied").json?.error.class).toBe("schema_violation");
    expect(
      update(
        root,
        "user_confirmed_satisfied",
        "--confirmed-by",
        "user",
        "--confirmed-at",
        "2026-07-13T12:00:00Z",
      ).rc,
    ).toBe(0);
    expect(update(root, "open").json?.error.class).toBe("conflict");
    expect(
      update(
        root,
        "open",
        "--confirmed-by",
        "user",
        "--confirmed-at",
        "2026-07-13T12:01:00Z",
      ).rc,
    ).toBe(0);
    expect(update(root, "not-a-state").json?.error.class).toBe("invalid_choice");
  });

  it("hydrates only mutable fields and leaves derived review state authoritative", () => {
    const entry = {
      number: 53,
      question: "immutable question",
      satisfaction: { state: "open", evidence: "old", review_needed: true, caveats: ["historical"] },
    };
    const hydrated = composeDecisionOverlay(entry, {
      satisfaction: {
        state: "provisionally_satisfied",
        evidence: "new",
        user_confirmation: { confirmed_by: "user", confirmed_at: "2026-07-13T12:00:00Z" },
        review_needed: false,
        question: "ignored",
      },
      question: "ignored",
    });
    expect(hydrated.question).toBe("immutable question");
    expect(hydrated.satisfaction).toMatchObject({
      state: "provisionally_satisfied",
      evidence: "new",
      review_needed: true,
    });
    expect(decisionContextEntry(hydrated).satisfaction).toMatchObject({ review_needed: true });
  });

  it("does not let legacy overlays affect entity review state or entity publication", () => {
    const root = project();
    appendDecision(root);
    expect(update(root, "open").rc).toBe(0);
    const entries = hydrateDecisionEntries(
      [{ number: 1, satisfaction: { state: "user_confirmed_satisfied" } }],
      root,
    );
    expect(entries[0].satisfaction).toMatchObject({ state: "user_confirmed_satisfied" });

    const decisions = Array.from({ length: 51 }, (_, index) => ({
      number: index + 1,
      date: "2026-07-13",
      question: `Q${index + 1}`,
      context: "c",
      alternatives: [{ name: "a", status: "chosen" }],
      choice: "a",
      reasoning: "r",
      confidence: "firm",
    }));
    fs.writeFileSync(path.join(root, ".agentera", "decisions.yaml"), dumpYamlMapping({ decisions }));
    expect(run(root, [
      "decisions",
      "append",
      "--question",
      "Q52",
      "--context",
      "c",
      "--alternative-chosen",
      "a",
      "--choice",
      "a",
      "--reasoning",
      "r",
      "--confidence",
      "firm",
      "--format",
      "json",
    ]).rc).toBe(0);
    expect(checkCompaction(root).some((item) => item.status.artifact === "decisions")).toBe(false);
    expect(fs.readdirSync(path.join(root, ".agentera/entities/decisions/decision"))).toHaveLength(2);
    expect(loadYamlMapping(fs.readFileSync(path.join(root, ".agentera/decisions.yaml"), "utf8")).decisions).toHaveLength(51);
  });

  it("keeps entity decisions independent of aggregate compaction limits", () => {
    const root = project();
    const agentera = path.join(root, ".agentera");
    for (let index = 1; index <= 11; index += 1) appendDecision(root, String(index));
    expect(checkCompaction(root)).toEqual(expect.arrayContaining([expect.objectContaining({ action: "skipped", status: expect.objectContaining({ artifact: "entity_state" }) })]));
    const appended = appendDecision(root, "12");
    expect(appended.rc).toBe(0);
    expect(fs.readdirSync(path.join(root, ".agentera/entities/decisions/decision"))).toHaveLength(12);
    expect(fs.existsSync(path.join(agentera, "decisions.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(agentera, "archive"))).toBe(false);
  });
});
