import fs from "node:fs";
import path from "node:path";

import { personalGlossaryCandidateProjectionContract } from "../registries/glossaryCandidateProjectionContract.js";
import { PERSONAL_GLOSSARY_MINING_POLICY_VERSION } from "../registries/glossaryMiningAuthority.js";
import { readCurrentGeneration } from "./extractCorpus/evidenceTiers.js";
import { mineExplicitGlossaryCandidates } from "./personalGlossaryExplicitMining.js";
import { mineRecurringGlossaryCandidates } from "./personalGlossaryRecurrence.js";
import {
  personalGlossaryCandidateProjectionPath,
  persistPersonalGlossaryCandidateProjectionAfterRefresh,
  projectPersonalGlossaryCandidates,
  type PersonalGlossaryCandidateProjectionStorageOptions,
  type PersonalGlossaryMiningFamilySummary,
  type PersonalGlossaryMiningSummary,
} from "./personalGlossaryCandidateProjection.js";

export interface PersonalGlossaryRefreshProjectionOptions
  extends PersonalGlossaryCandidateProjectionStorageOptions {
  tiersDir: string;
}

export interface PersonalGlossaryRefreshProjectionResult {
  status: "changed" | "unchanged_replay";
  generation: string;
  policy_version: string;
  candidate_projection_sha256: string;
  candidate_count: number;
  abstention_count: number;
  path: string;
}

export interface PersonalGlossaryRefreshCommitLock {
  descriptor: number;
  path: string;
}

export class PersonalGlossaryRefreshCommitBusyError extends Error {
  constructor() {
    super("another consented refresh is still publishing the current candidate projection");
    this.name = "PersonalGlossaryRefreshCommitBusyError";
  }
}

/** Exclude another consented refresh until evidence and its projection are committed together. */
export function acquirePersonalGlossaryRefreshCommitLock(
  options: PersonalGlossaryCandidateProjectionStorageOptions = {},
): PersonalGlossaryRefreshCommitLock {
  const directory = path.dirname(personalGlossaryCandidateProjectionPath(options));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const lockPath = path.join(directory, ".refresh.lock");
  try {
    const descriptor = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    return { descriptor, path: lockPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new PersonalGlossaryRefreshCommitBusyError();
    }
    throw error;
  }
}

export function releasePersonalGlossaryRefreshCommitLock(
  lock: PersonalGlossaryRefreshCommitLock,
): void {
  try {
    fs.unlinkSync(lock.path);
  } finally {
    fs.closeSync(lock.descriptor);
  }
}

function familySummary(
  keys: readonly string[],
  candidateCount: number,
  abstentions: ReadonlyArray<{ reason: string }>,
): PersonalGlossaryMiningFamilySummary {
  const counts = Object.fromEntries(keys.map((key) => [key, 0]));
  for (const abstention of abstentions) {
    if (!(abstention.reason in counts)) throw new TypeError("mining produced an unknown abstention reason");
    counts[abstention.reason] += 1;
  }
  return {
    candidate_count: candidateCount,
    abstention_count: abstentions.length,
    abstentions_by_reason: counts,
  };
}

/** Mine and publish the projection bound to the current successfully published evidence generation. */
export function produceCurrentPersonalGlossaryProjection(
  options: PersonalGlossaryRefreshProjectionOptions,
): PersonalGlossaryRefreshProjectionResult {
  const before = readCurrentGeneration(options.tiersDir);
  if (!before) throw new TypeError("current evidence generation is unavailable");

  const explicit = mineExplicitGlossaryCandidates({ tiersDir: options.tiersDir });
  const recurring = mineRecurringGlossaryCandidates({ tiersDir: options.tiersDir });
  const after = readCurrentGeneration(options.tiersDir);
  if (!after || explicit.generation !== before.manifest.generation ||
    recurring.generation !== before.manifest.generation ||
    after.manifest.generation !== before.manifest.generation) {
    throw new TypeError("current evidence generation changed during projection production");
  }

  const contract = personalGlossaryCandidateProjectionContract();
  const explicitSummary = familySummary(
    contract.explicitAbstentionKeys,
    explicit.candidates.length,
    explicit.abstentions,
  );
  const recurringSummary = familySummary(
    contract.recurringAbstentionKeys,
    recurring.candidates.length,
    recurring.abstentions,
  );
  const miningSummary: PersonalGlossaryMiningSummary = {
    schema_version: "agentera.personalGlossaryMiningSummary.v1",
    explicit: explicitSummary,
    recurring: recurringSummary,
    total_candidate_count: explicitSummary.candidate_count + recurringSummary.candidate_count,
    total_abstention_count: explicitSummary.abstention_count + recurringSummary.abstention_count,
  };
  const projection = projectPersonalGlossaryCandidates({
    generation: before.manifest.generation,
    policy_version: PERSONAL_GLOSSARY_MINING_POLICY_VERSION,
    retained_at: before.manifest.published_at,
    candidates: [
      ...explicit.candidates.map((candidate) => ({
        capsule: candidate.capsule,
        project_ids: candidate.project_ids,
      })),
      ...recurring.candidates.map((candidate) => ({
        capsule: candidate.capsule,
        project_ids: candidate.project_ids,
      })),
    ],
    mining_summary: miningSummary,
  });
  const persisted = persistPersonalGlossaryCandidateProjectionAfterRefresh(projection, options);
  const committed = readCurrentGeneration(options.tiersDir);
  if (!committed || committed.manifest.generation !== projection.generation) {
    throw new TypeError("current evidence generation changed before projection commit completed");
  }
  return {
    status: persisted.status,
    generation: projection.generation,
    policy_version: projection.policy_version,
    candidate_projection_sha256: projection.projection_sha256,
    candidate_count: projection.report.mining_summary.total_candidate_count,
    abstention_count: projection.report.mining_summary.total_abstention_count,
    path: persisted.path,
  };
}
