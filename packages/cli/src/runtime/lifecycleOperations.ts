import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../core/atomicWriter.js";

export const LIFECYCLE_OPERATION_CONTRACT_RELATIVE_PATH =
  "references/adapters/runtime-lifecycle-operation-contract.yaml";
export const LIFECYCLE_MANIFEST_SCHEMA = "agentera.lifecycleOwnershipManifest.v1" as const;
export const LIFECYCLE_LEDGER_SCHEMA = "agentera.lifecycleOwnershipLedger.v1" as const;

export const LIFECYCLE_RESOURCE_STATES = [
  "exact",
  "modified",
  "missing",
  "legacy",
  "symlinked",
  "wrong_type",
  "partial_managed",
  "unowned",
  "unsafe_path",
  "ambiguous_ownership",
] as const;
export const LIFECYCLE_PLAN_ACTIONS = [
  "create",
  "update",
  "remove",
  "finalize_ownership",
  "noop",
  "blocked_unowned",
  "action_required",
] as const;
export const LIFECYCLE_APPLY_STATUSES = [
  "applied",
  "noop",
  "failed",
  "blocked_unowned",
  "skipped_dependency",
  "action_required",
] as const;

export type LifecycleResourceKind = "file" | "directory" | "symlink";
export type LifecycleOperationIntent = "ensure" | "remove";
export type LifecycleResourceState = (typeof LIFECYCLE_RESOURCE_STATES)[number];
export type LifecyclePlanAction = (typeof LIFECYCLE_PLAN_ACTIONS)[number];
export type LifecycleApplyStatus = (typeof LIFECYCLE_APPLY_STATUSES)[number];
export type LifecycleOwnership =
  | "managed"
  | "legacy"
  | "claimable"
  | "unowned"
  | "partial"
  | "ambiguous"
  | "undeclared";

export interface LifecycleOperationSpec {
  id: string;
  destination: string;
  kind: LifecycleResourceKind;
  intent: LifecycleOperationIntent;
  content?: string | Buffer;
  linkTarget?: string;
  dependsOn?: string[];
  required?: boolean;
}

export interface LifecycleOwnershipDeclaration {
  resourceId: string;
  destination: string;
  kind: LifecycleResourceKind;
  intent: LifecycleOperationIntent;
  expectedFingerprint: string | null;
}

export interface LifecycleOwnershipManifest {
  schemaVersion: typeof LIFECYCLE_MANIFEST_SCHEMA;
  owner: "agentera";
  resources: LifecycleOwnershipDeclaration[];
}

export interface LifecycleOwnershipRecord {
  resourceId: string;
  destination: string;
  kind: LifecycleResourceKind;
  scope: "whole" | "partial";
  status: "managed" | "legacy" | "pending_create";
  fingerprint: string | null;
}

export interface LifecycleOwnershipLedger {
  schemaVersion: typeof LIFECYCLE_LEDGER_SCHEMA;
  owner: "agentera";
  records: LifecycleOwnershipRecord[];
}

export interface PlannedLifecycleOperation {
  id: string;
  destination: string;
  state: LifecycleResourceState;
  ownership: LifecycleOwnership;
  action: LifecyclePlanAction;
  required: boolean;
  dependsOn: string[];
  reason: string;
}

export interface LifecycleOperationPlan {
  schemaVersion: "agentera.lifecycleOperationPlan.v1";
  mode: "preview";
  operations: PlannedLifecycleOperation[];
  request: LifecycleOperationRequest;
}

export interface LifecycleOperationRequest {
  allowedRoots: string[];
  operations: LifecycleOperationSpec[];
  manifest: LifecycleOwnershipManifest;
  ledger?: LifecycleOwnershipLedger;
}

export interface AppliedLifecycleOperation extends PlannedLifecycleOperation {
  status: LifecycleApplyStatus;
  dependencyCauses: string[];
}

export interface LifecycleApplySummary {
  applied: number;
  noop: number;
  failed: number;
  blocked_unowned: number;
  skipped_dependency: number;
  action_required: number;
}

export interface LifecycleApplyResult {
  schemaVersion: "agentera.lifecycleApplyResult.v1";
  status: "success" | "non_success";
  operations: AppliedLifecycleOperation[];
  summary: LifecycleApplySummary;
  requiredUnmet: string[];
  ownershipLedger: LifecycleOwnershipLedger;
}

export interface LifecycleApplyOptions {
  persistLedger?: (ledger: LifecycleOwnershipLedger) => void;
}

export class LifecycleOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleOperationError";
  }
}

interface PathObservation {
  kind: LifecycleResourceKind | "other" | "missing";
  unsafeReason?: string;
}

function fingerprintBytes(bytes: Buffer): string {
  return `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
}

export function lifecycleOperationFingerprint(spec: LifecycleOperationSpec): string | null {
  if (spec.intent === "remove") return null;
  if (spec.kind === "directory") return "directory";
  if (spec.kind === "symlink") {
    return spec.linkTarget === undefined ? null : fingerprintBytes(Buffer.from(spec.linkTarget));
  }
  return spec.content === undefined
    ? null
    : fingerprintBytes(Buffer.isBuffer(spec.content) ? spec.content : Buffer.from(spec.content));
}

export function createLifecycleOwnershipManifest(
  operations: LifecycleOperationSpec[],
): LifecycleOwnershipManifest {
  return {
    schemaVersion: LIFECYCLE_MANIFEST_SCHEMA,
    owner: "agentera",
    resources: operations.map((spec) => ({
      resourceId: spec.id,
      destination: path.resolve(spec.destination),
      kind: spec.kind,
      intent: spec.intent,
      expectedFingerprint: lifecycleOperationFingerprint(spec),
    })),
  };
}

export function emptyLifecycleOwnershipLedger(): LifecycleOwnershipLedger {
  return { schemaVersion: LIFECYCLE_LEDGER_SCHEMA, owner: "agentera", records: [] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateLifecycleOwnershipManifest(value: unknown): string[] {
  if (!isObject(value)) return ["manifest must be an object"];
  const errors: string[] = [];
  if (value.schemaVersion !== LIFECYCLE_MANIFEST_SCHEMA) {
    errors.push(`manifest.schemaVersion must be ${LIFECYCLE_MANIFEST_SCHEMA}`);
  }
  if (value.owner !== "agentera") errors.push("manifest.owner must be agentera");
  if (!Array.isArray(value.resources)) return [...errors, "manifest.resources must be a list"];
  const seen = new Set<string>();
  for (const [index, resource] of value.resources.entries()) {
    if (!isObject(resource)) {
      errors.push(`manifest.resources[${index}] must be an object`);
      continue;
    }
    const id = resource.resourceId;
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`manifest.resources[${index}].resourceId must be a non-empty string`);
    } else if (seen.has(id)) {
      errors.push(`manifest.resources[${index}].resourceId duplicates ${id}`);
    } else seen.add(id);
    if (typeof resource.destination !== "string" || !path.isAbsolute(resource.destination)) {
      errors.push(`manifest.resources[${index}].destination must be absolute`);
    }
    if (!(["file", "directory", "symlink"] as unknown[]).includes(resource.kind)) {
      errors.push(`manifest.resources[${index}].kind is invalid`);
    }
    if (!(["ensure", "remove"] as unknown[]).includes(resource.intent)) {
      errors.push(`manifest.resources[${index}].intent is invalid`);
    }
    if (resource.expectedFingerprint !== null && typeof resource.expectedFingerprint !== "string") {
      errors.push(`manifest.resources[${index}].expectedFingerprint must be a string or null`);
    }
  }
  return errors;
}

export function validateLifecycleOwnershipLedger(value: unknown): string[] {
  if (!isObject(value)) return ["ledger must be an object"];
  const errors: string[] = [];
  if (value.schemaVersion !== LIFECYCLE_LEDGER_SCHEMA) {
    errors.push(`ledger.schemaVersion must be ${LIFECYCLE_LEDGER_SCHEMA}`);
  }
  if (value.owner !== "agentera") errors.push("ledger.owner must be agentera");
  if (!Array.isArray(value.records)) return [...errors, "ledger.records must be a list"];
  const seen = new Set<string>();
  for (const [index, record] of value.records.entries()) {
    if (!isObject(record)) {
      errors.push(`ledger.records[${index}] must be an object`);
      continue;
    }
    const id = record.resourceId;
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`ledger.records[${index}].resourceId must be a non-empty string`);
    } else if (seen.has(id)) {
      errors.push(`ledger.records[${index}].resourceId duplicates ${id}`);
    } else seen.add(id);
    if (typeof record.destination !== "string" || !path.isAbsolute(record.destination)) {
      errors.push(`ledger.records[${index}].destination must be absolute`);
    }
    if (!(["file", "directory", "symlink"] as unknown[]).includes(record.kind)) {
      errors.push(`ledger.records[${index}].kind is invalid`);
    }
    if (record.scope !== "whole" && record.scope !== "partial") {
      errors.push(`ledger.records[${index}].scope must be whole or partial`);
    }
    if (!(["managed", "legacy", "pending_create"] as unknown[]).includes(record.status)) {
      errors.push(`ledger.records[${index}].status is invalid`);
    }
    if (record.fingerprint !== null && typeof record.fingerprint !== "string") {
      errors.push(`ledger.records[${index}].fingerprint must be a string or null`);
    }
  }
  return errors;
}

export function readLifecycleOwnershipLedger(ledgerPath: string): LifecycleOwnershipLedger {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    const errors = validateLifecycleOwnershipLedger(parsed);
    if (errors.length > 0) throw new LifecycleOperationError(errors.join("; "));
    return parsed as LifecycleOwnershipLedger;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyLifecycleOwnershipLedger();
    throw error;
  }
}

export function writeLifecycleOwnershipLedgerAtomic(
  ledgerPath: string,
  ledger: LifecycleOwnershipLedger,
): void {
  const errors = validateLifecycleOwnershipLedger(ledger);
  if (errors.length > 0) throw new LifecycleOperationError(errors.join("; "));
  const parent = path.dirname(ledgerPath);
  let parentStat: fs.Stats;
  try {
    parentStat = fs.lstatSync(parent);
  } catch {
    throw new LifecycleOperationError(`ownership ledger parent does not exist: ${parent}`);
  }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new LifecycleOperationError(`ownership ledger parent is not a safe directory: ${parent}`);
  }
  writeFileAtomic(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
}

function cloneLedger(ledger: LifecycleOwnershipLedger): LifecycleOwnershipLedger {
  return {
    schemaVersion: ledger.schemaVersion,
    owner: ledger.owner,
    records: ledger.records.map((record) => ({ ...record })),
  };
}

function containingRoot(destination: string, allowedRoots: string[]): string | null {
  const roots = allowedRoots.map((root) => path.resolve(root)).sort((a, b) => b.length - a.length);
  return roots.find((root) => {
    const relative = path.relative(root, destination);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }) ?? null;
}

function lstatMaybe(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function observePath(destination: string, allowedRoots: string[]): PathObservation {
  if (!path.isAbsolute(destination)) {
    return { kind: "missing", unsafeReason: "destination must be absolute" };
  }
  const resolved = path.resolve(destination);
  const root = containingRoot(resolved, allowedRoots);
  if (!root) return { kind: "missing", unsafeReason: "destination escapes allowed roots" };
  const rootStat = lstatMaybe(root);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return { kind: "missing", unsafeReason: "allowed root is not an existing safe directory" };
  }
  const relative = path.relative(root, path.dirname(resolved));
  let cursor = root;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = lstatMaybe(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      return { kind: "missing", unsafeReason: `parent traverses symlink at ${cursor}` };
    }
    if (!stat.isDirectory()) {
      return { kind: "other", unsafeReason: `parent is not a directory at ${cursor}` };
    }
  }
  const stat = lstatMaybe(resolved);
  if (!stat) return { kind: "missing" };
  if (stat.isSymbolicLink()) return { kind: "symlink" };
  if (stat.isFile()) return { kind: "file" };
  if (stat.isDirectory()) return { kind: "directory" };
  return { kind: "other" };
}

function linkTargetSafety(spec: LifecycleOperationSpec, allowedRoots: string[]): string | null {
  if (spec.kind !== "symlink" || spec.intent !== "ensure") return null;
  if (spec.linkTarget === undefined) return "symlink operation has no link target";
  const target = path.resolve(path.dirname(spec.destination), spec.linkTarget);
  const root = containingRoot(target, allowedRoots);
  if (!root) return "symlink target escapes allowed roots";
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = lstatMaybe(cursor);
    if (!stat) break;
    if (stat.isSymbolicLink()) return `symlink target traverses another symlink at ${cursor}`;
  }
  return null;
}

function actualFingerprint(spec: LifecycleOperationSpec): string | null {
  if (spec.kind === "directory") return "directory";
  if (spec.kind === "symlink") return fingerprintBytes(Buffer.from(fs.readlinkSync(spec.destination)));
  return fingerprintBytes(fs.readFileSync(spec.destination));
}

function actionRequired(
  spec: LifecycleOperationSpec,
  state: LifecycleResourceState,
  ownership: LifecycleOwnership,
  reason: string,
): PlannedLifecycleOperation {
  return planned(spec, state, ownership, "action_required", reason);
}

function planned(
  spec: LifecycleOperationSpec,
  state: LifecycleResourceState,
  ownership: LifecycleOwnership,
  action: LifecyclePlanAction,
  reason: string,
): PlannedLifecycleOperation {
  return {
    id: spec.id,
    destination: path.resolve(spec.destination),
    state,
    ownership,
    action,
    required: spec.required !== false,
    dependsOn: [...(spec.dependsOn ?? [])],
    reason,
  };
}

function matchingDeclarations(
  manifest: LifecycleOwnershipManifest,
  spec: LifecycleOperationSpec,
): LifecycleOwnershipDeclaration[] {
  return manifest.resources.filter((resource) => resource.resourceId === spec.id);
}

function matchingRecords(
  ledger: LifecycleOwnershipLedger,
  spec: LifecycleOperationSpec,
): LifecycleOwnershipRecord[] {
  return ledger.records.filter((record) => record.resourceId === spec.id);
}

function planOne(
  spec: LifecycleOperationSpec,
  manifest: LifecycleOwnershipManifest,
  ledger: LifecycleOwnershipLedger,
  allowedRoots: string[],
): PlannedLifecycleOperation {
  const declarations = matchingDeclarations(manifest, spec);
  if (declarations.length !== 1) {
    return actionRequired(
      spec,
      declarations.length === 0 ? "ambiguous_ownership" : "ambiguous_ownership",
      declarations.length === 0 ? "undeclared" : "ambiguous",
      declarations.length === 0
        ? "no Agentera ownership declaration matches the resource"
        : "multiple Agentera ownership declarations match the resource",
    );
  }
  const declaration = declarations[0];
  const expectedFingerprint = lifecycleOperationFingerprint(spec);
  if (
    path.resolve(declaration.destination) !== path.resolve(spec.destination) ||
    declaration.kind !== spec.kind ||
    declaration.intent !== spec.intent ||
    declaration.expectedFingerprint !== expectedFingerprint
  ) {
    return actionRequired(
      spec,
      "ambiguous_ownership",
      "undeclared",
      "operation does not match its Agentera ownership declaration",
    );
  }
  const observation = observePath(spec.destination, allowedRoots);
  if (observation.unsafeReason) {
    return actionRequired(spec, "unsafe_path", "undeclared", observation.unsafeReason);
  }
  const unsafeLink = linkTargetSafety(spec, allowedRoots);
  if (unsafeLink) return actionRequired(spec, "unsafe_path", "undeclared", unsafeLink);

  const records = matchingRecords(ledger, spec);
  if (records.length > 1) {
    return actionRequired(
      spec,
      "ambiguous_ownership",
      "ambiguous",
      "multiple ownership ledger records match the resource",
    );
  }
  const record = records[0];
  if (record && (
    path.resolve(record.destination) !== path.resolve(spec.destination) ||
    record.kind !== spec.kind
  )) {
    return actionRequired(
      spec,
      "ambiguous_ownership",
      "ambiguous",
      "ownership ledger record does not match the declared destination and kind",
    );
  }
  if (record?.scope === "partial") {
    return actionRequired(
      spec,
      "partial_managed",
      "partial",
      "partial ownership cannot authorize a whole-resource mutation",
    );
  }

  if (!record && observation.kind !== "missing") {
    return planned(
      spec,
      "unowned",
      "unowned",
      "blocked_unowned",
      "pre-existing resource has no matching Agentera ownership ledger record",
    );
  }
  if (observation.kind === "missing") {
    if (spec.intent === "remove") {
      return record
        ? planned(spec, "missing", record.status === "legacy" ? "legacy" : "managed", "finalize_ownership", "resource is absent; stale ownership record will be removed")
        : planned(spec, "missing", "claimable", "noop", "resource is already absent");
    }
    return planned(
      spec,
      "missing",
      record?.status === "legacy" ? "legacy" : record ? "managed" : "claimable",
      "create",
      "declared resource is absent and can be created safely",
    );
  }

  if (observation.kind === "symlink" && spec.kind !== "symlink") {
    return actionRequired(
      spec,
      "symlinked",
      record?.status === "legacy" ? "legacy" : "managed",
      "resource is a symlink where a non-symlink was declared",
    );
  }
  if (observation.kind !== spec.kind) {
    return actionRequired(
      spec,
      "wrong_type",
      record?.status === "legacy" ? "legacy" : "managed",
      `resource kind ${observation.kind} does not match declared kind ${spec.kind}`,
    );
  }
  if (record?.status === "pending_create") {
    const actual = actualFingerprint(spec);
    if (actual === expectedFingerprint) {
      return planned(
        spec,
        "exact",
        "managed",
        "finalize_ownership",
        "interrupted create completed; ownership ledger can be finalized",
      );
    }
    return actionRequired(
      spec,
      "partial_managed",
      "partial",
      "pending create exists with unexpected content and cannot be claimed",
    );
  }
  if (record?.status === "legacy") {
    if (spec.intent !== "remove") {
      return actionRequired(spec, "legacy", "legacy", "legacy resources may only be removed");
    }
    return planned(spec, "legacy", "legacy", "remove", "owned legacy resource will be removed");
  }
  if (spec.intent === "remove") {
    if (spec.kind === "directory" && fs.readdirSync(spec.destination).length > 0) {
      return actionRequired(
        spec,
        "partial_managed",
        "partial",
        "non-empty directories require separately declared child removals",
      );
    }
    return planned(spec, "exact", "managed", "remove", "owned resource will be removed");
  }

  const actual = actualFingerprint(spec);
  if (actual === expectedFingerprint) {
    if (record?.fingerprint !== expectedFingerprint) {
      return planned(
        spec,
        "exact",
        "managed",
        "finalize_ownership",
        "resource is exact; ownership ledger fingerprint will be refreshed",
      );
    }
    return planned(spec, "exact", "managed", "noop", "owned resource already matches");
  }
  return planned(spec, "modified", "managed", "update", "owned resource differs from declaration");
}

function validateRequest(request: LifecycleOperationRequest): void {
  if (request.allowedRoots.length === 0) {
    throw new LifecycleOperationError("at least one allowed root is required");
  }
  const ids = request.operations.map((operation) => operation.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new LifecycleOperationError(`duplicate operation ids: ${[...new Set(duplicates)].join(", ")}`);
  }
  const idSet = new Set(ids);
  for (const operation of request.operations) {
    if (!operation.id) throw new LifecycleOperationError("operation ids must be non-empty");
    if (operation.intent === "ensure" && operation.kind === "file" && operation.content === undefined) {
      throw new LifecycleOperationError(`${operation.id}: file ensure operation requires content`);
    }
    if (operation.intent === "ensure" && operation.kind === "symlink" && operation.linkTarget === undefined) {
      throw new LifecycleOperationError(`${operation.id}: symlink ensure operation requires linkTarget`);
    }
    for (const dependency of operation.dependsOn ?? []) {
      if (!idSet.has(dependency)) {
        throw new LifecycleOperationError(`${operation.id}: unknown dependency ${dependency}`);
      }
      if (dependency === operation.id) {
        throw new LifecycleOperationError(`${operation.id}: operation cannot depend on itself`);
      }
    }
  }
  const manifestErrors = validateLifecycleOwnershipManifest(request.manifest).filter(
    (error) => !error.includes("duplicates"),
  );
  if (manifestErrors.length > 0) throw new LifecycleOperationError(manifestErrors.join("; "));
  const ledgerErrors = validateLifecycleOwnershipLedger(request.ledger ?? emptyLifecycleOwnershipLedger()).filter(
    (error) => !error.includes("duplicates"),
  );
  if (ledgerErrors.length > 0) throw new LifecycleOperationError(ledgerErrors.join("; "));
}

function executionOrder(operations: LifecycleOperationSpec[]): LifecycleOperationSpec[] {
  const pending = [...operations];
  const emitted = new Set<string>();
  const ordered: LifecycleOperationSpec[] = [];
  while (pending.length > 0) {
    const index = pending.findIndex((operation) =>
      (operation.dependsOn ?? []).every((dependency) => emitted.has(dependency)),
    );
    if (index < 0) {
      throw new LifecycleOperationError(`operation dependency cycle: ${pending.map((item) => item.id).join(", ")}`);
    }
    const [next] = pending.splice(index, 1);
    ordered.push(next);
    emitted.add(next.id);
  }
  return ordered;
}

export function planLifecycleOperations(request: LifecycleOperationRequest): LifecycleOperationPlan {
  validateRequest(request);
  const ledger = request.ledger ?? emptyLifecycleOwnershipLedger();
  const ordered = executionOrder(request.operations);
  return {
    schemaVersion: "agentera.lifecycleOperationPlan.v1",
    mode: "preview",
    operations: ordered.map((operation) =>
      planOne(operation, request.manifest, ledger, request.allowedRoots),
    ),
    request,
  };
}

function nextManagedRecord(spec: LifecycleOperationSpec): LifecycleOwnershipRecord {
  return {
    resourceId: spec.id,
    destination: path.resolve(spec.destination),
    kind: spec.kind,
    scope: "whole",
    status: "managed",
    fingerprint: lifecycleOperationFingerprint(spec),
  };
}

function withRecord(
  ledger: LifecycleOwnershipLedger,
  record: LifecycleOwnershipRecord | null,
  resourceId: string,
): LifecycleOwnershipLedger {
  const records = ledger.records.filter((candidate) => candidate.resourceId !== resourceId);
  if (record) records.push(record);
  return { ...ledger, records };
}

function publishLedger(
  next: LifecycleOwnershipLedger,
  persist: LifecycleApplyOptions["persistLedger"],
): LifecycleOwnershipLedger {
  if (persist) persist(cloneLedger(next));
  return next;
}

function writeSymlinkAtomic(destination: string, target: string): void {
  const temporary = `${destination}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.symlinkSync(target, temporary);
    fs.renameSync(temporary, destination);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary link may not have been created or may already be published.
    }
    throw error;
  }
}

function mutateResource(spec: LifecycleOperationSpec, action: LifecyclePlanAction): void {
  if (action === "remove") {
    if (spec.kind === "directory") fs.rmdirSync(spec.destination);
    else fs.unlinkSync(spec.destination);
    return;
  }
  if (action !== "create" && action !== "update") return;
  if (spec.kind === "directory") {
    fs.mkdirSync(spec.destination);
  } else if (spec.kind === "symlink") {
    writeSymlinkAtomic(spec.destination, spec.linkTarget as string);
  } else {
    writeFileAtomic(spec.destination, spec.content as string | Buffer);
  }
}

function applySummary(operations: AppliedLifecycleOperation[]): LifecycleApplySummary {
  const summary: LifecycleApplySummary = {
    applied: 0,
    noop: 0,
    failed: 0,
    blocked_unowned: 0,
    skipped_dependency: 0,
    action_required: 0,
  };
  for (const operation of operations) summary[operation.status] += 1;
  return summary;
}

export function applyLifecycleOperations(
  plan: LifecycleOperationPlan,
  options: LifecycleApplyOptions = {},
): LifecycleApplyResult {
  const request = plan.request;
  validateRequest(request);
  let ledger = cloneLedger(request.ledger ?? emptyLifecycleOwnershipLedger());
  const results: AppliedLifecycleOperation[] = [];
  const resultById = new Map<string, AppliedLifecycleOperation>();
  for (const spec of executionOrder(request.operations)) {
    const dependencyCauses = (spec.dependsOn ?? []).filter((dependency) => {
      const status = resultById.get(dependency)?.status;
      return status !== "applied" && status !== "noop";
    });
    const current = planOne(spec, request.manifest, ledger, request.allowedRoots);
    if (dependencyCauses.length > 0) {
      const result: AppliedLifecycleOperation = {
        ...current,
        status: "skipped_dependency",
        dependencyCauses,
        reason: `skipped because dependencies did not succeed: ${dependencyCauses.join(", ")}`,
      };
      results.push(result);
      resultById.set(spec.id, result);
      continue;
    }
    if (current.action === "noop" || current.action === "blocked_unowned" || current.action === "action_required") {
      const status: LifecycleApplyStatus = current.action === "noop" ? "noop" : current.action;
      const result = { ...current, status, dependencyCauses: [] };
      results.push(result);
      resultById.set(spec.id, result);
      continue;
    }
    try {
      if (current.action === "finalize_ownership") {
        const next = spec.intent === "remove"
          ? withRecord(ledger, null, spec.id)
          : withRecord(ledger, nextManagedRecord(spec), spec.id);
        ledger = publishLedger(next, options.persistLedger);
      } else {
        const existingRecord = ledger.records.find((record) => record.resourceId === spec.id);
        if (current.action === "create" && !existingRecord) {
          const pending: LifecycleOwnershipRecord = {
            ...nextManagedRecord(spec),
            status: "pending_create",
          };
          ledger = publishLedger(withRecord(ledger, pending, spec.id), options.persistLedger);
        }
        mutateResource(spec, current.action);
        const next = current.action === "remove"
          ? withRecord(ledger, null, spec.id)
          : withRecord(ledger, nextManagedRecord(spec), spec.id);
        ledger = publishLedger(next, options.persistLedger);
      }
      const result: AppliedLifecycleOperation = {
        ...current,
        status: "applied",
        dependencyCauses: [],
      };
      results.push(result);
      resultById.set(spec.id, result);
    } catch (error) {
      const result: AppliedLifecycleOperation = {
        ...current,
        status: "failed",
        dependencyCauses: [],
        reason: `${current.action} failed: ${(error as Error).message}`,
      };
      results.push(result);
      resultById.set(spec.id, result);
    }
  }
  const requiredUnmet = results
    .filter((result) => result.required && result.status !== "applied" && result.status !== "noop")
    .map((result) => result.id);
  return {
    schemaVersion: "agentera.lifecycleApplyResult.v1",
    status: requiredUnmet.length === 0 ? "success" : "non_success",
    operations: results,
    summary: applySummary(results),
    requiredUnmet,
    ownershipLedger: ledger,
  };
}
