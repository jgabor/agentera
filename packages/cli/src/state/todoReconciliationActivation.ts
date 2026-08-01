import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { reject } from "./write/errors.js";

export const TODO_RECONCILIATION_ACTIVATION_PATH = ".agentera/todo-reconciliation-activation.json";
export const TODO_RECONCILIATION_ACTIVATION_VERSION = "agentera.todoReconciliationActivation.v1";
export const TODO_RECONCILIATION_ITEM_LIMIT = 256;

const MAX_ACTIVATION_BYTES = 32 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export interface TodoReconciliationActivation {
  schema_version: typeof TODO_RECONCILIATION_ACTIVATION_VERSION;
  retained_legacy_rows: string[];
}

function activationFailure(message: string): never {
  reject({
    class: "conflict",
    message,
    recovery: `Preserve '${TODO_RECONCILIATION_ACTIVATION_PATH}', restore its last valid committed bytes, and retry the exact TODO mutation; no state was changed.`,
  });
}

export function todoLegacyRowFingerprint(section: string, line: string): string {
  return createHash("sha256").update(section).update("\0").update(line).digest("hex");
}

export function todoReconciliationActivationBytes(
  retainedLegacyRows: Iterable<string>,
): string {
  const retained = [...retainedLegacyRows].sort();
  if (
    retained.length > TODO_RECONCILIATION_ITEM_LIMIT
    || new Set(retained).size !== retained.length
    || retained.some((digest) => !SHA256.test(digest))
  ) activationFailure("TODO reconciliation activation has invalid retained legacy-row identities");
  return `${JSON.stringify({
    schema_version: TODO_RECONCILIATION_ACTIVATION_VERSION,
    retained_legacy_rows: retained,
  })}\n`;
}

export function loadTodoReconciliationActivation(
  root: string,
): { record: TodoReconciliationActivation; bytes: Buffer } | null {
  const target = path.join(root, TODO_RECONCILIATION_ACTIVATION_PATH);
  if (!fs.existsSync(target)) return null;
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    activationFailure("TODO reconciliation activation must be a regular file");
  }
  const bytes = fs.readFileSync(target);
  if (bytes.length > MAX_ACTIVATION_BYTES) {
    activationFailure("TODO reconciliation activation exceeds its 32768-byte bound");
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    activationFailure("TODO reconciliation activation is not valid bounded UTF-8 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    activationFailure("TODO reconciliation activation is not a mapping");
  }
  const record = value as Partial<TodoReconciliationActivation>;
  if (
    Object.keys(record).sort().join(",") !== "retained_legacy_rows,schema_version"
    || record.schema_version !== TODO_RECONCILIATION_ACTIVATION_VERSION
    || !Array.isArray(record.retained_legacy_rows)
    || record.retained_legacy_rows.length > TODO_RECONCILIATION_ITEM_LIMIT
    || record.retained_legacy_rows.some((digest) => typeof digest !== "string" || !SHA256.test(digest))
    || new Set(record.retained_legacy_rows).size !== record.retained_legacy_rows.length
  ) activationFailure("TODO reconciliation activation has an invalid canonical record");
  return { record: record as TodoReconciliationActivation, bytes };
}
