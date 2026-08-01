import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendDecisionEntity, updateDecisionSatisfactionEntity } from "../../src/state/decisionEntities.js";
import { appendHealthEntity } from "../../src/state/healthEntities.js";
import { appendProgressEntity } from "../../src/state/progressEntities.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
import { ExactReplacementConflictError, FileReplacementError } from "../../src/state/exactReplacementRecovery.js";
import { detectStateModeBinding } from "../../src/state/stateMode.js";
import { StateWriteInputError } from "../../src/state/write/errors.js";
import { operationSpec, type StateWriteRequest } from "../../src/state/write/operations.js";

const VALID_MARKER = "schemaVersion: agentera.stateMode.v1\nmode: entities\n";
const ENTITY_ID = "aaaaaaaaaa";
const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-publication-context-"));
  roots.push(root);
  return root;
}

function activate(root: string): void {
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera/state-mode.yaml"), VALID_MARKER);
}

function progressRequest(root: string): StateWriteRequest {
  const spec = operationSpec("progress", "append");
  if (!spec) throw new Error("progress append spec missing");
  const values = {
    timestamp: "2026-07-17 12:00",
    type: "fix",
    phase: "build",
    what: "bind publication",
    verified: "portable publication fixture",
    context: { intent: "prove portable publication" },
  };
  return { artifact: "progress", spec, projectRoot: root, dryRun: false, force: false, values, callerPayload: structuredClone(values), input: null };
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

function recoveryFiles(root: string): string[] {
  const recovery = path.join(root, ".agentera/.entity-recovery");
  if (!fs.existsSync(recovery)) return [];
  return fs.readdirSync(recovery, { recursive: true, encoding: "utf8" })
    .map((name) => path.join(recovery, name))
    .filter((file) => path.basename(file) !== ".gitignore" && fs.statSync(file).isFile());
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("portable recoverable entity publication", () => {
  it("uses project-relative standard filesystem paths without a host capability gate", () => {
    const root = project(); activate(root);
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    try {
      expect(binding.publicationContext.pinnedPath()).toBe(root);
      expect(binding.publicationContext.pinnedPath("TODO.md")).toBe(path.join(root, "TODO.md"));
    } finally {
      binding.publicationContext.close();
    }
  });

  it("publishes one immutable entity and reuses the same context across families", () => {
    const root = project(); activate(root);
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    try {
      expect(appendProgressEntity(progressRequest(root), { id: ENTITY_ID, publicationContext: binding.publicationContext }))
        .toMatchObject({ artifact: "progress", operation: { idempotent_replay: false } });
      expect(appendHealthEntity(healthRequest(root), { id: "bbbbbbbbbb", publicationContext: binding.publicationContext }))
        .toMatchObject({ artifact: "health", operation: { idempotent_replay: false } });
    } finally {
      binding.publicationContext.close();
    }
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
  });

  it("preserves an immutable-target competitor detected at the publication boundary", () => {
    const root = project(); activate(root);
    const target = path.join(root, ".agentera/entities/progress/progress_cycle", `${ENTITY_ID}.yaml`);
    const competitor = "competitor bytes\n";
    const competitorStage = path.join(root, "competitor.tmp");
    fs.writeFileSync(competitorStage, competitor);
    const originalLink = fs.linkSync.bind(fs); let injected = false;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      originalLink(source, destination);
      if (!injected && path.resolve(String(destination)) === target) {
        injected = true;
        fs.renameSync(competitorStage, target);
      }
    });

    expect(() => appendProgressEntity(progressRequest(root), { id: ENTITY_ID })).toThrow(ExactReplacementConflictError);
    expect(injected).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(competitor);
    expect(fs.readdirSync(path.dirname(target)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("replaces one file through a complete old-or-new rename boundary", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root);
    const originalRename = fs.renameSync.bind(fs); const observed: string[] = [];
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (String(source).endsWith("/replacement.tmp") && path.resolve(String(target)) === prior.target) {
        observed.push(fs.readFileSync(prior.target, "utf8"));
        const result = originalRename(source, target);
        observed.push(fs.readFileSync(prior.target, "utf8"));
        return result;
      }
      return originalRename(source, target);
    });
    const result = updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "new" } }));
    const published = fs.readFileSync(prior.target, "utf8");
    expect(result).toMatchObject({ operation: { idempotent_replay: false }, record: { evidence: "new" } });
    expect(observed).toEqual([prior.bytes, published]);
    expect(recoveryFiles(root)).toEqual([]);
  });

  it("detects changed bytes before publication and preserves them without replacement effects", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root);
    const competitor = "detected concurrent bytes\n"; fs.writeFileSync(prior.target, competitor);
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    try {
      expect(() => binding.publicationContext.replaceExisting(path.relative(root, prior.target), Buffer.from(prior.bytes), "replacement\n", 32_768))
        .toThrow(ExactReplacementConflictError);
    } finally {
      binding.publicationContext.close();
    }
    expect(fs.readFileSync(prior.target, "utf8")).toBe(competitor);
    expect(recoveryFiles(root)).toEqual([]);
  });

  it("reports an operational rename failure before effects and leaves the exact baseline", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root);
    const originalRename = fs.renameSync.bind(fs); let injected = false;
    vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
      if (!injected && String(source).endsWith("/replacement.tmp") && path.resolve(String(target)) === prior.target) {
        injected = true;
        throw Object.assign(new Error("injected rename EIO"), { code: "EIO" });
      }
      return originalRename(source, target);
    });
    expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "must not publish" } })))
      .toThrow(FileReplacementError);
    expect(injected).toBe(true);
    expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes);
    expect(recoveryFiles(root)).toEqual([]);
  });

  it("restores exact prior bytes when the marker changes at the final validation boundary", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root);
    const marker = path.join(root, ".agentera/state-mode.yaml"); const originalOpen = fs.openSync.bind(fs); let injected = false;
    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      const descriptor = originalOpen(candidate, flags, mode);
      if (!injected && String(candidate).endsWith("/replacement.json")) {
        injected = true;
        fs.writeFileSync(marker, `${VALID_MARKER}# changed\n`);
      }
      return descriptor;
    });
    expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "must roll back" } })))
      .toThrow(StateWriteInputError);
    expect(injected).toBe(true);
    expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes);
    expect(recoveryFiles(root)).toEqual([]);
  });

  it("rejects unsafe target and recovery paths before canonical bytes change", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root);
    const binding = detectStateModeBinding(root);
    if (binding.mode !== "entities") throw new Error("entity mode expected");
    try {
      expect(() => binding.publicationContext.replaceExisting("../outside", Buffer.from(prior.bytes), "unsafe\n", 32_768))
        .toThrow(StateWriteInputError);
    } finally {
      binding.publicationContext.close();
    }
    expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes);

    const outside = project(); fs.symlinkSync(outside, path.join(root, ".agentera/.entity-recovery"));
    expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "unsafe recovery" } })))
      .toThrow(/symbolic link|recovery root/i);
    expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("keeps failed post-commit cleanup private and replay-safe", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root);
    const originalUnlink = fs.unlinkSync.bind(fs); let injected = false;
    vi.spyOn(fs, "unlinkSync").mockImplementation((candidate) => {
      if (!injected && String(candidate).endsWith("/original.previous")) {
        injected = true;
        throw Object.assign(new Error("injected cleanup EIO"), { code: "EIO" });
      }
      return originalUnlink(candidate);
    });
    const request = decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "cleanup residue" } });
    expect(updateDecisionSatisfactionEntity(request)).toMatchObject({ operation: { idempotent_replay: false } });
    expect(injected).toBe(true);
    expect(fs.readFileSync(prior.target, "utf8")).toContain("cleanup residue");
    expect(recoveryFiles(root).map((file) => path.basename(file))).toEqual(["original.previous"]);
    expect(updateDecisionSatisfactionEntity(request)).toMatchObject({ operation: { idempotent_replay: true } });
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
  });

  it("keeps retained recovery payloads out of ordinary Git staging", () => {
    const root = project(); activate(root); decisionWithSatisfaction(root);
    git(root, "init"); git(root, "add", "."); git(root, "-c", "user.name=Agentera Test", "-c", "user.email=agentera@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture baseline");
    const originalUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((candidate) => {
      if (String(candidate).endsWith("/original.previous")) throw Object.assign(new Error("injected cleanup EIO"), { code: "EIO" });
      return originalUnlink(candidate);
    });
    updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "git confined" } }));
    const retained = recoveryFiles(root); expect(retained.map((file) => path.basename(file))).toEqual(["original.previous"]);
    const marker = path.join(root, ".agentera/.entity-recovery/.gitignore"); expect(fs.readFileSync(marker, "utf8")).toBe("*\n!.gitignore\n");
    expect(git(root, "status", "--short", "--untracked-files=all").split("\n").filter((line) => line.includes(".entity-recovery"))).toEqual(["?? .agentera/.entity-recovery/.gitignore"]);
  });
});
