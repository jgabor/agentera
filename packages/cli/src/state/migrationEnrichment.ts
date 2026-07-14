const BACKFILL_COMMAND = "agentera state backfill";

export function migrationEnrichmentContract(): Record<string, unknown> {
  return {
    requested: false,
    command: BACKFILL_COMMAND,
    selection: "separate_explicit_operator_invocation",
    dry_run: `${BACKFILL_COMMAND} --artifact ARTIFACT --number N --dry-run --format json`,
    apply: `${BACKFILL_COMMAND} --artifact ARTIFACT --number N --apply --force --format json`,
    remote_contact: false,
    recovery:
      "Git enrichment is optional. Run the exact dry-run first; if Git is unavailable or declined, local migration remains complete and this can be retried later.",
  };
}

export function migrationEnrichmentFollowUp(
  artifactId: string,
  entryNumber: number,
): Record<string, unknown> {
  const stableId = `${artifactId}:${entryNumber}`;
  return {
    kind: "optional_git_enrichment",
    requested: false,
    stable_id: stableId,
    selectors: { artifact: artifactId, number: entryNumber },
    dry_run: `${BACKFILL_COMMAND} --artifact ${artifactId} --number ${entryNumber} --dry-run --format json`,
    apply: `${BACKFILL_COMMAND} --artifact ${artifactId} --number ${entryNumber} --apply --force --format json`,
    remote_contact: false,
    recovery:
      "Review the exact dry-run before applying. Git unavailability or a refusal is non-blocking; retry the same selectors later.",
  };
}
