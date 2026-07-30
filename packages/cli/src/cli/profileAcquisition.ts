import fs from "node:fs";
import { TextDecoder } from "node:util";

import {
  personalProfileGrounding,
  PersonalGlossaryBoundaryError,
} from "../analytics/personalGlossaryProfile.js";
import { personalProfileGroundingContract } from "../registries/glossaryEntryContract.js";
import { discoverSchemasDir } from "./appContext.js";
import { parseProfileHeaderDates, registryArtifactPath } from "./orientation.js";

export type ProfileValidityStatus = "absent" | "valid" | "repair_needed";
export type ProfileValidityClass =
  | "absent"
  | "valid"
  | "malformed"
  | "ambiguous"
  | "unreadable"
  | "unsafe"
  | "oversized"
  | "invalid_utf8";

export interface ProfileValidityResult {
  status: ProfileValidityStatus;
  class: ProfileValidityClass;
  recovery: string | null;
}

export type ProfileFreshnessState = "current" | "stale" | "unknown";

export interface ProfileFreshnessResult {
  state: ProfileFreshnessState;
  days_since_generated: number | null;
  stale_threshold_days: number;
  generated_date: string | null;
  validated_date: string | null;
}

export interface ProfileAcquisitionResult {
  validity: ProfileValidityResult;
  freshness: ProfileFreshnessResult;
  profilePath: string | null;
  groundingContent: string | null;
}

export interface ProfileSafeReadHooks {
  afterPathSnapshot?: () => void;
  afterOpen?: () => void;
  afterRead?: () => void;
  noFollowFlag?: number;
}

type Env = Record<string, string | undefined>;
type BigStat = fs.BigIntStats;
type SafeReadResult =
  | { status: "ok"; bytes: Buffer }
  | { status: "absent" | "unreadable" | "unsafe" | "oversized" };

const DEFAULT_STALE_DAYS = 7;
const STALE_DAYS_ENV = "AGENTERA_PROFILE_MAX_AGE_DAYS";

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function sameIdentity(left: BigStat, right: BigStat): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function sameSnapshot(left: BigStat, right: BigStat): boolean {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

/** Read one path without following a final symlink and reject source changes. */
export function readProfileSourceSafely(
  profilePath: string,
  maxBytes: number,
  hooks: ProfileSafeReadHooks = {},
): SafeReadResult {
  let pathSnapshot: BigStat;
  try {
    pathSnapshot = fs.lstatSync(profilePath, { bigint: true });
  } catch (error) {
    return { status: errorCode(error) === "ENOENT" ? "absent" : "unreadable" };
  }
  if (!pathSnapshot.isFile() || pathSnapshot.isSymbolicLink()) return { status: "unsafe" };
  hooks.afterPathSnapshot?.();

  let fd: number;
  try {
    const noFollow = hooks.noFollowFlag ?? (fs.constants.O_NOFOLLOW ?? 0);
    fd = fs.openSync(profilePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    return { status: errorCode(error) === "ELOOP" ? "unsafe" : "unreadable" };
  }

  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(pathSnapshot, opened)) return { status: "unsafe" };
    if (opened.size > BigInt(maxBytes)) return { status: "oversized" };
    hooks.afterOpen?.();

    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    hooks.afterRead?.();

    const afterRead = fs.fstatSync(fd, { bigint: true });
    let currentPath: BigStat;
    try {
      currentPath = fs.lstatSync(profilePath, { bigint: true });
    } catch {
      return { status: "unsafe" };
    }
    if (!sameSnapshot(opened, afterRead) || !sameSnapshot(afterRead, currentPath)) {
      return { status: "unsafe" };
    }
    if (offset > maxBytes) return { status: "oversized" };
    return { status: "ok", bytes: bytes.subarray(0, offset) };
  } catch {
    return { status: "unreadable" };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // The acquisition already has a bounded result; close diagnostics are private.
    }
  }
}

function staleThreshold(env: Env): number {
  const parsed = Number.parseInt(env[STALE_DAYS_ENV] ?? String(DEFAULT_STALE_DAYS), 10);
  return Number.isNaN(parsed) || parsed < 0 ? DEFAULT_STALE_DAYS : parsed;
}

function unknownFreshness(env: Env): ProfileFreshnessResult {
  return {
    state: "unknown",
    days_since_generated: null,
    stale_threshold_days: staleThreshold(env),
    generated_date: null,
    validated_date: null,
  };
}

function freshness(text: string, env: Env): ProfileFreshnessResult {
  const dates = parseProfileHeaderDates(text);
  const anchor = dates.generatedUtc === null
    ? dates.validatedUtc
    : dates.validatedUtc === null
      ? dates.generatedUtc
      : Math.max(dates.generatedUtc, dates.validatedUtc);
  const threshold = staleThreshold(env);
  if (anchor === null) {
    return { ...unknownFreshness(env), generated_date: dates.generatedDate, validated_date: dates.validatedDate };
  }
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((today - anchor) / 86_400_000);
  return {
    state: days >= threshold ? "stale" : "current",
    days_since_generated: days,
    stale_threshold_days: threshold,
    generated_date: dates.generatedDate,
    validated_date: dates.validatedDate,
  };
}

function result(
  profilePath: string | null,
  env: Env,
  status: ProfileValidityStatus,
  validityClass: ProfileValidityClass,
  recovery: string | null,
): ProfileAcquisitionResult {
  return {
    validity: { status, class: validityClass, recovery },
    freshness: unknownFreshness(env),
    profilePath,
    groundingContent: null,
  };
}

export function acquireProfile(
  schemasDir?: string,
  env: Env = process.env,
  hooks: ProfileSafeReadHooks = {},
): ProfileAcquisitionResult {
  const contract = personalProfileGroundingContract();
  let profilePath: string;
  try {
    profilePath = registryArtifactPath("profile", schemasDir ?? discoverSchemasDir(), env, { warn: false });
  } catch {
    return result(null, env, "repair_needed", "unsafe", contract.repairRecovery);
  }

  const source = readProfileSourceSafely(profilePath, contract.maxProfileUtf8Bytes, hooks);
  if (source.status === "absent") {
    return result(profilePath, env, "absent", "absent", contract.absentRecovery);
  }
  if (source.status !== "ok") {
    return result(profilePath, env, "repair_needed", source.status, contract.repairRecovery);
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes);
  } catch {
    return result(profilePath, env, "repair_needed", "invalid_utf8", contract.repairRecovery);
  }

  try {
    const groundingContent = personalProfileGrounding(decoded);
    return {
      validity: { status: "valid", class: "valid", recovery: null },
      freshness: freshness(decoded, env),
      profilePath,
      groundingContent,
    };
  } catch (error) {
    const validityClass = error instanceof PersonalGlossaryBoundaryError
      ? error.availability
      : "malformed";
    return result(profilePath, env, "repair_needed", validityClass, contract.repairRecovery);
  }
}
