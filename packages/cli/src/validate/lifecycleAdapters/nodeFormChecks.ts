import fs from "node:fs";
import path from "node:path";

import { resolvePath } from "../../core/paths.js";
import { PackageRegistry } from "../../registries/packageRegistry.js";
import {
  RuntimeAdapterRegistry,
  loadRegistry as loadRuntimeRegistry,
} from "../../registries/runtimeAdapterRegistry.js";
import type { JsonObject } from "../../core/jsonValue.js";
import {
  CODEX_AGENTERA_METADATA_TERMS,
  CODEX_PROFILERA_STATUS_VALUES,
  CODEX_PROFILERA_TERMS,
  HARD_GATE_DOC_REQUIREMENTS,
  codexLifecycleStatusValues,
  codexLimitationTerms,
  copilotProfileraTerms,
  handlerCommandText,
  hardGateDocTerms,
  isDir,
  isFile,
  isMapping,
  loadJson,
  objectField,
  stringArrayField,
  stringField,
  opencodeEventPayloadTypes,
  packageManifest,
  resolveFromManifest,
  resolveInside,
  runtimeView,
  setsEqual,
  stringPaths,
  supportedEvents,
  unsupportedEvents,
  validateCommandHandler,
  validationEvents,
} from "./shared.js";

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
    let pkgJson: JsonObject;
    try {
      pkgJson = loadJson(manifest);
    } catch (exc) {
      errors.push(`${runtime}: could not read package metadata ${relativeManifest}: ${(exc as Error).message}`);
      continue;
    }
    let metadata: JsonObject | null = isMapping(pkgJson.agentera) ? pkgJson.agentera : null;
    if (!isMapping(metadata) && runtime === "claude") {
      const plugins = pkgJson.plugins;
      if (Array.isArray(plugins)) {
        const pluginRecord = plugins.find(
          (plugin) => isMapping(plugin) && stringField(plugin, "name") === "agentera" && isMapping(plugin.agentera),
        );
        metadata = pluginRecord && isMapping(pluginRecord) ? objectField(pluginRecord, "agentera") : null;
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
  plugin: JsonObject,
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
  plugin: JsonObject,
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
  plugin: JsonObject,
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

export function validateCodex(plugin: JsonObject, registry: RuntimeAdapterRegistry = loadRuntimeRegistry()): string[] {
  const errors: string[] = [];
  const codexEvents = supportedEvents(registry, "codex");
  const unsupportedCodexEvents = unsupportedEvents(registry, "codex");
  const lifecycleStatusValues = codexLifecycleStatusValues(registry);
  const limitationTerms = codexLimitationTerms(registry);
  const lifecycle = objectField(plugin, "lifecycleHooks");
  if (Object.keys(lifecycle).length === 0) return ["codex: missing lifecycleHooks limitation metadata"];

  if (lifecycle.configured !== false) errors.push("codex: lifecycleHooks.configured must be false");
  const lifecycleStatus = stringField(lifecycle, "status");
  if (!lifecycleStatusValues.includes(lifecycleStatus)) {
    errors.push("codex: lifecycleHooks.status must be one of " + lifecycleStatusValues.join(", "));
  }
  const events = objectField(lifecycle, "events");
  if (!isMapping(events)) {
    errors.push("codex: lifecycleHooks.events must be an object when present");
  } else {
    for (const event of Object.keys(events)) {
      if (!codexEvents.has(event)) errors.push(`codex: unsupported lifecycle event configured: ${event}`);
    }
  }
  const supported = lifecycle.supportedEvents;
  const codexSupportedList = stringArrayField(objectField(runtimeView(registry, "codex"), "lifecycle_events"), "supported_events");
  if (!Array.isArray(supported) || !setsEqual(new Set(supported.filter((entry): entry is string => typeof entry === "string")), codexEvents)) {
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
      const event = stringField(entry, "event");
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

export function validateCodexProfileraMetadata(root: string, plugin: JsonObject): string[] {
  const errors: string[] = [];
  const skillMetadata = Array.isArray(plugin.skillMetadata) ? plugin.skillMetadata : [];
  const agentera = skillMetadata.find(
    (skill: unknown) => isMapping(skill) && stringField(skill, "name") === "agentera",
  );
  if (!isMapping(agentera)) return ["codex.agentera: missing aggregate Agentera app metadata"];

  if (stringField(agentera, "runtimeSupport") !== "portable") {
    errors.push("codex.agentera: runtimeSupport must stay portable");
  }
  if (objectField(agentera, "policy").allow_implicit_invocation !== true) {
    errors.push("codex.agentera: Agentera app entry must allow implicit invocation");
  }
  const invocationHint = stringField(agentera, "invocationHint");
  if (typeof invocationHint !== "string" || !invocationHint.includes("$agentera")) {
    errors.push("codex.agentera: invocation hint must name $agentera");
  }
  const codex = objectField(plugin, "codex");
  const codexText = stringArrayField(codex, "limitations").join(" ");
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
      const displayName = stringField(objectField(runtimeView(registry, runtime), "identity"), "display_name").replace(/ CLI$/, "");
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
