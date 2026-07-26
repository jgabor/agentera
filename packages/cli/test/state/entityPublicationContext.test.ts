import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { appendDecisionEntity, updateDecisionSatisfactionEntity } from "../../src/state/decisionEntities.js";
import { appendHealthEntity } from "../../src/state/healthEntities.js";
import { appendProgressEntity } from "../../src/state/progressEntities.js";
import { validateEntityState } from "../../src/state/entityStorage.js";
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

function recoveryFiles(root: string): string[] {
  const recovery = path.join(root, ".agentera/.entity-recovery");
  if (!fs.existsSync(recovery)) return [];
  return fs.readdirSync(recovery, { recursive: true, encoding: "utf8" }).map((name) => path.join(recovery, name)).filter((file) => path.basename(file) !== ".gitignore" && fs.statSync(file).isFile());
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
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

  for (const boundary of ["link", "directory-sync"] as const) {
    function installReplacementMutation(target: string, mutate: () => void): () => boolean {
      let mutated = false;
      const once = (): void => { if (!mutated) { mutated = true; mutate(); } };
      if (boundary === "link") {
        const original = fs.linkSync.bind(fs);
        vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
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

  it("restores the pinned original when displaced-target revalidation cannot open", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root); const originalOpen = fs.openSync.bind(fs); let injected = false;
    vi.spyOn(fs, "openSync").mockImplementation((candidate, flags, mode) => {
      if (!injected && String(candidate).endsWith(".displaced")) { injected = true; throw Object.assign(new Error("injected displaced open failure"), { code: "EIO" }); }
      return originalOpen(candidate, flags, mode);
    });
    expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "new" } }))).toThrow(/displaced open failure.*restored|restored.*displaced open failure/i);
    expect(injected).toBe(true); expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes);
    expect(fs.readdirSync(path.dirname(prior.target)).filter((name) => name.includes(".previous") || name.includes(".tmp") || name.includes(".displaced"))).toEqual([]);
  });

  it("restores the pinned original after a non-EEXIST no-clobber publication failure", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root); const originalLink = fs.linkSync.bind(fs); let injected = false;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (!injected && String(source).endsWith(".tmp") && String(destination).endsWith("/bbbbbbbbbb.yaml")) { injected = true; throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" }); }
      return originalLink(source, destination);
    });
    expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "new" } }))).toThrow(/ENOSPC.*restored|restored.*ENOSPC/i);
    expect(injected).toBe(true); expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes);
    expect(fs.readdirSync(path.dirname(prior.target)).filter((name) => name.includes(".previous") || name.includes(".tmp") || name.includes(".displaced"))).toEqual([]);
  });

  for (const boundary of ["write", "fsync"] as const) {
    it(`fails before displacement when exact baseline snapshot ${boundary} fails`, () => {
      const root = project(); activate(root); const prior = decisionWithSatisfaction(root); let injected = false;
      const descriptorName = (descriptor: number): string => { try { return fs.readlinkSync(`/proc/self/fd/${descriptor}`); } catch { return ""; } };
      if (boundary === "write") {
        const originalWrite = fs.writeFileSync.bind(fs);
        vi.spyOn(fs, "writeFileSync").mockImplementation((candidate, data, options) => {
          if (!injected && typeof candidate === "number" && descriptorName(candidate).endsWith("/original.previous")) { injected = true; throw Object.assign(new Error("injected snapshot write EIO"), { code: "EIO" }); }
          return originalWrite(candidate, data, options as never);
        });
      } else {
        const originalSync = fs.fsyncSync.bind(fs);
        vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
          if (!injected && descriptorName(descriptor).endsWith("/original.previous")) { injected = true; throw Object.assign(new Error("injected snapshot fsync EIO"), { code: "EIO" }); }
          return originalSync(descriptor);
        });
      }
      expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "must not publish" } }))).toThrow(new RegExp(`snapshot ${boundary} EIO`));
      expect(injected).toBe(true); expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes); expect(recoveryFiles(root)).toEqual([]); expect(fs.existsSync(path.join(root, ".agentera/.entity-recovery"))).toBe(false);
    });
  }

  it("retains an independent exact baseline snapshot when an in-place competitor changes the displaced inode", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root); const baseline = fs.readFileSync(prior.target); const competitor = "in-place competitor bytes\n"; const originalSync = fs.fsyncSync.bind(fs); const originalWrite = fs.writeFileSync.bind(fs); let injected = false; let failure: unknown;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      originalSync(descriptor);
      let descriptorPath = ""; try { descriptorPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`); } catch { /* descriptor already closed */ }
      if (!injected && descriptorPath.endsWith("/replacement.tmp")) { injected = true; originalWrite(prior.target, competitor); }
    });
    try { updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "must not publish" } })); } catch (error) { failure = error; }
    const snapshots = recoveryFiles(root).filter((file) => file.endsWith("/original.previous"));
    expect(injected).toBe(true); expect(String(failure)).toMatch(/competitor.*baseline snapshot|baseline snapshot.*competitor/i); expect(fs.readFileSync(prior.target, "utf8")).toBe(competitor); expect(snapshots).toHaveLength(1); expect(fs.readFileSync(snapshots[0])).toEqual(baseline);
    const targetStat = fs.statSync(prior.target, { bigint: true }); const snapshotStat = fs.statSync(snapshots[0], { bigint: true }); expect(snapshotStat.ino).not.toBe(targetStat.ino); expect(snapshotStat.nlink).toBe(1n); expect(snapshotStat.mode & 0o077n).toBe(0n);
  });

  it("never clobbers a competitor created after displacement and surfaces retained original bytes", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root); const competitor = "competitor after displacement\n"; const originalLink = fs.linkSync.bind(fs); const originalWrite = fs.writeFileSync.bind(fs); let injected = false; let failure: unknown;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (!injected && String(source).endsWith(".tmp") && String(destination).endsWith("/bbbbbbbbbb.yaml")) { injected = true; originalWrite(prior.target, competitor); }
      return originalLink(source, destination);
    });
    try { updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "new" } })); } catch (error) { failure = error; }
    const recovery = recoveryFiles(root).filter((file) => file.endsWith(".previous"));
    expect(injected).toBe(true); expect(String(failure)).toMatch(/competing.*retained|retained.*competing/i); expect(recovery).toHaveLength(1); expect(String(failure)).toContain(path.basename(recovery[0]));
    expect(fs.readFileSync(prior.target, "utf8")).toBe(competitor); expect(fs.readFileSync(recovery[0], "utf8")).toBe(prior.bytes);
    expect(fs.readdirSync(path.dirname(prior.target)).filter((name) => name.includes(".previous") || name.includes(".tmp") || name.includes(".displaced"))).toEqual([]);
  });

  it("retains original and staged bytes with actionable paths when restoration also fails", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root); const originalLink = fs.linkSync.bind(fs); let publicationFailed = false; let restorationFailed = false; let failure: unknown;
    vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
      if (!publicationFailed && String(source).endsWith(".tmp") && String(destination).endsWith("/bbbbbbbbbb.yaml")) { publicationFailed = true; throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" }); }
      if (!restorationFailed && String(source).endsWith(".previous") && String(destination).endsWith("/bbbbbbbbbb.yaml")) { restorationFailed = true; throw Object.assign(new Error("injected restore EIO"), { code: "EIO" }); }
      return originalLink(source, destination);
    });
    try { updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "new" } })); } catch (error) { failure = error; }
    const names = recoveryFiles(root); const originalRecovery = names.find((name) => name.endsWith(".previous")); const stageRecovery = names.find((name) => name.endsWith(".tmp"));
    expect(publicationFailed && restorationFailed).toBe(true); expect(fs.existsSync(prior.target)).toBe(false); expect(originalRecovery).toBeTruthy(); expect(stageRecovery).toBeTruthy();
    expect(fs.readFileSync(originalRecovery!, "utf8")).toBe(prior.bytes); expect(fs.readFileSync(stageRecovery!, "utf8")).toContain("evidence: new"); expect(String(failure)).toContain(path.basename(originalRecovery!)); expect(String(failure)).toContain(path.basename(stageRecovery!));
    expect(fs.readdirSync(path.dirname(prior.target)).filter((name) => name.includes(".previous") || name.includes(".tmp") || name.includes(".displaced"))).toEqual([]);
  });

  it("removes all attempt recovery links after successful replacement", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root);
    expect(updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "new" } }))).toMatchObject({ operation: { idempotent_replay: false } });
    expect(fs.readFileSync(prior.target, "utf8")).not.toBe(prior.bytes);
    expect(fs.readdirSync(path.dirname(prior.target)).filter((name) => name.includes(".previous") || name.includes(".tmp") || name.includes(".displaced"))).toEqual([]);
    expect(recoveryFiles(root)).toEqual([]); expect(fs.existsSync(path.join(root, ".agentera/.entity-recovery"))).toBe(false);
  });

  it("rejects an unsafe private recovery-root link before displacement", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root); const outside = project(); fs.symlinkSync(outside, path.join(root, ".agentera/.entity-recovery"));
    expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "unsafe" } }))).toThrow(/symbolic link|ELOOP|recovery root/i);
    expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes); expect(fs.readdirSync(outside)).toEqual([]);
  });

  for (const authorityFailure of ["writable root", "symlink marker", "writable marker", "changed marker"] as const) {
    it(`rejects a pre-existing ${authorityFailure} recovery authority before displacement`, () => {
      const root = project(); activate(root); const prior = decisionWithSatisfaction(root); const recoveryRoot = path.join(root, ".agentera/.entity-recovery"); fs.mkdirSync(recoveryRoot, { mode: 0o700 });
      const marker = path.join(recoveryRoot, ".gitignore");
      if (authorityFailure === "writable root") fs.chmodSync(recoveryRoot, 0o770);
      else if (authorityFailure === "symlink marker") { const outside = path.join(project(), "outside-ignore"); fs.writeFileSync(outside, "outside\n"); fs.symlinkSync(outside, marker); }
      else { fs.writeFileSync(marker, authorityFailure === "changed marker" ? "not authoritative\n" : "*\n!.gitignore\n", { mode: 0o600 }); if (authorityFailure === "writable marker") fs.chmodSync(marker, 0o660); }
      expect(() => updateDecisionSatisfactionEntity(decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "unsafe authority" } }))).toThrow(/recovery root|ignore marker|symbolic link|ELOOP/i);
      expect(fs.readFileSync(prior.target, "utf8")).toBe(prior.bytes); expect(fs.readdirSync(recoveryRoot).filter((name) => name.startsWith("entity-"))).toEqual([]);
    });
  }

  it("keeps committed replacement successful when final cleanup fsync fails", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root); const originalSync = fs.fsyncSync.bind(fs); let directorySyncs = 0; let injected = false;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      let descriptorPath = ""; try { descriptorPath = fs.readlinkSync(`/proc/self/fd/${descriptor}`); } catch { /* file descriptor */ }
      if (descriptorPath.includes("/.entity-recovery/entity-") && fs.fstatSync(descriptor).isDirectory() && ++directorySyncs === 2) { injected = true; throw Object.assign(new Error("injected final cleanup fsync EIO"), { code: "EIO" }); }
      return originalSync(descriptor);
    });
    const request = decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "committed" } });
    expect(updateDecisionSatisfactionEntity(request)).toMatchObject({ operation: { idempotent_replay: false }, record: { evidence: "committed" } });
    expect(injected).toBe(true); expect(fs.readFileSync(prior.target, "utf8")).toContain("evidence: committed");
    expect(updateDecisionSatisfactionEntity(request)).toMatchObject({ operation: { idempotent_replay: true } });
    expect(fs.readdirSync(path.dirname(prior.target)).filter((name) => name.includes(".previous") || name.includes(".tmp") || name.includes(".displaced"))).toEqual([]);
  });

  it("keeps persistent post-commit unlink residue private, valid, and replayable", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root); const originalUnlink = fs.unlinkSync.bind(fs); const injected = new Set<string>();
    vi.spyOn(fs, "unlinkSync").mockImplementation((candidate) => {
      const suffix = String(candidate).endsWith(".displaced") ? "displaced" : String(candidate).endsWith(".previous") ? "previous" : "";
      if (suffix) { injected.add(suffix); throw Object.assign(new Error(`injected persistent ${suffix} unlink EIO`), { code: "EIO" }); }
      return originalUnlink(candidate);
    });
    const request = decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "unlink retry" } });
    expect(updateDecisionSatisfactionEntity(request)).toMatchObject({ operation: { idempotent_replay: false }, record: { evidence: "unlink retry" } });
    const retained = recoveryFiles(root); expect([...injected].sort()).toEqual(["displaced", "previous"]); expect(fs.readFileSync(prior.target, "utf8")).toContain("evidence: unlink retry");
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 }); expect(retained.some((file) => fs.readFileSync(file, "utf8") === prior.bytes)).toBe(true);
    expect(fs.readdirSync(path.dirname(prior.target)).filter((name) => name.includes(".previous") || name.includes(".tmp") || name.includes(".displaced"))).toEqual([]);
    expect(updateDecisionSatisfactionEntity(request)).toMatchObject({ operation: { idempotent_replay: true } });
    expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 }); expect(recoveryFiles(root)).toEqual(retained);
  });

  it("confines persistent recovery payloads from Git status and ordinary staging", () => {
    const root = project(); activate(root); const prior = decisionWithSatisfaction(root);
    git(root, "init"); git(root, "add", "."); git(root, "-c", "user.name=Agentera Test", "-c", "user.email=agentera@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture baseline");
    const originalUnlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, "unlinkSync").mockImplementation((candidate) => {
      if (String(candidate).endsWith(".displaced") || String(candidate).endsWith(".previous")) throw Object.assign(new Error("injected persistent recovery unlink EIO"), { code: "EIO" });
      return originalUnlink(candidate);
    });
    const request = decisionRequest(root, "update", { id: ENTITY_ID, satisfaction: { state: "provisionally_satisfied", evidence: "git confined" } });
    expect(updateDecisionSatisfactionEntity(request)).toMatchObject({ operation: { idempotent_replay: false } });
    const retained = recoveryFiles(root); expect(retained.map((file) => path.basename(file)).sort()).toEqual(["original.displaced", "original.previous"]);
    const marker = path.join(root, ".agentera/.entity-recovery/.gitignore"); expect(fs.readFileSync(marker, "utf8")).toBe("*\n!.gitignore\n");
    const statusRecovery = git(root, "status", "--short", "--untracked-files=all").split("\n").filter((line) => line.includes(".entity-recovery")); expect(statusRecovery).toEqual(["?? .agentera/.entity-recovery/.gitignore"]);
    for (const file of retained) expect(git(root, "check-ignore", "-v", path.relative(root, file))).toContain(".agentera/.entity-recovery/.gitignore:1:*");
    git(root, "add", ".");
    expect(git(root, "diff", "--cached", "--name-only", "--", ".agentera/.entity-recovery").trim()).toBe(".agentera/.entity-recovery/.gitignore");
    expect(git(root, "ls-files", "--others", "--exclude-standard", "--", ".agentera/.entity-recovery").trim()).toBe("");
    expect(fs.readFileSync(prior.target, "utf8")).toContain("evidence: git confined"); expect(validateEntityState(root)).toMatchObject({ valid: true, entityCount: 2 });
    expect(updateDecisionSatisfactionEntity(request)).toMatchObject({ operation: { idempotent_replay: true } }); expect(recoveryFiles(root)).toEqual(retained);
  });
});
