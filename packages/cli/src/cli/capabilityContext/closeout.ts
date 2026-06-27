import fs from "node:fs";
import { execFileSync } from "node:child_process";
import type { SchemaInfo } from "../appContext.js";
import { artifactPath } from "../appContext.js";
import { asList } from "../stateQuery.js";
import { capabilityContext } from "./contract.js";
import { docsConventions, entryStatus, sourceProvenance, uniqueList } from "./shared.js";
import { closeoutChangelogBoundary } from "./planState.js";
import { progressVerificationSummary } from "./progress.js";
import { decisionReviewPressure } from "./evidence.js";
import type { Dict } from "./types.js";

export function closeoutArtifactMappings(docs: Dict): Dict {
  const mapping = asList(docs.mapping);
  const ok = Boolean(docs.exists) && mapping.length > 0;
  return {
    status: ok ? "available" : "unavailable",
    source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.mapping"),
    entries: mapping,
    mapping_entries: mapping.length,
    caveats: ok ? [] : ["Docs artifact mappings are unavailable or empty in CLI docs state."],
  };
}

export function closeoutVersionPolicy(docs: Dict): Dict {
  const conventions = docsConventions(docs);
  const semverPolicy = conventions.semver_policy && typeof conventions.semver_policy === "object" && !Array.isArray(conventions.semver_policy) ? conventions.semver_policy : {};
  const versionFiles = asList(conventions.version_files);
  const registry = conventions.version_files_registry ?? null;
  const available = Object.keys(semverPolicy).length > 0;
  return {
    status: available ? "available" : "unavailable",
    source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.conventions"),
    version_files: versionFiles,
    version_files_registry: registry,
    semver_policy: semverPolicy,
    caveats: available ? [] : ["Docs version policy is unavailable in CLI docs state."],
  };
}

export function closeoutTodoBlockers(schemas: Record<string, SchemaInfo>, todoItems: Array<Record<string, string>>): Dict {
  const info: SchemaInfo = schemas.todo ?? { path: "TODO.md", record: undefined, schema: {}, fields: {} };
  const exists = fs.existsSync(artifactPath(info, "todo"));
  return {
    status: exists ? "available" : "unavailable",
    source_provenance: sourceProvenance("todo", "agentera todo --format json"),
    open_count: todoItems.length,
    items: todoItems,
    caveats: exists ? [] : ["TODO state is unavailable in CLI state."],
  };
}

export function closeoutBenchmarkEvidence(docs: Dict): Dict {
  const coverage = docs.coverage && typeof docs.coverage === "object" && !Array.isArray(docs.coverage) ? docs.coverage : {};
  const testsSummary = String(coverage.tests ?? "").trim();
  if (testsSummary && testsSummary.toLowerCase().includes("benchmark")) {
    return {
      status: "available",
      source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.coverage.tests"),
      summary_present: true,
      non_empty_evidence_present: true,
      history_scope: "cli_visible_summary",
      user_local_benchmark_reads_required: false,
      summary: testsSummary,
      caveats: [],
    };
  }
  return {
    status: "unavailable",
    source_provenance: sourceProvenance("docs", "agentera docs --format json", "summary.coverage.tests"),
    summary_present: false,
    non_empty_evidence_present: false,
    history_scope: "not_exposed_by_supported_cli_state",
    user_local_benchmark_reads_required: false,
    summary: null,
    caveats: ["Supported CLI/state summaries do not expose benchmark evidence; do not read user-local benchmark files for normal closeout."],
  };
}

export function localGitTagEvidence(targetVersion: string | null): Dict {
  const tag = targetVersion ? `v${targetVersion}` : null;
  const source = { source_family: "local_git", command: "git tag --list <target-tag>", remote: false };
  if (!tag) {
    return { status: "unavailable", tag: null, source_provenance: source, object_type: null, caveats: ["No selected target version is available for local tag evidence."] };
  }
  let stdout: string;
  try {
    stdout = execFileSync("git", ["tag", "--list", tag], { cwd: process.cwd(), encoding: "utf8", timeout: 2000 });
  } catch (exc) {
    const e = exc as { status?: number };
    if (typeof e.status === "number" && e.status !== 0) {
      return { status: "unavailable", tag, source_provenance: source, object_type: null, caveats: ["Local git tag evidence is unavailable because this project is not a git worktree."] };
    }
    return { status: "unavailable", tag, source_provenance: source, object_type: null, caveats: [`Local git tag evidence is unavailable: ${(exc as Error).message}`] };
  }
  if (!stdout.split(/\r\n|\r|\n/).includes(tag)) {
    return { status: "absent", tag, source_provenance: source, object_type: null, caveats: [`Local tag ${tag} is not present.`] };
  }
  let objectType: string | null = null;
  try {
    const out = execFileSync("git", ["cat-file", "-t", tag], { cwd: process.cwd(), encoding: "utf8", timeout: 2000 });
    objectType = out.trim() || null;
  } catch {
    objectType = null;
  }
  return {
    status: "available",
    tag,
    source_provenance: source,
    object_type: objectType,
    caveats: objectType ? [] : [`Local tag ${tag} exists but object type could not be verified.`],
  };
}

export function closeoutReleaseBoundary(changelogBoundary: Dict, bundle: Dict): Dict {
  const targetVersion = changelogBoundary.selected_target_version;
  const localTag = localGitTagEvidence(targetVersion ? String(targetVersion) : null);
  const metadataRecorded = Boolean(changelogBoundary.selected_target_recorded);
  const caveats = [...((changelogBoundary.caveats ?? []) as string[]), ...((localTag.caveats ?? []) as string[])];
  if (!metadataRecorded && localTag.status !== "available") {
    caveats.push("No local closeout metadata or local tag evidence is recorded for the selected target.");
  }
  return {
    status: changelogBoundary.boundary_present ? "available" : "incomplete",
    selected_target_version: targetVersion ?? null,
    boundary: changelogBoundary.boundary ?? null,
    local_metadata_evidence: {
      status: metadataRecorded ? "recorded" : "not_recorded",
      source_provenance: changelogBoundary.source_provenance ?? null,
      field: "changelog_boundary.selected_target_recorded",
    },
    local_tag_evidence: localTag,
    publication_evidence: {
      package_publication: "not_recorded_in_cli_state",
      remote_push: "not_recorded_in_cli_state",
      remote_checks_performed: false,
      registry_checks_performed: false,
      source_provenance: sourceProvenance("closeout_context", "agentera prime --context document --format json", "release_boundary.publication_evidence"),
      caveats: ["Closeout context does not contact remotes or package registries."],
    },
    app_refresh_evidence: {
      installed_app_status: bundle.status ?? null,
      refresh: "not_recorded_in_cli_state",
      approval_recorded: false,
      source_provenance: sourceProvenance("status", "agentera prime --format json", "app.status"),
    },
    caveats,
  };
}

export function documentCloseoutContext(
  capability: string | null,
  schemas: Record<string, SchemaInfo>,
  plan: Dict,
  progress: Dict,
  todoItems: Array<Record<string, string>>,
  docs: Dict,
  profile: Dict,
  bundle: Dict,
): Dict | null {
  if (capability !== "document") return null;
  const capabilityContract = capabilityContext(capability) ?? {};
  const artifactMappings = closeoutArtifactMappings(docs);
  const versionPolicy = closeoutVersionPolicy(docs);
  const todoBlockers = closeoutTodoBlockers(schemas, todoItems);
  const changelogBoundary = closeoutChangelogBoundary(schemas, plan);
  const progressEvidence = progressVerificationSummary(progress);
  const benchmarkEvidence = closeoutBenchmarkEvidence(docs);
  const releaseBoundary = closeoutReleaseBoundary(changelogBoundary, bundle);
  const reviewPressure = decisionReviewPressure(schemas);
  const requiredState: Record<string, boolean> = {
    artifact_mappings: artifactMappings.status === "available",
    version_policy: versionPolicy.status === "available",
    todo_blockers: todoBlockers.status === "available",
    changelog_boundary: Boolean(changelogBoundary.boundary_present),
    progress_evidence: progressEvidence.status === "available",
    benchmark_evidence_or_caveat: benchmarkEvidence.status === "available" || ((benchmarkEvidence.caveats ?? []) as string[]).length > 0,
    decision_review_pressure: reviewPressure.status !== "review_required",
  };
  const missingRequired = Object.entries(requiredState).filter(([, present]) => !present).map(([k]) => k);
  let stateCaveats: string[] = [];
  for (const family of (capabilityContract.missing_state_families ?? []) as string[]) {
    stateCaveats.push(`${family} state is not included in prime --context startup context.`);
  }
  for (const component of [artifactMappings, versionPolicy, todoBlockers, changelogBoundary, releaseBoundary, progressEvidence, benchmarkEvidence, reviewPressure]) {
    stateCaveats.push(...((component.caveats ?? []) as string[]));
  }
  if (bundle.status !== "up_to_date") stateCaveats.push("Agentera app files are not up to date; this is a caveat, not approval to repair or update app files.");
  if (profile.status !== "loaded") stateCaveats.push("profile-derived state is unavailable in prime --context response.");
  else if (profile.stale === true) stateCaveats.push("profile-derived state is stale; this is a caveat, not approval to refresh profile state.");
  stateCaveats = uniqueList(stateCaveats);
  const fallbackCommands = uniqueList([
    "agentera state todo --format json",
    "agentera state docs --format json",
    "agentera state progress --format json",
    "agentera state query changelog --format json",
    "agentera state query --list-artifacts --format json",
    ...((capabilityContract.cli_fallback ?? []) as string[]),
  ]);
  return {
    capability: "document",
    artifact_mappings: artifactMappings,
    version_policy: versionPolicy,
    todo_blockers: todoBlockers,
    changelog_boundary: changelogBoundary,
    release_boundary: releaseBoundary,
    progress_evidence: progressEvidence,
    benchmark_evidence: benchmarkEvidence,
    decision_review_pressure: reviewPressure,
    state_family_caveats: stateCaveats,
    fallback_commands: fallbackCommands,
    source_contract: {
      complete_for_closeout_context: missingRequired.length === 0,
      caveated: stateCaveats.length > 0,
      raw_artifact_reads_required: false,
      raw_artifact_read_policy:
        "Use this closeout_context and included status state first. Run listed routine/query CLI fallback commands " +
        "for missing or incomplete closeout state; raw artifact reads are last-resort diagnostics, not normal closeout behavior.",
      included_state_families: capabilityContract.included_state_families ?? [],
      missing_state_families: capabilityContract.missing_state_families ?? [],
      closeout_state_families: ["docs", "todo", "changelog", "progress", "benchmark_evidence", "decisions"],
      required_closeout_state: requiredState,
      missing_required_closeout_state: missingRequired,
      fallback_commands: fallbackCommands,
      caveats: stateCaveats,
      owns: [
        "artifact mappings",
        "version policy",
        "TODO blockers",
        "changelog or no-release boundary",
        "local metadata/tag versus publication boundary",
        "latest progress evidence",
        "benchmark evidence pointer or unavailable caveat",
        "protected decision review pressure",
        "provenance pointers and non-empty evidence flags",
        "fallback commands",
        "raw-read policy",
        "truthful completeness flag",
      ],
    },
  };
}
