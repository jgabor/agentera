import fs from "node:fs";
import path from "node:path";
import { runHostSkillConversion, hasPendingHostSkillConversion } from "./hostSkillConversion.js";

import { NPX_BUNDLE_SENTINEL } from "../core/sourceRoot.js";
import { declaresAgenteraSkill } from "../core/skillIdentity.js";
import { loadRegistry } from "../registries/packageRegistry.js";
import { acquireLifecycleOwnershipJournalLock, appendLifecycleOwnershipJournal, lifecycleOwnershipJournalPath, readLifecycleOwnershipJournal, releaseLifecycleOwnershipJournalLock } from "../runtime/lifecycleOwnershipJournal.js";
import { applyLifecycleOperations, createLifecycleOwnershipManifest, lifecycleOperationFingerprint, planLifecycleOperations, type LifecycleApplyOptions, type LifecycleOperationSpec } from "../runtime/lifecycleOperations.js";
import { observeLifecyclePath, secureLifecycleRemovalAvailable } from "../runtime/lifecyclePublication.js";

export const HOST_SKILL_DIRECTORY_ID = "shared-skill.directory";
export const HOST_SKILL_FILE_ID = "shared-skill.bootstrap";
export const HOST_SKILL_REFRESH_BASE_ID = "shared-skill.refresh-base";
export const HOST_SKILL_RECOVERY =
  "Preserve the reported destination and ownership journal. Review changed ownership, extra entries or legacy links/trees manually; this route never deletes or adopts them. Retry the same approved command after interruption. If ownership cannot be proven, move only the reviewed conflicting host directory aside with separate user approval, then preview a fresh install. Never prune a link target or remove unrelated app/project data.";

export function hostSkillPath(home: string): string {
  return path.join(path.resolve(home), ".agents", "skills", "agentera");
}

export function isCompatibleHostSkill(content: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  return declaresAgenteraSkill(content) && frontmatter !== undefined && /^version:\s*["']?3\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?["']?\s*$/m.test(frontmatter);
}

/** The host selection is distinct from the retained internal runtime skill tree. */
export function loadHostSkillSource(sourceRoot: string) {
  const registry = loadRegistry(path.join(sourceRoot, "references/adapters/package-registry.yaml"), sourceRoot);
  const surfaces = registry.get().bundle_surfaces as {
    host_skill: { source: string; path: string };
  };
  const selection = surfaces.host_skill;
  const relative = fs.existsSync(path.join(sourceRoot, NPX_BUNDLE_SENTINEL)) ? path.join(selection.path, "SKILL.md") : selection.source;
  const source = path.join(sourceRoot, relative);
  const observation = observeLifecyclePath(source, [sourceRoot]);
  if (observation.unsafeReason || observation.kind !== "file" || fs.lstatSync(source).nlink !== 1) throw new Error("Selected host bootstrap must be a safe regular file; repair the selected CLI distribution/runtime authority.");
  const content = fs.readFileSync(source, "utf8");
  if (!isCompatibleHostSkill(content)) throw new Error("Selected host bootstrap is incompatible with this CLI.");
  return {
    source,
    selection,
    content,
    version: registry.suiteVersion(),
    fingerprint: lifecycleOperationFingerprint({
      id: HOST_SKILL_FILE_ID,
      destination: source,
      kind: "file",
      intent: "ensure",
      content,
    })!,
  };
}

export interface HostSkillLifecycleArgs {
  home: string;
  appHome: string;
  sourceRoot: string;
  /** Explicit user permission, never inferred from discovery or project permission. */
  apply: boolean;
  authorization?: string | null;
}

export function runHostSkillLifecycle(args: HostSkillLifecycleArgs, options: LifecycleApplyOptions = {}) {
  const target = hostSkillPath(args.home);
  const observed = observeLifecyclePath(target, [path.resolve(args.home)]);
  const legacy = !observed.unsafeReason && (observed.kind === "symlink" || (observed.kind === "directory" && fs.readdirSync(target).some((name) => name !== "SKILL.md")));
  if (args.authorization || legacy || hasPendingHostSkillConversion(args.appHome)) return runHostSkillConversion(args, options);
  return runOneFileHostSkillLifecycle(args, options);
}

export function runOneFileHostSkillLifecycle(args: HostSkillLifecycleArgs, options: LifecycleApplyOptions = {}) {
  const home = path.resolve(args.home);
  const target = hostSkillPath(home);
  const file = path.join(target, "SKILL.md");
  const journalPath = lifecycleOwnershipJournalPath(args.appHome);
  const result = (status: "pending" | "success" | "noop" | "non_success", reason: string, operations: unknown[] = []) => ({
    schemaVersion: "agentera.hostSkillLifecycle.v1" as const,
    mode: args.apply ? "apply" : "preview",
    status,
    approval: args.apply ? "approved" : "not_requested",
    path: target,
    ownershipJournal: journalPath,
    reason,
    operations,
    recovery: HOST_SKILL_RECOVERY,
  });
  try {
    const source = loadHostSkillSource(args.sourceRoot);
    for (const destination of [target, journalPath]) {
      const relative = path.relative(path.resolve(args.sourceRoot), destination);
      if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) return result("non_success", "Host publication and ownership state must stay outside the internal runtime authority.");
    }
    // The one-file namespace may not contain its own ledger or runtime source.
    for (const other of [path.resolve(args.appHome), path.resolve(args.sourceRoot)]) {
      const rel = path.relative(target, other);
      if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) return result("non_success", "Host directory cannot contain app state or runtime authority.");
    }
    const homeObservation = observeLifecyclePath(home, [path.parse(home).root]);
    if (homeObservation.unsafeReason || homeObservation.kind !== "directory") return result("non_success", "Home must be an existing directory with no symlink ancestors.");
    const inspect = () => {
      const journal = readLifecycleOwnershipJournal(journalPath);
      if (!["absent", "clean"].includes(journal.state)) throw new Error(`Ownership journal is ${journal.state}; preserve it for explicit recovery.`);
      const requireCreatedIdentity = (resourceId: string, kind: string) => {
        // Intent persisted before create cannot prove who created an existing path.
        // Do not let the generic planner recover host ownership from bytes/shape.
        if (kind !== "missing" && journal.ledger.records.some((entry) => entry.resourceId === resourceId && entry.status === "pending_create" && !entry.identity))
          throw new Error(`${resourceId} exists but its interrupted create has no recorded publication identity; preserve the destination and ownership journal for manual recovery with separate user approval.`);
      };
      const directory = observeLifecyclePath(target, [home]);
      if (directory.unsafeReason) throw new Error(directory.unsafeReason);
      requireCreatedIdentity(HOST_SKILL_DIRECTORY_ID, directory.kind);
      if (!["missing", "directory"].includes(directory.kind)) throw new Error("Legacy link or wrong-type host destination is preserved; conversion is not supported by this route.");
      if (directory.kind === "directory" && fs.readdirSync(target).some((name) => name !== "SKILL.md")) throw new Error("Host directory has extra entries; all entries are preserved. Legacy full-tree conversion requires separate approval and tooling.");
      const observedFile = observeLifecyclePath(file, [home]);
      if (observedFile.unsafeReason) throw new Error(observedFile.unsafeReason);
      requireCreatedIdentity(HOST_SKILL_FILE_ID, observedFile.kind);
      if (observedFile.kind === "file" && fs.lstatSync(file).nlink !== 1) throw new Error("Hard-linked bootstrap is preserved; whole-file ownership is unsafe.");
      const record = journal.ledger.records.find((entry) => entry.resourceId === HOST_SKILL_FILE_ID);
      if (record?.status === "pending_create" && observedFile.kind === "file" && observedFile.fingerprint !== source.fingerprint) {
        const partial = fs.readFileSync(file);
        const desired = Buffer.from(source.content);
        const base = journal.ledger.records.find((entry) => entry.resourceId === HOST_SKILL_REFRESH_BASE_ID);
        const unchangedBase = base?.destination === file && base.fingerprint === observedFile.fingerprint && base.identity?.device === record.identity?.device && base.identity?.inode === record.identity?.inode;
        if (record.fingerprint !== source.fingerprint || (!unchangedBase && (partial.length > desired.length || !partial.equals(desired.subarray(0, partial.length))))) throw new Error("Interrupted bootstrap no longer matches the intended publication prefix; preserve changed bytes for explicit recovery.");
      }
      if (record?.status === "managed" && observedFile.kind === "file" && record.fingerprint !== observedFile.fingerprint && source.fingerprint !== observedFile.fingerprint) throw new Error("Owned bootstrap bytes were modified outside a completed publication; preserved for explicit recovery.");
      const operations: LifecycleOperationSpec[] = [];
      for (const [index, destination] of [path.join(home, ".agents"), path.join(home, ".agents", "skills")].entries()) {
        const observed = observeLifecyclePath(destination, [home]);
        if (observed.unsafeReason || !["missing", "directory"].includes(observed.kind)) throw new Error("Host parent is unsafe; preserved without repair.");
        requireCreatedIdentity(`shared-skill.parent-${index}`, observed.kind);
        if (observed.kind === "missing")
          operations.push({
            id: `shared-skill.parent-${index}`,
            destination,
            kind: "directory",
            intent: "ensure",
          });
      }
      operations.push(
        { id: HOST_SKILL_DIRECTORY_ID, destination: target, kind: "directory", intent: "ensure" },
        {
          id: HOST_SKILL_FILE_ID,
          destination: file,
          kind: "file",
          intent: "ensure",
          content: source.content,
        },
      );
      for (let index = 1; index < operations.length; index++) operations[index].dependsOn = [operations[index - 1].id];
      return planLifecycleOperations({
        allowedRoots: [home],
        operations,
        manifest: createLifecycleOwnershipManifest(operations),
        ledger: journal.ledger,
      });
    };
    const preview = inspect();
    const blockers = preview.operations.filter((op) => ["blocked_unowned", "action_required"].includes(op.action));
    if (blockers.length) return result("non_success", "Ownership or path review required; nothing was changed.", preview.operations);
    if (!args.apply) return result(preview.operations.every((op) => op.action === "noop") ? "noop" : "pending", "Read-only preview. Apply only with explicit user approval using --yes.", preview.operations);
    if (!secureLifecycleRemovalAvailable()) return result("non_success", "Safe publication requires Linux /proc/self/fd, O_DIRECTORY and O_NOFOLLOW.");
    const lock = acquireLifecycleOwnershipJournalLock(journalPath);
    try {
      const plan = inspect();
      const applied = applyLifecycleOperations(plan, {
        checkpointFileCreation: true,
        persistLedger: (ledger) => {
          const completed = ledger.records.some((entry) => entry.resourceId === HOST_SKILL_FILE_ID && entry.status === "managed");
          const next = completed
            ? {
                ...ledger,
                records: ledger.records.filter((entry) => entry.resourceId !== HOST_SKILL_REFRESH_BASE_ID),
              }
            : ledger;
          appendLifecycleOwnershipJournal(journalPath, next);
          options.persistLedger?.(next);
        },
        beforePublication: (boundary) => {
          options.beforePublication?.(boundary);
          // Recheck the namespace at the actual publication boundary, not just preview.
          const current = inspect();
          if (current.operations.some((op) => ["blocked_unowned", "action_required"].includes(op.action))) throw new Error("Ownership changed before host publication.");
          // Persist intended bytes before conditional in-place update. A killed
          // writer can resume only that prefix through its recorded identity.
          if (boundary.operationId === HOST_SKILL_FILE_ID && boundary.action === "update") {
            const ledger = current.request.ledger!;
            const record = ledger.records.find((entry) => entry.resourceId === HOST_SKILL_FILE_ID);
            if (record?.status === "managed") {
              const next = {
                ...ledger,
                records: [
                  ...ledger.records
                    .filter((entry) => entry.resourceId !== HOST_SKILL_REFRESH_BASE_ID)
                    .map((entry) =>
                      entry === record
                        ? {
                            ...entry,
                            status: "pending_create" as const,
                            fingerprint: source.fingerprint,
                          }
                        : entry,
                    ),
                  { ...record, resourceId: HOST_SKILL_REFRESH_BASE_ID },
                ],
              };
              appendLifecycleOwnershipJournal(journalPath, next);
              options.persistLedger?.(next);
            }
          }
        },
      });
      const final = inspect();
      const exact = fs.readdirSync(target).length === 1 && final.operations.every((op) => op.action === "noop");
      return result(applied.status !== "success" || !exact ? "non_success" : applied.summary.applied ? "success" : "noop", exact ? "Exactly one owned regular SKILL.md; internal runtime and unrelated state unchanged." : "Publication did not converge; preserve evidence and follow recovery.", applied.operations);
    } finally {
      releaseLifecycleOwnershipJournalLock(lock);
    }
  } catch (error) {
    return result("non_success", (error as Error).message);
  }
}
