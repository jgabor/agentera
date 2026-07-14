import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  gitBackfillContractProjection,
  stateGitBackfillContract,
} from "./gitBackfillAuthority.js";

const BACKFILL_COMMAND = "agentera state backfill";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function migrationEnrichmentContract(sourceRoot: string = resolveSourceRoot()): Record<string, unknown> {
  const backfill = stateGitBackfillContract(sourceRoot);
  return {
    requested: false,
    command: BACKFILL_COMMAND,
    selection: "separate_explicit_operator_invocation",
    dry_run: `${BACKFILL_COMMAND} --project PROJECT --artifact ARTIFACT --number N --dry-run --format json`,
    apply: `${BACKFILL_COMMAND} --project PROJECT --artifact ARTIFACT --number N --apply --force --format json`,
    remote_contact: false,
    contract: gitBackfillContractProjection(backfill),
    recovery: backfill.recovery,
  };
}

export function migrationEnrichmentFollowUp(
  project: string,
  artifactId: string,
  entryNumber: number,
  sourceRoot: string = resolveSourceRoot(),
): Record<string, unknown> {
  const stableId = `${artifactId}:${entryNumber}`;
  const selectedProject = shellQuote(project);
  const backfill = stateGitBackfillContract(sourceRoot);
  return {
    kind: "optional_git_enrichment",
    requested: false,
    stable_id: stableId,
    selectors: { project, artifact: artifactId, number: entryNumber },
    dry_run: `${BACKFILL_COMMAND} --project ${selectedProject} --artifact ${artifactId} --number ${entryNumber} --dry-run --format json`,
    apply: `${BACKFILL_COMMAND} --project ${selectedProject} --artifact ${artifactId} --number ${entryNumber} --apply --force --format json`,
    remote_contact: false,
    recovery: backfill.recovery,
  };
}
