import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { JsonObject } from "../../src/core/jsonValue.js";
import { loadYamlMappingFile } from "../../src/core/yaml.js";
import {
  APP_MANUAL_REVIEW_NEEDED,
  APP_MIGRATION_NEEDED,
  APP_OUTDATED,
  APP_REPAIR_NEEDED,
  APP_UP_TO_DATE,
} from "../../src/upgrade/doctor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../..");

const LIFECYCLE_AUTHORITY = path.join(REPO_ROOT, "references/cli/app-lifecycle-vocabulary.yaml");
const UPDATE_CHANNELS_AUTHORITY = path.join(REPO_ROOT, "references/cli/update-channels.yaml");
const VOCABULARY_INDEX = path.join(REPO_ROOT, "references/cli/vocabulary-index.yaml");
const VOCABULARY_MD = path.join(REPO_ROOT, "references/cli/vocabulary.md");

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

function lifecycleAuthority(): JsonObject {
  return loadYamlMappingFile(LIFECYCLE_AUTHORITY) as JsonObject; // cast: YAML parse IO boundary
}

function updateChannelsAuthority(): JsonObject {
  return loadYamlMappingFile(UPDATE_CHANNELS_AUTHORITY) as JsonObject; // cast: YAML parse IO boundary
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

describe("app lifecycle vocabulary authority", () => {
  it("keeps canonical statuses ordered and defined", () => {
    const authority = lifecycleAuthority();
    expect(authority.canonical_status_order).toEqual([...EXPECTED_STATUSES]);
    expect(Object.keys(authority.canonical_statuses as JsonObject)).toEqual([...EXPECTED_STATUSES]);
    for (const status of EXPECTED_STATUSES) {
      const entry = (authority.canonical_statuses as JsonObject)[status] as JsonObject;
      expect(String(entry.concept).trim()).not.toBe("");
      expect(String(entry.definition).trim()).not.toBe("");
      expect(Array.isArray(entry.deprecated_aliases)).toBe(true);
    }
  });

  it("maps deprecated app status aliases to canonical statuses", () => {
    const authority = lifecycleAuthority();
    const aliasToStatus = new Map<string, string>();
    for (const [status, raw] of Object.entries(authority.canonical_statuses as JsonObject)) {
      for (const alias of (raw as JsonObject).deprecated_aliases as string[]) {
        aliasToStatus.set(alias, status);
      }
    }
    expect(aliasToStatus.get("fresh")).toBe("up_to_date");
    expect(aliasToStatus.get("stale")).toBe("outdated");
    expect(aliasToStatus.get("refresh_required")).toBe("repair_needed");
    expect(aliasToStatus.get("fixed")).toBe("applied");
    expect(aliasToStatus.get("noop")).toBe("no_changes_needed");
    expect([...aliasToStatus.keys()].some((alias) => EXPECTED_STATUSES.includes(alias as (typeof EXPECTED_STATUSES)[number]))).toBe(
      false,
    );
  });

  it("defines major_boundary_crossing without adding a canonical status", () => {
    const authority = lifecycleAuthority();
    expect(authority.status_concept_order).toEqual(["major_boundary_crossing"]);
    const concept = (authority.status_concepts as JsonObject).major_boundary_crossing as JsonObject;
    expect(String(concept.definition)).toContain("v2→v3");
    expect((concept.requires_forward_major_confirmation as JsonObject).mechanism).toBe(
      "semver_compare_running_to_latest_on_selected_channel",
    );
    expect(concept.irreversible_exit_lines).toEqual(["v2_python_managed_app_home"]);
    expect(concept.item_tag).toBe("requires_explicit_major_opt_in");
    expect(concept.never_implicit_on_channels).toEqual(["stable"]);
    expect(canonicalStatuses(authority)).toEqual(new Set(EXPECTED_STATUSES));
  });

  it("scopes update verb as channel-aware", () => {
    const authority = lifecycleAuthority();
    const update = (authority.operation_verbs as JsonObject).update as JsonObject;
    expect(update.channel_aware).toBe(true);
    expect(String(update.scope)).toContain("update channel");
    expect(String(update.scope)).toContain("major_boundary_crossing");
    expect(update.authority_cross_ref).toBe("references/cli/update-channels.yaml");
  });

  it("keeps consumer ownership boundaries explicit and closed", () => {
    const authority = lifecycleAuthority();
    expect(authority.consumer_order).toEqual([...EXPECTED_LIFECYCLE_CONSUMERS]);
    expect(Object.keys(authority.consumers as JsonObject)).toEqual([...EXPECTED_LIFECYCLE_CONSUMERS]);
    const allowedStatuses = new Set(EXPECTED_STATUSES);
    const allowedVerbs = new Set(EXPECTED_VERBS);
    for (const consumer of EXPECTED_LIFECYCLE_CONSUMERS) {
      const entry = (authority.consumers as JsonObject)[consumer] as JsonObject;
      expect(entry.owns).toBeTruthy();
      expect(entry.may_define_new_statuses).toBe(false);
      for (const status of entry.may_emit_statuses as string[]) {
        expect(allowedStatuses.has(status)).toBe(true);
      }
      for (const verb of entry.may_use_verbs as string[]) {
        expect(allowedVerbs.has(verb)).toBe(true);
      }
    }
  });

  it("declares docs delegation contract", () => {
    expect(lifecycleAuthority().docs_delegation).toEqual({
      document: "references/cli/vocabulary.md",
      required_anchor: "App lifecycle status vocabulary",
      authority_path: "references/cli/app-lifecycle-vocabulary.yaml",
      must_not_duplicate_large_table: true,
    });
  });

  it("keeps doctor constants within canonical statuses and consumer allow-list", () => {
    const authority = lifecycleAuthority();
    const doctorAllowed = new Set(
      ((authority.consumers as JsonObject).doctor as JsonObject).may_emit_statuses as string[],
    );
    const observed = [APP_UP_TO_DATE, APP_OUTDATED, APP_REPAIR_NEEDED, APP_MIGRATION_NEEDED, APP_MANUAL_REVIEW_NEEDED];
    for (const status of observed) {
      expect(canonicalStatuses(authority).has(status)).toBe(true);
      expect(doctorAllowed.has(status)).toBe(true);
      expect(rejectedLifecycleStatusValues(authority).has(status)).toBe(false);
    }
  });
});

describe("update channels vocabulary authority", () => {
  it("defines stable and development channels with dist-tag and git resolution", () => {
    const authority = updateChannelsAuthority();
    expect(authority.default_channel).toBe("stable");
    expect(authority.channel_order).toEqual([...EXPECTED_CHANNELS]);
    expect(Object.keys(authority.channels as JsonObject)).toEqual([...EXPECTED_CHANNELS]);

    const stable = (authority.channels as JsonObject).stable as JsonObject;
    const development = (authority.channels as JsonObject).development as JsonObject;
    expect(stable.distribution_major).toBe(2);
    expect(development.distribution_major).toBe(3);

    const stableNpm = (stable.resolution as JsonObject).npm as JsonObject;
    const stableGit = (stable.resolution as JsonObject).git as JsonObject;
    const devNpm = (development.resolution as JsonObject).npm as JsonObject;
    const devGit = (development.resolution as JsonObject).git as JsonObject;

    expect(stableNpm.dist_tag).toBe("latest");
    expect(stableGit.ref).toBe("main");
    expect(String(stableNpm.update_command)).toContain("@latest");
    expect(String(stableGit.update_command)).toContain("@main");

    expect(devNpm.dist_tag).toBe("next");
    expect(String(devNpm.update_command)).toContain("@next");
    expect(devGit.supported).toBe(false);
    expect(devGit.update_command).toBeUndefined();
  });

  it("declares per-channel next_major successor metadata", () => {
    const authority = updateChannelsAuthority();
    const stable = (authority.channels as JsonObject).stable as JsonObject;
    const development = (authority.channels as JsonObject).development as JsonObject;
    const stableNext = stable.next_major as JsonObject;
    expect(stableNext.concept).toBe("forward_successor_line");
    expect(stableNext.channel).toBe("development");
    expect(stableNext.version).toBe("3.0.0");
    expect(stableNext.announced).toBe(true);
    expect((stableNext.npm as JsonObject).dist_tag).toBe("next");
    expect(String(stableNext.preview_command)).toContain("@next");
    const devNext = development.next_major as JsonObject;
    expect(devNext.concept).toBe("forward_successor_line");
    expect(devNext.channel).toBe("development");
    expect(devNext.version).toBe("3.0.0");
    expect(devNext.announced).toBe(true);
    expect((devNext.npm as JsonObject).dist_tag).toBe("next");
    expect(String(devNext.preview_command)).toContain("@next");
  });

  it("declares env, config, and CLI override keys", () => {
    const authority = updateChannelsAuthority();
    expect(authority.override_precedence).toEqual(["cli_flag", "env_var", "config_file", "default"]);
    const keys = authority.override_keys as JsonObject;
    expect((keys.cli as JsonObject).flag).toBe("--channel");
    expect((keys.env as JsonObject).name).toBe("AGENTERA_UPDATE_CHANNEL");
    expect((keys.config as JsonObject).key).toBe("update.channel");
    for (const surface of ["cli", "env", "config"]) {
      expect((keys[surface] as JsonObject).values).toEqual([...EXPECTED_CHANNELS]);
    }
  });

  it("keeps channel consumer boundaries explicit", () => {
    const authority = updateChannelsAuthority();
    expect(authority.consumer_order).toEqual([...EXPECTED_CHANNEL_CONSUMERS]);
    for (const consumer of EXPECTED_CHANNEL_CONSUMERS) {
      expect(((authority.consumers as JsonObject)[consumer] as JsonObject).may_resolve_channels).toEqual([...EXPECTED_CHANNELS]);
    }
  });

  it("defines version resolution and irreversibility rules", () => {
    const authority = updateChannelsAuthority();
    const vr = authority.version_resolution as JsonObject;
    expect(vr.forward_major_gate).toBeTruthy();
    expect((vr.irreversibility as JsonObject).downgrade_to_v2).toBe("permanently_blocked");
  });

  it("declares docs delegation contract", () => {
    expect(updateChannelsAuthority().docs_delegation).toEqual({
      document: "references/cli/vocabulary.md",
      required_anchor: "Update channels",
      authority_path: "references/cli/update-channels.yaml",
      must_not_duplicate_large_table: true,
    });
  });
});

describe("vocabulary index and docs sync", () => {
  it("includes update-channels.yaml in authority order", () => {
    const order = loadYamlMappingFile(VOCABULARY_INDEX).authority_order as string[];
    const lifecycleIdx = order.indexOf("references/cli/app-lifecycle-vocabulary.yaml");
    const channelsIdx = order.indexOf("references/cli/update-channels.yaml");
    const bundleIdx = order.indexOf("references/cli/bundle-skill-vocabulary.yaml");
    expect(lifecycleIdx).toBeGreaterThanOrEqual(0);
    expect(channelsIdx).toBeGreaterThan(lifecycleIdx);
    expect(bundleIdx).toBeGreaterThan(channelsIdx);
  });

  it("delegates update channels prose to the YAML authority", () => {
    const vocabulary = fs.readFileSync(VOCABULARY_MD, "utf8");
    const section = vocabulary.split("### Update channels")[1]?.split("### Bundle and SKILL.md vocabulary", 1)[0] ?? "";
    expect(section).toContain("references/cli/update-channels.yaml");
    expect(section).toContain("machine-readable authority");
    expect(section).not.toMatch(/\| Channel \| Dist tag \|/);
  });

  it("delegates app lifecycle prose to the YAML authority", () => {
    const vocabulary = fs.readFileSync(VOCABULARY_MD, "utf8");
    const section = vocabulary.split("### App lifecycle status vocabulary")[1]?.split("### Update channels", 1)[0] ?? "";
    expect(section).toContain("references/cli/app-lifecycle-vocabulary.yaml");
    expect(section).toContain("machine-readable authority");
    expect(section).not.toContain("| Concept | Canonical status |");
  });
});
