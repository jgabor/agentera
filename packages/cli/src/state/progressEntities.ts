import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";
import { StateRetrievalFailure, type StateFailureClass } from "./directRetrieval.js";
import {
  allocateAndPublishEntity,
  allocateEntityId,
  discoverEntities,
  publishEntity,
  type DiscoveredEntity,
} from "./entityStorage.js";
import type { ValidatedProjectRoot } from "./projectRoot.js";
import { localTimestamp } from "./write/assign.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./write/operations.js";

const ARTIFACT = "progress";
const BOUNDARY = "progress_cycle";
const ORDER = "timestamp_desc_then_id_asc";
const CURSOR_VERSION = 1;

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
  after_key: string;
}

export interface ProgressEntityListOptions {
  sourceRoot?: string;
  format?: "text" | "json" | "yaml";
}

export interface AppendProgressEntityOptions {
  sourceRoot?: string;
  id?: string;
  candidate?: () => string;
  validatedRoot?: ValidatedProjectRoot;
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error(`invalid progress entity ${field} in state storage authority`);
  return number;
}

function progressContract(sourceRoot = resolveSourceRoot()): ProgressContract {
  const authorityPath = path.join(
    sourceRoot,
    "references",
    "artifacts",
    "state-storage-authority.yaml",
  );
  const authority = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  const target = authority.entity_target;
  const storage =
    mapping(target) && mapping(target.storage_boundary)
      ? target.storage_boundary.shared_primitives
      : null;
  const entities = mapping(target) && Array.isArray(target.entities) ? target.entities : [];
  const progress = entities.find(
    (entity) => mapping(entity) && entity.boundary === BOUNDARY && entity.artifact === ARTIFACT,
  );
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

function failure(
  className: StateFailureClass,
  message: string,
  recovery: string,
  id?: string,
  exitCode: 1 | 2 = 1,
): StateRetrievalFailure {
  return new StateRetrievalFailure(
    {
      schemaVersion: "agentera.stateFailure.v1",
      status: "fail",
      error: {
        class: className,
        message,
        syntax: "agentera state progress get --id ID --format json",
        example: `agentera state progress get --id ${id ?? "qjtrmnpvka"} --format json`,
        recovery,
        artifact: ARTIFACT,
        ...(id ? { id } : {}),
      },
    },
    exitCode,
  );
}

function listFailure(
  className: StateFailureClass,
  message: string,
  recovery: string,
  exitCode: 1 | 2 = 1,
): StateRetrievalFailure {
  const result = failure(className, message, recovery, undefined, exitCode);
  result.body.error.syntax =
    "agentera state progress list [--limit N] [--cursor TOKEN] --format json";
  result.body.error.example = "agentera state progress list --limit 20 --format json";
  return result;
}

function progressRecord(values: Record<string, unknown>): JsonObject {
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
    if (typeof context[field] === "string")
      (record.context as JsonObject)[field] = context[field] as string;
  }
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(record.timestamp)))
    throw new Error("progress entity timestamp must use YYYY-MM-DD HH:MM");
  if (!record.type || !record.phase || !record.what || !(record.context as JsonObject).intent)
    throw new Error("progress entity requires type, phase, what, and context.intent");
  return record;
}

function relative(projectRoot: string, candidate: string): string {
  return path.relative(path.resolve(projectRoot), candidate).split(path.sep).join("/");
}

export function appendProgressEntity(
  req: StateWriteRequest,
  options: AppendProgressEntityOptions = {},
): StateWriteEnvelope {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const contract = progressContract(sourceRoot);
  const record = progressRecord(req.values);
  if (req.dryRun) {
    const id = options.id ?? allocateEntityId(req.projectRoot, options.candidate, sourceRoot);
    const target = path.join(
      path.resolve(req.projectRoot),
      contract.entityRoot,
      ARTIFACT,
      BOUNDARY,
      `${id}.yaml`,
    );
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
  const published = options.id
    ? publishEntity({
        projectRoot: req.projectRoot,
        sourceRoot,
        validatedRoot: options.validatedRoot,
        artifact: ARTIFACT,
        boundary: BOUNDARY,
        id: options.id,
        record,
      })
    : allocateAndPublishEntity(
        {
          projectRoot: req.projectRoot,
          sourceRoot,
          validatedRoot: options.validatedRoot,
          artifact: ARTIFACT,
          boundary: BOUNDARY,
          record,
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
  return `${String(entity.record?.timestamp ?? "")}\0${entity.id}`;
}

function sortedProgress(discovery: ReturnType<typeof discoverEntities>): DiscoveredEntity[] {
  const progress = discovery.entities.filter(
    (entity) => entity.boundary === BOUNDARY || entity.artifact === ARTIFACT,
  );
  const duplicate = progress.find((entity) => entity.classification === "duplicate");
  if (duplicate)
    throw listFailure(
      "ambiguous",
      `progress entity ID '${duplicate.id}' has multiple canonical candidates`,
      "Run agentera check validate state, assign unique IDs, and retry.",
    );
  const corrupt = progress.find(
    (entity) =>
      entity.classification !== "valid" ||
      !entity.id ||
      !entity.record ||
      typeof entity.record.timestamp !== "string",
  );
  if (corrupt)
    throw listFailure(
      "corrupt",
      `progress entity '${corrupt.relativePath}' is corrupt or violates the progress record contract`,
      "Run agentera check validate state, repair the canonical entity file, and retry.",
    );
  return progress.sort(
    (left, right) =>
      String(right.record!.timestamp).localeCompare(String(left.record!.timestamp)) ||
      left.id!.localeCompare(right.id!),
  );
}

function entry(projectRoot: string, entity: DiscoveredEntity): JsonObject {
  const id = entity.id!;
  return {
    id,
    artifact: ARTIFACT,
    record: entity.record!,
    provenance: {
      storage: "canonical_entity_file",
      path: relative(projectRoot, entity.path),
      boundary: BOUNDARY,
      detail: "full",
    },
    retrieval: { get: `agentera state progress get --id ${id} --format json` },
  };
}

function snapshotId(entities: DiscoveredEntity[]): string {
  const source = entities.map((entity) => ({
    id: entity.id,
    artifact: entity.artifact,
    record: entity.record,
  }));
  return createHash("sha256").update(canonicalRecordJson(source), "utf8").digest("hex");
}

function cursorKey(projectRoot: string, authorityPath: string): Buffer {
  return createHash("sha256")
    .update(path.resolve(projectRoot))
    .update("\0")
    .update(fs.readFileSync(authorityPath))
    .digest();
}

function encodeCursor(payload: ProgressCursor, projectRoot: string, authorityPath: string): string {
  const bytes = Buffer.from(canonicalRecordJson(payload), "utf8");
  const signature = createHmac("sha256", cursorKey(projectRoot, authorityPath))
    .update(bytes)
    .digest();
  return `${bytes.toString("base64url")}.${signature.toString("base64url")}`;
}

function decodeCursor(token: string, projectRoot: string, authorityPath: string): ProgressCursor {
  const [encoded, signed, extra] = token.split(".");
  if (!encoded || !signed || extra)
    throw listFailure(
      "cursor_invalid",
      "progress cursor is malformed",
      "Copy next_cursor exactly, or omit --cursor to start from the current snapshot.",
    );
  let bytes: Buffer;
  let signature: Buffer;
  try {
    bytes = Buffer.from(encoded, "base64url");
    signature = Buffer.from(signed, "base64url");
  } catch {
    throw listFailure(
      "cursor_invalid",
      "progress cursor is malformed",
      "Copy next_cursor exactly, or omit --cursor to start from the current snapshot.",
    );
  }
  const expected = createHmac("sha256", cursorKey(projectRoot, authorityPath))
    .update(bytes)
    .digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
    throw listFailure(
      "cursor_invalid",
      "progress cursor signature is invalid",
      "Copy next_cursor exactly, or omit --cursor to start from the current snapshot.",
    );
  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    payload = null;
  }
  if (
    !mapping(payload) ||
    payload.version !== CURSOR_VERSION ||
    payload.artifact !== ARTIFACT ||
    payload.order !== ORDER ||
    !mapping(payload.filters) ||
    typeof payload.snapshot_id !== "string" ||
    typeof payload.after_key !== "string"
  ) {
    throw listFailure(
      "cursor_invalid",
      "progress cursor does not match the progress entity list contract",
      "Omit --cursor to establish a new snapshot.",
    );
  }
  return payload as unknown as ProgressCursor;
}

function values(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(values);
  if (mapping(value))
    return Object.entries(value).flatMap(([key, child]) => [key, ...values(child)]);
  return [];
}

function filtersObject(filters: { topic?: string | null; status?: string | null }): JsonObject {
  return { topic: filters.topic ?? null, status: filters.status ?? null };
}

function serializedBytes(value: JsonObject, format: "text" | "json" | "yaml"): number {
  const text = format === "json" ? JSON.stringify(value, null, 2) + "\n" : YAML.stringify(value);
  return Buffer.byteLength(text, "utf8");
}

export function getProgressEntity(
  projectRoot: string,
  id: string,
  sourceRoot = resolveSourceRoot(),
): JsonObject {
  if (!/^[a-z]{10}$/.test(id))
    throw failure(
      "invalid_request",
      `progress ID '${id}' must be ten lowercase letters`,
      "Use the bare ID returned by progress append or list.",
      id,
      2,
    );
  const discovery = discoverEntities(projectRoot, sourceRoot);
  const matches = discovery.entities.filter((entity) => entity.id === id);
  if (matches.length > 1 || matches.some((entity) => entity.classification === "duplicate"))
    throw failure(
      "ambiguous",
      `progress entity ID '${id}' has multiple canonical candidates`,
      "Run agentera check validate state, assign unique IDs, and retry.",
      id,
    );
  const selected = matches[0];
  const expectedPath = path.join(
    path.resolve(projectRoot),
    progressContract(sourceRoot).entityRoot,
    ARTIFACT,
    BOUNDARY,
    `${id}.yaml`,
  );
  const corruptAtCanonicalPath = discovery.entities.find((entity) => entity.path === expectedPath);
  if (!selected && corruptAtCanonicalPath)
    throw failure(
      "corrupt",
      `progress entity '${corruptAtCanonicalPath.relativePath}' does not match its canonical ID envelope`,
      "Run agentera check validate state, repair the canonical entity file, and retry.",
      id,
    );
  if (!selected || selected.artifact !== ARTIFACT || selected.boundary !== BOUNDARY)
    throw failure(
      "not_found",
      `no progress entity exists with ID '${id}'`,
      "Copy an ID from agentera state progress list --format json and retry.",
      id,
    );
  if (
    selected.classification !== "valid" ||
    !selected.record ||
    typeof selected.record.timestamp !== "string"
  )
    throw failure(
      "corrupt",
      `progress entity '${selected.relativePath}' is corrupt or violates the progress record contract`,
      "Run agentera check validate state, repair the canonical entity file, and retry.",
      id,
    );
  return {
    schemaVersion: "agentera.stateRetrieval.v1",
    command: "state progress get",
    status: "ok",
    entry: entry(projectRoot, selected),
    source: { artifact: ARTIFACT, authority: "canonical_entity_file" },
    source_contract: {
      authority: "references/artifacts/state-storage-authority.yaml",
      detail: "full",
    },
  };
}

export function listProgressEntities(
  projectRoot: string,
  limit: number | undefined,
  filters: { topic?: string | null; status?: string | null } = {},
  cursor?: string,
  options: ProgressEntityListOptions = {},
): JsonObject {
  const sourceRoot = options.sourceRoot ?? resolveSourceRoot();
  const contract = progressContract(sourceRoot);
  const effectiveLimit = limit ?? contract.defaultLimit;
  if (
    !Number.isSafeInteger(effectiveLimit) ||
    effectiveLimit < 1 ||
    effectiveLimit > contract.maximumLimit
  ) {
    throw listFailure(
      "invalid_request",
      `--limit must be between 1 and ${contract.maximumLimit}`,
      `Use --limit ${contract.defaultLimit} or another value in the declared range.`,
      2,
    );
  }
  const all = sortedProgress(discoverEntities(projectRoot, sourceRoot));
  const snapshot = snapshotId(all);
  const filterState = filtersObject(filters);
  let afterKey = "";
  if (cursor) {
    const parsed = decodeCursor(cursor, projectRoot, contract.authorityPath);
    if (canonicalRecordJson(parsed.filters) !== canonicalRecordJson(filterState))
      throw listFailure(
        "cursor_invalid",
        "progress cursor filters do not match this request",
        "Repeat the original filters or omit --cursor to establish a new snapshot.",
      );
    if (parsed.snapshot_id !== snapshot)
      throw listFailure(
        "cursor_snapshot_unavailable",
        "progress entity source changed after this cursor snapshot",
        "Omit --cursor to restart from the current canonical entity snapshot.",
      );
    afterKey = parsed.after_key;
  }
  const filtered = all.filter((entity) => {
    if (
      filters.status &&
      String(entity.record!.type).toLowerCase() !== filters.status.toLowerCase()
    )
      return false;
    return (
      !filters.topic ||
      values(entity.record).some((value) =>
        value.toLowerCase().includes(filters.topic!.toLowerCase()),
      )
    );
  });
  const start = afterKey ? filtered.findIndex((entity) => sortKey(entity) === afterKey) + 1 : 0;
  if (afterKey && start === 0)
    throw listFailure(
      "cursor_snapshot_unavailable",
      "progress cursor continuation no longer exists in the canonical snapshot",
      "Omit --cursor to restart from the current canonical entity snapshot.",
    );
  let selected = filtered.slice(start, start + effectiveLimit);
  let byteTrimmed = false;
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
              after_key: sortKey(selected.at(-1)!),
            },
            projectRoot,
            contract.authorityPath,
          )
        : undefined;
    const filterFlags = [
      ...(filters.topic ? ["--topic", JSON.stringify(filters.topic)] : []),
      ...(filters.status ? ["--status", JSON.stringify(filters.status)] : []),
    ].join(" ");
    return {
      schemaVersion: "agentera.stateList.v1",
      command: "state progress list",
      status: remaining > 0 ? "degraded" : "ok",
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
        detail: "full",
        cursor: "opaque_snapshot_cursor",
      },
      ...(remaining > 0
        ? {
            omitted: true,
            omitted_count: remaining,
            omission_reason: byteTrimmed ? "serialized_byte_budget" : "page_limit",
            retrieval: {
              continue: `agentera state progress list --limit ${effectiveLimit}${filterFlags ? ` ${filterFlags}` : ""} --cursor ${nextCursor} --format json`,
              get: "agentera state progress get --id ID --format json",
            },
            next_cursor: nextCursor,
          }
        : {}),
    };
  };
  const format = options.format ?? "json";
  let response = makeResponse();
  while (serializedBytes(response, format) > contract.maxUtf8Bytes && selected.length > 0) {
    selected = selected.slice(0, -1);
    byteTrimmed = true;
    response = makeResponse();
  }
  if (selected.length === 0 && filtered.length > start)
    throw listFailure(
      "unsupported_state",
      `one full progress entity cannot fit the ${contract.maxUtf8Bytes}-byte list budget`,
      "Use exact get by ID for the full canonical entity, or reduce the entity scalar size before retrying.",
    );
  return response;
}

export function renderProgressEntityListText(response: JsonObject): string {
  return YAML.stringify(response);
}
