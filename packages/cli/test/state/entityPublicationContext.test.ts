import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendDecisionEntity, updateDecisionSatisfactionEntity } from "../../src/state/decisionEntities.js";
import { appendHealthEntity } from "../../src/state/healthEntities.js";
import { appendProgressEntity } from "../../src/state/progressEntities.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";

const VALID_MARKER = "schemaVersion: agentera.stateMode.v1\nmode: entities\n";
const ENTITY_ID = "aaaaaaaaaa";
const UNRELATED_ID = "zzzzzzzzzz";
const roots: string[] = [];

type Boundary = "directory" | "stage" | "link" | "final";

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-publication-context-"));
  roots.push(root);
  return root;
}

function activate(root: string): void {
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
}

function request(root: string): StateWriteRequest {
  const spec = operationSpec("progress", "append");
  if (!spec) throw new Error("progress append spec missing");
  const values = {
    timestamp: "2026-07-17 12:00",
    type: "fix",
    phase: "build",
    what: "bind publication",
    verified: "race fixture",
    context: { intent: "prove publication binding", constraints: "progress only" },
  };
  return {
    artifact: "progress",
    spec,
    projectRoot: root,
    dryRun: false,
    force: false,
    values,
    callerPayload: structuredClone(values),
    input: null,
  };
}

function decisionRequest(root: string, verb: "append" | "update", values: Record<string, unknown>): StateWriteRequest {
  const spec = operationSpec("decisions", verb);
  if (!spec) throw new Error(`decisions ${verb} spec missing`);
  return { artifact: "decisions", spec, projectRoot: root, dryRun: false, force: false, values, callerPayload: structuredClone(values), input: null };
}

function healthRequest(root: string): StateWriteRequest {
  const spec = operationSpec("health", "append");
  if (!spec) throw new Error("health append spec missing");
  const values = { date: "2026-07-17", dimensions: ["architecture_alignment"], findings_summary: { critical: 0, warning: 0, info: 0, filtered_by_confidence: 0 }, trajectory: "stable", grades: { architecture_alignment: "A" } };
  return { artifact: "health", spec, projectRoot: root, dryRun: false, force: false, values, callerPayload: structuredClone(values), input: values };
}

function decisionWithSatisfaction(root: string): { target: string; bytes: string } {
  appendDecisionEntity(decisionRequest(root, "append", { date: "2026-07-17", question: "Q?", context: "C", alternatives: { chosen: "A" }, choice: "A", reasoning: "R", confidence: "firm" }), { id: ENTITY_ID });
  updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "open" } }), { id: "bbbbbbbbbb" });
  const target = path.join(root, ".agentera/entities/decisions/decision_satisfaction/bbbbbbbbbb.yaml");
  return { target, bytes: fs.readFileSync(target, "utf8") };
}

function publishProgress(root: string): void {
  const binding = detectStateModeBinding(root);
  if (binding.mode !== "entities") throw new Error("entity mode expected");
  try {
    appendProgressEntity(request(root), {
      id: ENTITY_ID,
      publicationContext: binding.publicationContext,
    });
  } finally {
    binding.publicationContext.close();
  }
}

function unrelatedEntity(root: string): { path: string; bytes: string } {
  const target = path.join(root, `.agentera/entities/health/health_audit/${UNRELATED_ID}.yaml`);
  const bytes = `id: ${UNRELATED_ID}\nartifact: health\nrecord: {}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return { path: target, bytes };
}

function namesBelow(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, encoding: "utf8" });
}

function expectNoAttemptResidue(root: string): void {
  expect(fs.existsSync(path.join(root, `.agentera/entities/progress/progress_cycle/${ENTITY_ID}.yaml`))).toBe(false);
  expect(fs.existsSync(path.join(root, ".agentera/entities/progress"))).toBe(false);
  expect(fs.existsSync(path.join(root, ".agentera/.writer.lock"))).toBe(false);
  expect(namesBelow(path.join(root, ".agentera")).filter((name) =>
    name.includes(".writer.") || name.includes(`.${ENTITY_ID}.yaml.`),
  )).toEqual([]);
}

function installBoundaryMutation(boundary: Boundary, mutate: () => void): () => boolean {
  let mutated = false;
  const once = (): void => {
    if (mutated) return;
    mutated = true;
    mutate();
  };
  const originalMkdir = fs.mkdirSync.bind(fs);
  const originalOpen = fs.openSync.bind(fs);
  const originalLink = fs.linkSync.bind(fs);
  const originalSync = fs.fsyncSync.bind(fs);

  if (boundary === "directory") {
    vi.spyOn(fs, "mkdirSync").mockImplementation((candidate, options) => {
      const result = originalMkdir(candidate, options as never);
      if (String(candidate).endsWith("/entities") || String(candidate).endsWith("/progress")) once();
      return result as never;
    });
  } else if (boundary === "stage") {
    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = originalOpen(candidate, flags, mode);
      if (String(candidate).includes(`.${ENTITY_ID}.yaml.`) && String(candidate).endsWith(".tmp")) once();
      return descriptor;
    });
  } else if (boundary === "link") {
    vi.spyOn(fs, "linkSync").mockImplementation((source, target) => {
      originalLink(source, target);
      if (String(target).endsWith(`/${ENTITY_ID}.yaml`)) once();
    });
  } else {
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      originalSync(descriptor);
      let descriptorPath = "";
      try { descriptorPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`); } catch { /* not a directory descriptor */ }
      if (
        descriptorPath.endsWith("/progress_cycle")
        && fs.existsSync(`/proc/self/fd/${descriptor}/${ENTITY_ID}.yaml`)
      ) once();
    });
  }
  return () => mutated;
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("validated entity publication context", () => {
  for (const boundary of ["directory", "stage", "link", "final"] as const) {
    it(`rolls back a root replacement at the ${boundary} boundary without touching the successor`, () => {
      const parent = project();
      const root = path.join(parent, "project");
      const held = path.join(parent, "held");
      const replacement = path.join(parent, "replacement");
      fs.mkdirSync(root);
      fs.mkdirSync(replacement);
      activate(root);
      activate(replacement);
      const unrelated = unrelatedEntity(replacement);
      const originalRename = fs.renameSync.bind(fs);
      const didMutate = installBoundaryMutation(boundary, () => {
        originalRename(root, held);
        originalRename(replacement, root);
      });

      expect(() => publishProgress(root)).toThrow(/project root .* changed|publication context/i);
      expect(didMutate()).toBe(true);
      expectNoAttemptResidue(held);
      expectNoAttemptResidue(root);
      expect(fs.existsSync(path.join(held, ".agentera/entities"))).toBe(false);
      expect(fs.readFileSync(path.join(root, path.relative(replacement, unrelated.path)), "utf8")).toBe(unrelated.bytes);
      expect(fs.readFileSync(path.join(root, ".agentera/state-mode.yaml"), "utf8")).toBe(VALID_MARKER);
    });

    for (const markerChange of ["remove", "replace"] as const) {
      it(`${markerChange}s the marker at the ${boundary} boundary and rolls back only attempt-owned state`, () => {
        const root = project();
        activate(root);
        const marker = path.join(root, ".agentera/state-mode.yaml");
        const unrelated = unrelatedEntity(root);
        const didMutate = installBoundaryMutation(boundary, () => {
          fs.rmSync(marker);
          if (markerChange === "replace") fs.writeFileSync(marker, VALID_MARKER);
        });

        expect(() => publishProgress(root)).toThrow(/state mode marker .* changed.*conflict/i);
        expect(didMutate()).toBe(true);
        expectNoAttemptResidue(root);
        expect(fs.readFileSync(unrelated.path, "utf8")).toBe(unrelated.bytes);
        expect(fs.existsSync(marker)).toBe(markerChange === "replace");
        if (markerChange === "replace") expect(fs.readFileSync(marker, "utf8")).toBe(VALID_MARKER);
      });
    }
  }

  it("reuses the same context for a second entity family without family-specific race checks", () => {
    const root = project();
    activate(root);
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    try {
      expect(appendHealthEntity(healthRequest(root), {
        publicationContext: binding.publicationContext,
        id: ENTITY_ID,
      })).toMatchObject({ artifact: "health", operation: { idempotent_replay: false } });
    } finally {
      binding.publicationContext.close();
    }
    expect(fs.existsSync(path.join(root, `.agentera/entities/health/health_audit/${ENTITY_ID}.yaml`))).toBe(true);
  });

  for (const boundary of ["rename", "directory-sync"] as const) {
    function installReplacementMutation(target: string, mutate: () => void): () => boolean {
      let mutated = false;
      const once = (): void => { if (!mutated) { mutated = true; mutate(); } };
      if (boundary === "rename") {
        const original = fs.renameSync.bind(fs);
        vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
          original(source, destination);
          if (String(destination).endsWith("/bbbbbbbbbb.yaml") && String(source).endsWith(".tmp")) once();
        });
      } else {
        const original = fs.fsyncSync.bind(fs);
        vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
          original(descriptor);
          let descriptorPath = "";
          try { descriptorPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`); } catch { /* file descriptor */ }
          if (descriptorPath.endsWith("/decision_satisfaction") && fs.existsSync(target)) once();
        });
      }
      return () => mutated;
    }

    it(`restores exact satisfaction bytes after a root change at replacement ${boundary} without touching the successor`, () => {
      const parent = project(); const root = path.join(parent, "project"); const held = path.join(parent, "held"); const successor = path.join(parent, "successor");
      fs.mkdirSync(root); fs.mkdirSync(successor); activate(root); activate(successor);
      const prior = decisionWithSatisfaction(root); const successorTarget = path.join(successor, path.relative(root, prior.target)); const successorBytes = "successor-owned-by-another-root\n";
      fs.mkdirSync(path.dirname(successorTarget), { recursive: true }); fs.writeFileSync(successorTarget, successorBytes);
      const originalRename = fs.renameSync.bind(fs);
      const didMutate = installReplacementMutation(prior.target, () => { originalRename(root, held); originalRename(successor, root); });
      expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "new" } }))).toThrow(/project root .* changed|publication context/i);
      expect(didMutate()).toBe(true);
      expect(fs.readFileSync(path.join(held, path.relative(root, prior.target)), "utf8")).toBe(prior.bytes);
      expect(fs.readFileSync(path.join(root, path.relative(successor, successorTarget)), "utf8")).toBe(successorBytes);
      expect(namesBelow(held).filter((name) => name.includes(".previous") || name.includes(".tmp"))).toEqual([]);
    });

    for (const markerChange of ["remove", "replace"] as const) {
      it(`${markerChange}s the marker at replacement ${boundary} and restores exact satisfaction bytes without residue`, () => {
        const root = project(); activate(root); const marker = path.join(root, ".agentera/state-mode.yaml"); const prior = decisionWithSatisfaction(root);
        const didMutate = installReplacementMutation(prior.target, () => { fs.rmSync(marker); if (markerChange === "replace") fs.writeFileSync(marker, VALID_MARKER); });
        expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "new" } }))).toThrow(/state mode marker .* changed.*conflict/i);
        expect(didMutate()).toBe(true);
        expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes);
        expect(namesBelow(root).filter((name) => name.includes(".previous") || name.includes(".tmp"))).toEqual([]);
      });
    }
  }
});
