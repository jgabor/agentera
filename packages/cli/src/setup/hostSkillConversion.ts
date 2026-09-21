import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { acquireLifecycleOwnershipJournalLock, appendLifecycleOwnershipJournal, lifecycleOwnershipJournalPath, readLifecycleOwnershipJournal, releaseLifecycleOwnershipJournalLock, type LifecycleOwnershipJournalLock } from "../runtime/lifecycleOwnershipJournal.js";
import { applyLifecycleOperations, createLifecycleOwnershipManifest, planLifecycleOperations, type LifecycleApplyOptions, type LifecycleOwnershipRecord } from "../runtime/lifecycleOperations.js";
import { observeLifecyclePath, retainLifecycleResource, sameLifecycleIdentity, secureLifecycleRemovalAvailable } from "../runtime/lifecyclePublication.js";
import { hostSkillPath, loadHostSkillSource, runOneFileHostSkillLifecycle, type HostSkillLifecycleArgs } from "./hostSkillLifecycle.js";

const PREFIX = "shared-skill.conversion.";
const RETAINED = "shared-skill.retained.";
const RECOVERY =
  "Preserve the host, retained data and operation journal. Retry with the same --home, --install-root, --yes and --authorization token after interruption. Changed bytes, identities, source selection or scope require review before further effects. Approval covers the dedicated Agentera installation, not its symlink targets or other host, app or project data.";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + path.sep);

export function hasPendingHostSkillConversion(appHome: string): boolean {
  return readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(appHome)).ledger.records.some((record) => record.resourceId.startsWith(PREFIX) && record.status === "pending_create");
}

/** Approval manages the dedicated installation as a whole; the journal records this operation, not historical ownership. */
export function runHostSkillConversion(args: HostSkillLifecycleArgs, options: LifecycleApplyOptions = {}) {
  const home = path.resolve(args.home),
    appHome = path.resolve(args.appHome),
    sourceRoot = path.resolve(args.sourceRoot);
  const target = hostSkillPath(home),
    journalPath = lifecycleOwnershipJournalPath(appHome);
  let approved = false;
  const result = (status: "pending" | "success" | "noop" | "non_success", reason: string, detail: Record<string, unknown> = {}) => ({
    schemaVersion: "agentera.hostSkillLifecycle.v1" as const,
    mode: args.apply ? "apply" : "preview",
    status,
    approval: approved ? "approved" : "not_requested",
    path: target,
    ownershipJournal: journalPath,
    reason,
    operations: [] as unknown[],
    recovery: RECOVERY,
    ...detail,
  });
  try {
    const inspect = () => {
      const source = loadHostSkillSource(sourceRoot);
      if (inside(target, sourceRoot) || inside(target, appHome) || inside(sourceRoot, target) || inside(sourceRoot, journalPath)) throw new Error("Host, runtime authority and ownership state must not overlap.");
      const homeState = observeLifecyclePath(home, [path.parse(home).root]);
      if (homeState.unsafeReason || homeState.kind !== "directory") throw new Error("Home must be an existing safe directory.");
      const journal = readLifecycleOwnershipJournal(journalPath);
      if (!["absent", "clean"].includes(journal.state)) throw new Error(`Ownership journal is ${journal.state}; preserve it for explicit recovery.`);
      const markers = journal.ledger.records.filter((record) => record.resourceId.startsWith(PREFIX) && (record.status === "pending_create" || args.authorization === `sha256:${record.resourceId.slice(PREFIX.length)}`));
      if (markers.length > 1) throw new Error("Ambiguous host conversion operation; preserve all resources and report the blocked operation.");
      const marker = markers[0];
      const previousToken = marker?.resourceId.slice(PREFIX.length);
      if (previousToken && !/^[a-f0-9]{64}$/.test(previousToken)) throw new Error("Invalid conversion ownership record.");
      const moved = marker && observeLifecyclePath(marker.destination, [appHome]).kind !== "missing";
      const root = moved ? marker.destination : target;
      if (marker && marker.destination !== path.join(path.dirname(journalPath), `host-conversion-${previousToken}`, "legacy")) throw new Error("Conversion retention scope does not match this app home.");
      const entries: Array<{
        relative: string;
        record: LifecycleOwnershipRecord;
        linkTarget?: string;
      }> = [];
      const visit = (at: string) => {
        if (entries.length >= 4096) throw new Error("Legacy tree exceeds the supported 4096-entry conversion inventory; no update is offered.");
        const relative = path.relative(root, at),
          destination = path.join(target, relative);
        const observed = observeLifecyclePath(at, [moved ? appHome : home]);
        if (observed.unsafeReason || !["directory", "file", "symlink"].includes(observed.kind)) throw new Error(`Unsafe or missing legacy entry: ${destination}`);
        if (observed.kind === "file" && fs.lstatSync(at).nlink !== 1) throw new Error(`Hard-linked legacy entry is not supported: ${destination}`);
        entries.push({
          relative,
          record: {
            resourceId: `shared-skill.snapshot.${digest(relative)}`,
            destination,
            kind: observed.kind as LifecycleOwnershipRecord["kind"],
            scope: "whole",
            status: "managed",
            identity: observed.identity!,
            fingerprint: observed.fingerprint ?? null,
          },
          ...(observed.kind === "symlink" ? { linkTarget: fs.readlinkSync(at) } : {}),
        });
        if (observed.kind === "directory") for (const name of fs.readdirSync(at).sort()) visit(path.join(at, name));
      };
      visit(root);
      const legacy = entries[0]!;
      const retentionParent = observeLifecyclePath(path.dirname(journalPath), [path.parse(appHome).root]);
      if (retentionParent.unsafeReason || !["missing", "directory"].includes(retentionParent.kind)) throw new Error("Retention parent must be a safe directory.");
      const retentionDevice = retentionParent.identity?.device ?? retentionParent.directories.at(-1)?.identity.device;
      if (legacy.record.identity?.device !== retentionDevice) throw new Error("Host conversion requires retention on the same filesystem; no update is offered.");
      if (marker && (!sameLifecycleIdentity(marker.identity ?? undefined, legacy.record.identity ?? undefined) || marker.fingerprint !== previousToken)) throw new Error("Conversion marker does not match the approved installation snapshot.");
      if (legacy.record.kind !== "symlink" && legacy.record.kind !== "directory") throw new Error("Supported installations must be a directory or symlink.");
      for (const [index, parent] of [path.join(home, ".agents"), path.join(home, ".agents/skills")].entries()) {
        const observed = observeLifecyclePath(parent, [home]);
        if (observed.unsafeReason || observed.kind !== "directory" || journal.ledger.records.some((record) => record.resourceId === `shared-skill.parent-${index}` && record.status === "pending_create" && !record.identity))
          throw new Error("Host parent is unsafe or has no recorded publication identity; approval cannot extend to repairing its parents.");
      }
      const parent = observeLifecyclePath(target, [home]);
      const token = digest({
        home,
        appHome,
        sourceRoot,
        source: {
          path: source.source,
          selection: source.selection,
          fingerprint: source.fingerprint,
        },
        parents: parent.directories,
        entries,
      });
      if (previousToken && previousToken !== token) throw new Error("Conversion evidence changed after approval; preserve retained data and host without broadening consent.");
      const retention = path.join(path.dirname(journalPath), `host-conversion-${token}`),
        retainedPath = path.join(retention, "legacy");
      if (marker && observeLifecyclePath(retention, [appHome]).kind === "directory" && fs.readdirSync(retention).some((name) => name !== "legacy")) throw new Error("Retention directory has unexpected extra entries; preserve them and report the blocked operation.");
      if (!marker && observeLifecyclePath(retention, [appHome]).kind !== "missing") throw new Error("Retention destination already exists without conversion ownership.");
      const targetRuntime = legacy.linkTarget === undefined ? null : path.resolve(path.dirname(target), legacy.linkTarget);
      if (targetRuntime && (inside(target, targetRuntime) || inside(retention, targetRuntime) || inside(targetRuntime, target) || inside(targetRuntime, retention))) throw new Error("Legacy link target overlaps conversion output; no update is offered.");
      return {
        source,
        journal,
        marker,
        moved,
        root,
        entries,
        token,
        retention,
        retainedPath,
        targetRuntime,
      };
    };
    const preview = inspect();
    const details = {
      authorization: `sha256:${preview.token}`,
      affectedPaths: [target, path.join(target, "SKILL.md"), preview.retention, ...preview.entries.flatMap((entry) => [entry.record.destination, path.join(preview.retainedPath, entry.relative)]), journalPath],
      ownership: preview.entries.map((entry) => ({
        path: entry.record.destination,
        resourceId: entry.record.resourceId,
        identity: entry.record.identity,
        fingerprint: entry.record.fingerprint,
      })),
      retained: {
        path: preview.retainedPath,
        linkTarget: preview.targetRuntime,
        targetDataModified: false,
      },
      resultingShape: {
        path: target,
        kind: "directory",
        files: ["SKILL.md"],
        runtimeAuthority: sourceRoot,
      },
    };
    if (args.authorization && args.authorization !== details.authorization) return result("non_success", "Approval does not match the current host conversion preview; review a new preview before applying.", details);
    if (!args.apply) return result("pending", "Read-only conversion preview. Explicit approval requires --yes --authorization with this exact token.", details);
    if (args.authorization !== details.authorization) return result("non_success", "Legacy conversion requires explicit matching --authorization and --yes; nothing changed.", details);
    approved = true;
    if (!secureLifecycleRemovalAvailable()) return result("non_success", "Safe conversion requires Linux /proc/self/fd, O_DIRECTORY and O_NOFOLLOW.", details);
    let lock: LifecycleOwnershipJournalLock | undefined = acquireLifecycleOwnershipJournalLock(journalPath);
    try {
      let current = inspect();
      if (current.token !== preview.token) throw new Error("Stale conversion preview; nothing changed.");
      const save = (records: LifecycleOwnershipRecord[]) => {
        const ledger = { ...readLifecycleOwnershipJournal(journalPath).ledger, records };
        appendLifecycleOwnershipJournal(journalPath, ledger);
        options.persistLedger?.(ledger);
      };
      if (!current.marker) {
        options.beforePublication?.({
          operationId: "shared-skill.convert",
          destination: target,
          action: "remove",
        });
        current = inspect();
        if (current.token !== preview.token) throw new Error("Stale conversion preview; nothing changed.");
        const legacy = current.entries[0]!.record;
        save([
          ...current.journal.ledger.records,
          {
            ...legacy,
            resourceId: PREFIX + current.token,
            destination: current.retainedPath,
            fingerprint: current.token,
            status: "pending_create",
          },
        ]);
        current = inspect();
      }
      const retentionSpec = {
        id: `shared-skill.retention.${current.token}`,
        destination: current.retention,
        kind: "directory" as const,
        intent: "ensure" as const,
      };
      const ledger = current.journal.ledger;
      const plan = planLifecycleOperations({
        allowedRoots: [appHome],
        operations: [retentionSpec],
        manifest: createLifecycleOwnershipManifest([retentionSpec]),
        ledger,
      });
      const applied = applyLifecycleOperations(plan, {
        persistLedger: (next) => save(next.records),
      });
      if (applied.status !== "success") throw new Error("Retention directory publication is blocked; preserve it and report the failed operation.");
      current = inspect();
      if (!current.moved) {
        const original = observeLifecyclePath(target, [home]);
        retainLifecycleResource(
          {
            id: "shared-skill.convert",
            destination: target,
            kind: current.entries[0]!.record.kind,
          },
          original,
          current.retainedPath,
          observeLifecyclePath(current.retainedPath, [appHome]),
          (boundary) => {
            options.beforePublication?.(boundary);
            if (inspect().token !== preview.token) throw new Error("Conversion evidence changed before publication.");
          },
        );
      }
      current = inspect();
      // Preserve existing records for the moved namespace, then record the approved snapshot.
      const retainedPrefix = `${RETAINED}${current.token}.`;
      const relocated = current.journal.ledger.records.some((entry) => entry.resourceId === retainedPrefix + current.entries[0]!.record.resourceId);
      const records = current.journal.ledger.records.map((record) =>
        !record.resourceId.startsWith(PREFIX) && inside(target, record.destination) && !relocated
          ? {
              ...record,
              resourceId: retainedPrefix + record.resourceId,
              destination: path.join(current.retainedPath, path.relative(target, record.destination)),
            }
          : record,
      );
      for (const entry of current.entries) {
        const resourceId = retainedPrefix + entry.record.resourceId;
        if (!records.some((record) => record.resourceId === resourceId))
          records.push({
            ...entry.record,
            resourceId,
            destination: path.join(current.retainedPath, entry.relative),
          });
      }
      if (JSON.stringify(records) !== JSON.stringify(current.journal.ledger.records)) save(records);
      // The one-file writer owns its own lock and its established partial-write recovery.
      releaseLifecycleOwnershipJournalLock(lock);
      lock = undefined;
      if (inspect().token !== preview.token) throw new Error("Conversion evidence changed before one-file delivery.");
      const installed = runOneFileHostSkillLifecycle(
        { ...args, authorization: null },
        {
          ...options,
          beforePublication: (boundary) => {
            options.beforePublication?.(boundary);
            if (inspect().token !== preview.token) throw new Error("Conversion evidence changed before one-file publication.");
          },
        },
        true,
      );
      if (installed.status === "non_success")
        return result("non_success", installed.reason, {
          ...details,
          operations: installed.operations,
        });
      lock = acquireLifecycleOwnershipJournalLock(journalPath);
      inspect();
      const completed = readLifecycleOwnershipJournal(journalPath).ledger.records;
      if (completed.some((record) => record.resourceId === PREFIX + preview.token && record.status !== "managed")) save(completed.map((record) => (record.resourceId === PREFIX + preview.token ? { ...record, status: "managed" } : record)));
      return result(installed.status === "noop" && preview.marker?.status === "managed" ? "noop" : "success", "Only the approved host installation was converted; legacy data and operation evidence are retained.", { ...details, approval: "approved", operations: installed.operations });
    } finally {
      if (lock) releaseLifecycleOwnershipJournalLock(lock);
    }
  } catch (error) {
    return result("non_success", (error as Error).message);
  }
}
