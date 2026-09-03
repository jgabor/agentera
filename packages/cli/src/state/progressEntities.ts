import path from "node:path";
import { randomInt } from "node:crypto";

import YAML from "yaml";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import { allocateAndPublishEntity, allocateEntityId, assertEntityDiscoveryOrigin, discoverEntities, publishEntity, publishEntityUnderLock, withEntityWriterLock, type DiscoveredEntity } from "./entityStorage.js";
import type { EntityPublicationContext } from "./entityPublicationContext.js";
import { detailMetadata, detailProvenance, isSummaryEntity } from "./summaryEntityRead.js";
import { decodeListCursor, encodeListCursor, projectedListSnapshot } from "./listCursor.js";
import { localTimestamp } from "./write/assign.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";
import { glossaryCaveatPairAllowed, glossaryCaveatContract, type GlossaryCaveatContract } from "../registries/glossaryCaveatContract.js";
import { validateProgressGlossaryCaveat, type GlossaryCaveatEnvelope } from "./progressGlossaryCaveat.js";
import { nextProgressPublicationOrder, progressPublicationOrder, PROGRESS_PUBLICATION_ORDER_FIELD } from "./progressPublicationOrder.js";
import { detectStateModeBinding } from "./stateMode.js";
import { loadStateStorageAuthority } from "./stateStorageAuthority.js";
import { entityListSelectorFlags, entityListSelectorKey, projectEntityList, resolveEntityListSelector, type EntityListSelectorInput } from "./entityListProjection.js";
import { shellQuoteArgument } from "../core/shell.js";

const ARTIFACT = "progress";
const BOUNDARY = "progress_cycle";
const SUMMARY = "progress_summary";
const ORDER = "timestamp_desc_then_publication_order_desc_then_id_asc";
const CURSOR_VERSION = 2;

interface ProgressContract {
  authorityPath: string;
  entityRoot: string;
  defaultLimit: number;
  maximumLimit: number;
  maxUtf8Bytes: number;
}

interface ProgressCursor {
  version: number;
  artifact: "progress";
  order: string;
  filters: JsonObject;
  snapshot_id: string;
  selector: string;
  after_key: string;
}

export interface ProgressEntityListOptions {
  sourceRoot?: string;
  format?: "text" | "json" | "yaml";
  discovery?: ReturnType<typeof discoverEntities>;
  selector?: EntityListSelectorInput;
}

export interface AppendProgressEntityOptions {
  sourceRoot?: string;
  id?: string;
  candidate?: () => string;
  publicationContext?: EntityPublicationContext;
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function opaqueCaveatId(existing: Set<string>, contract: GlossaryCaveatContract): string {
  const alphabet = contract.idAlphabet;
  for (;;) {
    let id = "";
    for (let index = 0; index < contract.idLength; index += 1) id += alphabet[randomInt(alphabet.length)];
    if (!existing.has(id)) return id;
  }
}

function prepareGlossaryCaveat(values: Record<string, unknown>, discovery: ReturnType<typeof discoverEntities>, contract: GlossaryCaveatContract): { caveat?: GlossaryCaveatEnvelope; replay?: DiscoveredEntity } {
  if (!Object.prototype.hasOwnProperty.call(values, "glossary_caveat")) return {};
  if (!mapping(values.glossary_caveat)) throw new Error("glossary caveat mutation must be one privacy-safe mapping");
  const requested = values.glossary_caveat;
  const mutationFields = contract.fields.filter((field) => field !== "capability");
  if (Object.keys(requested).some((field) => !mutationFields.includes(field))) throw new Error("glossary caveat mutation contains a non-contract field");
  const event = String(requested.event ?? "");
  const reason = String(requested.reason ?? "");
  const ownership = String(requested.ownership_state ?? "");
  if (!contract.events.includes(event) || !contract.reasons.includes(reason) || !contract.ownershipStates.includes(ownership) || !glossaryCaveatPairAllowed(contract, reason, ownership)) throw new Error("glossary caveat requires one contract-declared reason and ownership state pair");
  const entities = discovery.entities.filter((entity) => entity.classification === "valid" && entity.artifact === ARTIFACT && entity.boundary === BOUNDARY);
  const rows = entities.flatMap((entity) => {
    const parsed = validateProgressGlossaryCaveat(entity.record!, contract);
    return parsed.status === "valid" ? [{ entity, caveat: parsed.caveat }] : [];
  });
  const terminalIds = new Set(rows.filter(({ caveat }) => caveat.event !== "current").map(({ caveat }) => caveat.caveat_id));
  const open = rows.filter(({ caveat }) => caveat.event === "current" && !terminalIds.has(caveat.caveat_id));
  if (event === "current") {
    if (requested.caveat_id !== undefined || requested.transition_id !== undefined) throw new Error("current glossary caveat identity is CLI-assigned and has no transition identity");
    const replay = open.find(({ caveat }) => caveat.reason === reason && caveat.ownership_state === ownership);
    if (replay) return { replay: replay.entity };
    const caveat_id = opaqueCaveatId(new Set(rows.flatMap(({ caveat }) => [caveat.caveat_id, caveat.transition_id].filter((id): id is string => id !== null))), contract);
    return {
      caveat: {
        ...requested,
        caveat_id,
        event,
        capability: "build",
        reason,
        ownership_state: ownership,
        transition_id: null,
      } as GlossaryCaveatEnvelope,
    };
  }
  const caveatId = String(requested.caveat_id ?? "");
  if (!contract.idPattern.test(caveatId)) throw new Error("terminal glossary caveat requires one opaque caveat ID");
  const existingTerminal = rows.find(({ caveat }) => caveat.caveat_id === caveatId && caveat.event === event && caveat.reason === reason && caveat.ownership_state === ownership && caveat.transition_id === (requested.transition_id ?? null));
  if (existingTerminal) return { replay: existingTerminal.entity };
  const current = open.find(({ caveat }) => caveat.caveat_id === caveatId);
  if (!current || current.caveat.reason !== reason || current.caveat.ownership_state !== ownership) throw new Error("terminal glossary caveat must match one current caveat identity and vocabulary");
  if (event === "resolved") {
    if (requested.transition_id !== undefined) throw new Error("resolved glossary caveat cannot have a transition identity");
    return { caveat: { ...requested, ...current.caveat, event, transition_id: null } };
  }
  if (event !== "superseded") throw new Error("glossary caveat event is invalid");
  const transitionId = String(requested.transition_id ?? "");
  if (!contract.idPattern.test(transitionId) || transitionId === caveatId || !open.some(({ caveat }) => caveat.caveat_id === transitionId)) throw new Error("superseded glossary caveat requires one different current successor identity");
  return { caveat: { ...requested, ...current.caveat, event, transition_id: transitionId } };
}

function positive(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`invalid progress entity ${field} in state storage authority`);
  return number;
}

function progressContract(sourceRoot = resolveSourceRoot()): ProgressContract {
  const { authorityPath, document: authority } = loadStateStorageAuthority(sourceRoot);
  const target = authority.entity_target;
  const storage = mapping(target) && mapping(target.storage_boundary) ? target.storage_boundary.shared_primitives : null;
  const entities = mapping(target) && Array.isArray(target.entities) ? target.entities : [];
  const progress = entities.find((entity) => mapping(entity) && entity.boundary === BOUNDARY && entity.artifact === ARTIFACT);
  const retrieval = mapping(progress) ? progress.retrieval : null;
  if (!mapping(storage) || typeof storage.canonical_root !== "string" || !mapping(retrieval)) {
    throw new Error(`invalid progress entity contract in '${authorityPath}'`);
  }
  return {
    authorityPath,
    entityRoot: storage.canonical_root,
    defaultLimit: positive(retrieval.default_limit, "default_limit"),
    maximumLimit: positive(retrieval.maximum_limit, "maximum_limit"),
    maxUtf8Bytes: positive(retrieval.max_utf8_bytes, "max_utf8_bytes"),
  };
}

function failure(className: StateFailureClass, message: string, recovery: string, id?: string, exitCode: 1 | 2 = 1): StateRetrievalFailure {
  return new StateRetrievalFailure(
    {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: className,
        message,
        syntax: "agentera state progress get --id ID",
        example: `agentera state progress get --id ${id ?? "qjtrmnpvka"}`,
        recovery,
        artifact: ARTIFACT,
        ...(id ? { id } : {}),
      },
    },
    exitCode,
  );
}

function listFailure(className: StateFailureClass, message: string, recovery: string, exitCode: 1 | 2 = 1): StateRetrievalFailure {
  const result = failure(className, message, recovery, undefined, exitCode);
  result.body.error.syntax = "agentera state progress list [--limit N] [--cursor TOKEN]";
  result.body.error.example = "agentera state progress list --limit 20";
  return result;
}

function progressRecord(values: Record<string, unknown>, caveatContract: GlossaryCaveatContract): JsonObject {
  const context = mapping(values.context) ? values.context : {};
  const record: JsonObject = {
    timestamp: typeof values.timestamp === "string" ? values.timestamp : localTimestamp(),
    type: String(values.type ?? ""),
    phase: String(values.phase ?? ""),
    what: String(values.what ?? ""),
    context: { intent: String(context.intent ?? "") },
  };
  for (const field of ["inspiration", "discovered", "verified", "next"] as const) {
    if (typeof values[field] === "string") record[field] = values[field] as string;
  }
  for (const field of ["constraints", "unknowns", "scope"] as const) {
    if (typeof context[field] === "string") (record.context as JsonObject)[field] = context[field] as string;
  }
  if (Object.prototype.hasOwnProperty.call(values, "glossary_caveat")) record.glossary_caveat = values.glossary_caveat as JsonObject;
  const caveat = validateProgressGlossaryCaveat(record, caveatContract);
  if (caveat.status === "invalid") throw new Error(caveat.violations.join("; "));
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.timestamp))) throw new Error("progress entity timestamp must use YYYY-MM-DD HH:MM");
  if (!record.type || !record.phase || !record.what || !(record.context as JsonObject).intent) throw new Error("progress entity requires type, phase, what, and context.intent");
  return record;
}

function relative(projectRoot: string, candidate: string): string {
  return path.relative(path.resolve(projectRoot), candidate).split(path.sep).join("/");
}

function logicalProgressRecord(record: JsonObject): JsonObject {
  const { [PROGRESS_PUBLICATION_ORDER_FIELD]: _publicationOrder, ...logical } = record;
  return logical;
}

export function appendProgressEntity(req: StateWriteRequest, options: AppendProgressEntityOptions = {}): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  if (!req.dryRun && !options.publicationContext) {
    const binding = detectStateModeBinding(req.projectRoot, sourceRoot);
    if (binding.mode !== "entities") {
      throw new Error("progress publication requires the durable entity-mode marker; legacy mode remains authoritative");
    }
    try {
      return withEntityWriterLock(binding.publicationContext, () =>
        appendProgressEntity(req, {
          ...options,
          publicationContext: binding.publicationContext,
        }),
      );
    } finally {
      binding.publicationContext.close();
    }
  }
  if (Object.prototype.hasOwnProperty.call(req.values, PROGRESS_PUBLICATION_ORDER_FIELD) || Object.prototype.hasOwnProperty.call(req.callerPayload, PROGRESS_PUBLICATION_ORDER_FIELD)) {
    throw new Error("progress publication_order is writer-owned and cannot be supplied by callers");
  }
  const contract = progressContract(sourceRoot);
  const discovery = discoverEntities(req.projectRoot, sourceRoot);
  const existing = sortedProgress(discovery);
  const caveatContract = glossaryCaveatContract(path.join(sourceRoot, "references", "artifacts", "glossary-entry-contract.yaml"));
  const values = req.input ?? req.values;
  const prepared = prepareGlossaryCaveat(values, discovery, caveatContract);
  if (prepared.replay) {
    return {
      schemaVersion: "agentera.stateWrite.v1",
      command: "state progress append",
      status: "pass",
      path: prepared.replay.path,
      id: prepared.replay.id as string,
      artifact: ARTIFACT,
      record: prepared.replay.record as JsonObject,
      operation: { verb: "append", dry_run: req.dryRun, idempotent_replay: true },
      validation: { status: "pass", violations: [] },
    };
  }
  if (prepared.caveat) values.glossary_caveat = prepared.caveat;
  const unsequencedRecord = progressRecord(values, caveatContract);
  if (!options.id) {
    const logicalReplay = existing.find((entity) => entity.record && canonicalRecordJson(logicalProgressRecord(entity.record)) === canonicalRecordJson(unsequencedRecord));
    if (logicalReplay?.record) {
      return {
        schemaVersion: "agentera.stateWrite.v1",
        command: "state progress append",
        status: "pass",
        path: logicalReplay.path,
        id: logicalReplay.id!,
        artifact: ARTIFACT,
        record: logicalReplay.record,
        operation: { verb: "append", dry_run: req.dryRun, idempotent_replay: true },
        validation: { status: "pass", violations: [] },
      };
    }
  }
  const exactReplay = options.id ? existing.find(({ id }) => id === options.id) : undefined;
  if (exactReplay?.record) {
    const { publication_order: _publicationOrder, ...existingCallerFields } = exactReplay.record;
    if (canonicalRecordJson(existingCallerFields) === canonicalRecordJson(unsequencedRecord)) {
      return {
        schemaVersion: "agentera.stateWrite.v1",
        command: "state progress append",
        status: "pass",
        path: exactReplay.path,
        id: exactReplay.id!,
        artifact: ARTIFACT,
        record: exactReplay.record,
        operation: { verb: "append", dry_run: req.dryRun, idempotent_replay: true },
        validation: { status: "pass", violations: [] },
      };
    }
  }
  const record = req.dryRun
    ? unsequencedRecord
    : {
        ...unsequencedRecord,
        [PROGRESS_PUBLICATION_ORDER_FIELD]: nextProgressPublicationOrder(existing.flatMap(({ record }) => (record ? [record] : []))),
      };
  if (req.dryRun) {
    options.publicationContext?.assertValid();
    const allocationRoot = options.publicationContext?.pinnedPath() ?? req.projectRoot;
    const id = options.id ?? allocateEntityId(allocationRoot, options.candidate, sourceRoot);
    const target = path.join(path.resolve(req.projectRoot), contract.entityRoot, ARTIFACT, BOUNDARY, `${id}.yaml`);
    options.publicationContext?.assertValid();
    return {
      schemaVersion: "agentera.stateWrite.v1",
      command: "state progress append",
      status: "pass",
      path: target,
      id,
      artifact: ARTIFACT,
      record,
      operation: { verb: "append", dry_run: true, idempotent_replay: false },
      validation: { status: "pass", violations: [] },
    };
  }
  const publicationRequest = {
    projectRoot: req.projectRoot,
    sourceRoot,
    publicationContext: options.publicationContext,
    artifact: ARTIFACT,
    boundary: BOUNDARY,
    record,
  };
  const published = options.publicationContext
    ? publishEntityUnderLock({
        ...publicationRequest,
        id: options.id ?? allocateEntityId(options.publicationContext.pinnedPath(), options.candidate, sourceRoot),
      })
    : options.id
      ? publishEntity({ ...publicationRequest, id: options.id })
      : allocateAndPublishEntity(
          {
            ...publicationRequest,
          },
          options.candidate,
        );
  return {
    schemaVersion: "agentera.stateWrite.v1",
    command: "state progress append",
    status: "pass",
    path: published.path,
    id: published.id,
    artifact: published.artifact,
    record,
    operation: { verb: "append", dry_run: false, idempotent_replay: published.replay },
    validation: { status: "pass", violations: [] },
  };
}

function sortKey(entity: DiscoveredEntity): string {
  return canonicalRecordJson([String(entity.record?.timestamp ?? ""), progressPublicationOrder(entity.record), entity.id]);
}

function sortedProgress(discovery: ReturnType<typeof discoverEntities>): DiscoveredEntity[] {
  const progress = discovery.entities.filter((entity) => entity.boundary === BOUNDARY || entity.artifact === ARTIFACT);
  const duplicate = progress.find((entity) => entity.classification === "duplicate");
  if (duplicate) throw listFailure("ambiguous", "canonical progress evidence has conflicting identities", "Run agentera check validate state, assign unique IDs, and retry.");
  const corrupt = progress.find((entity) => entity.classification !== "valid" || !entity.id || !entity.record || (entity.boundary === BOUNDARY && typeof entity.record.timestamp !== "string"));
  if (corrupt) throw listFailure("corrupt", "canonical progress evidence is corrupt or violates the progress record contract", "Run agentera check validate state, repair the canonical entity file, and retry.");
  return progress.sort((left, right) => {
    const timestamp = String(right.record!.timestamp ?? "").localeCompare(String(left.record!.timestamp ?? ""));
    if (timestamp) return timestamp;
    const leftOrder = progressPublicationOrder(left.record);
    const rightOrder = progressPublicationOrder(right.record);
    if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) return rightOrder - leftOrder;
    if (leftOrder !== null && rightOrder === null) return -1;
    if (leftOrder === null && rightOrder !== null) return 1;
    return left.id!.localeCompare(right.id!);
  });
}

function entry(projectRoot: string, entity: DiscoveredEntity): JsonObject {
  const id = entity.id!;
  return {
    id,
    artifact: ARTIFACT,
    record: entity.record!,
    ...detailMetadata(entity),
    provenance: detailProvenance(relative(projectRoot, entity.path), entity),
    retrieval: { get: `agentera state progress get --id ${id}` },
  };
}

function snapshotId(projectRoot: string, entities: DiscoveredEntity[], filters: JsonObject, entityRoot: string): string {
  return projectedListSnapshot({
    schemaVersion: "agentera.stateList.v1",
    command: "state progress list",
    order: ORDER,
    filters,
    source: { artifact: ARTIFACT, authority: "canonical_entity_files", root: entityRoot },
    source_contract: {
      authority: "references/artifacts/state-storage-authority.yaml",
      detail: entities.some(isSummaryEntity) ? "mixed" : "full",
      cursor: "opaque_snapshot_cursor_v2",
    },
    entries: entities.map((entity) => entry(projectRoot, entity)),
  });
}

function encodeCursor(payload: ProgressCursor, projectRoot: string, authorityPath: string): string {
  return encodeListCursor(payload as unknown as JsonObject, projectRoot, authorityPath);
}

function decodeCursor(token: string, projectRoot: string, authorityPath: string): ProgressCursor {
  const [encoded, signed, extra] = token.split(".");
  if (!encoded || !signed || extra) throw listFailure("cursor_invalid", "progress cursor is malformed or was issued for a prior ordering contract", "Omit --cursor to establish a new version 2 progress snapshot.");
  let payload: unknown;
  try {
    payload = decodeListCursor(token, projectRoot, authorityPath);
  } catch {
    throw listFailure("cursor_invalid", "progress cursor is malformed or was issued for a prior ordering contract", "Omit --cursor to establish a new version 2 progress snapshot.");
  }
  if (!mapping(payload) || payload.version !== CURSOR_VERSION || payload.artifact !== ARTIFACT || payload.order !== ORDER || !mapping(payload.filters) || typeof payload.snapshot_id !== "string" || typeof payload.selector !== "string" || typeof payload.after_key !== "string") {
    throw listFailure("cursor_invalid", "progress cursor does not match the version 2 progress ordering contract", "Omit --cursor to establish a new version 2 snapshot.");
  }
  return payload as unknown as ProgressCursor;
}

function values(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(values);
  if (mapping(value)) return Object.entries(value).flatMap(([key, child]) => [key, ...values(child)]);
  return [];
}

function filtersObject(filters: { topic?: string | null; status?: string | null }): JsonObject {
  return { topic: filters.topic ?? null, status: filters.status ?? null };
}

export function getProgressEntity(projectRoot: string, id: string, sourceRoot = resolveSourceRoot()): JsonObject {
  if (!/^[a-z]{10}$/.test(id)) throw failure("invalid_request", `progress ID '${id}' must be ten lowercase letters`, "Use the bare ID returned by progress append or list.", id, 2);
  const discovery = discoverEntities(projectRoot, sourceRoot);
  const matches = discovery.entities.filter((entity) => entity.id === id);
  if (matches.length > 1 || matches.some((entity) => entity.classification === "duplicate")) throw failure("ambiguous", `progress entity ID '${id}' has multiple canonical candidates`, "Run agentera check validate state, assign unique IDs, and retry.", id);
  const selected = matches[0];
  const expectedPath = path.join(path.resolve(projectRoot), progressContract(sourceRoot).entityRoot, ARTIFACT, selected?.boundary === SUMMARY ? SUMMARY : BOUNDARY, `${id}.yaml`);
  const corruptAtCanonicalPath = discovery.entities.find((entity) => entity.path === expectedPath);
  if (!selected && corruptAtCanonicalPath) throw failure("corrupt", "canonical progress evidence is corrupt or does not match its identity envelope", "Run agentera check validate state, repair the canonical entity file, and retry.", id);
  if (!selected || selected.artifact !== ARTIFACT || ![BOUNDARY, SUMMARY].includes(selected.boundary ?? "")) throw failure("not_found", `no progress entity exists with ID '${id}'`, "Copy an ID from agentera state progress list and retry.", id);
  if (selected.classification !== "valid" || !selected.record || (selected.boundary === BOUNDARY && typeof selected.record.timestamp !== "string"))
    throw failure("corrupt", "canonical progress evidence is corrupt or violates the progress record contract", "Run agentera check validate state, repair the canonical entity file, and retry.", id);
  return {
    schemaVersion: "agentera.stateRetrieval.v1",
    command: "state progress get",
    status: isSummaryEntity(selected) ? "degraded" : "ok",
    entry: entry(projectRoot, selected),
    source: { artifact: ARTIFACT, authority: "canonical_entity_file" },
    source_contract: {
      authority: "references/artifacts/state-storage-authority.yaml",
      detail: isSummaryEntity(selected) ? "summary" : "full",
    },
  };
}

export function listProgressEntities(projectRoot: string, limit: number | undefined, filters: { topic?: string | null; status?: string | null } = {}, cursor?: string, options: ProgressEntityListOptions = {}): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const contract = progressContract(sourceRoot);
  const effectiveLimit = limit ?? contract.defaultLimit;
  if (!Number.isSafeInteger(effectiveLimit) || effectiveLimit < 1 || effectiveLimit > contract.maximumLimit) {
    throw listFailure("invalid_request", `--limit must be between 1 and ${contract.maximumLimit}`, `Use --limit ${contract.defaultLimit} or another value in the declared range.`, 2);
  }
  if (options.discovery) assertEntityDiscoveryOrigin(projectRoot, sourceRoot, options.discovery);
  const all = sortedProgress(options.discovery ?? discoverEntities(projectRoot, sourceRoot));
  const filterState = filtersObject(filters);
  const filtered = all.filter((entity) => {
    if (filters.status && String(entity.record!.type).toLowerCase() !== filters.status.toLowerCase()) return false;
    return !filters.topic || values(entity.record).some((value) => value.toLowerCase().includes(filters.topic!.toLowerCase()));
  });
  const snapshot = snapshotId(projectRoot, filtered, filterState, contract.entityRoot);
  const format = options.format ?? "json";
  const projectionOptions = {
    family: "progress" as const,
    artifact: ARTIFACT,
    boundary: BOUNDARY,
    format,
    maxUtf8Bytes: contract.maxUtf8Bytes,
    selector: options.selector,
  };
  const selector = resolveEntityListSelector(
    options.selector,
    filtered.map((entity) => entry(projectRoot, entity)),
    projectionOptions,
  );
  const selectorKey = entityListSelectorKey(selector);
  let afterKey = "";
  if (cursor) {
    const parsed = decodeCursor(cursor, projectRoot, contract.authorityPath);
    if (canonicalRecordJson(parsed.filters) !== canonicalRecordJson(filterState)) throw listFailure("cursor_invalid", "progress cursor filters do not match this request", "Repeat the original filters or omit --cursor to establish a new snapshot.");
    if (parsed.selector !== selectorKey) throw listFailure("cursor_invalid", "progress cursor selectors do not match this request", "Repeat the original selector or omit --cursor to establish a new snapshot.");
    if (parsed.snapshot_id !== snapshot) throw listFailure("cursor_snapshot_unavailable", "progress entity source changed after this cursor snapshot", "Omit --cursor to restart from the current canonical entity snapshot.");
    afterKey = parsed.after_key;
  }
  const start = afterKey ? filtered.findIndex((entity) => sortKey(entity) === afterKey) + 1 : 0;
  if (afterKey && start === 0) throw listFailure("cursor_snapshot_unavailable", "progress cursor continuation no longer exists in the canonical snapshot", "Omit --cursor to restart from the current canonical entity snapshot.");
  const selected = filtered.slice(start, start + effectiveLimit);
  const makeResponse = (): JsonObject => {
    const remaining = filtered.length - start - selected.length;
    const nextCursor =
      remaining > 0 && selected.length > 0
        ? encodeCursor(
            {
              version: CURSOR_VERSION,
              artifact: ARTIFACT,
              order: ORDER,
              filters: filterState,
              snapshot_id: snapshot,
              selector: selectorKey,
              after_key: sortKey(selected.at(-1)!),
            },
            projectRoot,
            contract.authorityPath,
          )
        : undefined;
    const filterFlags = `${filters.topic ? ` --topic ${shellQuoteArgument(filters.topic)}` : ""}${filters.status ? ` --status ${shellQuoteArgument(filters.status)}` : ""}`;
    const selectorFlags = entityListSelectorFlags(selector);
    return {
      schemaVersion: "agentera.stateList.v1",
      command: "state progress list",
      status: remaining > 0 || filtered.some(isSummaryEntity) ? "degraded" : "ok",
      entries: selected.map((entity) => entry(projectRoot, entity)),
      counts: { total: filtered.length, returned: selected.length, remaining },
      filters: filterState,
      snapshot: {
        id: snapshot,
        first_page: !cursor,
        order: ORDER,
        has_more: remaining > 0,
        candidate_count: filtered.length,
      },
      source: {
        artifact: ARTIFACT,
        authority: "canonical_entity_files",
        root: contract.entityRoot,
      },
      source_contract: {
        authority: "references/artifacts/state-storage-authority.yaml",
        detail: filtered.some(isSummaryEntity) ? "mixed" : "full",
        cursor: "opaque_snapshot_cursor_v2",
      },
      ...(remaining > 0
        ? {
            omitted: true,
            omitted_count: remaining,
            omission_reason: "page_limit",
            retrieval: {
              continue: `agentera state progress list${filterFlags}${selectorFlags} --limit ${effectiveLimit} --cursor ${nextCursor}`,
              get: "agentera state progress get --id ID",
            },
            next_cursor: nextCursor,
          }
        : {}),
    };
  };
  return projectEntityList(makeResponse(), selector, projectionOptions);
}

export function renderProgressEntityListText(response: JsonObject): string {
  return YAML.stringify(response);
}
