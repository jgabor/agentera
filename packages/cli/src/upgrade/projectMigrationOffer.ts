import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { dumpYamlMapping } from "../core/yaml.js";
import { canonicalEntityEnvelopeBytes } from "../state/entityStorage.js";
import { classifyEntityCutoverProject, planEntityMigration } from "../state/entityMigrationPreview.js";
import { prepareEntityCutoverForUpgrade, ENTITY_MODE_MARKER, inspectEntityCutoverForUpgrade, type PreparedEntityCutover } from "../state/entityCutover.js";
import { validateRealProjectRoot } from "../state/projectRoot.js";
import { EntityPublicationContext } from "../state/entityPublicationContext.js";
import { readProjectFileSnapshot, snapshotProjectPath } from "../state/safeProjectFile.js";
import { todoReconciliationBinding } from "../state/todoDocsEntities.js";
import { todoCutoverPublicProjectionViolations } from "../state/todoReconciliationInspection.js";
import { inspectTodoReconciliation } from "../state/todoReconciliationTransaction.js";
import { TODO_RECONCILIATION_ACTIVATION_PATH } from "../state/todoReconciliationActivation.js";
import { resolveSourceRootStrict } from "./appModel.js";
import { acquireLifecycleOwnershipJournalLock, releaseLifecycleOwnershipJournalLock } from "../runtime/lifecycleOwnershipJournal.js";
import { commandText } from "./upgradeCommands.js";
import { buildUpgradePlan, validateUpgradeApply, type UpgradeOrchestratorArgs, type UpgradePlanV2 } from "./upgradeOrchestrator.js";
import type { MigrationPhaseItem } from "./migrateArtifactsV2ToV3.js";

// This is a migration checkpoint, not a consent service or authentication proof.
export const PROJECT_MIGRATION_APPROVAL = ".agentera/migrations/project-upgrade.json";
export const PROJECT_MIGRATION_LOCK_OWNER = ".agentera/migrations/project-upgrade/apply.lock/owner.json";
const PREFIX = "project-migration:";
export const PROJECT_MIGRATION_STARTUP_GUIDANCE = `# Status before project migration

Status is read-only. Brief the user from status_context and the blocked startup outcome. The project cannot enter normal writer work yet.
Present startup.state_cutover.migration_offer in full: selected project, target, summary, every effect and grouped source, loss, and forward-only warning. Ask its question once. Only explicit Yes runs its unchanged apply_command. No, silence or no offer runs nothing. Do not ask per-file questions, copy tokens for the user, prepare sources, or infer Git, app, home, shared-skill, reset or capability-execution permission.
The token binds scope and snapshots, not user participation. Under known original approval, matching checkpoints resume the original command without another question; unexpected changes require fresh preview and approval. Require exit 0 and JSON success/noop after state and startup verification. Otherwise report the actual incomplete state and bounded forward recovery, never completion from a marker.
This is the project-migration startup capsule, not the full requested capability instructions. Full Status guidance remains at capability_context.details.instructions. Read applicable detail and obtain the capability's own permission before any subsequent work; migration Yes does not start another task.
`;
export class ProjectMigrationApprovalError extends Error {
  constructor() {
    super("Reviewed migration scope, inputs, effects or checkpoints no longer match. Preserve the observed project and checkpoint. Obtain a fresh read-only preview and approval for unexpected changes; use the original command only for matching progress under known approval.");
  }
}
export function hasProjectMigrationCheckpoint(project: string): boolean {
  try {
    return readProjectFileSnapshot(validateRealProjectRoot(path.resolve(project)), PROJECT_MIGRATION_APPROVAL).kind !== "missing";
  } catch {
    return false;
  }
}
export function withProjectMigrationApproval<T>(args: UpgradeOrchestratorArgs, project: string, apply: (locks: readonly string[]) => T): T {
  try {
    bindProjectMigrationApproval(args, args.migrationAuthorization!, [], true);
  } catch {
    throw new ProjectMigrationApprovalError();
  }
  const lock = acquireLifecycleOwnershipJournalLock(path.join(project, ".agentera/migrations/project-upgrade/ownership"));
  const owner = path.join(project, PROJECT_MIGRATION_LOCK_OWNER);
  try {
    bindProjectMigrationApproval(args, args.migrationAuthorization!, [owner]);
    return apply([owner]);
  } finally {
    releaseLifecycleOwnershipJournalLock(lock);
  }
}
type BoundPath = {
  path: string;
  before: string | null;
  after: string | null;
  identity?: string;
  afterMode?: number;
};
type Effect = { phase: string; action: string; source?: string; target?: string; summary: string };
interface Operation {
  schema: "agentera.projectMigrationOperation.v1";
  project: string;
  head: string;
  tool: string;
  contracts: string;
  previousCheckpointSha256: string | null;
  previousCheckpointIdentity: string | null;
  source: string;
  effects: Effect[];
  paths: BoundPath[];
}
export type ProjectMigrationOffer = {
  status: "ready";
  project: string;
  target: "v3";
  effects: Array<{ action: string; source?: string; sources?: string[]; summary: string }>;
  summary: string;
  loss: string;
  warning: string;
  approval: "explicit_yes_only";
  question: string;
  apply_command: string;
};
export function renderProjectMigrationOffer(offer: ProjectMigrationOffer | null | undefined): string {
  if (!offer) return "";
  return [
    "\nProject migration offer (read-only preflight passed)",
    `Project: ${offer.project}; target: ${offer.target}`,
    offer.summary,
    ...offer.effects.map((effect) => `${effect.action}${effect.source ? ` (${effect.source})` : effect.sources ? ` (${effect.sources.join(", ")})` : ""}: ${effect.summary}`),
    offer.loss,
    offer.warning,
    offer.question,
    `Only after explicit Yes: ${offer.apply_command}`,
    "No or no answer makes no changes.\n",
  ].join("\n");
}
const hash = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
const digest = (operation: Operation): string => PREFIX + hash(JSON.stringify(operation));
function recordedOperation(bytes: Buffer): Operation {
  const { binding, ...operation } = JSON.parse(bytes.toString("utf8")) as Operation & {
    binding: string;
  };
  if (operation.schema !== "agentera.projectMigrationOperation.v1" || binding !== digest(operation)) throw new ProjectMigrationApprovalError();
  return operation;
}
const operationBytes = (operation: Operation): string => JSON.stringify({ ...operation, binding: digest(operation) }) + "\n";
function boundOperation(args: UpgradeOrchestratorArgs): Operation {
  const root = validateRealProjectRoot(path.resolve(args.project ?? process.cwd()));
  const checkpoint = readProjectFileSnapshot(root, PROJECT_MIGRATION_APPROVAL);
  if (checkpoint.kind !== "file") throw new ProjectMigrationApprovalError();
  const operation = recordedOperation(checkpoint.bytes);
  if (digest(operation) !== args.migrationAuthorization || operation.project !== root.path) throw new ProjectMigrationApprovalError();
  return operation;
}
export function checkPreparedProjectMigration(args: UpgradeOrchestratorArgs, prepared: PreparedEntityCutover): void {
  if (!args.migrationAuthorization) return;
  const operation = boundOperation(args);
  if (prepared.recovery) {
    try {
      validateProgress(operation);
    } catch {
      throw new ProjectMigrationApprovalError();
    }
    return;
  }
  const marker = hash(
    dumpYamlMapping({
      schemaVersion: "agentera.stateMode.v1",
      mode: "entities",
      source_fingerprint: prepared.sourceFingerprint,
      preview_digest: prepared.previewDigest,
    }),
  );
  if (prepared.head !== operation.head || prepared.sourceFingerprint !== operation.source || operation.paths.find((item) => item.path === ENTITY_MODE_MARKER)?.after !== marker) throw new ProjectMigrationApprovalError();
}
export function checkReviewedMigrationItems(args: UpgradeOrchestratorArgs, phases: readonly { name: string; items: MigrationPhaseItem[] }[]): void {
  if (!args.migrationAuthorization || !args.yes) return;
  const operation = boundOperation(args);
  try {
    validateProgress(operation);
  } catch {
    throw new ProjectMigrationApprovalError();
  }
  for (const phase of phases)
    for (const item of phase.items) {
      if (item.status !== "pending" || item.action === "normalize-plan-lifecycle") continue;
      const relative = item.source ? projectPath(operation.project, item.source) : undefined;
      const approved = operation.paths.find((entry) => entry.path === relative);
      if (!approved || !operation.effects.some((effect) => effect.phase === phase.name && effect.action === item.action && effect.source === relative)) throw new ProjectMigrationApprovalError();
      const current = snapshot(operation.project, approved.path);
      if (current !== approved.before || approved.after !== (item.newText === undefined ? null : hash(item.newText))) throw new ProjectMigrationApprovalError();
      if (approved.identity) {
        const stat = fs.lstatSync(path.join(operation.project, approved.path));
        if (`${stat.dev}:${stat.ino}:${stat.mode}` !== approved.identity) throw new ProjectMigrationApprovalError();
      }
    }
}
function toolDigest(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const digest = createHash("sha256");
  const visit = (relative: string): void => {
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && /\.(js|ts)$/.test(entry.name)) digest.update(child).update(fs.readFileSync(path.join(root, child)));
    }
  };
  visit("");
  return digest.digest("hex");
}
function contractDigest(): string {
  const root = resolveSourceRootStrict();
  const digest = createHash("sha256");
  const visit = (relative: string): void => {
    const absolute = path.join(root, relative);
    if (fs.statSync(absolute).isDirectory()) for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    else if (/\.(yaml|json)$/.test(relative)) digest.update(relative).update(fs.readFileSync(absolute));
  };
  visit("skills/agentera");
  visit("references/artifacts");
  visit("references/adapters");
  return digest.digest("hex");
}

function snapshot(project: string, relative: string): string | null {
  const absolute = path.join(project, relative);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isDirectory() && !fs.lstatSync(absolute).isSymbolicLink()) {
    if (fs.realpathSync(absolute) !== absolute) throw new Error(`unsafe migration directory '${relative}'`);
    return "directory";
  }
  const observed = readProjectFileSnapshot(validateRealProjectRoot(project), relative);
  if (observed.kind === "missing") return null;
  if (observed.kind !== "file") throw new Error(`unsafe migration path '${relative}'`);
  return hash(observed.bytes);
}

function projectPath(project: string, value: string): string {
  const relative = path.relative(project, path.resolve(project, value)).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("migration effect is outside the selected project");
  return relative;
}

function operationFor(args: UpgradeOrchestratorArgs, preview: UpgradePlanV2, lockPaths: readonly string[] = []): Operation {
  const project = preview.project;
  const sourceRoot = resolveSourceRootStrict();
  const previous = readProjectFileSnapshot(validateRealProjectRoot(project), PROJECT_MIGRATION_APPROVAL);
  if (previous.kind !== "file" && previous.kind !== "missing") throw new Error("unsafe migration checkpoint");
  if (previous.kind === "file") {
    const recorded = recordedOperation(previous.bytes);
    const stat = fs.lstatSync(path.join(project, PROJECT_MIGRATION_APPROVAL));
    if (git(project, ["ls-files", "-z", "--", PROJECT_MIGRATION_APPROVAL])) throw new Error("tracked checkpoint replacement is outside the supported clean-source preflight");
    if (
      recorded.schema !== "agentera.projectMigrationOperation.v1" ||
      recorded.project !== project ||
      !Array.isArray(recorded.paths) ||
      !/^[a-f0-9]{40,64}$/.test(recorded.head) ||
      !/^[a-f0-9]{64}$/.test(recorded.tool) ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o022) !== 0 ||
      (fs.existsSync(path.join(project, ".agentera/migrations/project-upgrade/apply.lock")) && !lockPaths.length)
    )
      throw new Error("checkpoint requires bounded recovery, not a new offer");
  }
  if (process.platform !== "linux" || !fs.existsSync("/proc/self/fd")) throw new Error("migration publication requires Linux /proc/self/fd");
  if (args.installRoot || args.legacyCleanup || args.only?.length || args.force || args.runtime || preview.channel.channel !== "development") throw new Error("offer requires the full project-only development migration");
  if (classifyEntityCutoverProject(project, sourceRoot) !== "legacy") throw new Error("project is not a supported complete v2 source");
  const error = validateUpgradeApply({ ...args, yes: true, dryRun: false }, preview);
  if (error || preview.summary.blocked || preview.summary.failed) throw new Error(error ?? "migration preflight is blocked");
  const prepared = prepareEntityCutoverForUpgrade(project, sourceRoot, previous.kind === "file" ? [...lockPaths, path.join(project, PROJECT_MIGRATION_LOCK_OWNER)] : lockPaths);
  const plan = planEntityMigration(project, sourceRoot);
  if (
    plan.todo_reconciliation &&
    todoCutoverPublicProjectionViolations(
      plan.todo_reconciliation.markdown_after,
      plan.entries.filter((entry) => entry.boundary === "todo_item").map((entry) => ({ id: entry.proposed_target!.id, record: entry.record })),
    ).length
  )
    throw new Error("proposed TODO projection is not supported");
  const paths = new Map<string, BoundPath>();
  const bind = (relative: string, after?: string | null): void => {
    const before = snapshot(project, relative);
    const stat = before === null ? null : fs.lstatSync(path.join(project, relative));
    paths.set(relative, {
      path: relative,
      before,
      after: after === undefined ? before : after,
      ...(stat ? { identity: `${stat.dev}:${stat.ino}:${stat.mode}` } : {}),
      ...(after !== null && before !== "directory" ? { afterMode: stat?.mode ?? 0o100600 } : {}),
    });
  };
  for (const source of plan.sources) if (!source.path.endsWith("/")) bind(source.path);
  for (const singleton of plan.preserved_singletons) if (!singleton.source_path.endsWith("/")) bind(singleton.source_path);
  for (const entry of plan.entries) {
    const target = entry.proposed_target!;
    bind(
      target.path,
      hash(
        canonicalEntityEnvelopeBytes({
          id: target.id!,
          artifact: entry.artifact!,
          record: entry.record,
          migrationProvenance: entry.canonical_migration_provenance,
        }),
      ),
    );
  }
  const effects: Effect[] = [];
  for (const phase of preview.phases)
    for (const item of phase.items) {
      if (item.status !== "pending") continue;
      if (phase.name === "entities" || item.action === "normalize-plan-lifecycle") continue;
      // Offers deliberately refuse an effect whose final bytes cannot be bound.
      if (!item.source || !["runtime", "cleanup"].includes(phase.name)) throw new Error("migration effect cannot be bound by the project offer");
      const relative = projectPath(project, item.source);
      const stat = fs.lstatSync(path.join(project, relative));
      if (stat.isSymbolicLink()) throw new Error("migration offer cannot retire a symlink");
      const retire = (entry: string): void => {
        const observed = fs.lstatSync(path.join(project, entry));
        if (observed.isDirectory()) for (const name of fs.readdirSync(path.join(project, entry)).sort()) retire(`${entry}/${name}`);
        else if (!observed.isFile() || observed.isSymbolicLink()) throw new Error("unsupported project retirement source");
        bind(entry, null);
      };
      if (stat.isDirectory()) retire(relative);
      else bind(relative, item.newText === undefined ? null : hash(item.newText));
      effects.push({
        phase: phase.name,
        action: item.action,
        source: relative,
        ...(item.target ? { target: projectPath(project, item.target) } : {}),
        summary: item.message,
      });
    }
  const marker = dumpYamlMapping({
    schemaVersion: "agentera.stateMode.v1",
    mode: "entities",
    source_fingerprint: plan.source_fingerprint,
    preview_digest: plan.preview_digest,
  });
  bind(ENTITY_MODE_MARKER, hash(marker));
  if (plan.todo_reconciliation) {
    bind(plan.todo_reconciliation.public_path, hash(plan.todo_reconciliation.markdown_after));
    bind(TODO_RECONCILIATION_ACTIVATION_PATH, hash(plan.todo_reconciliation.activation_after));
  }
  // Include bookkeeping, not just reviewed data targets. The lifecycle lock
  // prepares a sibling directory under project-upgrade before publishing its
  // owner. Native directory pinning needs read/search access to each ancestor.
  const publicationParents = [
    ...[...paths.values()].filter((entry) => entry.before !== entry.after).map((entry) => path.posix.dirname(entry.path)),
    path.posix.dirname(PROJECT_MIGRATION_APPROVAL),
    path.posix.dirname(path.posix.dirname(PROJECT_MIGRATION_LOCK_OWNER)),
    path.posix.dirname(PROJECT_MIGRATION_LOCK_OWNER),
    ".agentera",
    ".agentera/.writer.lock",
    ...(plan.todo_reconciliation ? [".agentera/.todo-reconciliation"] : []),
    ...(plan.todo_reconciliation || previous.kind === "file" ? [".agentera/.entity-recovery"] : []),
  ];
  const root = validateRealProjectRoot(project);
  for (const ancestor of root.identities) fs.accessSync(ancestor.absolute, fs.constants.R_OK | fs.constants.X_OK);
  for (const parent of new Set(publicationParents)) {
    const observed = snapshotProjectPath(project, parent === "." ? "" : parent, "directory");
    if (observed.kind === "unsafe") throw new Error("unsafe migration publication parent");
    const existingParent = observed.kind === "stable" ? observed.absolute : path.dirname(observed.absolute);
    const existing = snapshotProjectPath(project, path.relative(project, existingParent), "directory");
    if (existing.kind !== "stable") throw new Error("migration publication parent changed during preflight");
    for (const ancestor of existing.identities) fs.accessSync(ancestor.absolute, fs.constants.R_OK | fs.constants.X_OK);
    fs.accessSync(existingParent, fs.constants.W_OK | fs.constants.X_OK);
  }
  effects.unshift({
    phase: "entities",
    action: "entity-cutover",
    summary: `Publish ${plan.entries.length} entities and activate v3${plan.todo_reconciliation ? "; reconcile TODO" : ""}. Keep v2 records and scoped recovery hashes.`,
  });
  effects.push({
    phase: "verification",
    action: "verify",
    summary: "Verify state and startup.",
  });
  return {
    schema: "agentera.projectMigrationOperation.v1",
    project,
    head: prepared.head,
    tool: toolDigest(),
    contracts: contractDigest(),
    previousCheckpointSha256: previous.kind === "file" ? hash(previous.bytes) : null,
    previousCheckpointIdentity:
      previous.kind === "file"
        ? (() => {
            const stat = fs.lstatSync(path.join(project, PROJECT_MIGRATION_APPROVAL));
            return `${stat.dev}:${stat.ino}:${stat.mode}`;
          })()
        : null,
    source: prepared.sourceFingerprint,
    effects,
    paths: [...paths.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

export function projectMigrationOffer(args: UpgradeOrchestratorArgs, supplied?: UpgradePlanV2): ProjectMigrationOffer | null {
  try {
    const preview = supplied ?? buildUpgradePlan({ ...args, yes: false, dryRun: true });
    const operation = operationFor(args, preview);
    const authorization = digest(operation);
    const apply = ["npx", "-y", "agentera@next", "upgrade", "--channel", "development", "--project", operation.project, "--yes", "--authorization", authorization, "--format", "json"];
    const effects: ProjectMigrationOffer["effects"] = operation.effects.filter((effect) => !effect.source).map(({ action, summary }) => ({ action, summary }));
    const removals = operation.paths.filter((item) => item.before !== null && item.after === null).map((item) => item.path);
    if (removals.length)
      effects.splice(1, 0, {
        action: "retire",
        sources: removals,
        summary: "Remove these owned retired project resources; declared directories are removed only when empty.",
      });
    return {
      status: "ready",
      project: operation.project,
      target: "v3",
      effects,
      summary: "Convert tracked v2 state to v3 and verify it. No Git, app, home or shared-skill changes.",
      loss: operation.paths.some((item) => item.before !== null && item.before !== "directory" && item.after === null)
        ? "The listed retired working files are removed without a migration backup. Original state records and existing Git history are retained."
        : "No original state records or existing Git history are deleted.",
      warning: "Forward-only: rollback/return to v2 unsupported; missing history stays missing.",
      approval: "explicit_yes_only",
      question: "Migrate this project to v3?",
      apply_command: commandText(apply),
    };
  } catch {
    return null;
  }
}

function git(project: string, args: string[]): string {
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[name];
  const result = spawnSync("git", args, { cwd: project, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error("cannot verify the migration Git snapshot");
  return result.stdout;
}

function validateProgress(operation: Operation): void {
  const project = operation.project;
  if (operation.tool !== toolDigest() || operation.contracts !== contractDigest() || git(project, ["rev-parse", "HEAD"]).trim() !== operation.head) throw new Error("migration tool or HEAD changed");
  const allowed = new Set(operation.paths.map((item) => item.path));
  for (const item of operation.paths) {
    const current = snapshot(project, item.path);
    if (current !== item.before && current !== item.after) throw new Error(`migration input or expected progress changed at '${item.path}'`);
    if (current !== null && current === item.before && item.identity) {
      const stat = fs.lstatSync(path.join(project, item.path));
      if (`${stat.dev}:${stat.ino}:${stat.mode}` !== item.identity) throw new Error(`migration source identity changed at '${item.path}'`);
    }
    if (current !== null && current !== "directory" && current === item.after && item.afterMode !== undefined && fs.lstatSync(path.join(project, item.path)).mode !== item.afterMode) throw new Error(`migration target mode changed at '${item.path}'`);
    if (current === "directory")
      for (const name of fs.readdirSync(path.join(project, item.path))) {
        if (!allowed.has(`${item.path}/${name}`)) throw new Error(`retirement directory changed at '${item.path}'`);
      }
  }
  const changed = git(project, ["diff", "HEAD", "--name-only", "-z"]).split("\0").filter(Boolean);
  const staged = git(project, ["diff", "--cached", "HEAD", "--name-only", "-z"]).split("\0").filter(Boolean);
  if (
    staged.length ||
    changed.some((item) => {
      const approved = operation.paths.find((entry) => entry.path === item);
      return !approved || approved.before === approved.after || snapshot(project, item) !== approved.after;
    })
  )
    throw new Error("Git scope changed since approval");
  const untracked = git(project, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  if (untracked.some((item) => !allowed.has(item) && item !== PROJECT_MIGRATION_APPROVAL && item !== PROJECT_MIGRATION_LOCK_OWNER && item !== ".agentera/.entity-recovery/.gitignore" && !item.startsWith(".agentera/.writer.lock/") && !item.startsWith(".agentera/.todo-reconciliation/")))
    throw new Error("untracked project scope changed since approval");
  if (untracked.includes(".agentera/.entity-recovery/.gitignore") && snapshot(project, ".agentera/.entity-recovery/.gitignore") !== hash("*\n!.gitignore\n")) throw new Error("file replacement recovery boundary changed");
  inspectTodoReconciliation(project, todoReconciliationBinding(project, resolveSourceRootStrict()), (targets) => {
    for (const target of targets) {
      const approved = operation.paths.find((item) => item.path === target.path);
      const before = target.before === null ? null : hash(target.before);
      if (!approved || approved.after !== hash(target.after) || (before !== approved.before && before !== approved.after)) throw new Error("migration checkpoint effects changed");
    }
  });
  inspectEntityCutoverForUpgrade(project, resolveSourceRootStrict());
  const preview = buildUpgradePlan({ project, channel: "development", dryRun: true });
  for (const phase of preview.phases)
    for (const item of phase.items) {
      if (item.status === "failed" || item.status === "blocked") throw new Error("migration recovery preflight is blocked");
      if (item.status === "pending" && phase.name !== "entities" && item.action !== "normalize-plan-lifecycle" && !operation.effects.some((effect) => effect.phase === phase.name && effect.action === item.action && effect.source === (item.source ? projectPath(project, item.source) : undefined)))
        throw new Error("migration effects changed since approval");
    }
}

/** Called inside the existing project upgrade lock, before any executor effects. */
export function bindProjectMigrationApproval(args: UpgradeOrchestratorArgs, authorization: string, lockPaths: readonly string[] = [], readOnly = false): void {
  if (!authorization.startsWith(PREFIX) || args.installRoot || args.legacyCleanup || args.only?.length || args.force || args.runtime || args.channel !== "development") throw new Error("stale migration scope; obtain a fresh project-only preview and approval");
  const project = validateRealProjectRoot(path.resolve(args.project ?? process.cwd())).path;
  const checkpoint = readProjectFileSnapshot(validateRealProjectRoot(project), PROJECT_MIGRATION_APPROVAL);
  if (checkpoint.kind === "file") {
    const operation = recordedOperation(checkpoint.bytes);
    if (operation.schema !== "agentera.projectMigrationOperation.v1" || operation.project !== project) throw new Error("missing or changed migration approval checkpoint");
    if (digest(operation) === authorization) {
      validateProgress(operation);
      return;
    }
    // A fresh Yes can replace only the exact reviewed checkpoint, and only
    // while the ordinary full tracked legacy preflight remains supported.
    const preview = buildUpgradePlan({ ...args, yes: false, dryRun: true });
    const fresh = operationFor(args, preview, lockPaths);
    if (digest(fresh) !== authorization) throw new Error("stale migration approval; obtain a fresh preview and approval");
    if (readOnly) return;
    const owner = lockPaths.find((entry) => entry === path.join(project, PROJECT_MIGRATION_LOCK_OWNER));
    if (!owner) throw new Error("migration checkpoint publication lock is missing");
    const context = EntityPublicationContext.open(validateRealProjectRoot(project), PROJECT_MIGRATION_LOCK_OWNER, fs.readFileSync(owner));
    const after = operationBytes(fresh);
    try {
      context.replaceExisting(PROJECT_MIGRATION_APPROVAL, checkpoint.bytes, after, Math.max(checkpoint.bytes.length, Buffer.byteLength(after)));
    } finally {
      context.close();
    }
    return;
  }
  if (checkpoint.kind !== "missing") throw new Error("unsafe migration approval checkpoint");
  const preview = buildUpgradePlan({ ...args, yes: false, dryRun: true });
  const operation = operationFor(args, preview, lockPaths);
  if (digest(operation) !== authorization) throw new Error("stale migration inputs or effects; obtain a fresh preview and approval");
  if (readOnly) return;
  const directory = path.join(project, ".agentera/migrations");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory()) throw new Error("unsafe migration checkpoint directory");
  const fd = fs.openSync(path.join(project, PROJECT_MIGRATION_APPROVAL), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, operationBytes(operation));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(directoryFd);
  } finally {
    fs.closeSync(directoryFd);
  }
}
