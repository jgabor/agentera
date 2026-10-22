import { VALIDATE_FAMILY_NAMES, VERIFY_TARGETS } from "./checkCatalog.js";
import { VALIDATE_ARTIFACT_PROTOCOL_IDS } from "../../registries/artifactProtocolIds.js";
import { CAPABILITY_INSTRUCTIONS } from "../../capabilities/index.js";
import YAML from "yaml";
import { validateStructuredInputInventory } from "../../registries/structuredInputInventory.js";
import { verificationPolicyErrors, verificationPendingContract } from "../../registries/verificationPolicy.js";
import { validateGlossaryEvaluationAuthority, validateFrozenGlossaryHoldout, validateFrozenGlossaryBehaviorFixture, loadGlossaryEvaluationHoldout, loadGlossaryEvaluationBehaviorFixture } from "../../eval/glossaryEvaluation.js";
import { GuidanceInputError, guidanceQuote } from "../guidanceDetail.js";
import { operationIndex, requireValid, type ServiceAuthority } from "./serviceDetail.js";
import { loadProjectionPolicy } from "../../state/projectionPolicy.js";

const OPERATIONS = ["validate", "verify", "lint", "compact"];
export function checkDetailSections(a: ServiceAuthority, base: string, operation?: string, target?: string) {
  if (!operation) {
    operationIndex(a, base, OPERATIONS);
    return;
  }
  if (!OPERATIONS.includes(operation)) throw new GuidanceInputError("Select an advertised check operation.", OPERATIONS);
  const targets =
    operation === "validate"
      ? [...VALIDATE_FAMILY_NAMES, ...Object.keys(CAPABILITY_INSTRUCTIONS).map((name) => `capability ${name}`), ...VALIDATE_ARTIFACT_PROTOCOL_IDS.map((name) => `artifact ${name}`)]
      : operation === "verify"
        ? Object.entries(VERIFY_TARGETS).flatMap(([family, values]) => values.map((value) => `${family} ${value}`))
        : [];
  if (target !== undefined && !targets.includes(target)) throw new GuidanceInputError("Select a target advertised by this check operation.", targets);
  if (targets.length)
    a.add(
      "targets",
      targets.map((value) => ({
        target: value,
        command: `${base} --operation ${guidanceQuote(operation)} --target ${guidanceQuote(value)}`,
        source_only: ["retained-references", "activation-conjunction"].includes(value),
      })),
      "packages/cli/src/cli/commands/checkCatalog.ts; artifactProtocolIds.ts",
      "target_navigation",
    );
  const prefix = "npx -y agentera@next check";
  const common = {
    operation,
    target: target ?? null,
    effects: "Explaining never runs a validator, evaluator, diagnostic or repair. Normal validate/lint and compact check do not mutate profile, project, host or registry. Compact fix and evaluator execution are distinct effectful operations, not implied by discovery.",
    output: "Operational JSON retains its owning command envelope and exit contract. Validation results are not construction guidance, user approval, semantic correctness, or permission to publish. Resolve reported violations through the owning schema/capability/writer; never edit typed entities directly.",
    correction: "Use the returned syntax and static schema details first; correct the selected input and rerun that same check. Do not infer a passing check from an available explanation.",
    construction: "npx -y agentera@next schema",
  };
  if (operation === "validate") {
    const [family, name] = (target ?? "").split(" ");
    a.add(
      "usage",
      {
        ...common,
        syntax: `${prefix} validate FAMILY [CAPABILITY] [--artifact A] [--file PATH] [--cwd PATH] [--format FORMAT]`,
        example: family === "artifact" ? `${prefix} validate artifact --artifact ${name ?? "glossary"} --file ./input.yaml` : family === "capability" ? `${prefix} validate capability ${name ?? "profile"}` : `${prefix} validate ${family || "capability-contract"}`,
        scopes: {
          capability: "Canonical capability name or supplied capability path; checks complete authoring structure, stable IDs, primitive references and cross-capability qualifications.",
          "capability-contract": "Validates shared authoring governance, not project data.",
          artifact: "--artifact identifies construction schema; --file supplies a prospective artifact without writing it. Without a file the validator resolves the project artifact. Artifact validation does not publish the input.",
          state: "Validates typed project state and cutover/reconciliation consistency, with --cwd selecting the project. Legacy state may require the explicit migration route, not manual entity edits.",
          "cross-capability": "Validates the read/write artifact graph.",
          "app-home-contract": "Checks runtime app-home terminology and contract consistency, not installation repair.",
          vocabularyAuthority: "Checks canonical names and permitted historical aliases.",
          "retained-references": "Source checkout only: retained inventory ownership, classification and references; unavailable as a packaged validation capability.",
          "activation-conjunction": "Source checkout only: conjunctive activation evidence; source/packaging qualification, not consumer runtime readiness.",
          selfAudit: "Source editorial abstraction, filler and verbosity contract checks.",
          "release-metadata": "Read-only release metadata consistency. Passing is not registry credentials or publication approval.",
        },
        exit_codes: {
          0: "selected validation passes",
          1: "validation fails",
          2: "malformed operational request (existing envelope)",
        },
        detail: name && family === "artifact" ? `npx -y agentera@next schema --artifact ${name}` : family === "capability" && name ? `npx -y agentera@next prime --context ${name} --detail validation` : "npx -y agentera@next schema --capability-contract",
      },
      "packages/cli/src/cli/commands/validate.ts; packages/cli/src/cli/dispatch/check.ts",
    );
    if (target === "retained-references") {
      a.yaml("references/analysis/structured-input-inventory.yaml", "structured_input_inventory", (_value, file) => requireValid(validateStructuredInputInventory(file)));
    }
  } else if (operation === "verify") {
    a.add(
      "usage",
      {
        ...common,
        syntax: `${prefix} verify eval {skills|semantic|routing|glossary} [--format FORMAT] [target options]`,
        examples: [`${prefix} verify eval skills --dry-run`, `${prefix} verify eval semantic --fixtures ./fixtures.yaml`, `${prefix} verify eval routing`, `${prefix} verify eval glossary`],
        targets: {
          "eval skills": "Default/dry-run lists a bounded plan, without a host runtime. --run requires separate host permission; --skill NAME, --runtime auto|opencode|cursor, --timeout SECONDS (default 120), --parallel N (default 1) bound execution. Do not combine --run and --dry-run.",
          "eval semantic": "Requires repeatable --fixtures PATH. Evaluation conformance is not proof of semantic generalization or a live model result.",
          "eval routing": "Deterministic routing/conformance evaluation, no semantic host call. Full request/receipt and evidence limits: npx -y agentera@next route explain --topic evaluation.",
          "eval glossary":
            "Runs the isolated bounded product-behavior harness against frozen fixtures and exact metric denominators; returns metric report plus fail-closed gate. No live history/profile is read. Corpus records and holdout labels are not emitted by explanation. A quantitative pass does not enable inferred automatic admission.",
        },
        output: "JSON command/status/family/target/engine/diagnostics/safety, plus glossary_evaluation for glossary. Diagnostic stdout/stderr lines are bounded by the executor. A failing or not-run gate is non-authorizing; preserve its reason and rerun only after correction.",
        qualification: "Source, package, stress, performance, capacity and generated-overlap are maintainer lane owners, not additional check verify targets; npm consumers cannot reproduce them by looking up installed files. Smoke is retired here.",
      },
      "packages/cli/src/cli/commands/verify.ts",
    );
    a.yaml("references/analysis/verification-policy.yaml", "verification_policy", (value) => {
      if (value.schemaVersion !== "agentera.verificationPolicy.v1") throw new Error("Invalid verification policy version.");
      requireValid(verificationPolicyErrors(value));
      requireValid(verificationPendingContract(value.overlap).issues);
    });
    if (target === "eval glossary") {
      const evaluation = a.yaml("references/analysis/personal-glossary-evaluation-authority.yaml", "evaluation", (value) => requireValid(validateGlossaryEvaluationAuthority(value)));
      const holdoutBytes = a.bind("references/analysis/personal-glossary-holdout.yaml");
      const corpusBytes = a.bind("references/analysis/personal-glossary-evaluation-corpus.yaml");
      for (const text of [holdoutBytes, corpusBytes]) {
        const doc = YAML.parseDocument(text);
        if (doc.errors.length || doc.warnings.length) throw new Error("Invalid evaluation reference.");
      }
      const holdout = loadGlossaryEvaluationHoldout(a.root),
        corpus = loadGlossaryEvaluationBehaviorFixture(a.root);
      requireValid(validateFrozenGlossaryHoldout(evaluation, holdout, holdoutBytes));
      requireValid(validateFrozenGlossaryBehaviorFixture(evaluation, holdout, corpus, corpusBytes));
      a.add(
        "fixture_boundary",
        {
          validation: "Frozen holdout/corpus structures and exact digest bindings are validated before serving this guidance. No evaluation is run and no corpus records, labels or personal definitions are returned.",
          action: "npx -y agentera@next check verify eval glossary",
        },
        "references/analysis/personal-glossary-holdout.yaml; references/analysis/personal-glossary-evaluation-corpus.yaml",
        "reference_validation_not_fixture_disclosure",
      );
    }
  } else {
    const details = {
      lint: {
        syntax: `${prefix} lint --artifact A [--file PATH | --text TEXT] [--strict] [--format FORMAT]`,
        example: `${prefix} lint --artifact progress --file ./entry.yaml`,
        input: "Choose one explicit text/file input or resolve the artifact in the current project. Checks verbosity, abstraction and filler; does not publish or fix text. --strict changes failure policy.",
        recovery: "Correct the named editorial issue, retain concrete evidence and rerun. Construction is available through schema --artifact A.",
      },
      compact: {
        syntax: `${prefix} compact [--project PATH] [--mode check|fix | --apply] [--format FORMAT]`,
        example: `${prefix} compact --mode check`,
        input: "Check is the read-only default. Fix/--apply may write compacted projections/archives through their owners; protected overflow requires an owning content decision, not blind deletion.",
        recovery: "Inspect operations and protected_overflow before authorizing fix; follow artifact schema budget/archive and typed writer authority. A failing compact gate is not superseded by unit tests.",
      },
    };
    a.add(
      "usage",
      {
        ...common,
        ...details[operation as keyof typeof details],
        output: "Read the output section for this operation's complete JSON fields, conditional variants, bounds and exit semantics. An explanation is not an executed check or permission to repair/publish.",
      },
      `packages/cli/src/cli/commands/${operation}.ts`,
    );
    const inputFailure = {
      schemaVersion: "agentera.invalidInputEnvelope.v2",
      status: "fail",
      error: {
        class: "Parse-error classification or unsupported_target for an input/read/uncaught command error; compact may forward the writer's input-error class",
        message: "Cause of rejection",
        recovery: "Scoped correction; always present",
        valid_values: "Optional valid selector values",
        syntax: "Optional accepted grammar",
        example: "Optional usage example",
        violations: "Optional validation messages",
        diagnosis: "Optional structured diagnosis supplied by the rejecting owner",
      },
    };
    if (operation === "lint") {
      a.add(
        "output",
        {
          format: "Public lint emits JSON on stdout. The findings payload has no schemaVersion; input rejection uses the separate envelope below.",
          fields: {
            command: "lint",
            status: "pass if all three checks pass, otherwise fail; independent of advisory exit policy",
            artifact: "Requested artifact label, or canonical budget label when the project artifact is resolved",
            source: "text for --text; otherwise the explicit/resolved artifact file path",
            strict: "Boolean echo of --strict (default false)",
            checks: [
              {
                name: "verbosity, abstraction or filler (in that order)",
                status: "pass or fail",
                detail: "Finding or passing-check explanation",
                action: "Empty string on pass; scoped correction on failure. A verbosity authority error asks for authority repair, not text shortening.",
              },
            ],
            summary: {
              failed: "Number of failed checks",
              passed: "Number of passing checks; passed + failed = 3",
              advisory: "!strict, even if a verbosity authority failure forces exit 1",
            },
          },
          outcomes: {
            pass: { status: "pass", exit_code: 0, advisory: "!strict" },
            content_issues_advisory: {
              status: "fail",
              strict: false,
              advisory: true,
              exit_code: 0,
            },
            content_issues_strict: { status: "fail", strict: true, advisory: false, exit_code: 1 },
            authority_failure: {
              status: "fail",
              exit_code: 1,
              advisory: "!strict",
              condition: "A failed check detail starts with 'verbosity authority error'; operational failure is never waived by advisory mode",
            },
            input_failure: {
              status: "fail",
              exit_code: 2,
              condition: "Invalid arguments or unavailable input; not a findings payload",
            },
          },
          input_failure: inputFailure,
          bounds:
            "Exactly three checks, no result cursor. --text uses entry verbosity; file/project input uses full-artifact budgets from the selected schema/verbosity authority. Those are content budgets, not an output-byte guarantee: the findings producer has no separate response byte cap. Invalid-input JSON uses a 32768-byte budget and can replace oversized details with class/message/recovery. Static detail pagination is separate.",
          recovery: "Read status and checks even after exit 0. Correct content findings, repair a failed authority before retrying, or correct rejected input. No lint mode edits the artifact.",
        },
        "packages/cli/src/cli/commands/lint.ts#lintPayloadForContent,cmdLint; packages/cli/src/cli/dispatch/check.ts#runLint; packages/cli/src/cli/errors.ts",
      );
    } else if (operation === "compact") {
      const policy = loadProjectionPolicy(a.root);
      const recovery = {
        status: "complete, degraded, blocked or unsupported",
        attempted: "Full entries considered for archive verification",
        verified: "Entries with verified archive recovery",
        retained_full: "Full entries retained instead of summarizing without verified recovery",
        refused_count: "Number of refused summarizations",
        refusals: [
          {
            stable_id: "Archive-era artifact:number identity, not a bare entity selector",
            artifact_id: "Artifact identifier",
            entry_number: "Optional numbered record identity",
            archive_path: "Optional expected archive path",
            status: "complete, degraded, blocked or unsupported",
            reason: "verified, not_found, corrupt, immutable_conflict or unsupported_state",
            detail_availability: "full",
            source: "archive or current_projection",
            error: {
              schemaVersion: "agentera.stateFailure.v1",
              class: "not_found, corrupt, immutable_conflict or unsupported_state",
              message: "Why recovery was refused",
              syntax: "Recovery grammar",
              example: "Recovery example",
              recovery: "Scoped instruction preserving full detail",
              details: "Cause-specific structured metadata; optional error object, not a request to discard data",
            },
          },
        ],
      };
      a.add(
        "output",
        {
          format: "Public compact emits JSON on stdout. The ordinary payload has no schemaVersion. Optional operation fields appear only when the producer supplies them.",
          fields: {
            command: "check compact",
            status: "summary.status (pass or fail); byte-budget fallback may instead emit degraded",
            project: "Resolved project root",
            summary: {
              status: "fail for error or volatile_todo_reference actions, or in check mode for over_limit/pending_fix/formatting/pending_formatting; otherwise pass",
              mode: "check or fix",
              artifact_count: "Operation count before output trimming",
              over_limit_count: "Number of over_limit or pending_fix operations, not excess-entry count",
              formatting_count: "Number of formatting or pending_formatting operations",
              protected_overflow_count: "Number of protected_overflow operations, not protected-entry count",
              projection_count: "Number of projection or pending_projection operations",
              error_count: "Number of error operations",
              changed_count: "Number of operations reporting changed=true",
              action_counts: "Mapping of each observed action to its operation count",
              guidance: "Producer's scoped next step; read alongside all action/recovery fields",
            },
            operations: [
              {
                artifact: "Artifact or scoped artifact-section label",
                path: "Artifact path",
                exists: "Boolean",
                classification: "Producer classification (for example compactable, error, protected or unbounded); do not treat unknown classifications as repair permission",
                active_count: "Active/full entry count or null when not countable",
                archive_count: "Summary/archive-tier entry count in this projection, or null; not total immutable history size",
                total_count: "Active plus archive-tier count or null",
                over_limit_count: "Excess entries for this artifact or null",
                pending_summarization_count: "Optional count of entries awaiting summary formatting (may be null)",
                projection_state: "Optional within_defaults or over_defaults; display pressure is distinct from history loss",
                protected_overflow_count: "Protected-entry pressure; defaults to zero if absent/null in status",
                mode: "check or fix",
                action: "missing, skipped, ok, refused, projection/pending_projection, over_limit/pending_fix, formatting/pending_formatting, compacted, protected_overflow, error or volatile_todo_reference",
                changed: "Whether this operation changed the projection",
                message: "Operation explanation",
                reason: "Underlying classification/budget reason",
                recovery: { ...recovery },
                diagnostics: [
                  {
                    path: "Optional TODO-reference diagnostic's project-relative YAML path",
                    reference: "Volatile TODO line reference requiring a stable anchor",
                  },
                ],
                omitted_count: "Optional count of TODO-reference diagnostics beyond the first 20",
                result: {
                  active_before: "Pre-operation full count",
                  archive_before: "Pre-operation summary count",
                  active_after: "Post-operation full count",
                  archive_after: "Post-operation summary count",
                  dropped: "Producer's dropped-entry count, distinct from display omissions",
                  omitted_count: "Projection entries omitted from display (default zero)",
                  omission_reason: "Optional explanation for display omission",
                  changed: "Whether the result changed bytes",
                  recovery: { ...recovery },
                },
              },
            ],
          },
          optional_fields: "Operation recovery, diagnostics/omitted_count and result are conditional. result appears only for a non-null compaction result; nested result.recovery and omission_reason are also conditional. Refusal error/entry_number/archive_path are conditional.",
          projection_omission: {
            omitted: true,
            omitted_count: "Operations omitted by the output byte budget",
            omission_reason: "projection_byte_budget",
            retrieval: {
              available: false,
              reason: "unsupported_numbered_retrieval",
              artifact_id: "compact",
            },
            omission_provenance: "null for operation trimming; no claim of verified archive detail",
          },
          budget_fallback: {
            command: "compact",
            status: "degraded",
            entries: [],
            counts: { entries: "Omitted operation count", returned_entries: 0 },
            source: {
              artifact: "compact",
              detail_availability: "unavailable",
              source: "current_projection",
            },
            omitted: true,
            omitted_count: "Omitted operation count",
            omission_reason: "projection_required_fields_exceed_budget",
            retrieval: {
              available: false,
              reason: "unsupported_numbered_retrieval",
              artifact_id: "compact",
            },
            omission_provenance: {
              source: "current_projection",
              detail_availability: "unavailable",
              compatibility: "degraded",
              archive_verified: false,
              omitted_count: "Omitted operation count",
            },
            error: {
              class: "projection_output_budget",
              message: "Required fields exceeded the budget",
              syntax: "Producer fallback syntax (not a new compact retrieval command)",
              example: "Producer fallback example",
              recovery: "No direct retrieval route is declared; use the supported owning artifact commands",
            },
          },
          minimal_fallback:
            "If the detailed fallback still exceeds the budget, only command=compact, status=degraded, omitted=true, omitted_count, omission_reason=projection_output_budget and retrieval remain. If even that cannot fit, input rejection is emitted. Summary/status omission never changes the underlying operation exit calculation.",
          bounds: {
            max_utf8_bytes: policy.maxUtf8Bytes,
            todo_reference_diagnostics: 20,
            policy: "State-storage projection byte budget. Operations may be removed while summary counts remain pre-trimming totals. No compact cursor or direct numbered retrieval is advertised. Correct the producer's cause or use owning artifact retrieval, not an invented state compact command.",
          },
          exit_codes: {
            0: "No error/volatile-reference action and, in check mode, no over_limit/formatting action. Projection pressure, refused/protected work and a degraded output alone do not make this producer exit nonzero; inspect recovery before any repair.",
            1: "volatile_todo_reference, or check mode with over_limit/formatting",
            2: "An error operation (takes precedence), invalid input, writer input rejection or uncaught command/authority failure",
          },
          input_failure: inputFailure,
        },
        "packages/cli/src/cli/commands/compact.ts; packages/cli/src/hooks/compaction/types.ts; packages/cli/src/state/archiveRecovery.ts; packages/cli/src/state/projectionPolicy.ts; references/artifacts/state-storage-authority.yaml",
      );
    }
  }
}
