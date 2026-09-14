import { CAPABILITY_INSTRUCTIONS } from "../../capabilities/index.js";
import { validateGlossaryEntryContract, personalGlossaryOutputContract, personalProfileGroundingContract } from "../../registries/glossaryEntryContract.js";
import { validateEvidenceTierContract } from "../../registries/evidenceTierContract.js";
import { glossaryAdviceContract } from "../../registries/glossaryAdviceContract.js";
import { personalGlossaryCandidateProjectionContract } from "../../registries/glossaryCandidateProjectionContract.js";
import { personalGlossaryCandidateDecisionContract } from "../../registries/glossaryCandidateDecisionContract.js";
import { personalGlossaryReviewRecordsContract } from "../../registries/glossaryReviewRecordsContract.js";
import { personalGlossaryProfileFullContract } from "../../registries/glossaryProfileFullContract.js";
import { validateProtocolSelf } from "../../validate/capability.js";
import { GuidanceInputError } from "../guidanceDetail.js";
import { operationIndex, requireValid, type ServiceAuthority } from "./serviceDetail.js";

export function reportDetailSections(a: ServiceAuthority, base: string, operation?: string) {
  const relative = "references/artifacts/glossary-entry-contract.yaml";
  const entry = a.yaml(relative, "entry", (_value, file) => requireValid(validateGlossaryEntryContract(file)));
  const file = `${a.root}/${relative}`;
  const output = personalGlossaryOutputContract(file),
    candidates = personalGlossaryCandidateProjectionContract(file),
    decision = personalGlossaryCandidateDecisionContract(file),
    reviews = personalGlossaryReviewRecordsContract(file);
  const tail = (command: string) => command.split(" report ")[1];
  const operations = [
    "summary",
    "refresh",
    "profile-grounding",
    "glossary-advice",
    `${tail(candidates.candidateReadCommand)} list`,
    `${tail(candidates.candidateReadCommand)} get`,
    tail(decision.command),
    ...["queue", "disposition", "list", "get"].map((verb) => `${tail(reviews.command)} ${verb}`),
    tail(output.command),
  ];
  if (operations.some((value) => !value || value.includes("undefined"))) throw new Error("Invalid report command metadata.");
  if (operation === undefined) {
    a.sections.length = 0;
    operationIndex(a, base, operations);
    return;
  }
  if (!operations.includes(operation)) throw new GuidanceInputError("Select an advertised report operation (nested command tail as one argument).", operations);
  const invocation = `npx -y agentera@next report${operation === "summary" ? "" : ` ${operation}`}`;
  const exactCandidate = "--candidate-id ID --candidate-revision REVISION --generation GENERATION --policy-version POLICY";
  const syntax =
    operation === "summary"
      ? `${invocation} [--project VALUE] [--sources active|all] [--format json]`
      : operation === "refresh"
        ? `${invocation} [--dry-run | --consent local-history] [source-selection options] [--format json]`
        : operation === "profile-grounding"
          ? `${invocation} [--format json]`
          : operation === "glossary-advice"
            ? `${invocation} (--input FILE_OR_DASH | --term-input FILE_OR_DASH) [--format json]`
            : operation === `${tail(candidates.candidateReadCommand)} list`
              ? `${invocation} [--source-family explicit|recurring] [--provenance-kind KIND] [--scope personal|ambiguous] [--limit N] [--cursor TOKEN] [--format json]`
              : operation === `${tail(candidates.candidateReadCommand)} get`
                ? `${invocation} ${exactCandidate} [--format json]`
                : operation === `${tail(reviews.command)} list`
                  ? `${invocation} [--status pending|terminal] [--limit N] [--cursor TOKEN] [--format json]`
                  : operation === `${tail(reviews.command)} get`
                    ? `${invocation} --review-id ID ${exactCandidate} [--format json]`
                    : `${invocation} --input FILE_OR_DASH${operation === tail(output.command) ? " [--dry-run]" : ""} [--format json]`;
  a.add(
    "usage",
    {
      syntax,
      input: "FILE_OR_DASH is an explicitly supplied structured mapping file or - for stdin. Get bindings and opaque cursors come from the preceding current private response, never invented values. Static explanation does not consume that input.",
      output:
        "Summary/refresh: read output for operation-specific result variants and fields. Other operations: read runtime_contract for the selected loader's request/result fields and bounds, and entry for full meanings and conditional rules. profile_full_integration is downstream workflow guidance only, not a summary/refresh result.",
      recovery: "Follow the current command's structured reason/recovery. Missing consent never authorizes acquisition. Stale current bindings require a fresh read/decision; conflicting approval replay cannot be repaired by guessing a new nonce or signature.",
    },
    "packages/cli/src/cli/dispatch/lifecycle.ts; packages/cli/src/cli/commands/report.ts",
  );
  if (operation === "summary" || operation === "refresh") {
    a.add(
      "output",
      operation === "summary"
        ? {
            format: "The public route defaults to JSON. A successful summary is the analytics object, not a command/status envelope. The retained stats labels below are compatibility output, not new command names.",
            ready: {
              generated_at: "ISO timestamp of this analysis",
              extracted_at: "Evidence extraction timestamp or null when unknown",
              project_filter: "Requested project string or null for all projects; case-sensitive substring match in either direction between nonempty project ID and request",
              source_view: "active (default) or all, echoing the selected provenance view",
              source_provenance: [
                {
                  source_class: "active_runtime or historical_import (retained source class)",
                  source_product: "Recorded source product/runtime, or unknown",
                  active_runtime: "boolean",
                  records: "Number of selected evidence records from this provenance, not number of invocations",
                },
              ],
              skills: {
                "<capability>": {
                  total: "Invocation count",
                  completed: "Count with a matched exit marker",
                  incomplete: "Count without a matched exit marker",
                  trigger_slash: "Slash-triggered invocation count",
                  trigger_natural: "Natural-language invocation count",
                },
              },
              per_project: "Mapping of project ID to the same capability/count buckets as skills",
              invocations: [
                {
                  skill: "Canonical capability name",
                  glyph: "Intro marker glyph",
                  intro_word: "Intro marker word",
                  intro_source_id: "Source turn ID",
                  intro_timestamp: "Source turn timestamp",
                  completed: "boolean; matching exit marker found, not a quality judgment",
                  exit_status: "complete, flagged, stuck, waiting, or null when unmatched",
                  exit_source_id: "Matched exit turn ID or null",
                  exit_timestamp: "Matched exit timestamp or null",
                  trigger: "slash or natural",
                  project_id: "Source project ID",
                  source_class: "Retained provenance class",
                  source_product: "Retained provenance product",
                  active_runtime: "boolean; historical imports are not active evidence",
                },
              ],
            },
            unavailable: {
              command: "stats",
              status: "missing or stale",
              corpus_path: "Resolved private corpus location",
              reason: "Why current evidence cannot be analyzed",
              next: "Legacy recovery preview command; canonical equivalent is npx -y agentera@next report refresh --dry-run",
              privacy: { local_history_read: false, local_history_write: false },
            },
            bounds:
              "Analytics streams bounded evidence shards and applies the evidence authority's reader caps; legacy corpus fallback is bounded. The operational summary is not paginated by the static guidance cursor. invocations/per_project can contain private identifiers; a summary is not permission to export them.",
            effects: "JSON summary reads existing evidence only and does not acquire runtime history. Explicit --format text writes USAGE.md in the user-local usage directory and prints a summary/report path. Neither form publishes PROFILE.md or project glossary entries.",
            exit_codes: {
              0: "Analytics emitted (including an empty selected scope)",
              2: "Invalid request or unavailable evidence. A failure after readiness assessment can emit only stderr, not the unavailable JSON envelope; retain that diagnostic.",
            },
          }
        : {
            format: "Public JSON retains command=stats refresh. Variant fields below are conditional, not a promise that every response includes every field.",
            consent_required: {
              command: "stats refresh",
              status: "degraded_consent_required",
              recovery: "Canonical equivalent: npx -y agentera@next report refresh --consent local-history, only after approval",
              privacy: {
                local_history_read: false,
                local_history_write: false,
                tier_write: false,
                required_consent: "local-history",
                provided_consent: "Supplied value or null",
              },
            },
            dry_run: {
              command: "stats refresh",
              status: "dry_run",
              privacy: {
                local_history_read: false,
                local_history_write: false,
                tier_write: false,
                required_consent: "local-history",
                provided_consent: null,
              },
              corpus_path: "Private intermediate location; no monolithic corpus write",
              tier_path: "dirname(corpus_path)/tiers",
              engine: {
                command: "Argument array describing extraction; diagnostics only, not a replacement public command",
              },
              diagnostics: "Array of privacy, tier and optional historical-import qualifications",
            },
            attempted: {
              command: "stats refresh",
              status: "pass, flagged (engine exit 4), or fail",
              exit_signal: "EX2 for engine exit 4, otherwise null",
              privacy: {
                local_history_read: "true after entering acquisition; false if the refresh lock failed before acquisition",
                local_history_write: false,
                tier_write: "Engine exit 0 (false on lock failure)",
                projection_write: "true only when candidate projection was published",
                required_consent: "local-history",
                provided_consent: "local-history",
                historical_imports: "Selected import-source names",
                historical_import_warning: "Claude transcript secret/content warning or null",
              },
              corpus_path: "Private intermediate location",
              tier_path: "Bounded evidence tier directory",
              evidence: {
                status: "published on engine success, failed on engine failure; readable or unavailable if lock acquisition failed",
                generation: "Current manifest generation, present only when available",
                published_at: "Current manifest publication time, present only when available",
              },
              projection: {
                not_attempted: { status: "not_attempted" },
                failed: {
                  status: "failed",
                  reason: "Projection/lock failure cause",
                  recovery: "Exact scoped recovery; do not delete a live refresh lock or invent generation bindings",
                },
                published: {
                  status: "published",
                  write_status: "changed or unchanged_replay",
                  generation: "Evidence generation binding",
                  policy_version: "Mining policy binding",
                  candidate_projection_sha256: "Exact published projection digest",
                  candidate_count: "Candidate count",
                  abstention_count: "Abstention count",
                  path: "Private candidate projection location",
                },
              },
              engine: {
                command: "Extraction argument array (diagnostic)",
                exit_code: "Engine integer exit code, or null if not started due to lock failure",
                stdout: "Nonempty captured output lines; may contain coverage diagnostics",
                stderr: "Nonempty captured diagnostic lines",
              },
            },
            exit_codes: {
              0: "Dry-run or successful engine plus projection",
              1: "Lock/projection failure, or engine failure code 1",
              2: "Missing/invalid consent or invalid request; invalid flag combinations may emit stderr only",
              4: "Engine flagged coverage (EX2); not success",
              other: "Other nonzero extraction exit codes propagate unchanged",
            },
            recovery:
              "Evidence publication and projection publication have separate statuses: evidence can be current while projection fails. Keep both, rerun the same approved refresh after correcting its cause, then reread current candidate bindings. Replay reports unchanged_replay rather than fabricating a new approval. --coverage-audit-only audits without extraction; engine/projection status remains decisive. No result is approval to publish personal or project definitions.",
            bounds: "Evidence tier, shard, coverage and projection bounds come from evidence and entry/runtime contracts. Operational engine line arrays are not static-detail pagination; retain the complete diagnostic. Explicit text format prints status and engine lines instead of these JSON fields.",
          },
      "packages/cli/src/cli/commands/report.ts; packages/cli/src/analytics/usageStats.ts; packages/cli/src/analytics/personalGlossaryRefreshProjection.ts",
    );
  }
  a.yaml("references/analysis/evidence-tier-authority.yaml", "evidence", (_value, pathname) => requireValid(validateEvidenceTierContract(pathname)));
  a.yaml("skills/agentera/protocol.yaml", "protocol", (_value, pathname) => requireValid(validateProtocolSelf(pathname)));
  a.add("profile_construction", CAPABILITY_INSTRUCTIONS.profile, "packages/cli/src/capabilities/profile/instructions.ts", "complete_compiled_profile_construction_and_lifecycle");
  a.add(
    operation === "summary" || operation === "refresh" ? "profile_full_integration" : "runtime_contract",
    operation === "profile-grounding"
      ? personalProfileGroundingContract(file)
      : operation === "glossary-advice"
        ? glossaryAdviceContract(file)
        : operation.startsWith(tail(candidates.candidateReadCommand))
          ? candidates
          : operation === tail(decision.command)
            ? decision
            : operation.startsWith(tail(reviews.command))
              ? reviews
              : operation === tail(output.command)
                ? output
                : personalGlossaryProfileFullContract(file),
    relative,
    "actual_runtime_loader_projection",
  );
  a.add(
    "workflow",
    {
      operation,
      invocation: `npx -y agentera@next report${operation === "summary" ? "" : ` ${operation}`}`,
      input_help: `npx -y agentera@next report --help`,
      discovery: {
        construction: "npx -y agentera@next schema --artifact glossary --section entry",
        profile: "npx -y agentera@next prime --context profile --detail instructions",
        project_publication: "npx -y agentera@next state glossary explain --verb publish",
      },
      history_consent:
        "Default summary reads existing bounded analytics with --sources active; --sources all includes historical imports with provenance. Refresh --dry-run previews before acquisition; refresh --consent local-history authorizes local history acquisition, not profile/project publication. Transcripts may contain secrets. --import-source claude is historical, never active. --accept-coverage-gap explicitly accepts skipped available runtimes; --coverage-audit-only does not extract.",
      refresh_grammar:
        "npx -y agentera@next report refresh --dry-run; after explicit consent: npx -y agentera@next report refresh --consent local-history. Optional --project-root PATH (repeatable), --output PATH (tier-parent selection, not a monolithic corpus write), --codex-sessions-dir PATH, --opencode-conversations-dir PATH, --copilot-conversations-dir PATH, --cursor-projects-dir PATH, --cursor-chats-dir PATH, --claude-projects-dir PATH, --no-codex, --no-opencode, --no-copilot, --no-cursor, --import-source claude.",
      effects:
        "Grounding, advice, candidate reads and decision are read-only. Refresh writes user-local evidence tiers and a generation-bound candidate projection only after consent. Queue/disposition write private review metadata, not definitions. Publish separately revalidates the exact current decision/receipt or review authorization immediately before the owned PROFILE.md Glossary effect. No report operation publishes project glossary entries.",
      lifecycle:
        "Use current candidate ID, revision, generation and policy exactly. Stale generations, expired context, missing/corrupt stores and conflicting replay fail closed: reacquire current bounded reads, rerun the decision, and seek fresh approval where required; never guess bindings or broaden consent. Pending v1 review reads do not migrate. Only disposition can migrate a valid current record. Inferred automatic admission remains disabled regardless of host confidence.",
      privacy:
        "These examples contain no personal definitions. Actual candidate/advice/grounding results can be private; do not copy them to project state, public logs or shared reports. Review reads expose only opaque bindings and lifecycle metadata. Approval requires the configured current-user signed local-host channel, not an agent-authored yes flag.",
      complete_semantics:
        "entry contains all shared fields, provenance, consumer precedence, advice matrix, candidate/review/receipt/publication shapes, bounds, expiry and replay rules. evidence contains acquisition, coverage and compatibility recovery. profile_construction supplies the full Profile format and permanence/decay meanings. Follow their semantic subsections, not authority paths.",
      declared_sections: Object.keys(entry),
    },
    "packages/cli/src/cli/dispatch/lifecycle.ts; packages/cli/src/cli/commands/report.ts",
  );
}
