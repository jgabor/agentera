import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMappingFile } from "../core/yaml.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_MIGRATION_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
} from "../upgrade/doctor.js";

/**
 * Validate vocabulary authority YAML contracts (Decision 54 lifecycle status
 * vocabulary, Decision 57 first_invocation_read, update channels, index order).
 * Emits the same delegated validate envelope shape as lifecycle-adapters.
 */

const EXPECTED_STATUSES = [
  "up_to_date",
  "outdated",
  "repair_needed",
  "migration_needed",
  "manual_review_needed",
  "ready_to_apply",
  "applied",
  "no_changes_needed",
] as const;

const EXPECTED_VERBS = ["install", "repair", "update", "migrate", "upgrade", "refresh"] as const;
const EXPECTED_LIFECYCLE_CONSUMERS = ["doctor", "status", "upgrade", "docs", "tests"] as const;
const EXPECTED_CHANNELS = ["stable", "development"] as const;
const EXPECTED_CHANNEL_CONSUMERS = ["upgrade", "doctor", "prime", "docs", "tests"] as const;

function rootDefault(): string {
  return resolveSourceRoot();
}

function authorityPath(root: string, relative: string): string {
  return path.join(root, relative);
}

function canonicalStatuses(authority: JsonObject): Set<string> {
  return new Set(Object.keys(authority.canonical_statuses as JsonObject));
}

function rejectedLifecycleStatusValues(authority: JsonObject): Set<string> {
  const statuses = authority.canonical_statuses as JsonObject;
  const verbs = authority.operation_verbs as JsonObject;
  const deprecated = Object.values(statuses).flatMap((entry) => {
    const aliases = (entry as JsonObject).deprecated_aliases;
    return Array.isArray(aliases) ? aliases : [];
  });
  const nonLifecycleVerbs = Object.entries(verbs)
    .filter(([, entry]) => (entry as JsonObject).lifecycle_allowed === false)
    .map(([name]) => name);
  return new Set([...deprecated, ...nonLifecycleVerbs].map(String));
}

function validateLifecycleAuthority(root: string): string[] {
  const errors: string[] = [];
  const p = authorityPath(root, "references/cli/app-lifecycle-vocabulary.yaml");
  let authority: JsonObject;
  try {
    authority = loadYamlMappingFile(p) as JsonObject; // cast: YAML parse IO boundary
  } catch (exc) {
    return [`app-lifecycle-vocabulary.yaml: ${(exc as Error).message}`];
  }

  if (!Array.isArray(authority.canonical_status_order) || authority.canonical_status_order.length === 0) {
    errors.push("app-lifecycle-vocabulary.yaml: canonical_status_order is required");
  } else if (
    JSON.stringify(authority.canonical_status_order) !== JSON.stringify([...EXPECTED_STATUSES])
  ) {
    errors.push("app-lifecycle-vocabulary.yaml: canonical_status_order drifted from Decision 54 pin");
  }

  const statusKeys = Object.keys(authority.canonical_statuses as JsonObject);
  if (JSON.stringify(statusKeys) !== JSON.stringify([...EXPECTED_STATUSES])) {
    errors.push("app-lifecycle-vocabulary.yaml: canonical_statuses keys drifted from Decision 54 pin");
  }

  for (const status of EXPECTED_STATUSES) {
    const entry = (authority.canonical_statuses as JsonObject)[status] as JsonObject | undefined;
    if (!entry || !String(entry.concept ?? "").trim() || !String(entry.definition ?? "").trim()) {
      errors.push(`app-lifecycle-vocabulary.yaml: canonical status '${status}' is incomplete`);
    }
  }

  const aliasToStatus = new Map<string, string>();
  for (const [status, raw] of Object.entries(authority.canonical_statuses as JsonObject)) {
    for (const alias of (raw as JsonObject).deprecated_aliases as string[]) {
      aliasToStatus.set(alias, status);
    }
  }
  const expectedAliases: Record<string, string> = {
    fresh: "up_to_date",
    stale: "outdated",
    refresh_required: "repair_needed",
    fixed: "applied",
    noop: "no_changes_needed",
  };
  for (const [alias, status] of Object.entries(expectedAliases)) {
    if (aliasToStatus.get(alias) !== status) {
      errors.push(`app-lifecycle-vocabulary.yaml: deprecated alias '${alias}' must map to '${status}'`);
    }
  }

  const doctorAllowed = new Set(
    ((authority.consumers as JsonObject).doctor as JsonObject).may_emit_statuses as string[],
  );
  const observed = [
    APP_UP_TO_DATE,
    APP_OUTDATED,
    APP_REPAIR_NEEDED,
    APP_MIGRATION_NEEDED,
    APP_MANUAL_REVIEW_NEEDED,
  ];
  for (const status of observed) {
    if (!canonicalStatuses(authority).has(status)) {
      errors.push(`doctor constant '${status}' is not a canonical lifecycle status`);
    } else if (!doctorAllowed.has(status)) {
      errors.push(`doctor consumer may not emit canonical status '${status}'`);
    } else if (rejectedLifecycleStatusValues(authority).has(status)) {
      errors.push(`doctor constant '${status}' is a rejected lifecycle alias or verb`);
    }
  }

  if (!Array.isArray(authority.consumer_order) || authority.consumer_order.length === 0) {
    errors.push("app-lifecycle-vocabulary.yaml: consumer_order is required");
  } else if (
    JSON.stringify(authority.consumer_order) !== JSON.stringify([...EXPECTED_LIFECYCLE_CONSUMERS])
  ) {
    errors.push("app-lifecycle-vocabulary.yaml: consumer_order drifted from Decision 54 pin");
  }

  const allowedStatuses = new Set(EXPECTED_STATUSES);
  const allowedVerbs = new Set(EXPECTED_VERBS);
  for (const consumer of EXPECTED_LIFECYCLE_CONSUMERS) {
    const entry = (authority.consumers as JsonObject)[consumer] as JsonObject | undefined;
    if (!entry) {
      errors.push(`app-lifecycle-vocabulary.yaml: missing consumer '${consumer}'`);
      continue;
    }
    if (entry.may_define_new_statuses !== false) {
      errors.push(`app-lifecycle-vocabulary.yaml: consumer '${consumer}' must not define new statuses`);
    }
    for (const status of (entry.may_emit_statuses as string[]) ?? []) {
      if (!allowedStatuses.has(status as (typeof EXPECTED_STATUSES)[number])) {
        errors.push(`app-lifecycle-vocabulary.yaml: consumer '${consumer}' emits unknown status '${status}'`);
      }
    }
    for (const verb of (entry.may_use_verbs as string[]) ?? []) {
      if (!allowedVerbs.has(verb as (typeof EXPECTED_VERBS)[number])) {
        errors.push(`app-lifecycle-vocabulary.yaml: consumer '${consumer}' uses unknown verb '${verb}'`);
      }
    }
  }

  const delegation = authority.docs_delegation as JsonObject | undefined;
  if (
    delegation?.document !== "references/cli/vocabulary.md" ||
    delegation?.required_anchor !== "App lifecycle status vocabulary" ||
    delegation?.authority_path !== "references/cli/app-lifecycle-vocabulary.yaml"
  ) {
    errors.push("app-lifecycle-vocabulary.yaml: docs_delegation contract drifted");
  }

  return errors;
}

function validateUpdateChannelsAuthority(root: string): string[] {
  const errors: string[] = [];
  const p = authorityPath(root, "references/cli/update-channels.yaml");
  let authority: JsonObject;
  try {
    authority = loadYamlMappingFile(p) as JsonObject; // cast: YAML parse IO boundary
  } catch (exc) {
    return [`update-channels.yaml: ${(exc as Error).message}`];
  }

  if (authority.default_channel !== "stable") {
    errors.push("update-channels.yaml: default_channel must be stable");
  }
  if (JSON.stringify(authority.channel_order) !== JSON.stringify([...EXPECTED_CHANNELS])) {
    errors.push("update-channels.yaml: channel_order drifted");
  }

  const stable = (authority.channels as JsonObject).stable as JsonObject | undefined;
  const development = (authority.channels as JsonObject).development as JsonObject | undefined;
  if (!stable || !development) {
    errors.push("update-channels.yaml: stable and development channels are required");
  } else {
    const stableNpm = (stable.resolution as JsonObject)?.npm as JsonObject | undefined;
    const devNpm = (development.resolution as JsonObject)?.npm as JsonObject | undefined;
    if (stableNpm?.dist_tag !== "latest" || devNpm?.dist_tag !== "next") {
      errors.push("update-channels.yaml: npm dist_tag pins drifted");
    }
    if (!String(stableNpm?.update_command ?? "").includes("@latest")) {
      errors.push("update-channels.yaml: stable npm update_command must reference @latest");
    }
    if (!String(devNpm?.update_command ?? "").includes("@next")) {
      errors.push("update-channels.yaml: development npm update_command must reference @next");
    }
    if ((development.resolution as JsonObject)?.git && (development.resolution as JsonObject).git) {
      const devGit = (development.resolution as JsonObject).git as JsonObject;
      if (devGit.supported !== false) {
        errors.push("update-channels.yaml: development git resolution must be unsupported");
      }
    }
  }

  if (!Array.isArray(authority.consumer_order)) {
    errors.push("update-channels.yaml: consumer_order is required");
  } else if (
    JSON.stringify(authority.consumer_order) !== JSON.stringify([...EXPECTED_CHANNEL_CONSUMERS])
  ) {
    errors.push("update-channels.yaml: consumer_order drifted");
  }

  const delegation = authority.docs_delegation as JsonObject | undefined;
  if (
    delegation?.document !== "references/cli/vocabulary.md" ||
    delegation?.required_anchor !== "Update channels" ||
    delegation?.authority_path !== "references/cli/update-channels.yaml"
  ) {
    errors.push("update-channels.yaml: docs_delegation contract drifted");
  }

  return errors;
}

function validateInstructionContract(root: string): string[] {
  const errors: string[] = [];
  const p = authorityPath(root, "references/cli/capability-instruction-contract.yaml");
  let authority: JsonObject;
  try {
    authority = loadYamlMappingFile(p) as JsonObject; // cast: YAML parse IO boundary
  } catch (exc) {
    return [`capability-instruction-contract.yaml: ${(exc as Error).message}`];
  }

  const firstRead = authority.first_invocation_read as JsonObject | undefined;
  if (!firstRead) {
    errors.push("capability-instruction-contract.yaml: first_invocation_read block is required");
    return errors;
  }

  const allowed = firstRead.allowed_values as JsonObject | undefined;
  if (!allowed || typeof allowed.prime_context !== "object") {
    errors.push("capability-instruction-contract.yaml: first_invocation_read.allowed_values.prime_context is required");
  } else {
    const meaning = String((allowed.prime_context as JsonObject).meaning ?? "");
    if (!meaning.includes("agentera prime --context")) {
      errors.push("capability-instruction-contract.yaml: prime_context obligation must reference agentera prime --context");
    }
  }

  if (firstRead.default_rule !== "prime_context") {
    errors.push("capability-instruction-contract.yaml: first_invocation_read.default_rule must be prime_context");
  }

  const cliMeta = (authority.current_state as JsonObject | undefined)?.cli_metadata as JsonObject | undefined;
  if (cliMeta?.field !== "first_invocation_read") {
    errors.push("capability-instruction-contract.yaml: cli_metadata.field must be first_invocation_read");
  }

  const delegation = authority.docs_delegation as JsonObject | undefined;
  if (
    delegation?.document !== "references/cli/vocabulary.md" ||
    delegation?.required_anchor !== "Capability instruction contract" ||
    delegation?.authority_path !== "references/cli/capability-instruction-contract.yaml"
  ) {
    errors.push("capability-instruction-contract.yaml: docs_delegation contract drifted");
  }

  return errors;
}

function validateVocabularyIndex(root: string): string[] {
  const errors: string[] = [];
  const p = authorityPath(root, "references/cli/vocabulary-index.yaml");
  let index: JsonObject;
  try {
    index = loadYamlMappingFile(p) as JsonObject; // cast: YAML parse IO boundary
  } catch (exc) {
    return [`vocabulary-index.yaml: ${(exc as Error).message}`];
  }

  const order = index.authority_order as string[] | undefined;
  if (!Array.isArray(order)) {
    return ["vocabulary-index.yaml: authority_order is required"];
  }

  const lifecycleIdx = order.indexOf("references/cli/app-lifecycle-vocabulary.yaml");
  const channelsIdx = order.indexOf("references/cli/update-channels.yaml");
  const bundleIdx = order.indexOf("references/cli/bundle-skill-vocabulary.yaml");
  if (lifecycleIdx < 0 || channelsIdx < 0 || bundleIdx < 0) {
    errors.push("vocabulary-index.yaml: authority_order missing required vocabulary authorities");
  } else if (!(lifecycleIdx < channelsIdx && channelsIdx < bundleIdx)) {
    errors.push("vocabulary-index.yaml: authority_order must place lifecycle before channels before bundle");
  }

  const vocabularyMd = authorityPath(root, "references/cli/vocabulary.md");
  if (!fs.existsSync(vocabularyMd)) {
    errors.push("references/cli/vocabulary.md: missing vocabulary prose delegation surface");
    return errors;
  }

  const vocabulary = fs.readFileSync(vocabularyMd, "utf8");
  const lifecycleSection =
    vocabulary.split("### App lifecycle status vocabulary")[1]?.split("### Update channels", 1)[0] ?? "";
  if (
    !lifecycleSection.includes("references/cli/app-lifecycle-vocabulary.yaml") ||
    !lifecycleSection.includes("machine-readable authority")
  ) {
    errors.push("references/cli/vocabulary.md: app lifecycle section must delegate to YAML authority");
  }

  const channelsSection =
    vocabulary.split("### Update channels")[1]?.split("### Bundle and SKILL.md vocabulary", 1)[0] ?? "";
  if (
    !channelsSection.includes("references/cli/update-channels.yaml") ||
    !channelsSection.includes("machine-readable authority")
  ) {
    errors.push("references/cli/vocabulary.md: update channels section must delegate to YAML authority");
  }

  return errors;
}

export function validateVocabularyAuthority(root: string = rootDefault()): string[] {
  const resolved = resolvePath(root);
  return [
    ...validateLifecycleAuthority(resolved),
    ...validateUpdateChannelsAuthority(resolved),
    ...validateInstructionContract(resolved),
    ...validateVocabularyIndex(resolved),
  ];
}

export interface VocabularyAuthorityMainOptions {
  root?: string;
  out?: (line: string) => void;
}

export function vocabularyAuthorityMain(opts: VocabularyAuthorityMainOptions = {}): number {
  const root = resolvePath(opts.root ?? rootDefault());
  const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const errors = validateVocabularyAuthority(root);
  if (errors.length > 0) {
    out("vocabulary authority validation failed:");
    for (const error of errors) out(`- ${error}`);
    return 1;
  }
  out("vocabulary authority ok");
  return 0;
}
