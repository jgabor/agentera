import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { reject } from "./write/errors.js";
import type { JsonObject } from "../core/jsonValue.js";
import { CANONICAL_DEVELOPMENT_CLI } from "../core/developmentChannel.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import type { TodoReconciliationTarget } from "./todoReconciliationTransaction.js";

export const TODO_RECONCILIATION_ACTIVATION_PATH = ".agentera/todo-reconciliation-activation.json";
export const TODO_RECONCILIATION_ACTIVATION_VERSION = "agentera.todoReconciliationActivation.v1";
export const TODO_RECONCILIATION_ITEM_LIMIT = 256;

const MAX_ACTIVATION_BYTES = 32 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
export const TODO_ACTIVATION_PREVIEW_COMMAND = `${CANONICAL_DEVELOPMENT_CLI} state todo activate --dry-run --format json`;
export const TODO_ACTIVATION_APPLY_COMMAND = `${CANONICAL_DEVELOPMENT_CLI} state todo activate --effect-sha256 EFFECT_SHA256 --yes --format json`;
const CHANGE_LIMIT = 20;

export interface TodoReconciliationActivation {
  schema_version: typeof TODO_RECONCILIATION_ACTIVATION_VERSION;
  retained_legacy_rows: string[];
  effect_sha256?: string;
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
  effectSha256?: string,
): string {
  const retained = [...retainedLegacyRows].sort();
  if (
    retained.length > TODO_RECONCILIATION_ITEM_LIMIT
    || new Set(retained).size !== retained.length
    || retained.some((digest) => !SHA256.test(digest))
  ) activationFailure("TODO reconciliation activation has invalid retained legacy-row identities");
  if (effectSha256 !== undefined && !SHA256.test(effectSha256)) activationFailure("TODO reconciliation activation has an invalid effect authorization");
  return `${JSON.stringify({
    schema_version: TODO_RECONCILIATION_ACTIVATION_VERSION,
    retained_legacy_rows: retained,
    ...(effectSha256 ? { effect_sha256: effectSha256 } : {}),
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
    !["retained_legacy_rows,schema_version", "effect_sha256,retained_legacy_rows,schema_version"].includes(Object.keys(record).sort().join(","))
    || record.schema_version !== TODO_RECONCILIATION_ACTIVATION_VERSION
    || !Array.isArray(record.retained_legacy_rows)
    || record.retained_legacy_rows.length > TODO_RECONCILIATION_ITEM_LIMIT
    || record.retained_legacy_rows.some((digest) => typeof digest !== "string" || !SHA256.test(digest))
    || new Set(record.retained_legacy_rows).size !== record.retained_legacy_rows.length
    || (record.effect_sha256 !== undefined && (typeof record.effect_sha256 !== "string" || !SHA256.test(record.effect_sha256)))
  ) activationFailure("TODO reconciliation activation has an invalid canonical record");
  return { record: record as TodoReconciliationActivation, bytes };
}

function sha256(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function boundedPublicChanges(before: string, after: string): JsonObject {
  const beforeLines = before.split(/\r?\n/); const afterLines = after.split(/\r?\n/); const changes: JsonObject[] = []; let count = 0;
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
    if (beforeLines[index] === afterLines[index]) continue; count += 1;
    if (changes.length < CHANGE_LIMIT) changes.push({ line: index + 1, before: (beforeLines[index] ?? "").slice(0, 240), after: (afterLines[index] ?? "").slice(0, 240) });
  }
  return { count, items: changes, omitted_count: count - changes.length };
}
export function todoActivationEffect(scan: { matchedRows: number; convertedRows: number; retainedLegacyRows: string[] }, targets: readonly TodoReconciliationTarget[], publicPath: string, markdownBefore: Buffer, rendered: string, resurrectedIds: readonly string[]): JsonObject {
  const changedTargets = targets.filter((target) => target.before === null || !target.before.equals(Buffer.from(target.after))).map((target) => ({ path: target.path, before_sha256: target.before === null ? null : sha256(target.before), after_sha256: sha256(target.after) }));
  const evidence: JsonObject = {
    counts: { matched: scan.matchedRows, converted: scan.convertedRows, retained: scan.retainedLegacyRows.length, conflicting: 0 }, targets: changedTargets,
    public_document: { path: publicPath, changed: !markdownBefore.equals(Buffer.from(rendered)), before_bytes: markdownBefore.length, after_bytes: Buffer.byteLength(rendered), before_sha256: sha256(markdownBefore), after_sha256: sha256(rendered), changed_lines: boundedPublicChanges(markdownBefore.toString("utf8"), rendered) },
    risks: { resurrected_count: resurrectedIds.length, resurrected_ids: resurrectedIds.slice(0, CHANGE_LIMIT), omitted_count: Math.max(0, resurrectedIds.length - CHANGE_LIMIT) },
  };
  const authorizedTargets = changedTargets.map((target) => target.path === TODO_RECONCILIATION_ACTIVATION_PATH ? { ...target, after_sha256: "activation_effect_authorization" } : target);
  return { ...evidence, effect_sha256: sha256(canonicalRecordJson({ ...evidence, targets: authorizedTargets })) };
}
export function unchangedTodoActivationEffect(publicPath: string, markdown: Buffer, retained: number, authorizedEffectSha256?: string): JsonObject {
  const evidence: JsonObject = { counts: { matched: 0, converted: 0, retained, conflicting: 0 }, targets: [], public_document: { path: publicPath, changed: false, before_bytes: markdown.length, after_bytes: markdown.length, before_sha256: sha256(markdown), after_sha256: sha256(markdown), changed_lines: { count: 0, items: [], omitted_count: 0 } }, risks: { resurrected_count: 0, resurrected_ids: [], omitted_count: 0 } };
  return { ...evidence, effect_sha256: authorizedEffectSha256 ?? sha256(canonicalRecordJson(evidence)) };
}
