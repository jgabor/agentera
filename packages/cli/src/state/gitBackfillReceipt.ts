import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalRecordJson } from "./archiveDiscovery.js";
import type { GitBackfillArgs, Occurrence, ScanResult } from "./gitBackfill.js";

export const PREVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;
export const PREVIEW_TOKEN_MAX_BYTES = 2048;

type ReceiptPayload = {
  schema_version: "agentera.gitBackfillPreview.v1";
  project_identity: string;
  source_root: string;
  artifact: string;
  number: number;
  head: string;
  candidate: {
    commit: string;
    path: string;
    git_path: string;
    blob_id: string;
    content_hash: string;
    reachable: true;
  };
  archive_bytes_sha256: string;
  record_sha256: string;
  issued_at: number;
  expires_at: number;
};

type EncodedReceipt = {
  payload: ReceiptPayload;
  signature: string;
};

export type PreviewReceiptStatus =
  | "accepted"
  | "required"
  | "invalid"
  | "expired"
  | "project_mismatch"
  | "changed_head"
  | "candidate_changed";

export type PreviewReceiptValidation =
  | { ok: true; payload: ReceiptPayload }
  | { ok: false; status: Exclude<PreviewReceiptStatus, "accepted" | "required">; message: string };

function projectIdentity(projectRoot: string): string {
  const resolved = fs.realpathSync(path.resolve(projectRoot));
  const stat = fs.statSync(resolved);
  return `${resolved}\0${String(stat.dev)}:${String(stat.ino)}`;
}

function signingKey(projectRoot: string, sourceRoot: string): Buffer {
  return createHash("sha256")
    .update(
      `agentera-git-backfill-preview\0${projectIdentity(projectRoot)}\0${path.resolve(sourceRoot)}`,
      "utf8",
    )
    .digest();
}

function signature(payload: ReceiptPayload, projectRoot: string, sourceRoot: string): string {
  return createHmac("sha256", signingKey(projectRoot, sourceRoot))
    .update(canonicalRecordJson(payload), "utf8")
    .digest("hex");
}

function hashBytes(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodedReceipt(value: unknown): value is EncodedReceipt {
  return isRecord(value) && isRecord(value.payload) && typeof value.signature === "string";
}

export function createPreviewToken(
  scan: ScanResult,
  args: Pick<GitBackfillArgs, "artifact" | "number">,
  candidate: Occurrence,
  archiveBytes: string,
  recordSha256: string,
  now = Date.now(),
): string {
  if (!scan.beforeHead || !args.artifact || args.number === undefined) {
    throw new Error("preview receipt requires an exact artifact, number, and stable HEAD");
  }
  const payload: ReceiptPayload = {
    schema_version: "agentera.gitBackfillPreview.v1",
    project_identity: projectIdentity(scan.projectRoot),
    source_root: path.resolve(scan.sourceRoot),
    artifact: args.artifact,
    number: args.number,
    head: scan.beforeHead,
    candidate: {
      commit: candidate.commit,
      path: candidate.path,
      git_path: candidate.gitPath,
      blob_id: candidate.blobId,
      content_hash: candidate.contentHash,
      reachable: true,
    },
    archive_bytes_sha256: hashBytes(archiveBytes),
    record_sha256: recordSha256,
    issued_at: now,
    expires_at: now + PREVIEW_TOKEN_TTL_MS,
  };
  const token = Buffer.from(
    canonicalRecordJson({ payload, signature: signature(payload, scan.projectRoot, scan.sourceRoot) }),
    "utf8",
  ).toString("base64url");
  if (Buffer.byteLength(token, "utf8") > PREVIEW_TOKEN_MAX_BYTES) {
    throw new Error("preview receipt exceeded its bounded token size");
  }
  return token;
}

export function validatePreviewToken(
  token: string | null | undefined,
  projectRoot: string,
  sourceRoot: string,
  now = Date.now(),
): PreviewReceiptValidation {
  if (!token || Buffer.byteLength(token, "utf8") > PREVIEW_TOKEN_MAX_BYTES) {
    return { ok: false, status: "invalid", message: "preview receipt is missing or exceeds its bounded size" };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, status: "invalid", message: "preview receipt is not a valid opaque token" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return { ok: false, status: "invalid", message: "preview receipt cannot be decoded" };
  }
  if (!encodedReceipt(parsed)) {
    return { ok: false, status: "invalid", message: "preview receipt has an invalid envelope" };
  }
  let expectedSignature: string;
  let identity: string;
  try {
    identity = projectIdentity(projectRoot);
    expectedSignature = signature(parsed.payload, projectRoot, sourceRoot);
  } catch {
    return { ok: false, status: "project_mismatch", message: "preview receipt project identity could not be verified" };
  }
  if (parsed.payload.project_identity !== identity || parsed.payload.source_root !== path.resolve(sourceRoot)) {
    return { ok: false, status: "project_mismatch", message: "preview receipt belongs to another project or authority" };
  }
  const actualSignature = Buffer.from(parsed.signature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (actualSignature.length !== expected.length || !timingSafeEqual(actualSignature, expected)) {
    return { ok: false, status: "invalid", message: "preview receipt signature does not match its contents" };
  }
  if (
    parsed.payload.schema_version !== "agentera.gitBackfillPreview.v1" ||
    !Number.isSafeInteger(parsed.payload.issued_at) ||
    !Number.isSafeInteger(parsed.payload.expires_at) ||
    parsed.payload.expires_at <= parsed.payload.issued_at
  ) {
    return { ok: false, status: "invalid", message: "preview receipt has invalid validity bounds" };
  }
  if (parsed.payload.expires_at <= now) {
    return { ok: false, status: "expired", message: "preview receipt has expired; run the exact dry-run again" };
  }
  if (
    typeof parsed.payload.artifact !== "string" ||
    !Number.isSafeInteger(parsed.payload.number) ||
    parsed.payload.number < 1 ||
    typeof parsed.payload.head !== "string" ||
    !validHash(parsed.payload.archive_bytes_sha256) ||
    !validHash(parsed.payload.record_sha256) ||
    !isRecord(parsed.payload.candidate) ||
    typeof parsed.payload.candidate.commit !== "string" ||
    typeof parsed.payload.candidate.path !== "string" ||
    typeof parsed.payload.candidate.git_path !== "string" ||
    typeof parsed.payload.candidate.blob_id !== "string" ||
    !validHash(parsed.payload.candidate.content_hash) ||
    parsed.payload.candidate.reachable !== true
  ) {
    return { ok: false, status: "invalid", message: "preview receipt has invalid candidate provenance" };
  }
  return { ok: true, payload: parsed.payload };
}

export function receiptMatchesPreview(
  receipt: ReceiptPayload,
  scan: ScanResult,
  args: Pick<GitBackfillArgs, "artifact" | "number">,
  candidate: Occurrence,
  archiveBytes: string,
  recordSha256: string,
): { ok: true } | { ok: false; status: "changed_head" | "candidate_changed"; message: string } {
  if (!scan.beforeHead || scan.headStatus !== "stable" || receipt.head !== scan.beforeHead) {
    return { ok: false, status: "changed_head", message: "HEAD changed since the dry-run; rerun the exact dry-run" };
  }
  if (
    receipt.artifact !== args.artifact ||
    receipt.number !== args.number ||
    receipt.candidate.commit !== candidate.commit ||
    receipt.candidate.path !== candidate.path ||
    receipt.candidate.git_path !== candidate.gitPath ||
    receipt.candidate.blob_id !== candidate.blobId ||
    receipt.candidate.content_hash !== candidate.contentHash ||
    receipt.candidate.reachable !== candidate.reachable ||
    receipt.record_sha256 !== recordSha256 ||
    receipt.archive_bytes_sha256 !== hashBytes(archiveBytes)
  ) {
    return { ok: false, status: "candidate_changed", message: "candidate or immutable archive bytes changed since the dry-run" };
  }
  return { ok: true };
}
