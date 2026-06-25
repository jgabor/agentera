import fs from "node:fs";
import path from "node:path";

import type { JsonObject, JsonValue } from "../../core/jsonValue.js";
import { resolvePath } from "../../core/paths.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import {
  PackageRegistry,
  loadRegistry as loadPackageRegistry,
} from "../../registries/packageRegistry.js";
import { RuntimeAdapterRegistry } from "../../registries/runtimeAdapterRegistry.js";

export type Dict = JsonObject;

export const REGISTRY_CONTRACT_ERROR_PREFIX = "registry contract error";

export const CODEX_PROFILE_TERMS = [
  "allow_implicit_invocation: false",
  "codex_session_corpus",
  "bounded Codex history, session, or config corpus data",
];

export const CODEX_AGENTERA_METADATA_TERMS = ["$agentera", "bounded Codex session corpus data", "AGENTERA_HOME"];

export const CODEX_PROFILE_STATUS_VALUES = ["ok", "degraded"];

export const HARD_GATE_DOC_REQUIREMENTS: Record<string, string[]> = {
  "references/adapters/runtime-feature-parity.md": ["opencode", "copilot", "cursor"],
  "references/adapters/opencode.md": ["opencode"],
};

export function rootDefault(): string {
  return resolveSourceRoot();
}

function packageRegistryPath(root: string): string {
  return path.join(root, "references/adapters/package-registry.yaml");
}

export function isMapping(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function objectField(obj: JsonObject, key: string): JsonObject {
  const value = obj[key];
  return isMapping(value) ? value : {};
}

export function stringArrayField(obj: JsonObject, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

export function stringField(obj: JsonObject, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : "";
}

export function loadJson(p: string): Dict {
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!isMapping(data)) {
    throw new Error(`${p}: expected JSON object`);
  }
  return data;
}

export function registryContractError(exc: Error): string {
  return `${REGISTRY_CONTRACT_ERROR_PREFIX}: ${exc.message}`;
}

export function runtimeView(registry: RuntimeAdapterRegistry, runtime: string): Dict {
  return registry.consumerView("lifecycle", runtime);
}

export function packageManifest(root: string): PackageRegistry {
  const registryPath = packageRegistryPath(root);
  if (fs.existsSync(registryPath) && fs.statSync(registryPath).isFile()) {
    return loadPackageRegistry(registryPath, root);
  }
  return loadPackageRegistry(packageRegistryPath(rootDefault()), rootDefault());
}

export function supportedEvents(registry: RuntimeAdapterRegistry, runtime: string): Set<string> {
  const lifecycleEvents = objectField(runtimeView(registry, runtime), "lifecycle_events");
  return new Set(stringArrayField(lifecycleEvents, "supported_events"));
}

export function unsupportedEvents(registry: RuntimeAdapterRegistry, runtime: string): Set<string> {
  const lifecycleEvents = objectField(runtimeView(registry, runtime), "lifecycle_events");
  return new Set(stringArrayField(lifecycleEvents, "unsupported_events"));
}

export function opencodeEventPayloadTypes(registry: RuntimeAdapterRegistry): Set<string> {
  const lifecycleEvents = objectField(runtimeView(registry, "opencode"), "lifecycle_events");
  const eventStatus = objectField(lifecycleEvents, "event_status");
  const out = new Set<string>();
  for (const [event, status] of Object.entries(eventStatus)) {
    if (status === "supported_via_event") out.add(event);
  }
  return out;
}

export function validationEvents(registry: RuntimeAdapterRegistry, runtime: string): string[] {
  const artifactValidation = objectField(runtimeView(registry, runtime), "artifact_validation");
  return stringArrayField(artifactValidation, "validation_events");
}

function claimTerms(text: string, candidates: string[]): string[] {
  const normalized = text.toLowerCase();
  return candidates.filter((term) => normalized.includes(term.toLowerCase()));
}

export function copilotProfileTerms(registry: RuntimeAdapterRegistry): string[] {
  const view = runtimeView(registry, "copilot");
  const lifecycleEvents = objectField(view, "lifecycle_events");
  const documentationClaims = objectField(view, "documentation_claims");
  const text = [
    ...stringArrayField(lifecycleEvents, "limitations"),
    ...stringArrayField(documentationClaims, "parity_claims"),
  ].join(" ");
  return claimTerms(text, ["profile", "bounded", "corpus", "metadata", "missing source families"]);
}

export function codexLifecycleStatusValues(registry: RuntimeAdapterRegistry): string[] {
  const lifecycleEvents = objectField(runtimeView(registry, "codex"), "lifecycle_events");
  const eventStatus = objectField(lifecycleEvents, "event_status");
  const statuses = ["stable"];
  for (const event of stringArrayField(lifecycleEvents, "supported_events")) {
    const status = eventStatus[event];
    if (typeof status === "string" && status !== "unsupported" && !statuses.includes(status)) {
      statuses.push(status);
    }
  }
  return statuses;
}

export function codexLimitationTerms(registry: RuntimeAdapterRegistry): string[] {
  const view = runtimeView(registry, "codex");
  const lifecycleEvents = objectField(view, "lifecycle_events");
  const artifactValidation = objectField(view, "artifact_validation");
  const text = [
    ...stringArrayField(lifecycleEvents, "limitations"),
    ...stringArrayField(artifactValidation, "hard_gate_claims"),
  ].join(" ");
  return claimTerms(text, ["codex_hooks", "apply_patch", "openai/codex#18391"]);
}

export function hardGateDocTerms(registry: RuntimeAdapterRegistry, runtime: string, relativePath: string): string[] {
  const view = runtimeView(registry, runtime);
  const artifact = objectField(view, "artifact_validation");
  const documentationClaims = objectField(view, "documentation_claims");
  const primary =
    relativePath === "references/adapters/opencode.md"
      ? stringArrayField(documentationClaims, "parity_claims")
      : stringArrayField(artifact, "hard_gate_claims");
  return [...primary, ...stringArrayField(artifact, "payload_reconstruction_limitations")];
}

export function validateCommandHandler(errors: string[], runtime: string, event: string, index: number, handler: unknown): void {
  const prefix = `${runtime}.${event}[${index}]`;
  if (!isMapping(handler)) {
    errors.push(`${prefix}: handler must be an object`);
    return;
  }
  if (handler.type !== "command") {
    errors.push(`${prefix}: handler type must be 'command'`);
  }
  if ("command" in handler) {
    errors.push(`${prefix}: use bash/powershell, not Claude-style command`);
  }
  if (!handler.bash && !handler.powershell) {
    errors.push(`${prefix}: handler must define bash or powershell`);
  }
  const timeout = handler.timeoutSec;
  if (timeout !== null && timeout !== undefined && !(typeof timeout === "number" && Number.isInteger(timeout))) {
    errors.push(`${prefix}: timeoutSec must be an integer`);
  }
}

export function handlerCommandText(handler: unknown): string {
  if (!isMapping(handler)) return "";
  return [handler.bash, handler.powershell].filter((p) => typeof p === "string").join(" ");
}

export function stringPaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((p) => typeof p === "string")) return value;
  return [];
}

export function resolveInside(root: string, p: string): string | null {
  const resolved = resolvePath(path.join(root, p));
  const rel = path.relative(resolvePath(root), resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return null;
  return resolved;
}

export function resolveFromManifest(root: string, manifest: string, p: string): string | null {
  const resolved = resolvePath(path.join(path.dirname(manifest), p));
  const rel = path.relative(resolvePath(root), resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return null;
  return resolved;
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
