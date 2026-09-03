import fs from "node:fs";
import path from "node:path";

import type { JsonObject } from "../core/jsonValue.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadYamlMapping } from "../core/yaml.js";
import { loadRegistry } from "../registries/packageRegistry.js";
import { NATIVE_RESOURCE_CLEANUP_CONTRACT_RELATIVE_PATH } from "../runtime/lifecycleAuthority.js";

export const PRODUCT_V1_RESET_AUTHORITY_RELATIVE_PATH = "references/adapters/product-v1-reset.yaml";

const PACKAGE_REGISTRY_RELATIVE_PATH = "references/adapters/package-registry.yaml";
const RUNTIME_LIFECYCLE_RELATIVE_PATH = "references/adapters/runtime-lifecycle-authority.yaml";
const ALLOWED_ROOTS = new Set(["project", "profile_root", "install_root", "runtime_declared_roots"]);

export interface ProductV1ProjectArtifactEvidence {
  id: string;
  generation: "product_v1";
  triggersReset: boolean;
  path: string;
  currentPath: string;
}

export interface ProductV1ResetScopeEntry {
  id: string;
  action: "delete" | "recreate";
  owner: string;
  boundedRoot: "project" | "profile_root" | "install_root" | "runtime_declared_roots";
  targets: string[];
}

export interface ProductV1ResetAuthority {
  sourcePath: string;
  projectArtifacts: ProductV1ProjectArtifactEvidence[];
  installationPackage: {
    manifest: string;
    selector: string;
    predicate: "semver_major_equals_1";
  };
  scope: ProductV1ResetScopeEntry[];
}

function mapping(value: unknown, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a mapping`);
  }
  return value as JsonObject;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function textList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty string list`);
  return value.map((item, index) => text(item, `${field}[${index}]`));
}

function relativePath(value: unknown, field: string): string {
  const result = text(value, field);
  if (path.isAbsolute(result) || result.split("/").includes("..")) {
    throw new Error(`${field} must stay within its declared root`);
  }
  return result;
}

export function loadProductV1ResetAuthority(authorityPath = path.join(resolveSourceRoot(), PRODUCT_V1_RESET_AUTHORITY_RELATIVE_PATH), sourceRoot = resolveSourceRoot()): ProductV1ResetAuthority {
  const data = loadYamlMapping(fs.readFileSync(authorityPath, "utf8"));
  if (data.schema_version !== "agentera.productV1ResetInventory.v1") {
    throw new Error("product v1 reset authority has unsupported schema_version");
  }

  const policy = mapping(data.policy, "policy");
  if (policy.trigger !== "any_declared_product_v1_generation_evidence" || policy.schema_identifier_suffix_is_evidence !== false || policy.discovery !== "declared_roots_only" || policy.preserve_unlisted_state !== true) {
    throw new Error("product v1 reset authority policy must require bounded product-generation evidence");
  }

  const sources = mapping(data.source_authorities, "source_authorities");
  if (sources.retired_resources !== NATIVE_RESOURCE_CLEANUP_CONTRACT_RELATIVE_PATH || sources.package_inventory !== PACKAGE_REGISTRY_RELATIVE_PATH || sources.runtime_lifecycle !== RUNTIME_LIFECYCLE_RELATIVE_PATH) {
    throw new Error("product v1 reset authority must reference the existing runtime and package authorities");
  }
  for (const authority of Object.values(sources)) {
    if (typeof authority !== "string" || !fs.existsSync(path.join(sourceRoot, authority))) {
      throw new Error(`product v1 reset source authority does not exist: ${String(authority)}`);
    }
  }

  const triggers = mapping(data.trigger_evidence, "trigger_evidence");
  if (!Array.isArray(triggers.project_artifacts) || triggers.project_artifacts.length === 0) {
    throw new Error("trigger_evidence.project_artifacts must be non-empty");
  }
  const projectArtifacts = triggers.project_artifacts.map((value, index) => {
    const item = mapping(value, `trigger_evidence.project_artifacts[${index}]`);
    if (item.generation !== "product_v1") {
      throw new Error(`trigger_evidence.project_artifacts[${index}].generation must be product_v1`);
    }
    if (typeof item.triggers_reset !== "boolean") {
      throw new Error(`trigger_evidence.project_artifacts[${index}].triggers_reset must be boolean`);
    }
    return {
      id: text(item.id, `trigger_evidence.project_artifacts[${index}].id`),
      generation: "product_v1" as const,
      triggersReset: item.triggers_reset === true,
      path: relativePath(item.path, `trigger_evidence.project_artifacts[${index}].path`),
      currentPath: relativePath(item.current_path, `trigger_evidence.project_artifacts[${index}].current_path`),
    };
  });

  const packageTrigger = mapping(triggers.installation_package, "trigger_evidence.installation_package");
  const packageRecord = loadRegistry(path.join(sourceRoot, PACKAGE_REGISTRY_RELATIVE_PATH), sourceRoot).get("agentera");
  if (
    packageTrigger.generation !== "product_v1" ||
    packageTrigger.triggers_reset !== true ||
    packageTrigger.authority !== PACKAGE_REGISTRY_RELATIVE_PATH ||
    packageTrigger.manifest !== packageRecord.version_authority.persisted_authority ||
    packageTrigger.selector !== packageRecord.version_authority.selector ||
    packageTrigger.predicate !== "semver_major_equals_1"
  ) {
    throw new Error("installation package trigger must use the package inventory's version authority and product-v1 major");
  }

  const runtimeTrigger = mapping(triggers.runtime_resources, "trigger_evidence.runtime_resources");
  if (runtimeTrigger.authority !== NATIVE_RESOURCE_CLEANUP_CONTRACT_RELATIVE_PATH || runtimeTrigger.role !== "reset_scope_only") {
    throw new Error("retired runtime identities must remain reset scope, not product-v1 trigger evidence");
  }

  if (!Array.isArray(data.scope_inventory) || data.scope_inventory.length === 0) {
    throw new Error("scope_inventory must be non-empty");
  }
  const ids = new Set<string>();
  const scope = data.scope_inventory.map((value, index) => {
    const item = mapping(value, `scope_inventory[${index}]`);
    const id = text(item.id, `scope_inventory[${index}].id`);
    const owner = text(item.owner, `scope_inventory[${index}].owner`);
    const action = item.action;
    const boundedRoot = item.bounded_root;
    if (ids.has(id)) throw new Error(`scope_inventory has duplicate id: ${id}`);
    if (action !== "delete" && action !== "recreate") throw new Error(`scope_inventory[${index}].action is invalid`);
    if (typeof boundedRoot !== "string" || !ALLOWED_ROOTS.has(boundedRoot)) {
      throw new Error(`scope_inventory[${index}].bounded_root is invalid`);
    }
    ids.add(id);
    return {
      id,
      action: action as ProductV1ResetScopeEntry["action"],
      owner,
      boundedRoot: boundedRoot as ProductV1ResetScopeEntry["boundedRoot"],
      targets: textList(item.targets, `scope_inventory[${index}].targets`).map((target, targetIndex) => relativePath(target, `scope_inventory[${index}].targets[${targetIndex}]`)),
    };
  });

  return {
    sourcePath: authorityPath,
    projectArtifacts,
    installationPackage: {
      manifest: packageTrigger.manifest as string,
      selector: packageTrigger.selector as string,
      predicate: "semver_major_equals_1",
    },
    scope,
  };
}

export function productV1ArtifactPairs(): ReadonlyArray<readonly [string, string]> {
  return loadProductV1ResetAuthority().projectArtifacts.map(({ path: legacyPath, currentPath }) => [legacyPath, currentPath] as const);
}

export function productV1ProjectTriggerPaths(): readonly string[] {
  return loadProductV1ResetAuthority()
    .projectArtifacts.filter(({ triggersReset }) => triggersReset)
    .map(({ path: legacyPath }) => legacyPath);
}

export function isProductV1PackageVersion(version: string): boolean {
  return /^1\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}
