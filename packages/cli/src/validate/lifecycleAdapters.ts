import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { resolvePath } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import {
  PackageRegistry,
  loadRegistry as loadPackageRegistry,
} from "../registries/packageRegistry.js";
import {
  RegistryError,
  RuntimeAdapterRegistry,
  loadRegistry as loadRuntimeRegistry,
} from "../registries/runtimeAdapterRegistry.js";

/**
 * Validate runtime lifecycle hook adapter metadata. Faithful TS port of
 * scripts/validate_lifecycle_adapters.py.
 *
 * NOTE: validates the CURRENT (Python-form) runtime manifests for parity. The
 * node-form hook command rewiring + removal of validate_packaged_python_scripts/
 * validate_uv_runtime happens in the Phase 9 cutover.
 */

type Dict = Record<string, any>;

const REGISTRY_CONTRACT_ERROR_PREFIX = "registry contract error";
const CODEX_PROFILERA_TERMS = [
  "allow_implicit_invocation: false",
  "codex_session_corpus",
  "bounded Codex history, session, or config corpus data",
];
const CODEX_AGENTERA_METADATA_TERMS = ["$agentera", "bounded Codex session corpus data", "AGENTERA_HOME"];
const CODEX_PROFILERA_STATUS_VALUES = ["ok", "degraded"];
const UV_SCRIPT_SHEBANG = "#!/usr/bin/env -S uv run --script";
const UV_INSTALL_GUIDANCE =
  "uv is required to run packaged Agentera Python scripts; install it from " +
  "https://docs.astral.sh/uv/getting-started/installation/ and then rerun the check";
const HARD_GATE_DOC_REQUIREMENTS: Record<string, string[]> = {
  "references/adapters/runtime-feature-parity.md": ["opencode", "copilot", "cursor"],
  "references/adapters/opencode.md": ["opencode"],
};

function rootDefault(): string {
  return resolveSourceRoot();
}

function packageRegistryPath(root: string): string {
  return path.join(root, "references/adapters/package-registry.yaml");
}

function isMapping(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function loadJson(p: string): Dict {
  const data = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!isMapping(data)) {
    throw new Error(`${p}: expected JSON object`);
  }
  return data;
}

function registryContractError(exc: Error): string {
  return `${REGISTRY_CONTRACT_ERROR_PREFIX}: ${exc.message}`;
}

function runtimeView(registry: RuntimeAdapterRegistry, runtime: string): Dict {
  return registry.consumerView("lifecycle", runtime);
}

function packageManifest(root: string): PackageRegistry {
  const registryPath = packageRegistryPath(root);
  if (fs.existsSync(registryPath) && fs.statSync(registryPath).isFile()) {
    return loadPackageRegistry(registryPath, root);
  }
  return loadPackageRegistry(packageRegistryPath(rootDefault()), rootDefault());
}

function supportedEvents(registry: RuntimeAdapterRegistry, runtime: string): Set<string> {
  return new Set(runtimeView(registry, runtime).lifecycle_events.supported_events);
}

function unsupportedEvents(registry: RuntimeAdapterRegistry, runtime: string): Set<string> {
  return new Set(runtimeView(registry, runtime).lifecycle_events.unsupported_events);
}

function opencodeEventPayloadTypes(registry: RuntimeAdapterRegistry): Set<string> {
  const eventStatus = runtimeView(registry, "opencode").lifecycle_events.event_status;
  const out = new Set<string>();
  for (const [event, status] of Object.entries(eventStatus)) {
    if (status === "supported_via_event") out.add(event);
  }
  return out;
}

function validationEvents(registry: RuntimeAdapterRegistry, runtime: string): string[] {
  return runtimeView(registry, runtime).artifact_validation.validation_events;
}

function claimTerms(text: string, candidates: string[]): string[] {
  const normalized = text.toLowerCase();
  return candidates.filter((term) => normalized.includes(term.toLowerCase()));
}

function copilotProfileraTerms(registry: RuntimeAdapterRegistry): string[] {
  const view = runtimeView(registry, "copilot");
  const text = [...view.lifecycle_events.limitations, ...view.documentation_claims.parity_claims].join(" ");
  return claimTerms(text, ["profilera", "bounded", "corpus", "metadata", "missing source families"]);
}

function codexLifecycleStatusValues(registry: RuntimeAdapterRegistry): string[] {
  const eventStatus = runtimeView(registry, "codex").lifecycle_events.event_status;
  const statuses = ["stable"];
  for (const event of runtimeView(registry, "codex").lifecycle_events.supported_events) {
    const status = eventStatus[event];
    if (typeof status === "string" && status !== "unsupported" && !statuses.includes(status)) {
      statuses.push(status);
    }
  }
  return statuses;
}

function codexLimitationTerms(registry: RuntimeAdapterRegistry): string[] {
  const view = runtimeView(registry, "codex");
  const text = [...view.lifecycle_events.limitations, ...view.artifact_validation.hard_gate_claims].join(" ");
  return claimTerms(text, ["codex_hooks", "apply_patch", "openai/codex#18391"]);
}

function hardGateDocTerms(registry: RuntimeAdapterRegistry, runtime: string, relativePath: string): string[] {
  const view = runtimeView(registry, runtime);
  const artifact = view.artifact_validation;
  const primary =
    relativePath === "references/adapters/opencode.md" ? view.documentation_claims.parity_claims : artifact.hard_gate_claims;
  return [...primary, ...artifact.payload_reconstruction_limitations];
}

function validateCommandHandler(errors: string[], runtime: string, event: string, index: number, handler: unknown): void {
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

function handlerCommandText(handler: unknown): string {
  if (!isMapping(handler)) return "";
  return [handler.bash, handler.powershell].filter((p) => typeof p === "string").join(" ");
}

function stringPaths(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((p) => typeof p === "string")) return value;
  return [];
}

function resolveInside(root: string, p: string): string | null {
  const resolved = resolvePath(path.join(root, p));
  const rel = path.relative(resolvePath(root), resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return null;
  return resolved;
}

function resolveFromManifest(root: string, manifest: string, p: string): string | null {
  const resolved = resolvePath(path.join(path.dirname(manifest), p));
  const rel = path.relative(resolvePath(root), resolved);
  if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) return null;
  return resolved;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isPackagedPythonScript(p: string): boolean {
  if (!isFile(p)) return false;
  const suffix = path.extname(p);
  if (suffix === ".py") return true;
  if (suffix) return false;
  const firstLine = fs.readFileSync(p, "utf8").split(/\r\n|\r|\n/)[0] ?? "";
  return Boolean(firstLine) && (firstLine.includes("python") || firstLine.includes("uv run --script"));
}

function packagedPythonScripts(root: string): string[] {
  const paths: string[] = [];
  for (const directory of ["scripts", "hooks"]) {
    const scriptRoot = path.join(root, directory);
    if (!isDir(scriptRoot)) continue;
    for (const name of fs.readdirSync(scriptRoot)) {
      const p = path.join(scriptRoot, name);
      if (isPackagedPythonScript(p)) paths.push(p);
    }
  }
  return paths.sort();
}

function extractInlineScriptMetadata(text: string): string[] | null {
  const lines = text.split(/\r\n|\r|\n/);
  const start = lines.indexOf("# /// script");
  if (start === -1) return null;
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index] === "# ///") {
      return lines.slice(start + 1, index);
    }
  }
  return null;
}

function metadataDeclaresRequiresPython(metadata: string[]): boolean {
  return metadata.some((line) => line.trim().startsWith("# requires-python = "));
}

function metadataDeclaresDependencies(metadata: string[]): boolean {
  return metadata.some((line) => line.trim().startsWith("# dependencies = ["));
}

export function validatePackagedPythonScripts(root: string): string[] {
  const errors: string[] = [];
  for (const p of packagedPythonScripts(root)) {
    const relative = path.relative(root, p);
    const text = fs.readFileSync(p, "utf8");
    const lines = text.split(/\r\n|\r|\n/);
    const firstLine = lines.length > 0 ? lines[0] : "";
    if (firstLine !== UV_SCRIPT_SHEBANG) {
      errors.push(`${relative}: packaged Python script must use uv script shebang`);
    }
    const metadata = extractInlineScriptMetadata(text);
    if (metadata === null) {
      errors.push(`${relative}: packaged Python script must declare inline script metadata`);
      continue;
    }
    if (!metadataDeclaresRequiresPython(metadata)) {
      errors.push(`${relative}: packaged Python script must declare requires-python`);
    }
    if (!metadataDeclaresDependencies(metadata)) {
      errors.push(`${relative}: packaged Python script must declare dependencies`);
    }
  }
  return errors;
}

export function validateUvRuntime(): string[] {
  const result = spawnSync(process.platform === "win32" ? "where" : "which", ["uv"], { encoding: "utf8" });
  if (result.status !== 0) return [UV_INSTALL_GUIDANCE];
  return [];
}

export function validateSuiteBundleSurface(
  root: string,
  runtimeNames: Set<string> | null = null,
  packageRegistry: PackageRegistry | null = null,
): string[] {
  const errors: string[] = [];
  const pkg = packageRegistry ?? packageManifest(root);
  const runtimePackageSurfaces = pkg.runtimeManifestPaths();
  const requiredPaths = pkg.sharedPathRequirements();
  const packageShapes = pkg.runtimePackageShapes();
  const active = runtimeNames ?? new Set(Object.keys(runtimePackageSurfaces));

  for (const runtime of [...active].sort()) {
    const relativeManifest = runtimePackageSurfaces[runtime];
    if (relativeManifest === undefined) {
      errors.push(`${runtime}: unknown runtime package surface`);
      continue;
    }
    const manifest = path.join(root, relativeManifest);
    if (!isFile(manifest)) {
      errors.push(`${runtime}: missing package metadata ${relativeManifest}`);
      continue;
    }
    let pkgJson: Dict;
    try {
      pkgJson = loadJson(manifest);
    } catch (exc) {
      errors.push(`${runtime}: could not read package metadata ${relativeManifest}: ${(exc as Error).message}`);
      continue;
    }
    let metadata = pkgJson.agentera;
    if (!isMapping(metadata) && runtime === "claude") {
      const plugins = pkgJson.plugins;
      if (Array.isArray(plugins)) {
        metadata =
          plugins.find(
            (plugin) => isMapping(plugin) && plugin.name === "agentera" && isMapping(plugin.agentera),
          )?.agentera ?? null;
      }
    }
    if (!isMapping(metadata)) {
      errors.push(`${runtime}: missing agentera app metadata`);
      continue;
    }
    const expectedShape = packageShapes[runtime];
    if (metadata.packageShape !== expectedShape) {
      errors.push(`${runtime}: agentera.packageShape must be ${expectedShape}`);
    }
    const installRootValue = metadata.installRoot;
    if (typeof installRootValue !== "string" || !installRootValue) {
      errors.push(`${runtime}: agentera.installRoot must point at the Agentera app root`);
      continue;
    }
    const installRoot = resolveFromManifest(root, manifest, installRootValue);
    if (installRoot === null) {
      errors.push(`${runtime}: agentera.installRoot must stay inside package root`);
      continue;
    }
    if (installRoot !== resolvePath(root)) {
      errors.push(`${runtime}: AGENTERA_HOME must resolve to the package root`);
    }
    const sharedPaths = metadata.sharedPaths;
    if (!Array.isArray(sharedPaths) || !sharedPaths.every((p) => typeof p === "string")) {
      errors.push(`${runtime}: agentera.sharedPaths must list app paths`);
      continue;
    }
    const listed = new Set(sharedPaths);
    for (const [p, expectedKind] of Object.entries(requiredPaths)) {
      if (!listed.has(p)) {
        errors.push(`${runtime}: shared tool path ${p} missing from package metadata`);
        continue;
      }
      const resolved = resolveInside(installRoot, p);
      if (resolved === null) {
        errors.push(`${runtime}: shared tool path ${p} must stay inside the Agentera app root`);
      } else if (expectedKind === "dir" && !isDir(resolved)) {
        errors.push(`${runtime}: shared tool path ${p} must resolve to a directory`);
      } else if (expectedKind === "file" && !isFile(resolved)) {
        errors.push(`${runtime}: shared tool path ${p} must resolve to a file`);
      }
    }
    const singleSkill = metadata.singleSkillInstall;
    if (typeof singleSkill !== "string" || !singleSkill.includes("core") || !singleSkill.includes("suite")) {
      errors.push(
        `${runtime}: agentera.singleSkillInstall must state core skill behavior does not require suite tools`,
      );
    }
  }
  return errors;
}

export function validateCopilot(
  plugin: Dict,
  pluginRoot: string,
  registry: RuntimeAdapterRegistry = loadRuntimeRegistry(),
): string[] {
  const errors: string[] = [];
  if ("lifecycleHooks" in plugin) {
    errors.push("copilot: use supported hooks component field, not lifecycleHooks");
  }
  const skills = plugin.skills;
  if (!(typeof skills === "string" || Array.isArray(skills))) {
    errors.push("copilot.skills must be a string or string array path");
  } else if (Array.isArray(skills) && !skills.every((p) => typeof p === "string")) {
    errors.push("copilot.skills entries must be path strings");
  } else {
    for (const p of stringPaths(skills)) {
      const resolved = resolveInside(pluginRoot, p);
      if (resolved === null) errors.push("copilot.skills paths must stay inside plugin root");
      else if (!isDir(resolved)) errors.push("copilot.skills paths must resolve to skill directories");
    }
  }
  const hooks = plugin.hooks;
  if (!(typeof hooks === "string" || Array.isArray(hooks))) {
    errors.push("copilot.hooks must be a string or string array path");
  } else if (Array.isArray(hooks) && !hooks.every((p) => typeof p === "string")) {
    errors.push("copilot.hooks entries must be path strings");
  } else {
    for (const p of stringPaths(hooks)) {
      const resolved = resolveInside(pluginRoot, p);
      if (resolved === null) errors.push("copilot.hooks paths must stay inside plugin root");
      else if (!isDir(resolved)) errors.push("copilot.hooks paths must resolve to a hook directory");
    }
  }
  const description = plugin.description;
  const profileraTerms = copilotProfileraTerms(registry);
  if (typeof description !== "string" || profileraTerms.some((term) => !description.includes(term))) {
    errors.push("copilot.profilera: description must expose bounded corpus metadata limits");
  }
  return errors;
}

export function validateCopilotHooks(
  pluginRoot: string,
  plugin: Dict,
  registry: RuntimeAdapterRegistry = loadRuntimeRegistry(),
): string[] {
  const errors: string[] = [];
  const copilotEvents = supportedEvents(registry, "copilot");
  const requiredPrewriteHook = validationEvents(registry, "copilot")[0] ?? "";
  const hookPaths = stringPaths(plugin.hooks);
  if (hookPaths.length === 0) return errors;

  for (const hooks of hookPaths) {
    const hookDir = resolveInside(pluginRoot, hooks);
    if (hookDir === null) {
      errors.push("copilot.hooks paths must stay inside plugin root");
      continue;
    }
    if (!isDir(hookDir)) {
      errors.push("copilot.hooks must resolve to a hook directory");
      continue;
    }
    const seenEvents = new Set<string>();
    const jsonFiles = fs
      .readdirSync(hookDir)
      .filter((n) => n.endsWith(".json"))
      .sort();
    for (const name of jsonFiles) {
      const hook = loadJson(path.join(hookDir, name));
      const stem = name.replace(/\.json$/, "");
      const event = hook.name;
      if (!copilotEvents.has(stem)) {
        errors.push(`copilot: unsupported lifecycle hook file configured: ${name}`);
      }
      if (typeof event !== "string") {
        errors.push(`copilot.${name}: hook name must be a string`);
        continue;
      }
      if (!copilotEvents.has(event)) {
        errors.push(`copilot: unsupported lifecycle event configured: ${event}`);
        continue;
      }
      if (stem !== event) {
        errors.push(`copilot.${name}: hook filename must match event name ${event}`);
      }
      if (event !== event.slice(0, 1).toLowerCase() + event.slice(1)) {
        errors.push(`copilot: event must be lower-camel: ${event}`);
      }
      validateCommandHandler(errors, "copilot", event, 0, hook);
      seenEvents.add(event);
      if (event === requiredPrewriteHook) {
        const commandText = handlerCommandText(hook);
        if (!commandText.includes("hook validate-artifact")) {
          errors.push("copilot.preToolUse: artifact hard gate must run agentera hook validate-artifact");
        }
      }
    }
    if (!seenEvents.has(requiredPrewriteHook)) {
      errors.push("copilot: missing required preToolUse artifact validation hook");
    }
  }
  return errors;
}

export function validateCursor(
  root: string,
  plugin: Dict,
  registry: RuntimeAdapterRegistry = loadRuntimeRegistry(),
): string[] {
  void registry;
  const errors: string[] = [];
  const cursorMeta = plugin.cursor;
  if (!isMapping(cursorMeta)) {
    errors.push("cursor: missing cursor metadata object");
  } else {
    const limitations = cursorMeta.limitations;
    if (!Array.isArray(limitations) || limitations.length === 0) {
      errors.push("cursor: limitations must document cloud agents, bare hej, and hard-gate gating");
    } else {
      const joined = limitations.map((item) => String(item)).join(" ");
      for (const term of ["Cloud agents", "bare hej", "hard-gate", "smoke"]) {
        if (!joined.toLowerCase().includes(term.toLowerCase())) {
          errors.push(`cursor: limitations must mention '${term}'`);
        }
      }
    }
  }

  const skillPaths = stringPaths(plugin.skills);
  if (skillPaths.length === 0) {
    errors.push("cursor.skills must be a string or string array path");
  }
  for (const skillPath of skillPaths) {
    const resolved = resolveInside(root, skillPath.replace(/^\.\//, ""));
    if (resolved === null) {
      errors.push("cursor.skills paths must stay inside repository root");
    }
  }

  const hookPaths = stringPaths(plugin.hooks);
  if (hookPaths.length === 0) {
    errors.push("cursor.hooks must reference bundled hooks.json");
  }
  for (const hookPath of hookPaths) {
    const resolved = resolveInside(root, hookPath.replace(/^\.\//, ""));
    if (resolved === null || !isFile(resolved)) {
      errors.push("cursor.hooks must resolve to .cursor/hooks.json");
    }
  }

  const agentPaths = stringPaths(plugin.agents);
  if (agentPaths.length === 0) {
    errors.push("cursor.agents must reference managed capability agents");
  } else {
    for (const agentPath of agentPaths) {
      const resolved = resolveInside(root, agentPath.replace(/^\.\//, ""));
      if (resolved === null || !isDir(resolved)) {
        errors.push("cursor.agents must resolve to .cursor/agents");
      } else if (fs.readdirSync(resolved).filter((n) => n.endsWith(".md")).length < 12) {
        errors.push("cursor.agents must expose twelve managed capability descriptors");
      }
    }
  }

  const reference = path.join(root, "references/adapters/cursor.md");
  if (!isFile(reference)) {
    errors.push("cursor: missing references/adapters/cursor.md");
  } else {
    const text = fs.readFileSync(reference, "utf8").toLowerCase();
    for (const term of ["cloud agents", "cursor-agent", "metadata-only", "live pretooluse write smoke"]) {
      if (!text.includes(term)) {
        errors.push(`cursor.md must document '${term}'`);
      }
    }
  }
  return errors;
}

export function validateCursorHooks(root: string, registry: RuntimeAdapterRegistry = loadRuntimeRegistry()): string[] {
  const errors: string[] = [];
  const cursorEvents = supportedEvents(registry, "cursor");
  const requiredPrewriteHook = validationEvents(registry, "cursor")[0] ?? "";
  const hooksPath = path.join(root, ".cursor", "hooks.json");
  if (!isFile(hooksPath)) return ["cursor: missing .cursor/hooks.json"];

  const payload = loadJson(hooksPath);
  const hooks = payload.hooks;
  if (!isMapping(hooks)) return [...errors, "cursor: hooks.json must contain a hooks object"];

  const configured = new Set<string>();
  for (const [event, entries] of Object.entries(hooks)) {
    if (!cursorEvents.has(event)) {
      errors.push(`cursor: unsupported lifecycle event configured: ${event}`);
      continue;
    }
    if (!Array.isArray(entries)) {
      errors.push(`cursor.${event}: hook entries must be a list`);
      continue;
    }
    configured.add(event);
    entries.forEach((entry, index) => {
      if (!isMapping(entry)) {
        errors.push(`cursor.${event}[${index}]: hook entry must be an object`);
        return;
      }
      const command = entry.command;
      if (typeof command !== "string" || !command.trim()) {
        errors.push(`cursor.${event}[${index}]: command must be a string`);
        return;
      }
      if (event === "sessionStart" && !command.includes("hook cursor-session-start")) {
        errors.push("cursor.sessionStart: must run agentera hook cursor-session-start");
      }
      if (event === requiredPrewriteHook && !command.includes("hook cursor-pre-tool-use")) {
        errors.push("cursor.preToolUse: artifact hard gate must run agentera hook cursor-pre-tool-use");
      }
    });
  }
  for (const required of ["sessionStart", "sessionEnd", requiredPrewriteHook, "postToolUse"]) {
    if (required && !configured.has(required)) {
      errors.push(`cursor: missing required lifecycle hook ${required}`);
    }
  }
  return errors;
}

export function validateCodex(plugin: Dict, registry: RuntimeAdapterRegistry = loadRuntimeRegistry()): string[] {
  const errors: string[] = [];
  const codexEvents = supportedEvents(registry, "codex");
  const unsupportedCodexEvents = unsupportedEvents(registry, "codex");
  const lifecycleStatusValues = codexLifecycleStatusValues(registry);
  const limitationTerms = codexLimitationTerms(registry);
  const lifecycle = plugin.lifecycleHooks;
  if (!isMapping(lifecycle)) return ["codex: missing lifecycleHooks limitation metadata"];

  if (lifecycle.configured !== false) errors.push("codex: lifecycleHooks.configured must be false");
  if (!lifecycleStatusValues.includes(lifecycle.status)) {
    errors.push("codex: lifecycleHooks.status must be one of " + lifecycleStatusValues.join(", "));
  }
  const events = lifecycle.events ?? {};
  if (!isMapping(events)) {
    errors.push("codex: lifecycleHooks.events must be an object when present");
  } else {
    for (const event of Object.keys(events)) {
      if (!codexEvents.has(event)) errors.push(`codex: unsupported lifecycle event configured: ${event}`);
    }
  }
  const supported = lifecycle.supportedEvents;
  const codexSupportedList = runtimeView(registry, "codex").lifecycle_events.supported_events;
  if (!Array.isArray(supported) || !setsEqual(new Set(supported), codexEvents)) {
    errors.push(
      "codex: supportedEvents must list every Codex codex_hooks event (" + codexSupportedList.join(", ") + ")",
    );
  }
  const unsupported = lifecycle.unsupportedEvents;
  if (!Array.isArray(unsupported) || unsupported.length === 0) {
    errors.push("codex: unsupportedEvents must list Claude-Code-specific events with no Codex equivalent");
  } else {
    for (const entry of unsupported) {
      if (!isMapping(entry)) {
        errors.push("codex: unsupportedEvents entries must be objects with event and reason fields");
        continue;
      }
      const event = entry.event;
      if (codexEvents.has(event)) {
        errors.push(`codex: unsupportedEvents must not list event '${event}' that codex_hooks now supports`);
      } else if (!unsupportedCodexEvents.has(event)) {
        errors.push(`codex: unsupportedEvents entry '${event}' is not claimed by the registry`);
      }
    }
  }
  const limitations = lifecycle.limitations;
  if (!Array.isArray(limitations) || limitations.length === 0) {
    errors.push("codex: limitations must document codex_hooks status and apply_patch interception");
  } else {
    const joined = limitations.filter((item) => typeof item === "string").join(" ");
    for (const term of limitationTerms) {
      if (!joined.includes(term)) {
        errors.push(`codex: limitations must cite '${term}' so apply_patch interception ground truth stays surfaced`);
      }
    }
    for (const marker of ["experimental, require host config opt-in", "experimental-disabled", "no real-time"]) {
      if (joined.includes(marker)) {
        errors.push(`codex: limitations carry stale wording '${marker}'; remove it`);
      }
    }
  }
  return errors;
}

export function validateCodexProfileraMetadata(root: string, plugin: Dict): string[] {
  const errors: string[] = [];
  const agentera = (plugin.skillMetadata ?? []).find(
    (skill: unknown) => isMapping(skill) && skill.name === "agentera",
  );
  if (!isMapping(agentera)) return ["codex.agentera: missing aggregate Agentera app metadata"];

  if (agentera.runtimeSupport !== "portable") errors.push("codex.agentera: runtimeSupport must stay portable");
  if ((agentera.policy ?? {}).allow_implicit_invocation !== true) {
    errors.push("codex.agentera: Agentera app entry must allow implicit invocation");
  }
  const invocationHint = agentera.invocationHint;
  if (typeof invocationHint !== "string" || !invocationHint.includes("$agentera")) {
    errors.push("codex.agentera: invocation hint must name $agentera");
  }
  const codex = plugin.codex;
  const codexText = isMapping(codex) ? (codex.limitations ?? []).join(" ") : "";
  for (const term of CODEX_AGENTERA_METADATA_TERMS) {
    if (!`${invocationHint || ""} ${codexText}`.includes(term)) {
      errors.push(`codex.agentera: metadata must surface '${term}'`);
    }
  }
  for (const rel of ["agents/openai.yaml"]) {
    const p = path.join(root, rel);
    if (!isFile(p)) {
      errors.push(`codex.agentera: missing metadata surface ${rel}`);
      continue;
    }
    const text = fs.readFileSync(p, "utf8");
    if (!text.includes("path: ./skills/agentera")) {
      errors.push(`codex.agentera: ${rel} must point at installed skills/agentera`);
    }
    for (const stalePath of ["path: ./skills/hej", "metadata: ./skills/hej", "skills/<name>/agents"]) {
      if (text.includes(stalePath)) {
        errors.push(`codex.agentera: ${rel} carries stale v1 skill path '${stalePath}'`);
      }
    }
    for (const term of CODEX_PROFILERA_TERMS) {
      if (!text.includes(term)) errors.push(`codex.agentera: ${rel} missing '${term}'`);
    }
    if (!CODEX_PROFILERA_STATUS_VALUES.some((value) => text.includes(`status: ${value}`))) {
      errors.push(
        `codex.agentera: ${rel} missing status declaration (expected one of ` +
          CODEX_PROFILERA_STATUS_VALUES.join(", ") +
          ")",
      );
    }
    if (text.includes("collector exists") || text.includes("not implemented")) {
      errors.push(`codex.agentera: ${rel} contains stale missing-collector wording`);
    }
  }
  return errors;
}

export function validateOpencode(root: string, registry: RuntimeAdapterRegistry = loadRuntimeRegistry()): string[] {
  const errors: string[] = [];
  const pluginPath = path.join(root, ".opencode/plugins/agentera.js");
  if (!isFile(pluginPath)) return ["opencode: missing .opencode/plugins/agentera.js"];

  const text = fs.readFileSync(pluginPath, "utf8");
  if (!text.includes("event: async")) {
    errors.push("opencode: session lifecycle must use the generic event hook");
  }
  for (const eventType of opencodeEventPayloadTypes(registry)) {
    if (!text.includes(`event.type !== "${eventType}"`) && !text.includes(`event.type === "${eventType}"`)) {
      errors.push(`opencode: event hook must handle or explicitly skip ${eventType}`);
    }
    if (text.includes(`"${eventType}":`)) {
      errors.push(`opencode: must not register direct hook ${eventType}`);
    }
  }
  for (const eventType of unsupportedEvents(registry, "opencode")) {
    if (text.includes(`"${eventType}":`)) {
      errors.push(`opencode: must not register unsupported direct hook ${eventType}`);
    }
  }
  const payloadTypes = opencodeEventPayloadTypes(registry);
  const directHooks = [...supportedEvents(registry, "opencode")].filter((e) => !payloadTypes.has(e));
  for (const event of directHooks) {
    if (!text.includes(`"${event}"`)) {
      errors.push(`opencode: missing "${event}" hook`);
    }
  }
  if (!text.includes("validateArtifactCandidate")) {
    errors.push("opencode: tool.execute.before must validate artifact candidates");
  }
  return errors;
}

function normalizedDocText(p: string): string {
  return fs.readFileSync(p, "utf8").replace(/`/g, "");
}

export function validateHardGateDocs(root: string, registry: RuntimeAdapterRegistry = loadRuntimeRegistry()): string[] {
  const errors: string[] = [];
  for (const [relativePath, runtimes] of Object.entries(HARD_GATE_DOC_REQUIREMENTS)) {
    const p = path.join(root, relativePath);
    if (!isFile(p)) {
      errors.push(`${relativePath}: missing hard-gate documentation surface`);
      continue;
    }
    const text = normalizedDocText(p);
    for (const runtime of runtimes) {
      const displayName = runtimeView(registry, runtime).identity.display_name.replace(/ CLI$/, "");
      for (const term of hardGateDocTerms(registry, runtime, relativePath)) {
        const normalizedTerm = term.replace(/`/g, "").replace(/\.$/, "");
        if (!text.includes(normalizedTerm)) {
          errors.push(`${relativePath}: ${displayName} hard-gate docs must keep scoped claim term '${term}'`);
        }
      }
    }
  }
  return errors;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export interface LifecycleMainOptions {
  root?: string;
  checkUvRuntime?: boolean;
  out?: (line: string) => void;
}

export function lifecycleMain(opts: LifecycleMainOptions = {}): number {
  const root = resolvePath(opts.root ?? rootDefault());
  const out = opts.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const errors: string[] = [];
  let registry: RuntimeAdapterRegistry | null = null;
  try {
    registry = loadRuntimeRegistry(path.join(root, "references/adapters/runtime-adapter-registry.yaml"));
  } catch (exc) {
    if (exc instanceof RegistryError || exc instanceof Error) {
      errors.push(registryContractError(exc as Error));
    } else {
      throw exc;
    }
  }

  if (errors.length > 0) {
    out("lifecycle adapter validation failed:");
    for (const error of errors) out(`- ${error}`);
    return 1;
  }
  const reg = registry as RuntimeAdapterRegistry;

  const copilot = loadJson(path.join(root, "plugin.json"));
  errors.push(...validateCopilot(copilot, root, reg));
  errors.push(...validateCopilotHooks(root, copilot, reg));
  const cursorPlugin = loadJson(path.join(root, ".cursor-plugin/plugin.json"));
  errors.push(...validateCursor(root, cursorPlugin, reg));
  errors.push(...validateCursorHooks(root, reg));
  const codex = loadJson(path.join(root, ".codex-plugin/plugin.json"));
  errors.push(...validateCodex(codex, reg));
  errors.push(...validateCodexProfileraMetadata(root, codex));
  errors.push(...validateOpencode(root, reg));
  const packageManifestReg = packageManifest(root);
  errors.push(...validateSuiteBundleSurface(root, null, packageManifestReg));
  errors.push(...validatePackagedPythonScripts(root));
  if (opts.checkUvRuntime) {
    errors.push(...validateUvRuntime());
  }
  errors.push(...validateHardGateDocs(root, reg));

  if (errors.length > 0) {
    out("lifecycle adapter validation failed:");
    for (const error of errors) out(`- ${error}`);
    return 1;
  }
  out("lifecycle adapter metadata ok");
  return 0;
}
