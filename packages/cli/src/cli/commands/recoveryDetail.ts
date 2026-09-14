import { loadLifecycleAuthority } from "../../runtime/lifecycleAuthority.js";
import { loadRuntimeLifecycleAdapterContract } from "../../runtime/lifecycleAdapterContract.js";
import { loadLifecycleOperationContract } from "../../runtime/lifecycleOperationContract.js";
import { loadNativeResourceCleanupContract } from "../../runtime/nativeResourceCleanup.js";
import { loadProductV1ResetAuthority } from "../../upgrade/productV1ResetAuthority.js";
import { validateRegistryData } from "../../registries/packageRegistry.js";
import { validateLifecycleAuthority as validateLifecycleVocabulary, validateUpdateChannelsAuthority } from "../../validate/vocabularyAuthority.js";
import { SOURCE_LABELS, SETUP_EVIDENCE, BUNDLE_EVIDENCE } from "../../state/installRoot.js";
import { GuidanceInputError } from "../guidanceDetail.js";
import { operationIndex, requireValid, type ServiceAuthority } from "./serviceDetail.js";

const OPERATIONS = ["install", "refresh", "migrate", "reset", "cleanup"];
export function recoveryDetailSections(a: ServiceAuthority, base: string, owner: "upgrade" | "doctor" | "app-home", operation?: string) {
  if (owner === "upgrade" && !operation) {
    operationIndex(a, base, OPERATIONS);
    return;
  }
  if (operation && !OPERATIONS.includes(operation)) throw new GuidanceInputError("Select a supported lifecycle explanation.", OPERATIONS);
  const cli = "npx -y agentera@next";
  a.add(
    "resolution",
    {
      command: `${cli} app-home`,
      precedence: SOURCE_LABELS,
      defaults: "Explicit --install-root wins, then AGENTERA_HOME, then the platform app home. AGENTERA_DEFAULT_INSTALL_ROOT overrides the default. Linux uses XDG_DATA_HOME or ~/.local/share; macOS uses ~/Library/Application Support; Windows uses APPDATA or ~/AppData/Roaming, each under agentera.",
      home_override: "app-home --home HOME isolates default resolution from inherited XDG_DATA_HOME, APPDATA, AGENTERA_HOME and AGENTERA_DEFAULT_INSTALL_ROOT. --install-root remains explicit. Output is the existing resolved path/source JSON object; no directory is created.",
      runtime_data:
        "The npm CLI is self-contained: bundled runtime data travels with the executable and is not the host skill projection. AGENTERA_BOOTSTRAP_SOURCE_ROOT explicitly selects runtime authority data; an invalid selected authority must be repaired, not replaced with an unrelated installed copy. AGENTERA_HOME selects durable app data, not a replacement for the package executable.",
      evidence: { setup: SETUP_EVIDENCE, legacy_bundle: BUNDLE_EVIDENCE },
      privacy: "Discovery serves names and precedence only, never resolved user paths, profile contents, config files or ownership journals.",
    },
    "packages/cli/src/state/installRoot.ts; packages/cli/src/core/sourceRoot.ts; packages/cli/src/cli/commands/appHome.ts",
  );
  if (owner === "app-home") return;
  a.add(
    "recovery",
    {
      fresh_project: "A fresh Git project is initialized only by state plan create. Do not use upgrade --yes to initialize it. Partial, corrupt or unknown marker-absent state remains blocked behind read-only recovery, not state migrate/backfill, projection repair, restore or downgrade.",
      fresh_commands: [`${cli} prime --context plan`, `${cli} state plan explain --verb create`, `${cli} state plan create --input PLAN.yaml --dry-run`],
      interrupted_migration:
        "Rerun the same full v2-to-v3 apply command after interruption; completed work converges to no change. No rollback or reconstruction of missing history is offered. Compacted progress/decision/health summaries remain immutable read-only summary entities with retained source provenance, detail_availability=summary and compatibility=degraded. Their deterministic ID segment follows full records and makes no chronology claim. They are not current full detail or standalone satisfaction targets.",
      cleanup_ownership:
        "Cleanup preview is ID-scoped and excludes app/project migration phases. Declared marker-managed regular Codex descriptors/OpenCode agents/commands can prove whole-file ownership; other resources require their declared ledger/fingerprint evidence. Shared config.toml keys are report-only: matching values never authorize shared-configuration mutation. Mixed hooks and ambiguous/unowned resources are retained. Eligible leaves apply independently; collisions still leave a non-success outcome. Empty declared directories are removed deepest-first non-recursively; symlinks/non-empty paths are preserved. Restart OpenCode after a successful historical plugin removal. No replacement hook/native integration is installed.",
      verification: "upgrade --verify without --yes is read-only doctor/context verification; with --yes it follows approved migration. Explicit --legacy-cleanup with --verify requires --yes. After approved effects, run doctor and prime; neither command repairs automatically.",
      commands: [`${cli} doctor`, `${cli} prime`, `${cli} upgrade --verify`, `${cli} check explain --operation durability`],
      locks:
        "Apply takes the required project lock; explicit cleanup also takes its ownership-journal/shared lock. Acquisition is atomic and release requires the matching token. A stale/malformed lock blocks. Never delete a lock merely because a retry failed: confirm no operation owns the exact reported lock before removing only that lock and retrying. Preview creates no locks.",
      retained:
        "Protected objective experiments, runtime-local sessions and canonical TODO rows are outside compacted-summary migration. Reset is only for declared product-v1 evidence, never v2 or a schema identifier ending in .v1. Review irreversible_loss, each deletion and recreation and exact authorization before reset; no backup/restore is retained.",
    },
    "UPGRADE.md; packages/cli/src/upgrade; packages/cli/src/runtime/nativeResourceCleanup.ts",
  );
  a.yaml("references/cli/app-lifecycle-vocabulary.yaml", "vocabulary", () => requireValid(validateLifecycleVocabulary(a.root)));
  a.yaml("references/cli/update-channels.yaml", "channels", () => requireValid(validateUpdateChannelsAuthority(a.root)));
  a.yaml("references/adapters/package-registry.yaml", "package", (value) => requireValid(validateRegistryData(value, a.root)));
  a.add(
    "boundaries",
    {
      current: "One npm package supplies the CLI and its internal runtime contracts. Shared-skill health is separate from package/runtime-data and project-state health. This command explains current executors; it does not install, reset, migrate or repair anything.",
      host_projection:
        "upgrade --shared-skill previews fresh one-file installation, ledger-owned refresh, or conversion of a positively owned legacy link/copied tree. Fresh/one-file apply requires --yes; legacy conversion requires --yes --authorization TOKEN from the exact reviewed preview. Preview reports affected paths, per-entry ownership, retained legacy data and resulting SKILL.md-only shape. Conversion retains the old link/tree in the selected app-home runtime-lifecycle directory without following links; the existing ownership journal remains outside the host. Linux safe publication and same-filesystem retention are required. Every copied entry must have matching whole-resource ledger identity and fingerprint; names, matching bytes, pending-create without identity, extras and ambiguity never grant ownership. No route recreates the full-tree host link.",
      permissions: "Preview is read-only. Apply requires explicit user approval and matching ownership/scope. Discovery, CI success, .env/.npmrc, a receipt, or an inherited token is not registry mutation authorization. No publication command is added.",
      maintainer_boundary:
        "Package construction, bootstrap integrity, toolchain baseline, source/package parity and historical release qualification are source-only maintainer checks. Consumers use the packaged CLI, not scripts or installation companion file lookups. Reinstall/retry the selected npm distribution if package bytes are missing; diagnose the host projection separately.",
      commands: [`${cli} doctor`, `${cli} app-home`, `${cli} upgrade --dry-run`, `${cli} upgrade --explain`],
    },
    "packages/cli/src/setup/sharedSkill.ts; packages/cli/src/upgrade/productV1Reset.ts; docs/packaging/v3-packaging.md",
  );
  if (owner === "doctor")
    a.add(
      "signals",
      {
        syntax: `${cli} doctor [--install-root PATH] [--home HOME] [--project PATH] [--expected-version VERSION] [--expect-command CMD] [--retired-resource ID] [--smoke] [--allow-live-model] [--format json]`,
        behavior: "Read-only diagnosis of app/package version and command presence, project-state readiness, shared skill and retired resources. --smoke is bounded offline; no live model call by default. Diagnosis never repairs automatically.",
        corrections: {
          up_to_date: "No app repair is required; this does not prove host trust or project readiness.",
          outdated: "Select the intended distribution/channel, then preview upgrade; do not confuse npm package version with durable data version.",
          repair_needed: "Separate missing package/runtime data from broken shared-skill projection. Retry a valid package invocation; preview only the scoped owned repair.",
          migration_needed: `${cli} upgrade --channel development --dry-run`,
          manual_review_needed: "Stop for an ownership/trust/scope decision. --force is not blanket ownership permission.",
          todo_reconciliation: "Inspect the emitted reconciliation state/counts and use the returned typed migration recovery; do not hand-edit entities or treat a legacy aggregate as current state.",
          retired_resource: `${cli} upgrade --explain --operation cleanup`,
          shared_skill:
            "shape distinguishes missing, one_file, extra_entries, legacy_symlink, invalid_bootstrap, wrong_type and unsafe_path. compatibility reports v3 bootstrap version compatibility separately from freshness and runtime_authority. ownership reports whether a scoped install/refresh preview is blocked. Doctor never repairs; use upgrade --shared-skill --dry-run and obtain explicit user permission before --yes. Host trust and package/project health remain separate.",
        },
        output: "Existing structured diagnosis includes app/project/CLI/shared-skill evidence and scoped next actions. A healthy package is not evidence that host trust is enabled. Preserve unknown/denied signals rather than automatically changing permissions.",
      },
      "packages/cli/src/cli/commands/doctor.ts; packages/cli/src/upgrade/doctor.ts",
    );
  if (owner === "upgrade") {
    const operations = {
      install: {
        applicability: "Fresh npm invocation needs no checkout or AGENTERA_HOME. --shared-skill is an isolated existing upgrade lifecycle route for a fresh host bootstrap or owned one-file refresh, not app/project migration. It selects the package registry host surface, never the internal runtime tree.",
        preview: `${cli} upgrade --shared-skill --dry-run`,
        apply: `${cli} upgrade --shared-skill --yes`,
        legacy_conversion: {
          preview: `${cli} upgrade --shared-skill --home HOME --install-root APP --dry-run`,
          apply: `${cli} upgrade --shared-skill --home HOME --install-root APP --yes --authorization TOKEN`,
          retained:
            "The app-home lifecycle journal and host-conversion-TOKEN/legacy retain approval progress and legacy ownership/data. No old runtime target is deleted. Review every affected path and ownership record before authorizing. Conversion supports a ledger-owned link or a copied tree with whole-resource ownership for every entry, on the same filesystem as app-home retention.",
        },
        approval:
          "--yes attests explicit user permission to change the selected home. Agent/project write access and static discovery do not grant that permission. --home HOME and --install-root PATH select host and external ownership-state roots. No project, channel, reset, cleanup, force, verify or migration flags may be combined. Default without --yes is read-only preview.",
      },
      refresh: {
        applicability: "Owned one-file host bootstrap refresh uses --shared-skill. Existing app-content upgrade remains separate, as does report refresh. Host refresh never copies runtime companions or prunes the retained internal runtime tree.",
        preview: `${cli} upgrade --shared-skill --dry-run`,
        apply: `${cli} upgrade --shared-skill --yes`,
        recovery:
          "Inspect preview and obtain explicit user permission first. Retry the same approved command after interruption; legacy conversion retries must retain the same --home, --install-root and --authorization token. The token binds source selection/bytes, host parents and each legacy ownership record, inode and fingerprint. Retained legacy records and the approval checkpoint support forward-only replay; completed work becomes no-op. Unknown/changed identities, user-modified bytes, malformed evidence and unowned extras are preserved with non_success. Interrupted create with no recorded identity cannot adopt an existing destination. Changed/ambiguous retained evidence requires manual recovery, not a new token bypass. Never delete a journal or prune a link target to force success.",
      },
      migrate: {
        applicability: "Forward-only v2-to-v3 development migration. Full cross-major apply requires a Git worktree with complete tracked, unchanged v2 source at HEAD. No rollback, restore, non-Git apply or partial --only cross-major migration.",
        preview: `${cli} upgrade --channel development --project "$PWD" --dry-run`,
        apply: `${cli} upgrade --channel development --project "$PWD" --yes`,
        recovery:
          "Keep the approved scope and checkpoint evidence. Without explicit --install-root, recovery is project-scoped: global cleanup blockers are not enumerated and global resources are not mutated. App/global cleanup requires explicit --install-root scope or --legacy-cleanup RESOURCE_ID with its ownership evidence; host conversion remains the separate --shared-skill route and cannot be authorized by project migration. Re-run preview after interruption and follow the returned recovery. Full apply automatically verifies state and startup. Never infer completion from partial effects.",
      },
      reset: {
        applicability: "Irreversible bounded product-v1 reset only for authority-declared generation evidence. No backup/restore; schema identifier suffix alone is not generation evidence.",
        preview: `${cli} upgrade --reset-product-v1 --dry-run`,
        apply: `${cli} upgrade --reset-product-v1 --yes --authorization TOKEN`,
        recovery:
          "Copy the authorization from the exact reviewed preview. The broad destructive reset scope lists host removal/recreation and binds the selected one-file delivery source. It unlinks only the approved host link or removes the approved one-file leaves non-recursively, then uses the one-file writer; it never traverses a link target or recreates a full-tree link. Full copied host trees/unowned extras require separately approved conversion or manual recovery first. Changed scope makes approval stale: obtain a fresh preview and explicit approval. Preserve all unlisted targets and retry using the retained reset journal.",
      },
      cleanup: {
        applicability: "Migration-only cleanup of one declared retired leaf or historical alias. It does not register current native integrations.",
        preview: `${cli} upgrade --legacy-cleanup RESOURCE_ID --dry-run`,
        apply: `${cli} upgrade --legacy-cleanup RESOURCE_ID --yes`,
        recovery: "Use a selector returned in cleanup authority or doctor evidence. Require matching marker/ledger/fingerprint ownership. Missing or ambiguous evidence is manual review, not force-delete permission. Preview again after interruption; already absent owned leaves can be no-ops.",
      },
    };
    a.add(
      "usage",
      {
        operation,
        ...operations[operation as keyof typeof operations],
        options: "Existing --install-root PATH, --home HOME, --project PATH, --channel stable|development, --only artifacts|runtime|cleanup (repeatable where applicable), --force, --verify and --format json retain their executor meanings. Static explanation rejects them rather than inspecting their locations.",
        retained: "Only the selected authority-declared scope may change. Project, profile, runtime target, ownership journal and unowned extras outside that scope are retained. No registry mutation or live-home change follows from explanation.",
      },
      "packages/cli/src/cli/dispatch/lifecycle.ts; UPGRADE.md",
    );
  }
  if (operation === "migrate" || operation === "cleanup" || operation === "reset" || owner === "doctor") {
    let lifecycle: ReturnType<typeof loadLifecycleAuthority>;
    a.yaml("references/adapters/runtime-lifecycle-authority.yaml", "migration_lifecycle", (_value, file) => {
      lifecycle = loadLifecycleAuthority(file);
    });
    a.yaml("references/adapters/runtime-lifecycle-adapters.yaml", "migration_adapters", (_value, file) => {
      loadRuntimeLifecycleAdapterContract(file, lifecycle);
    });
    a.yaml("references/adapters/runtime-lifecycle-operation-contract.yaml", "migration_operations", (_value, file) => {
      loadLifecycleOperationContract(file);
    });
    a.yaml("references/adapters/runtime-retired-resources.yaml", "cleanup", (_value, file) => {
      loadNativeResourceCleanupContract(file);
    });
  }
  if (operation === "reset")
    a.yaml("references/adapters/product-v1-reset.yaml", "reset", (_value, file) => {
      loadProductV1ResetAuthority(file, a.root);
    });
}
