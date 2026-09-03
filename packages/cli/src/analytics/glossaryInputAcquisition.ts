import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { personalGlossaryConsumerEntries, PersonalGlossaryBoundaryError } from "./personalGlossaryProfile.js";
import { glossaryAcquisitionContract, GlossaryEntryBoundError, type GlossaryOwner } from "../registries/glossaryEntryContract.js";
import { docsPathOverridesFromBytes, loadArtifactRecord, resolveArtifactPath } from "../registries/artifactRegistry.js";
import { ARTIFACT_PROTOCOL_PATHS } from "../registries/artifactProtocolIds.js";
import { assertValidatedProjectRoot, validateRealProjectRoot, type ValidatedProjectRoot } from "../state/projectRoot.js";
import { parseProjectGlossaryDocument } from "../state/write/glossaryPublication.js";

export type GlossaryAvailability = "absent" | "valid_empty" | "valid_present" | "malformed" | "unreadable" | "ambiguous" | "over_bound";

export interface ConsumerGlossaryEntry {
  term: string;
  meaning: string;
  owner: GlossaryOwner;
}

export interface GlossaryInputAvailability {
  owner: GlossaryOwner;
  availability: GlossaryAvailability;
  entries: ConsumerGlossaryEntry[];
  gap_proving: boolean;
  diagnostic: { class: GlossaryAvailability; recovery: string } | null;
}

export type ProjectAcquisitionReadKind = "docs_override" | "glossary_target";

export interface ProjectAcquisitionReadHooks {
  afterPathSnapshot?: (kind: ProjectAcquisitionReadKind) => void;
}

export interface AcquiredGlossaryInputs {
  project: GlossaryInputAvailability;
  personal: GlossaryInputAvailability;
}

const PROJECT_RECOVERY = "Repair the canonical GLOSSARY.md artifact or docs mapping, then run agentera state query --list-artifacts before retrying glossary acquisition.";
const PERSONAL_RECOVERY = "Run agentera profile to repair or regenerate the owned Glossary section, then retry glossary acquisition.";

function valid(owner: GlossaryOwner, availability: "absent" | "valid_empty" | "valid_present", entries: ConsumerGlossaryEntry[]): GlossaryInputAvailability {
  return {
    owner,
    availability,
    entries,
    gap_proving: owner === "project" && availability !== "valid_present",
    diagnostic: null,
  };
}

function invalid(owner: GlossaryOwner, availability: Exclude<GlossaryAvailability, "absent" | "valid_empty" | "valid_present">): GlossaryInputAvailability {
  return {
    owner,
    availability,
    entries: [],
    gap_proving: false,
    diagnostic: {
      class: availability,
      recovery: owner === "project" ? PROJECT_RECOVERY : PERSONAL_RECOVERY,
    },
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function readBoundedRegularFile(pathname: string, maxBytes: number): { status: "ok"; bytes: Buffer } | { status: "absent" | "unreadable" | "ambiguous" | "over_bound" } {
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(pathname, { bigint: true });
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { status: "absent" } : { status: "unreadable" };
  }
  if (before.isSymbolicLink() || !before.isFile()) return { status: "ambiguous" };
  const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW;
  if (noFollow === undefined) return { status: "ambiguous" };
  let descriptor: number;
  try {
    descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ELOOP") return { status: "ambiguous" };
    return { status: "unreadable" };
  }
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened) || !opened.isFile()) return { status: "ambiguous" };
    if (opened.size > BigInt(maxBytes)) return { status: "over_bound" };
    const bytes = readDescriptorBounded(descriptor, maxBytes);
    if (bytes === null) return { status: "over_bound" };
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(pathname, { bigint: true });
    if (!sameFileSnapshot(opened, after) || !sameIdentity(opened, current)) {
      return { status: "ambiguous" };
    }
    return { status: "ok", bytes };
  } catch {
    return { status: "unreadable" };
  } finally {
    fs.closeSync(descriptor);
  }
}

interface PathIdentity {
  pathname: string;
  dev: bigint;
  ino: bigint;
  type: "directory" | "file";
}

function sameIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return sameIdentity(left, right) && left.isFile() && right.isFile() && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function readDescriptorBounded(descriptor: number, maxBytes: number): Buffer | null {
  const candidate = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < candidate.byteLength) {
    const count = fs.readSync(descriptor, candidate, offset, candidate.byteLength - offset, null);
    if (count === 0) break;
    offset += count;
  }
  return offset > maxBytes ? null : candidate.subarray(0, offset);
}

function identitiesStable(identities: readonly PathIdentity[]): boolean {
  return identities.every((identity) => {
    try {
      const current = fs.lstatSync(identity.pathname, { bigint: true });
      return current.dev === identity.dev && current.ino === identity.ino && (identity.type === "directory" ? current.isDirectory() : current.isFile()) && !current.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function readStableProjectFile(root: ValidatedProjectRoot, pathname: string, maxBytes: number, kind: ProjectAcquisitionReadKind, hooks: ProjectAcquisitionReadHooks): { status: "ok"; bytes: Buffer } | { status: "absent" | "unreadable" | "ambiguous" | "over_bound" } {
  assertValidatedProjectRoot(root);
  const relative = path.relative(root.path, pathname);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { status: "ambiguous" };
  }
  const identities: PathIdentity[] = [];
  let current = root.path;
  const segments = relative.split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return { status: "unreadable" };
      try {
        hooks.afterPathSnapshot?.(kind);
      } catch {
        return { status: "ambiguous" };
      }
      if (!identitiesStable(identities)) return { status: "ambiguous" };
      try {
        fs.lstatSync(current);
        return { status: "ambiguous" };
      } catch (missingError) {
        if (errorCode(missingError) !== "ENOENT") return { status: "ambiguous" };
        try {
          assertValidatedProjectRoot(root);
        } catch {
          return { status: "ambiguous" };
        }
        return { status: "absent" };
      }
    }
    if (stat.isSymbolicLink()) return { status: "ambiguous" };
    const type = index === segments.length - 1 ? "file" : "directory";
    if ((type === "file" && !stat.isFile()) || (type === "directory" && !stat.isDirectory())) {
      return { status: "ambiguous" };
    }
    identities.push({ pathname: current, dev: stat.dev, ino: stat.ino, type });
  }

  try {
    hooks.afterPathSnapshot?.(kind);
  } catch {
    return { status: "ambiguous" };
  }
  const noFollow = (fs.constants as Record<string, number>).O_NOFOLLOW;
  if (noFollow === undefined) return { status: "ambiguous" };
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const leaf = identities.at(-1)!;
    if (!opened.isFile() || opened.dev !== leaf.dev || opened.ino !== leaf.ino || !identitiesStable(identities)) {
      return { status: "ambiguous" };
    }
    if (opened.size > BigInt(maxBytes)) return { status: "over_bound" };
    const bytes = readDescriptorBounded(descriptor, maxBytes);
    if (bytes === null) return { status: "over_bound" };
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(opened, after) || !identitiesStable(identities)) {
      return { status: "ambiguous" };
    }
    assertValidatedProjectRoot(root);
    return { status: "ok", bytes };
  } catch (error) {
    const code = errorCode(error);
    return code === "EACCES" || code === "EPERM" ? { status: "unreadable" } : { status: "ambiguous" };
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* A failed close cannot make rejected bytes authoritative. */
      }
    }
  }
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function acquireProjectGlossaryInput(projectRoot: string, hooks: ProjectAcquisitionReadHooks = {}): GlossaryInputAvailability {
  const bounds = glossaryAcquisitionContract();
  let root;
  let pathname: string;
  try {
    root = validateRealProjectRoot(projectRoot);
    const record = loadArtifactRecord("glossary");
    if (!record) return invalid("project", "ambiguous");
    const docsPath = path.join(root.path, ARTIFACT_PROTOCOL_PATHS.docs!);
    const docsSource = readStableProjectFile(root, docsPath, bounds.maxSourceUtf8Bytes, "docs_override", hooks);
    if (docsSource.status !== "ok" && docsSource.status !== "absent") {
      return invalid("project", "ambiguous");
    }
    let docsPathOverrides: Record<string, string> = {};
    if (docsSource.status === "ok") {
      const decoded = decodeUtf8(docsSource.bytes);
      if (decoded === null) return invalid("project", "ambiguous");
      try {
        docsPathOverrides = docsPathOverridesFromBytes(decoded, true);
      } catch {
        return invalid("project", "ambiguous");
      }
    }
    pathname = resolveArtifactPath(record, root.path, { strictWrite: true, docsPathOverrides });
    assertValidatedProjectRoot(root);
  } catch {
    return invalid("project", "ambiguous");
  }

  const source = readStableProjectFile(root, pathname, bounds.maxSourceUtf8Bytes, "glossary_target", hooks);
  if (source.status === "absent") return valid("project", "absent", []);
  if (source.status !== "ok") return invalid("project", source.status);

  try {
    assertValidatedProjectRoot(root);
    const decoded = decodeUtf8(source.bytes);
    if (decoded === null) return invalid("project", "malformed");
    const document = parseProjectGlossaryDocument(decoded, bounds.maxEntries);
    assertValidatedProjectRoot(root);
    const entries = document.entries.map((entry) => ({
      term: String(entry.term),
      meaning: String(entry.meaning),
      owner: "project" as const,
    }));
    return valid("project", entries.length === 0 ? "valid_empty" : "valid_present", entries);
  } catch (error) {
    return invalid("project", error instanceof GlossaryEntryBoundError ? "over_bound" : "malformed");
  }
}

export function acquirePersonalGlossaryInput(profilePath: string): GlossaryInputAvailability {
  const bounds = glossaryAcquisitionContract();
  const source = readBoundedRegularFile(profilePath, bounds.maxSourceUtf8Bytes);
  if (source.status === "absent") return valid("personal", "absent", []);
  if (source.status !== "ok") return invalid("personal", source.status);

  try {
    const decoded = decodeUtf8(source.bytes);
    if (decoded === null) return invalid("personal", "malformed");
    const parsed = personalGlossaryConsumerEntries(decoded, bounds.maxEntries);
    if (parsed === null) return valid("personal", "absent", []);
    const entries = parsed.map(({ term, meaning }) => ({
      term,
      meaning,
      owner: "personal" as const,
    }));
    return valid("personal", entries.length === 0 ? "valid_empty" : "valid_present", entries);
  } catch (error) {
    if (error instanceof GlossaryEntryBoundError) return invalid("personal", "over_bound");
    if (error instanceof PersonalGlossaryBoundaryError) return invalid("personal", error.availability);
    return invalid("personal", "malformed");
  }
}

export function acquireGlossaryInputs(projectRoot: string, personalProfilePath: string, projectHooks: ProjectAcquisitionReadHooks = {}): AcquiredGlossaryInputs {
  return {
    project: acquireProjectGlossaryInput(projectRoot, projectHooks),
    personal: acquirePersonalGlossaryInput(personalProfilePath),
  };
}
