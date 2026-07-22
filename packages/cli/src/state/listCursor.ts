import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { canonicalRecordJson } from "./archiveDiscovery.js";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function cursorKey(projectRoot: string, authorityPath: string): Buffer {
  return createHash("sha256")
    .update(path.resolve(projectRoot))
    .update("\0")
    .update(fs.readFileSync(authorityPath))
    .digest();
}

function decodeCanonicalSegment(segment: string): Buffer {
  if (!BASE64URL.test(segment)) throw new Error("noncanonical base64url");
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) throw new Error("noncanonical base64url");
  return bytes;
}

export function encodeListCursor(payload: JsonObject, projectRoot: string, authorityPath: string): string {
  const bytes = Buffer.from(canonicalRecordJson(payload), "utf8");
  const signature = createHmac("sha256", cursorKey(projectRoot, authorityPath)).update(bytes).digest();
  return `${bytes.toString("base64url")}.${signature.toString("base64url")}`;
}

export function decodeListCursor(token: string, projectRoot: string, authorityPath: string): JsonObject {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("malformed cursor");
  const bytes = decodeCanonicalSegment(parts[0]!);
  const supplied = decodeCanonicalSegment(parts[1]!);
  const expected = createHmac("sha256", cursorKey(projectRoot, authorityPath)).update(bytes).digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("invalid cursor signature");
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid cursor payload");
  return value as JsonObject;
}

export function projectedListSnapshot(projection: JsonObject): string {
  return createHash("sha256").update(canonicalRecordJson(projection), "utf8").digest("hex");
}
