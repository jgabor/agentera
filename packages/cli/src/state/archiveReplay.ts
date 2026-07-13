import { isDeepStrictEqual } from "node:util";

import type { JsonObject } from "../core/jsonValue.js";
import { discoverNumberedArchives } from "./archiveDiscovery.js";
import type { WritableArtifact } from "./write/operations.js";
import { reject } from "./write/errors.js";

function mappingPath(entry: Record<string, unknown>, field: string): unknown {
  let value: unknown = entry;
  for (const part of field.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function isExactArchiveReplay(
  entry: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): boolean {
  if (!entry) return false;
  const projected: Record<string, unknown> = {};
  for (const [key, expected] of Object.entries(payload)) {
    if (expected === undefined) continue;
    const parts = key.split(".");
    let cursor = projected;
    for (const part of parts.slice(0, -1)) {
      if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts.at(-1) as string] = mappingPath(entry, key);
  }
  return isDeepStrictEqual(projected, payload);
}

export function findArchivedReplay(
  projectRoot: string,
  artifact: WritableArtifact,
  payload: Record<string, unknown>,
): JsonObject | undefined {
  if (Object.keys(payload).length === 0) return undefined;
  return discoverNumberedArchives(projectRoot).entries
    .filter((entry) => entry.artifactId === artifact)
    .find((entry) => isExactArchiveReplay(entry.record, payload))?.record;
}

export function recoverArchivedEntry(
  candidate: Record<string, unknown>,
  collection: string,
  entries: Record<string, unknown>[],
  recovered: Record<string, unknown>,
  descending: boolean,
): void {
  const number = Number(recovered.number);
  const sameNumber = entries.find((entry) => Number(entry.number) === number);
  if (sameNumber && !isDeepStrictEqual(sameNumber, recovered)) {
    reject({
      class: "conflict",
      message: `archived entry ${number} conflicts with the current ${collection} projection`,
    });
  }
  if (sameNumber) return;
  candidate[collection] = [...entries, recovered].sort((a, b) => {
    const difference = Number(a.number) - Number(b.number);
    return descending ? -difference : difference;
  });
}
