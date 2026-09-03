import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import { allocateAndPublishEntity, allocateEntityId, assertEntityDiscoveryOrigin, discoverEntities, publishEntity, type DiscoveredEntity } from "./entityStorage.js";
import type { EntityPublicationContext } from "./entityPublicationContext.js";
import { healthEntityViolations } from "./healthEntityValidation.js";
import { detailMetadata, detailProvenance, isSummaryEntity } from "./summaryEntityRead.js";
import { decodeListCursor, encodeListCursor, projectedListSnapshot } from "./listCursor.js";
import { localDate } from "./write/assign.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";
import { loadStateStorageAuthority } from "./stateStorageAuthority.js";
import { entityListSelectorFlags, entityListSelectorKey, projectEntityList, resolveEntityListSelector, type EntityListSelectorInput } from "./entityListProjection.js";
import { shellQuoteArgument } from "../core/shell.js";

const ARTIFACT = "health";
const BOUNDARY = "health_audit";
const SUMMARY = "health_summary";
const ORDER = "appended_at_desc_then_id_asc_then_legacy_date_desc_then_id_asc";
const ID_PATTERN = /^[a-z]{10}$/;

interface HealthContract {
  authorityPath: string;
  entityRoot: string;
  defaultLimit: number;
  maximumLimit: number;
  maxUtf8Bytes: number;
}

export interface HealthEntityOptions {
  sourceRoot?: string;
  id?: string;
  candidate?: () => string;
  publicationContext?: EntityPublicationContext;
}

function mapping(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`invalid health entity ${field} authority`);
  return result;
}

function contract(sourceRoot = resolveSourceRoot()): HealthContract {
  const { authorityPath, document: authority } = loadStateStorageAuthority(sourceRoot);
  const target = mapping(authority.entity_target) ? authority.entity_target : {};
  const storage = mapping(target.storage_boundary) && mapping(target.storage_boundary.shared_primitives) ? target.storage_boundary.shared_primitives : {};
  const entities = Array.isArray(target.entities) ? target.entities : [];
  const health = entities.find((value) => mapping(value) && value.boundary === BOUNDARY && value.artifact === ARTIFACT);
  const retrieval = mapping(health) && mapping(health.retrieval) ? health.retrieval : {};
  if (typeof storage.canonical_root !== "string") throw new Error(`invalid health entity contract in '${authorityPath}'`);
  return {
    authorityPath,
    entityRoot: storage.canonical_root,
    defaultLimit: positive(retrieval.default_limit, "default_limit"),
    maximumLimit: positive(retrieval.maximum_limit, "maximum_limit"),
    maxUtf8Bytes: positive(retrieval.max_utf8_bytes, "max_utf8_bytes"),
  };
}

function failure(kind: StateFailureClass, message: string, recovery: string, id?: string, exitCode: 1 | 2 = 1): StateRetrievalFailure {
  return new StateRetrievalFailure(
    {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: kind,
        message,
        syntax: "agentera state health get --id ID",
        example: `agentera state health get --id ${id ?? "qjtrmnpvka"}`,
        recovery,
        artifact: ARTIFACT,
        ...(id ? { id } : {}),
      },
    },
    exitCode,
  );
}

function listFailure(kind: StateFailureClass, message: string, recovery: string, exitCode: 1 | 2 = 1): StateRetrievalFailure {
  const result = failure(kind, message, recovery, undefined, exitCode);
  result.body.error.syntax = "agentera state health list [--limit N] [--cursor TOKEN]";
  result.body.error.example = "agentera state health list --limit 20";
  return result;
}

function healthRecord(values: Record<string, unknown>): JsonObject {
  for (const field of ["id", "artifact", "number", "stable_id", "artifact_id", "entry_number", "appended_at"]) {
    if (field in values) throw new Error(`health entity record forbids identity field '${field}'`);
  }
  const record = structuredClone(values) as JsonObject;
  if (typeof record.date !== "string") record.date = localDate();
  record.appended_at = new Date().toISOString();
  const violations = healthEntityViolations(record);
  if (violations.length) throw new Error(`health entity violates the canonical audit schema: ${violations.join("; ")}`);
  return record;
}

function envelope(published: { path: string; id: string; artifact: string; replay: boolean }, record: JsonObject, dryRun: boolean): StateWriteEnvelope {
  return {
    schemaVersion: "agentera.stateWrite.v1",
    command: "state health append",
    status: "pass",
    path: published.path,
    id: published.id,
    artifact: published.artifact,
    record,
    operation: { verb: "append", dry_run: dryRun, idempotent_replay: published.replay },
    validation: { status: "pass", violations: [] },
  };
}

function withoutAppendTimestamp(record: JsonObject): JsonObject {
  const copy = structuredClone(record);
  delete copy.appended_at;
  return copy;
}

function existingReplay(root: string, sourceRoot: string, id: string, record: JsonObject): DiscoveredEntity | null {
  const existing = discoverEntities(root, sourceRoot).entities.find((entity) => entity.id === id && entity.artifact === ARTIFACT && entity.boundary === BOUNDARY && entity.classification === "valid" && entity.record !== null && healthEntityViolations(entity.record).length === 0);
  if (!existing || canonicalRecordJson(withoutAppendTimestamp(existing.record!)) !== canonicalRecordJson(withoutAppendTimestamp(record))) return null;
  return existing;
}

export function appendHealthEntity(req: StateWriteRequest, options: HealthEntityOptions = {}): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const declared = contract(sourceRoot);
  const record = healthRecord(req.input ?? req.values);
  if (req.dryRun) {
    options.publicationContext?.assertValid();
    const id = options.id ?? allocateEntityId(options.publicationContext?.pinnedPath() ?? req.projectRoot, options.candidate, sourceRoot);
    options.publicationContext?.assertValid();
    return envelope(
      {
        path: path.join(path.resolve(req.projectRoot), declared.entityRoot, ARTIFACT, BOUNDARY, `${id}.yaml`),
        id,
        artifact: ARTIFACT,
        replay: false,
      },
      record,
      true,
    );
  }
  if (options.id) {
    const replay = existingReplay(req.projectRoot, sourceRoot, options.id, record);
    if (replay) return envelope({ path: replay.path, id: options.id, artifact: ARTIFACT, replay: true }, replay.record!, false);
  }
  const published = options.id
    ? publishEntity({
        projectRoot: req.projectRoot,
        sourceRoot,
        publicationContext: options.publicationContext,
        artifact: ARTIFACT,
        boundary: BOUNDARY,
        id: options.id,
        record,
      })
    : allocateAndPublishEntity(
        {
          projectRoot: req.projectRoot,
          sourceRoot,
          publicationContext: options.publicationContext,
          artifact: ARTIFACT,
          boundary: BOUNDARY,
          record,
        },
        options.candidate,
      );
  return envelope(published, record, false);
}

function relative(root: string, candidate: string): string {
  return path.relative(path.resolve(root), candidate).split(path.sep).join("/");
}

function healthEntities(root: string, sourceRoot: string, supplied?: ReturnType<typeof discoverEntities>): DiscoveredEntity[] {
  if (supplied) assertEntityDiscoveryOrigin(root, sourceRoot, supplied);
  const discovery = supplied ?? discoverEntities(root, sourceRoot);
  const relevant = discovery.entities.filter((entity) => entity.artifact === ARTIFACT || entity.boundary === BOUNDARY);
  const bad = relevant.find((entity) => entity.classification !== "valid" || !entity.id || !entity.record || (entity.boundary === BOUNDARY && healthEntityViolations(entity.record).length > 0));
  if (bad) throw listFailure(bad.classification === "duplicate" ? "ambiguous" : "corrupt", `health entity '${bad.relativePath}' is not canonical`, "Run agentera check validate state, preserve conflicting evidence, and repair the canonical entity files.");
  return relevant;
}

function entry(root: string, entity: DiscoveredEntity): JsonObject {
  const id = entity.id!;
  return {
    id,
    artifact: ARTIFACT,
    record: entity.record!,
    ...detailMetadata(entity),
    provenance: detailProvenance(relative(root, entity.path), entity),
    retrieval: { get: `agentera state health get --id ${id}` },
  };
}

export function getHealthEntity(root: string, id: string, sourceRoot = resolveSourceRoot()): JsonObject {
  if (!ID_PATTERN.test(id)) throw failure("invalid_request", `health ID '${id}' must be ten lowercase letters`, "Use a bare ID returned by health append or list.", id, 2);
  const all = discoverEntities(root, sourceRoot).entities;
  const matches = all.filter((entity) => entity.id === id);
  if (matches.length > 1 || matches.some((entity) => entity.classification === "duplicate")) throw failure("ambiguous", `health entity ID '${id}' has multiple canonical candidates`, "Run agentera check validate state, preserve conflicting evidence, and assign unique IDs.", id);
  const selected = matches[0];
  const expectedPath = path.join(path.resolve(root), contract(sourceRoot).entityRoot, ARTIFACT, selected?.boundary === SUMMARY ? SUMMARY : BOUNDARY, `${id}.yaml`);
  const canonical = all.find((entity) => entity.path === expectedPath);
  if (!selected && canonical) throw failure("corrupt", `health entity '${canonical.relativePath}' does not match its canonical ID envelope`, "Run agentera check validate state and repair the canonical entity file.", id);
  if (!selected || selected.artifact !== ARTIFACT || ![BOUNDARY, SUMMARY].includes(selected.boundary ?? "")) throw failure("not_found", `no health entity exists with ID '${id}'`, "Copy an ID from agentera state health list and retry.", id);
  if (selected.classification !== "valid" || !selected.record || (selected.boundary === BOUNDARY && healthEntityViolations(selected.record).length > 0))
    throw failure("corrupt", `health entity '${selected.relativePath}' is corrupt or violates the audit contract`, "Run agentera check validate state, preserve its evidence, and repair the canonical entity file.", id);
  return {
    schemaVersion: "agentera.stateRetrieval.v1",
    command: "state health get",
    status: isSummaryEntity(selected) ? "degraded" : "ok",
    entry: entry(root, selected),
    source: { artifact: ARTIFACT, authority: "canonical_entity_file" },
    source_contract: {
      authority: "references/artifacts/state-storage-authority.yaml",
      detail: isSummaryEntity(selected) ? "summary" : "full",
    },
  };
}

function appendTimestamp(entity: DiscoveredEntity): string | null {
  return typeof entity.record?.appended_at === "string" ? entity.record.appended_at : null;
}

function compareHealthEntities(left: DiscoveredEntity, right: DiscoveredEntity): number {
  const leftTimestamp = appendTimestamp(left);
  const rightTimestamp = appendTimestamp(right);
  if (leftTimestamp !== null && rightTimestamp !== null) {
    return rightTimestamp.localeCompare(leftTimestamp) || left.id!.localeCompare(right.id!);
  }
  if (leftTimestamp !== null) return -1;
  if (rightTimestamp !== null) return 1;
  return String(right.record!.date ?? "").localeCompare(String(left.record!.date ?? "")) || left.id!.localeCompare(right.id!);
}

function key(entity: DiscoveredEntity): string {
  return `${appendTimestamp(entity) ?? String(entity.record!.date ?? "")}\0${entity.id}`;
}
function snapshot(root: string, entities: DiscoveredEntity[], dimension: string | undefined, entityRoot: string): string {
  return projectedListSnapshot({
    schemaVersion: "agentera.stateList.v1",
    command: "state health list",
    order: ORDER,
    filters: { dimension: dimension ?? null },
    source: { artifact: ARTIFACT, authority: "canonical_entity_files", root: entityRoot },
    source_contract: {
      authority: "references/artifacts/state-storage-authority.yaml",
      detail: entities.some(isSummaryEntity) ? "mixed" : "full",
      cursor: "opaque_snapshot_cursor",
    },
    entries: entities.map((entity) => entry(root, entity)),
  });
}
function encode(payload: JsonObject, root: string, authorityPath: string): string {
  return encodeListCursor(payload, root, authorityPath);
}
function decode(token: string, root: string, authorityPath: string): JsonObject {
  try {
    return decodeListCursor(token, root, authorityPath);
  } catch {
    throw listFailure("cursor_invalid", "health cursor is malformed or belongs to another project", "Copy next_cursor exactly, or omit --cursor to restart.");
  }
}
export function listHealthEntities(
  root: string,
  limit?: number,
  dimension?: string,
  cursor?: string,
  options: {
    sourceRoot?: string;
    format?: string;
    discovery?: ReturnType<typeof discoverEntities>;
    selector?: EntityListSelectorInput;
  } = {},
): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const declared = contract(sourceRoot);
  const effectiveLimit = limit ?? declared.defaultLimit;
  if (!Number.isSafeInteger(effectiveLimit) || effectiveLimit < 1 || effectiveLimit > declared.maximumLimit) throw listFailure("invalid_request", `health list limit must be 1..${declared.maximumLimit}`, "Use a limit in the declared range.", 2);
  const all = healthEntities(root, sourceRoot, options.discovery);
  let filtered = [...all].sort(compareHealthEntities);
  if (dimension) {
    const needle = dimension.toLowerCase();
    filtered = filtered.filter((entity) => canonicalRecordJson(entity.record).toLowerCase().includes(needle));
  }
  const format = options.format ?? "json";
  const projectionOptions = {
    family: "health" as const,
    artifact: ARTIFACT,
    boundary: BOUNDARY,
    format,
    maxUtf8Bytes: declared.maxUtf8Bytes,
    selector: options.selector,
  };
  const selector = resolveEntityListSelector(
    options.selector,
    filtered.map((entity) => entry(root, entity)),
    projectionOptions,
  );
  const selectorKey = entityListSelectorKey(selector);
  const snap = snapshot(root, filtered, dimension, declared.entityRoot);
  let start = 0;
  if (cursor) {
    const value = decode(cursor, root, declared.authorityPath);
    if (value.selector !== selectorKey) throw listFailure("cursor_invalid", "health cursor selectors do not match this request", "Repeat the original selector, or omit --cursor to restart from the current snapshot.");
    if (value.version !== 1 || value.artifact !== ARTIFACT || value.order !== ORDER || value.snapshot_id !== snap || value.dimension !== (dimension ?? null))
      throw listFailure("cursor_snapshot_unavailable", "health state or filters changed after this cursor snapshot", "Repeat the original filters, or omit --cursor to restart from the current snapshot.");
    const found = filtered.findIndex((entity) => key(entity) === value.after_key);
    if (found < 0) throw listFailure("cursor_snapshot_unavailable", "health cursor continuation is unavailable", "Omit --cursor to restart.");
    start = found + 1;
  }
  const selected = filtered.slice(start, start + effectiveLimit);
  const response = (): JsonObject => {
    const remaining = filtered.length - start - selected.length;
    const next =
      remaining && selected.length
        ? encode(
            {
              version: 1,
              artifact: ARTIFACT,
              order: ORDER,
              snapshot_id: snap,
              selector: selectorKey,
              dimension: dimension ?? null,
              after_key: key(selected.at(-1)!),
            },
            root,
            declared.authorityPath,
          )
        : undefined;
    const selectorFlags = entityListSelectorFlags(selector);
    return {
      schemaVersion: "agentera.stateList.v1",
      command: "state health list",
      status: remaining || filtered.some(isSummaryEntity) ? "degraded" : "ok",
      entries: selected.map((entity) => entry(root, entity)),
      counts: { total: filtered.length, returned: selected.length, remaining },
      filters: { dimension: dimension ?? null },
      snapshot: {
        id: snap,
        first_page: !cursor,
        order: ORDER,
        has_more: Boolean(remaining),
        candidate_count: filtered.length,
      },
      source: {
        artifact: ARTIFACT,
        authority: "canonical_entity_files",
        root: declared.entityRoot,
      },
      source_contract: {
        authority: "references/artifacts/state-storage-authority.yaml",
        detail: filtered.some(isSummaryEntity) ? "mixed" : "full",
        cursor: "opaque_snapshot_cursor",
      },
      retrieval: {
        ...(next
          ? {
              continue: `agentera state health list${dimension ? ` --dimension ${shellQuoteArgument(dimension)}` : ""}${selectorFlags} --limit ${effectiveLimit} --cursor ${next}`,
            }
          : {}),
      },
      ...(remaining
        ? {
            omitted: true,
            omitted_count: remaining,
            omission_reason: "page_limit",
            next_cursor: next,
          }
        : {}),
    };
  };
  return projectEntityList(response(), selector, projectionOptions);
}
