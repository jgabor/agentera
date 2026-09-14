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
  "Preserve the host, retained data and ownership journal. Retry with the same --home, --install-root, --yes and --authorization token after interruption. Changed bytes, identities, source selection or scope require a new reviewed preview; ambiguous or unowned entries require manual recovery with separate approval. Never recursively remove the host namespace or prune a link target.";
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const inside = (root: string, candidate: string) => candidate === root || candidate.startsWith(root + path.sep);

export function hasPendingHostSkillConversion(appHome: string): boolean {
  return readLifecycleOwnershipJournal(lifecycleOwnershipJournalPath(appHome)).ledger.records.some((record) => record.resourceId.startsWith(PREFIX) && record.status === "pending_create");
}

/** Only a durable whole-resource record plus matching inode AND bytes proves legacy ownership. */
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
      if (journal.state !== "clean") throw new Error("Legacy conversion requires a clean existing ownership journal; names and byte equality are not ownership.");
      const markers = journal.ledger.records.filter((record) => record.resourceId.startsWith(PREFIX));
      if (markers.length > 1) throw new Error("Ambiguous host conversion ownership; preserve all resources for manual recovery.");
      const marker = markers[0];
      const previousToken = marker?.resourceId.slice(PREFIX.length);
      if (previousToken && !/^[a-f0-9]{64}$/.test(previousToken)) throw new Error("Invalid conversion ownership record.");
      const retainedPrefix = previousToken ? `${RETAINED}${previousToken}.` : "";
      const originalRecords = journal.ledger.records.filter((record) => !record.resourceId.startsWith(PREFIX) && !record.resourceId.startsWith("shared-skill.retention."));
      const moved = marker && observeLifecyclePath(marker.destination, [appHome]).kind !== "missing";
      const root = moved ? marker.destination : target;
      if (marker && marker.destination !== path.join(path.dirname(journalPath), `host-conversion-${previousToken}`, "legacy")) throw new Error("Conversion retention scope does not match this app home.");
      const entries: Array<{
        relative: string;
        record: LifecycleOwnershipRecord;
        linkTarget?: string;
      }> = [];
      const visit = (at: string) => {
        if (entries.length >= 4096) throw new Error("Legacy tree exceeds the supported conversion inventory; use manual recovery.");
        const relative = path.relative(root, at),
          destination = path.join(target, relative);
        const observed = observeLifecyclePath(at, [moved ? appHome : home]);
        if (observed.unsafeReason || !["directory", "file", "symlink"].includes(observed.kind)) throw new Error(`Unsafe or missing legacy entry: ${destination}`);
        if (observed.kind === "file" && fs.lstatSync(at).nlink !== 1) throw new Error(`Hard-linked legacy entry is not supported: ${destination}`);
        const retainedRecords = moved ? originalRecords.filter((record) => record.destination === at && record.resourceId.startsWith(retainedPrefix)) : [];
        const records = retainedRecords.length ? retainedRecords : originalRecords.filter((record) => record.destination === destination);
        const record = records[0];
        if (records.length !== 1 || !record || record.scope !== "whole" || !["managed", "legacy"].includes(record.status) || record.kind !== observed.kind || !sameLifecycleIdentity(record.identity ?? undefined, observed.identity) || record.fingerprint !== observed.fingerprint)
          throw new Error(`Ownership missing, ambiguous or changed for ${destination}; preserve unowned extras and user changes for manual recovery.`);
        entries.push({
          relative,
          record: {
            ...record,
            destination,
            resourceId: retainedPrefix && record.resourceId.startsWith(retainedPrefix) ? record.resourceId.slice(retainedPrefix.length) : record.resourceId,
          },
          ...(observed.kind === "symlink" ? { linkTarget: fs.readlinkSync(at) } : {}),
        });
        if (observed.kind === "directory") for (const name of fs.readdirSync(at).sort()) visit(path.join(at, name));
      };
      visit(root);
      const legacy = entries[0]!;
      if (fs.lstatSync(root).dev !== fs.statSync(path.dirname(journalPath)).dev) throw new Error("Host conversion requires retention on the same filesystem; use separately approved manual recovery.");
      if (marker && (!sameLifecycleIdentity(marker.identity ?? undefined, legacy.record.identity ?? undefined) || marker.fingerprint !== previousToken)) throw new Error("Conversion marker does not match legacy ownership evidence.");
      if (legacy.record.kind !== "symlink" && (legacy.record.kind !== "directory" || !entries.some((entry) => entry.relative === "SKILL.md" && entry.record.kind === "file"))) throw new Error("Supported copied installations must contain an owned regular SKILL.md.");
      for (const [index, parent] of [path.join(home, ".agents"), path.join(home, ".agents/skills")].entries()) {
        const observed = observeLifecyclePath(parent, [home]);
        if (observed.unsafeReason || observed.kind !== "directory" || journal.ledger.records.some((record) => record.resourceId === `shared-skill.parent-${index}` && record.status === "pending_create" && !record.identity))
          throw new Error("Host parent is unsafe or has no recorded publication identity; manual recovery required.");
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
      if (previousToken && previousToken !== token) throw new Error("Conversion evidence changed after approval; preserve retained data and host for manual recovery.");
      const retention = path.join(path.dirname(journalPath), `host-conversion-${token}`),
        retainedPath = path.join(retention, "legacy");
      if (marker && observeLifecyclePath(retention, [appHome]).kind === "directory" && fs.readdirSync(retention).some((name) => name !== "legacy")) throw new Error("Retention directory has unowned extras; preserve them for manual recovery.");
      if (!marker && observeLifecyclePath(retention, [appHome]).kind !== "missing") throw new Error("Retention destination already exists without conversion ownership.");
      const targetRuntime = legacy.linkTarget === undefined ? null : path.resolve(path.dirname(target), legacy.linkTarget);
      if (targetRuntime && (inside(target, targetRuntime) || inside(retention, targetRuntime) || inside(targetRuntime, target) || inside(targetRuntime, retention))) throw new Error("Legacy link target overlaps conversion output; manual recovery required.");
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
      const observedRetention = observeLifecyclePath(current.retention, [appHome]);
      if (observedRetention.kind !== "missing" && ledger.records.some((record) => record.resourceId === retentionSpec.id && record.status === "pending_create" && !record.identity)) throw new Error("Retention directory exists without recorded creation identity; manual recovery required.");
      const plan = planLifecycleOperations({
        allowedRoots: [appHome],
        operations: [retentionSpec],
        manifest: createLifecycleOwnershipManifest([retentionSpec]),
        ledger,
      });
      const applied = applyLifecycleOperations(plan, {
        persistLedger: (next) => save(next.records),
      });
      if (applied.status !== "success") throw new Error("Retention directory ownership is blocked; preserve it for manual recovery.");
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
      // Keep all positive ownership evidence, relocating only records for the retained tree.
      const owned = new Set(current.entries.map((entry) => entry.record.resourceId));
      const retainedPrefix = `${RETAINED}${current.token}.`;
      const records = current.journal.ledger.records.map((record) =>
        owned.has(record.resourceId)
          ? {
              ...record,
              resourceId: retainedPrefix + record.resourceId,
              destination: path.join(current.retainedPath, path.relative(target, record.destination)),
            }
          : record,
      );
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
      return result(installed.status === "noop" && preview.marker?.status === "managed" ? "noop" : "success", "Only the approved host installation was converted; legacy data and ownership evidence are retained.", { ...details, approval: "approved", operations: installed.operations });
    } finally {
      if (lock) releaseLifecycleOwnershipJournalLock(lock);
    }
  } catch (error) {
    return result("non_success", (error as Error).message);
  }
}
