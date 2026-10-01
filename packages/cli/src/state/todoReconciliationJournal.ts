import { createHash } from "node:crypto";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { TODO_RECONCILIATION_ACTIVATION_PATH } from "./todoReconciliationActivation.js";
import { reject } from "./write/errors.js";
import type { Journal, JournalTarget, TodoReconciliationCreateReceipt } from "./todoReconciliationTransaction.js";

export const VERSION = "agentera.todoReconciliationTransaction.v1";
export const DIRECTORY = ".agentera/.todo-reconciliation";
export const MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
export const MAX_TARGET_BYTES = 1024 * 1024;
export const MAX_TARGETS = Math.floor(MAX_JOURNAL_BYTES / 32);
const ENTITY_MODE_MARKER = ".agentera/state-mode.yaml";
const decode = (bytes: string): Buffer => Buffer.from(bytes, "base64");
function exactBase64(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return decode(value).toString("base64") === value;
  } catch {
    return false;
  }
}
export function validTarget(relative: string, publicPath: string): boolean {
  return relative === publicPath || relative === TODO_RECONCILIATION_ACTIVATION_PATH || relative === ENTITY_MODE_MARKER || /^\.agentera\/entities\/[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*\/[a-z]{10}\.yaml$/.test(relative);
}
export function invalidJournal(message: string): never {
  reject({
    class: "conflict",
    message,
    recovery: `Preserve '${DIRECTORY}', restore its last valid committed journal bytes, and retry the exact non-dry-run TODO mutation; no target bytes were changed.`,
  });
}

/** The existing journal validator, shared by read-only inspection and recovery. */
export function parseTodoReconciliationJournal(bytes: Buffer, fileName: string | undefined, inferCreate: (targets: JournalTarget[]) => TodoReconciliationCreateReceipt | undefined): Journal {
  if (bytes.length > MAX_JOURNAL_BYTES) invalidJournal("TODO reconciliation journal exceeds its byte bound");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    invalidJournal("TODO reconciliation journal is not valid bounded UTF-8 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidJournal("TODO reconciliation journal is not a mapping");
  const value = parsed as Partial<Journal>;
  const expectedKeys = [
    "schema_version",
    "id",
    "public_path",
    "mapping_sha256",
    "targets",
    ...(value.create === undefined ? [] : ["create"]),
    ...(value.create_batch === undefined ? [] : ["create_batch"]),
    ...(value.activation_effect_sha256 === undefined ? [] : ["activation_effect_sha256"]),
    ...(value.owner_mapping_sha256 === undefined ? [] : ["owner_mapping_sha256"]),
    ...(value.update_batch_effect_sha256 === undefined ? [] : ["update_batch_effect_sha256"]),
  ]
    .sort()
    .join(",");
  if (
    Object.keys(value).sort().join(",") !== expectedKeys ||
    value.schema_version !== VERSION ||
    typeof value.id !== "string" ||
    !/^[a-f0-9]{24}$/.test(value.id) ||
    typeof value.public_path !== "string" ||
    typeof value.mapping_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.mapping_sha256) ||
    !Array.isArray(value.targets) ||
    value.targets.length < 1 ||
    value.targets.length > MAX_TARGETS
  )
    invalidJournal("TODO reconciliation journal is malformed");
  if (value.activation_effect_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.activation_effect_sha256)) invalidJournal("TODO reconciliation journal has an invalid activation effect authorization");
  if (value.owner_mapping_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.owner_mapping_sha256)) invalidJournal("TODO reconciliation journal has an invalid owner-mapping authorization");
  if (value.update_batch_effect_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(value.update_batch_effect_sha256)) invalidJournal("TODO reconciliation journal has an invalid update-batch effect authorization");
  if (
    value.create_batch !== undefined &&
    (!value.create_batch ||
      typeof value.create_batch !== "object" ||
      Array.isArray(value.create_batch) ||
      Object.keys(value.create_batch).sort().join(",") !== "effect_sha256,input_sha256,local_refs" ||
      !/^[a-f0-9]{64}$/.test(value.create_batch.effect_sha256) ||
      !/^[a-f0-9]{64}$/.test(value.create_batch.input_sha256) ||
      !value.create_batch.local_refs ||
      typeof value.create_batch.local_refs !== "object" ||
      Array.isArray(value.create_batch.local_refs) ||
      Object.entries(value.create_batch.local_refs).some(([ref, id]) => !/^[a-z][a-z0-9_-]{0,63}$/.test(ref) || typeof id !== "string" || !/^[a-z]{10}$/.test(id)))
  )
    invalidJournal("TODO reconciliation journal has an invalid create-batch receipt");
  if (
    value.create !== undefined &&
    (!value.create ||
      typeof value.create !== "object" ||
      Array.isArray(value.create) ||
      Object.keys(value.create).sort().join(",") !== "created_id,request_sha256" ||
      typeof value.create.created_id !== "string" ||
      !/^[a-z]{10}$/.test(value.create.created_id) ||
      typeof value.create.request_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.create.request_sha256))
  )
    invalidJournal("TODO reconciliation journal has an invalid create receipt");
  const paths = new Set<string>();
  for (const target of value.targets) {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      Object.keys(target).sort().join(",") !== "after,before,path" ||
      typeof target.path !== "string" ||
      !validTarget(target.path, value.public_path) ||
      paths.has(target.path) ||
      (target.before !== null && !exactBase64(target.before)) ||
      !exactBase64(target.after) ||
      decode(target.after).length > MAX_TARGET_BYTES ||
      (target.before !== null && decode(target.before).length > MAX_TARGET_BYTES)
    )
      invalidJournal("TODO reconciliation journal has an invalid target");
    paths.add(target.path);
  }
  const body = value.targets as JournalTarget[];
  const activates = body.some((target) => target.path === TODO_RECONCILIATION_ACTIVATION_PATH);
  if (!activates && (value.activation_effect_sha256 !== undefined || value.owner_mapping_sha256 !== undefined)) invalidJournal("TODO reconciliation journal effect authorization has no activation target");
  if (value.owner_mapping_sha256 !== undefined && value.activation_effect_sha256 === undefined) invalidJournal("TODO reconciliation journal owner-mapping authorization has no effect authorization");
  const inferredCreate = inferCreate(body);
  if (value.create && (!inferredCreate || value.create.created_id !== inferredCreate.created_id || value.create.request_sha256 !== inferredCreate.request_sha256)) invalidJournal("TODO reconciliation create receipt does not match its canonical entity target");
  const identity =
    value.create || value.create_batch || value.activation_effect_sha256 || value.owner_mapping_sha256 || value.update_batch_effect_sha256
      ? {
          ...(value.create ? { create: value.create } : {}),
          ...(value.create_batch ? { create_batch: value.create_batch } : {}),
          ...(value.activation_effect_sha256 ? { activation_effect_sha256: value.activation_effect_sha256 } : {}),
          ...(value.owner_mapping_sha256 ? { owner_mapping_sha256: value.owner_mapping_sha256 } : {}),
          ...(value.update_batch_effect_sha256 ? { update_batch_effect_sha256: value.update_batch_effect_sha256 } : {}),
          targets: body,
        }
      : body;
  const expectedId = createHash("sha256").update(canonicalRecordJson(identity)).digest("hex").slice(0, 24);
  if (value.id !== expectedId || (fileName !== undefined && fileName !== `${value.id}.json`)) invalidJournal("TODO reconciliation journal identity does not match its canonical targets");
  const create = value.create ?? (value.create_batch ? undefined : inferredCreate);
  return { ...value, ...(create ? { create } : {}) } as Journal;
}
