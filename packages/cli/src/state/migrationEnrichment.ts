const BACKFILL_COMMAND = "agentera state backfill";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function migrationEnrichmentContract(): Record<string, unknown> {
  return {
    requested: false,
    command: BACKFILL_COMMAND,
    selection: "separate_explicit_operator_invocation",
    dry_run: `${BACKFILL_COMMAND} --project PROJECT --artifact ARTIFACT --number N --dry-run --format json`,
    apply: `${BACKFILL_COMMAND} --project PROJECT --artifact ARTIFACT --number N --apply --force --format json`,
    remote_contact: false,
    recovery:
      "Git enrichment is optional. Apply exact selectors directly when wanted; if Git is unavailable or declined, local migration remains complete and this can be retried later.",
  };
}

export function migrationEnrichmentFollowUp(
  project: string,
  artifactId: string,
  entryNumber: number,
): Record<string, unknown> {
  const stableId = `${artifactId}:${entryNumber}`;
  const selectedProject = shellQuote(project);
  return {
    kind: "optional_git_enrichment",
    requested: false,
    stable_id: stableId,
    selectors: { project, artifact: artifactId, number: entryNumber },
    dry_run: `${BACKFILL_COMMAND} --project ${selectedProject} --artifact ${artifactId} --number ${entryNumber} --dry-run --format json`,
    apply: `${BACKFILL_COMMAND} --project ${selectedProject} --artifact ${artifactId} --number ${entryNumber} --apply --force --format json`,
    remote_contact: false,
    recovery:
      "Review the optional dry-run if useful. Git unavailability or a refusal is non-blocking; retry the same selectors later.",
  };
}
