import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import {
  docsPathOverridesFromBytes,
  loadArtifactRecord,
  resolveArtifactPath,
} from "../registries/artifactRegistry.js";
import { ARTIFACT_PROTOCOL_PATHS } from "../registries/artifactProtocolIds.js";
import { validateRealProjectRoot } from "./projectRoot.js";
import { readProjectFileSnapshot } from "./safeProjectFile.js";

export const CHANGELOG_QUERY_COMMAND = "agentera state query changelog";
export const CHANGELOG_SCANNER_ID = "agentera.changelogHeadingScanner.v1";
export const CHANGELOG_MAX_READ_BYTES = 1_048_576;
export const CHANGELOG_DOCS_MAX_READ_BYTES = 262_144;
export const CHANGELOG_MAX_HEADING_BYTES = 256;
export const CHANGELOG_MAX_SOURCE_PATH_BYTES = 512;
export const CHANGELOG_MAX_OUTPUT_BYTES = 2_000;
export const CHANGELOG_CLOSEOUT_RESERVE_BYTES = 400;
const CHANGELOG_SHARED_MAX_OUTPUT_BYTES = CHANGELOG_MAX_OUTPUT_BYTES - CHANGELOG_CLOSEOUT_RESERVE_BYTES;

const UNRELEASED_RE = /^## \[Unreleased\]\s*$/i;
const RELEASE_RE = /^## \[((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?)\](?:\s+(?:-|·)\s+\d{4}-\d{2}-\d{2})?\s*$/;

export interface ChangelogHeadingScan {
  status: "available" | "incomplete";
  recognizedHeadings: string[];
  recognizedReleaseVersions: string[];
  recognizedReleaseCount: number;
  unreleasedHeading: string | null;
  latestReleaseHeading: string | null;
  boundary: string | null;
  identityBoundExceeded: boolean;
}

export interface ChangelogReadResult {
  projection: JsonObject;
  recognizedReleaseVersions: string[];
}

const RECOVERY: JsonObject = {
  strategy: "repair_validate_retry_once",
  repair: "Repair or restore the configured CHANGELOG artifact as a bounded regular project file with unambiguous Keep a Changelog release headings.",
  validate: "Confirm there is at most one Unreleased heading, every release identity is unique, and no arbitrary release-level H2 headings remain.",
  retry: CHANGELOG_QUERY_COMMAND,
  retry_limit: 1,
};

/** Classify release-level headings without depending on paths, line endings, or project state. */
export function scanChangelogHeadings(text: string): ChangelogHeadingScan {
  const h2 = text.split(/\r\n|\r|\n/).filter((line) => line.startsWith("## ")).map((line) => line.trim());
  const boundedH2 = h2.filter((heading) => Buffer.byteLength(heading, "utf8") <= CHANGELOG_MAX_HEADING_BYTES);
  const identityBoundExceeded = boundedH2.length !== h2.length;
  const unreleased = boundedH2.filter((heading) => UNRELEASED_RE.test(heading));
  const releases: Array<{ heading: string; version: string }> = [];
  let malformedCount = identityBoundExceeded ? 1 : 0;
  for (const heading of boundedH2) {
    if (UNRELEASED_RE.test(heading)) continue;
    const match = RELEASE_RE.exec(heading);
    if (match) releases.push({ heading, version: match[1]! });
    else malformedCount += 1;
  }
  const releaseVersions = releases.map(({ version }) => version);
  const duplicateRelease = new Set(releaseVersions).size !== releaseVersions.length;
  const available = malformedCount === 0
    && unreleased.length <= 1
    && !duplicateRelease
    && releases.length > 0;
  const unreleasedHeading = unreleased.length === 1 ? unreleased[0]! : null;
  const latestReleaseHeading = releases[0]?.heading ?? null;
  const boundary = available ? (unreleasedHeading ?? latestReleaseHeading) : null;
  const recognizedHeadings = available
    ? [unreleasedHeading, latestReleaseHeading].filter((heading): heading is string => heading !== null)
    : [];
  return {
    status: available ? "available" : "incomplete",
    recognizedHeadings,
    recognizedReleaseVersions: releaseVersions,
    recognizedReleaseCount: releases.length,
    unreleasedHeading,
    latestReleaseHeading,
    boundary,
    identityBoundExceeded,
  };
}

function source(relativePath: string | null): JsonObject {
  return {
    artifact: "changelog",
    path: relativePath,
    path_resolution: "artifact_registry",
  };
}

function provenance(): JsonObject {
  return {
    source_family: "changelog",
    command: CHANGELOG_QUERY_COMMAND,
    field: "recognized_headings",
    scanner: CHANGELOG_SCANNER_ID,
  };
}

function serializedProjectionBytes(projection: JsonObject): number {
  return Buffer.byteLength(`${JSON.stringify(projection, null, 2)}\n`, "utf8");
}

function projectionResult(projection: JsonObject, recognizedReleaseVersions: string[]): ChangelogReadResult {
  if (serializedProjectionBytes(projection) <= CHANGELOG_SHARED_MAX_OUTPUT_BYTES) {
    return { projection, recognizedReleaseVersions };
  }
  return fixedBoundFailure();
}

export function boundedChangelogUnavailable(
  caveat = "CHANGELOG state is unavailable because its bounded identity projection exceeds the supported output limit.",
): ChangelogReadResult {
  const projection: JsonObject = {
    schemaVersion: "agentera.changelogRead.v1",
    command: "changelog",
    status: "unavailable",
    recognized_headings: [],
    recognized_release_count: 0,
    unreleased_present: false,
    latest_release_heading: null,
    boundary_present: false,
    boundary: null,
    source: source(null),
    source_provenance: provenance(),
    caveats: [caveat],
    recovery: RECOVERY,
  };
  if (serializedProjectionBytes(projection) > CHANGELOG_SHARED_MAX_OUTPUT_BYTES) {
    throw new Error("fixed changelog unavailable projection exceeds its output limit");
  }
  return { projection, recognizedReleaseVersions: [] };
}

function fixedBoundFailure(): ChangelogReadResult {
  return boundedChangelogUnavailable();
}

function unavailable(relativePath: string | null, caveat: string): ChangelogReadResult {
  if (relativePath !== null && Buffer.byteLength(relativePath, "utf8") > CHANGELOG_MAX_SOURCE_PATH_BYTES) {
    return fixedBoundFailure();
  }
  return projectionResult(
    {
      schemaVersion: "agentera.changelogRead.v1",
      command: "changelog",
      status: "unavailable",
      recognized_headings: [],
      recognized_release_count: 0,
      unreleased_present: false,
      latest_release_heading: null,
      boundary_present: false,
      boundary: null,
      source: source(relativePath),
      source_provenance: provenance(),
      caveats: [caveat],
      recovery: RECOVERY,
    },
    [],
  );
}

function relativeArtifactPath(projectRoot: string, absolute: string): string | null {
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

/** Resolve and safely read the registry-owned CHANGELOG singleton for one project. */
export function readChangelog(projectRootInput: string): ChangelogReadResult {
  let projectRoot: ReturnType<typeof validateRealProjectRoot>;
  try {
    projectRoot = validateRealProjectRoot(projectRootInput);
  } catch {
    return unavailable("CHANGELOG.md", "CHANGELOG state is unavailable because the project root is unsafe or unreadable.");
  }

  let overrides: Record<string, string> = {};
  const docsSnapshot = readProjectFileSnapshot(
    projectRoot,
    ARTIFACT_PROTOCOL_PATHS.docs,
    undefined,
    CHANGELOG_DOCS_MAX_READ_BYTES,
  );
  if (docsSnapshot.kind === "unsafe") {
    return unavailable(null, "CHANGELOG state is unavailable because the configured docs path authority is unsafe, unreadable, or over its read limit.");
  }
  if (docsSnapshot.kind === "file") {
    let docsText: string;
    try {
      docsText = new TextDecoder("utf-8", { fatal: true }).decode(docsSnapshot.bytes);
    } catch {
      return unavailable(null, "CHANGELOG state is unavailable because the configured docs path authority is not valid UTF-8.");
    }
    try {
      overrides = docsPathOverridesFromBytes(docsText, true);
    } catch {
      return unavailable(null, "CHANGELOG state is unavailable because the configured docs path authority is malformed.");
    }
  }

  let relativePath = "CHANGELOG.md";
  try {
    const record = loadArtifactRecord("changelog");
    if (!record) return unavailable(relativePath, "CHANGELOG state is unavailable because its artifact registry entry could not be resolved.");
    const absolute = resolveArtifactPath(record, projectRoot.path, { docsPathOverrides: overrides, strictWrite: true });
    const resolvedRelative = relativeArtifactPath(projectRoot.path, absolute);
    if (resolvedRelative === null) return unavailable(relativePath, "CHANGELOG state is unavailable because its configured path is unsafe.");
    if (Buffer.byteLength(resolvedRelative, "utf8") > CHANGELOG_MAX_SOURCE_PATH_BYTES) return fixedBoundFailure();
    relativePath = resolvedRelative;
  } catch {
    return unavailable(relativePath, "CHANGELOG state is unavailable because its configured path is unsafe.");
  }

  const snapshot = readProjectFileSnapshot(projectRoot, relativePath, undefined, CHANGELOG_MAX_READ_BYTES);
  if (snapshot.kind === "missing") {
    return unavailable(relativePath, "CHANGELOG state is unavailable because the configured artifact is missing.");
  }
  if (snapshot.kind === "unsafe") {
    const caveat = snapshot.reason === "over_limit"
      ? "CHANGELOG state is unavailable because the configured artifact exceeds the bounded read limit."
      : "CHANGELOG state is unavailable because the configured artifact is not a safe readable regular file.";
    return unavailable(relativePath, caveat);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
  } catch {
    return unavailable(relativePath, "CHANGELOG state is unavailable because the configured artifact is not valid UTF-8.");
  }
  const scan = scanChangelogHeadings(text);
  if (scan.identityBoundExceeded) return fixedBoundFailure();
  const incomplete = scan.status === "incomplete";
  return projectionResult(
    {
      schemaVersion: "agentera.changelogRead.v1",
      command: "changelog",
      status: scan.status,
      recognized_headings: scan.recognizedHeadings,
      recognized_release_count: scan.recognizedReleaseCount,
      unreleased_present: scan.unreleasedHeading !== null,
      latest_release_heading: scan.latestReleaseHeading,
      boundary_present: scan.boundary !== null,
      boundary: scan.boundary,
      source: source(relativePath),
      source_provenance: provenance(),
      caveats: incomplete
        ? ["CHANGELOG headings are incomplete or ambiguous; use one optional Unreleased heading and distinct Keep a Changelog release headings only."]
        : [],
      recovery: incomplete ? RECOVERY : null,
    },
    scan.recognizedReleaseVersions,
  );
}
