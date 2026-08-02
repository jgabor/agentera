import path from "node:path";
import { readdirSync as fsReaddirSync, readFileSync as fsReadFileSync, statSync as fsStatSync } from "node:fs";

import { resolvePath } from "../../core/paths.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { validateAgentString, validatePathValue } from "../argvalidate.js";
import { HookCliAdapter } from "../../hooks/validateArtifact/index.js";
import { validateCapability, validateContractSelf, validateProtocolSelf } from "../../validate/capability.js";
import { loadYamlMapping } from "../../core/yaml.js";
import { validateGraph } from "../../validate/crossCapability.js";
import { validate as validateAppHome } from "../../validate/appHomeContract.js";
import { selfAuditMain } from "../../validate/selfAudit.js";
import { vocabularyAuthorityMain } from "../../validate/vocabularyAuthority.js";
import { releaseMetadataMain } from "../../release/releaseMetadata.js";
import {
  VALIDATE_ARTIFACT_PROTOCOL_IDS,
  normalizeArtifactProtocolId,
} from "../../registries/artifactProtocolIds.js";
import { emitStructured } from "../structured.js";
import type { JsonObject, JsonValue } from "../../core/jsonValue.js";
import { validateEntityState } from "../../state/entityStorage.js";
import { inspectTodoReconciliationDrift } from "../../state/todoDocsEntities.js";
import { detectStateModeBinding } from "../../state/stateMode.js";
import { loadEntityCutoverTargetsForMarker } from "../../state/entityCutover.js";
import { validateRealProjectRoot } from "../../state/projectRoot.js";
import { readProjectFileSnapshot } from "../../state/safeProjectFile.js";
import {
  loadTodoReadinessContract,
  TodoReadinessContractError,
} from "../../registries/todoReadinessContract.js";

/** Port of scripts/agentera cmd_validate delegated-script family. */

type Io = { out?: (t: string) => void; err?: (t: string) => void };

interface ProcResult {
  stdout: string;
  stderr: string;
  returncode: number;
}

const VALIDATE_DELEGATED_SCRIPTS: Record<string, string> = {
  "cross-capability": "validate_cross_capability.py",
  "app-home-contract": "validate_app_home_contract.py",
  vocabularyAuthority: "validate_vocabulary_authority.py",
  selfAudit: "self_audit.py",
  "release-metadata": "validate_release_metadata.py",
};

function pySplitlines(s: string): string[] {
  if (!s) return [];
  const parts = s.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function runCrossCapability(): ProcResult {
  const errors = validateGraph();
  if (errors.length > 0) {
    return { stdout: errors.map((e) => `FAIL: ${e}\n`).join(""), stderr: "", returncode: 1 };
  }
  return { stdout: "cross-capability artifact graph ok\n", stderr: "", returncode: 0 };
}

function runAppHomeContract(): ProcResult {
  const errors = validateAppHome(resolvePath(repoRoot()));
  if (errors.length > 0) {
    return {
      stdout: "",
      stderr: "App-home contract validation failed:\n" + errors.map((e) => `- ${e}\n`).join(""),
      returncode: 1,
    };
  }
  return { stdout: "OK: app-home contract terminology is release-ready\n", stderr: "", returncode: 0 };
}

function runVocabularyAuthority(): ProcResult {
  const lines: string[] = [];
  const rc = vocabularyAuthorityMain({ out: (line) => lines.push(line) });
  return { stdout: lines.map((l) => l + "\n").join(""), stderr: "", returncode: rc };
}

function runSelfAudit(): ProcResult {
  const lines: string[] = [];
  const rc = selfAuditMain({ out: (line) => lines.push(line) });
  return { stdout: lines.map((l) => l + "\n").join(""), stderr: "", returncode: rc };
}

function runReleaseMetadata(): ProcResult {
  const lines: string[] = [];
  const rc = releaseMetadataMain({ out: (line) => lines.push(line) });
  return { stdout: lines.map((l) => l + "\n").join(""), stderr: "", returncode: rc };
}

function repoRoot(): string {
  // appHomeContract.validate resolves its own default root; pass the source root.
  return process.cwd();
}

export interface DelegatedValidateArgs {
  format?: string;
}

const DELEGATED_RUNNERS: Record<string, (args: DelegatedValidateArgs) => ProcResult> = {
  "cross-capability": () => runCrossCapability(),
  "app-home-contract": () => runAppHomeContract(),
  vocabularyAuthority: () => runVocabularyAuthority(),
  selfAudit: () => runSelfAudit(),
  "release-metadata": () => runReleaseMetadata(),
};

function validationProcessPayload(
  targetFamily: string,
  target: string,
  p: string | null,
  result: ProcResult,
): JsonObject {
  const lines = pySplitlines(result.stderr).map((l) => l.trim());
  const violations = lines.filter((l) => l.trim()).map((l) => (l.startsWith("  ") ? l.slice(2) : l));
  const payload: JsonObject = {
    command: "validate",
    status: result.returncode === 0 ? "pass" : "fail",
    target_family: targetFamily,
    target,
    violations,
    engine: {
      exit_code: result.returncode,
      stdout: pySplitlines(result.stdout),
      stderr: pySplitlines(result.stderr),
    },
  };
  if (p !== null) payload.path = resolvePath(p);
  return payload;
}

function delegatedValidationPayload(targetFamily: string, result: ProcResult, engineCommand: string): JsonObject {
  const payload = validationProcessPayload(targetFamily, targetFamily, null, result);
  // cast: payload.engine carries captured subprocess stdout/stderr (IO boundary)
  payload.engine = { ...(payload.engine as JsonObject), command: engineCommand };
  return payload;
}

export function cmdValidate(family: string, args: DelegatedValidateArgs, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  if (!(family in DELEGATED_RUNNERS)) {
    throw new Error(
      "unsupported validate target family; valid families: capability, artifact, " +
        "cross-capability, app-home-contract, vocabularyAuthority, selfAudit, release-metadata, capability-contract.",
    );
  }
  const result = DELEGATED_RUNNERS[family](args);
  if ((args.format ?? "text") === "json") {
    emitStructured(
      delegatedValidationPayload(family, result, VALIDATE_DELEGATED_SCRIPTS[family]),
      "json",
      out,
    );
  } else {
    if (result.stdout) out(result.stdout);
    if (result.stderr) err(result.stderr);
  }
  return result.returncode;
}

export function isDelegatedValidateFamily(family: string): boolean {
  return family in DELEGATED_RUNNERS;
}

// ── capability + capability-contract families ───────────────────────

const CAPABILITY_NAMES = [
  "status", "vision", "discuss", "research", "plan", "build",
  "optimize", "audit", "document", "profile", "design", "orchestrate",
];
const CONTRACT_PATH = "skills/agentera/capability_schema_contract.yaml";
const PROTOCOL_PATH = "skills/agentera/protocol.yaml";
const TODO_READINESS_PATH = "skills/agentera/schemas/artifacts/todo.yaml";

function pyRepr(value: string): string {
  return value.includes("'") && !value.includes('"') ? `"${value}"` : `'${value}'`;
}

function validateCapabilityTarget(target: string): string {
  validateAgentString(target, "capability target");
  const sourceRoot = resolveSourceRoot();
  if (CAPABILITY_NAMES.includes(target)) {
    return path.join(sourceRoot, "skills", "agentera", "capabilities", target);
  }
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(target)) {
    const valid = CAPABILITY_NAMES.join(", ");
    throw new Error(
      `unsupported capability target ${pyRepr(target)}; valid capability names: ${valid}. ` +
        "Syntax: agentera validate capability <capability-or-path> [--format text|json]. " +
        "Example: agentera validate capability status",
    );
  }
  validatePathValue(target, "capability path");
  return target;
}

function capabilityResult(capDir: string): ProcResult {
  const resolved = resolvePath(capDir);
  let stdout = `Validating capability: ${resolved}\nUsing contract: ${CONTRACT_PATH}\n`;
  let errors: string[];
  try {
    errors = validateCapability(resolved, path.join(resolveSourceRoot(), CONTRACT_PATH));
  } catch (exc) {
    errors = [(exc as Error).message];
  }
  let stderr = "";
  let returncode = 0;
  if (errors.length > 0) {
    stderr = "FAILED:\n" + errors.map((e) => `  ${e}\n`).join("");
    returncode = 1;
  } else {
    stdout += "PASS: capability directory is valid\n";
  }
  return { stdout, stderr, returncode };
}

function listDirsSorted(dir: string): string[] {
  let entries: string[];
  try {
    entries = fsReaddirSync(dir);
  } catch {
    return [];
  }
  return entries
    .map((e) => path.join(dir, e))
    .filter((p) => {
      try {
        return fsStatSync(p).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export function cmdValidateCapability(target: string, args: { format?: string }, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const capDir = validateCapabilityTarget(target);
  const sourceRoot = resolveSourceRoot();
  const capabilityRoot = path.join(sourceRoot, "skills", "agentera", "capabilities");
  let targets = [capDir];
  if (resolvePath(capDir) === resolvePath(capabilityRoot)) {
    targets = listDirsSorted(capDir);
  }
  const format = args.format ?? "text";
  if (targets.length > 1) {
    const results = targets.map((t) => capabilityResult(t));
    const status = results.every((r) => r.returncode === 0) ? "pass" : "fail";
    if (format === "json") {
      const checks = targets.map((t, i) =>
        validationProcessPayload("capability", path.basename(t), t, results[i]),
      );
      emitStructured(
        {
          command: "validate",
          status,
          target_family: "capability-set",
          target,
          path: resolvePath(capDir),
          checks,
          // cast: c.violations are captured validation-engine lines (subprocess IO boundary)
          violations: checks.flatMap((c) => c.violations as string[]),
          summary: {
            passed: checks.filter((c) => c.status === "pass").length,
            failed: checks.filter((c) => c.status === "fail").length,
          },
        },
        "json",
        out,
      );
    } else {
      for (const r of results) {
        if (r.stdout) out(r.stdout);
        if (r.stderr) err(r.stderr);
      }
    }
    return status === "pass" ? 0 : 1;
  }
  const result = capabilityResult(capDir);
  if (format === "json") {
    emitStructured(validationProcessPayload("capability", target, capDir, result), "json", out);
  } else {
    if (result.stdout) out(result.stdout);
    if (result.stderr) err(result.stderr);
  }
  return result.returncode;
}

function contractSelfResult(): ProcResult {
  let stdout = `Self-validating contract: ${CONTRACT_PATH}\n`;
  let errors: string[];
  try {
    errors = validateContractSelf(path.join(resolveSourceRoot(), CONTRACT_PATH));
  } catch (exc) {
    errors = [(exc as Error).message];
  }
  let stderr = "";
  let returncode = 0;
  if (errors.length > 0) {
    stderr = "FAILED: contract does not pass its own rules:\n" + errors.map((e) => `  ${e}\n`).join("");
    returncode = 1;
  } else {
    stdout += "PASS: contract is self-referentially valid\n";
  }
  return { stdout, stderr, returncode };
}

function protocolSelfResult(): ProcResult {
  let stdout = `Validating protocol: ${PROTOCOL_PATH}\n`;
  let errors: string[];
  try {
    errors = validateProtocolSelf(path.join(resolveSourceRoot(), PROTOCOL_PATH));
  } catch (exc) {
    errors = [(exc as Error).message];
  }
  let stderr = "";
  let returncode = 0;
  if (errors.length > 0) {
    stderr = "FAILED:\n" + errors.map((e) => `  ${e}\n`).join("");
    returncode = 1;
  } else {
    stdout += "PASS: protocol is internally consistent\n";
  }
  return { stdout, stderr, returncode };
}

function todoReadinessResult(): ProcResult {
  let stdout = `Validating TODO readiness: ${TODO_READINESS_PATH}\n`;
  let errors: string[] = [];
  try {
    loadTodoReadinessContract(
      path.join(resolveSourceRoot(), TODO_READINESS_PATH),
      path.join(resolveSourceRoot(), PROTOCOL_PATH),
      path.join(resolveSourceRoot(), CONTRACT_PATH),
    );
  } catch (exc) {
    errors = exc instanceof TodoReadinessContractError ? exc.errors : [(exc as Error).message];
  }
  let stderr = "";
  let returncode = 0;
  if (errors.length > 0) {
    stderr = "FAILED:\n" + errors.map((error) => `  ${error}\n`).join("");
    returncode = 1;
  } else {
    stdout += "PASS: TODO readiness contract is internally consistent\n";
  }
  return { stdout, stderr, returncode };
}

export function cmdValidateCapabilityContract(args: { format?: string }, io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const results: Array<[string, ProcResult]> = [
    ["capability-contract-self", contractSelfResult()],
    ["capability-protocol", protocolSelfResult()],
    ["todo-readiness", todoReadinessResult()],
  ];
  if ((args.format ?? "text") === "json") {
    const checks = results.map(([name, result]) => delegatedValidationPayload(name, result, "validate_capability.py"));
    emitStructured(
      {
        command: "validate",
        status: results.every(([, r]) => r.returncode === 0) ? "pass" : "fail",
        target_family: "capability-contract",
        target: "capability-schema-contract-protocol-and-todo-readiness",
        checks,
        // cast: c.violations are captured validation-engine lines (subprocess IO boundary)
        violations: checks.flatMap((c) => c.violations as string[]),
        summary: {
          passed: results.filter(([, r]) => r.returncode === 0).length,
          failed: results.filter(([, r]) => r.returncode !== 0).length,
        },
      },
      "json",
      out,
    );
  } else {
    for (const [, result] of results) {
      if (result.stdout) out(result.stdout);
      if (result.stderr) err(result.stderr);
    }
  }
  return results.every(([, r]) => r.returncode === 0) ? 0 : 1;
}

// ── artifact family ─────────────────────────────────────────────────

function validateArtifactLabel(artifact: string): void {
  validateAgentString(artifact, "artifact");
  if (normalizeArtifactProtocolId(artifact) === null) {
    const valid = VALIDATE_ARTIFACT_PROTOCOL_IDS.join(", ");
    throw new Error(
      `unsupported artifact ${pyRepr(artifact)}; valid artifact_id values: ${valid}. ` +
        "Syntax: agentera check validate artifact --artifact <ARTIFACT_ID> [--file <PATH>] [--format text|json]. " +
        "Example: agentera check validate artifact --artifact plan --file .agentera/plan.yaml --format json",
    );
  }
}

export function cmdValidateArtifact(
  args: { artifact: string; file?: string | null; cwd?: string | null; format?: string },
  io: Io,
): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const artifact = String(args.artifact);
  validateArtifactLabel(artifact);
  const cwd = resolvePath(args.cwd ?? process.cwd());
  const adapter = new HookCliAdapter();
  const [rc, payload] = adapter.runExplicit(artifact, args.file ?? null, cwd);
  if ((args.format ?? "text") === "json") {
    const wrapped: JsonObject = {
      ...payload,
      command: "validate",
      status: payload.status ?? "fail",
      target_family: "artifact",
      target: artifact,
      engine: { command: "validate-artifact", exit_code: rc },
    };
    emitStructured(wrapped, "json", out);
    if (wrapped.status === "fail" && rc === 0) return 2;
    return rc;
  }
  out(
    `status=${payload.status} | artifact=${payload.artifact} | ` +
      `file=${payload.file} | docs_mapped_default=${payload.docs_mapped_default} | ` +
      `path_source=${payload.path_source}\n`,
  );
  // cast: payload.violations come from the artifact-validation hook (subprocess IO boundary)
  for (const violation of payload.violations as string[]) err(`${violation}\n`);
  return rc;
}

export function cmdValidateState(
  args: { cwd?: string | null; format?: string },
  io: Io,
): number {
  const out = io.out ?? ((text: string) => process.stdout.write(text));
  const err = io.err ?? ((text: string) => process.stderr.write(text));
  const projectRoot = resolvePath(args.cwd ?? process.cwd());
  const payload = validateStatePayload(projectRoot);
  const issues = payload.issues as unknown as JsonObject[];
  if ((args.format ?? "text") === "json") emitStructured(payload, "json", out);
  else {
    out(`status=${payload.status} | entities=${payload.entity_count} | issues=${payload.issue_count} | project_root=${projectRoot}\n`);
    for (const issue of issues) err(`${issue.code}: ${issue.message}\nrecovery: ${issue.recovery}\n`);
    if ((payload.omitted_issue_count as number) > 0) err(`omitted ${payload.omitted_issue_count} additional issues; repair listed issues and rerun agentera check validate state --cwd ${JSON.stringify(projectRoot)}\n`);
  }
  return payload.valid ? 0 : 1;
}

/** The executable whole-state contract shared by the public command and upgrade verification. */
export function validateStatePayload(projectRootInput: string): JsonObject {
  const projectRoot = resolvePath(projectRootInput);
  const result = validateEntityState(projectRoot);
  const issues: JsonObject[] = [...result.issues as unknown as JsonObject[]];
  let additionalOmittedIssues = 0;
  let entityMode = false;
  try {
    const binding = detectStateModeBinding(projectRoot);
    if (binding.mode === "entities") {
      entityMode = true;
      binding.publicationContext.close();
      const markerSnapshot = readProjectFileSnapshot(validateRealProjectRoot(projectRoot), ".agentera/state-mode.yaml");
      if (markerSnapshot.kind !== "file") throw new Error("entity-mode marker became unavailable during maintenance validation");
      const marker = loadYamlMapping(markerSnapshot.bytes.toString("utf8"));
      if (typeof marker.migration_id === "string" || marker.cutover === "one_way_git") {
        const targets = loadEntityCutoverTargetsForMarker(projectRoot, markerSnapshot.bytes);
        const byPath = new Map(result.entities.map((entity) => [entity.relativePath, entity]));
        for (const target of targets) {
          const actual = byPath.get(target.path);
          if (!actual || actual.classification !== "valid" || (target.id && actual.id !== target.id) || (target.artifact && actual.artifact !== target.artifact)) {
            issues.push({ code: "missing_migrated_entity", path: target.path, id: target.id ?? null, artifact: target.artifact ?? null, message: `cutover target '${target.path}' is missing or no longer has its declared identity`, recovery: "Restore a valid canonical entity at the manifest-declared path; no state was changed." });
          }
        }
      }
    }
  } catch (error) {
    if (issues.length < 100) issues.push({ code: "invalid_state_marker_or_manifest", path: ".agentera/state-mode.yaml", message: (error as Error).message, recovery: "Restore the durable marker and immutable migration evidence, then rerun this read-only check." });
    else additionalOmittedIssues += 1;
  }
  if (entityMode) {
    try {
      const reconciliation = inspectTodoReconciliationDrift(projectRoot);
      const driftItems = Array.isArray(reconciliation.items) ? reconciliation.items.filter((item): item is JsonObject => item !== null && typeof item === "object" && !Array.isArray(item)) : [];
      const reconciliationOmitted = Number(reconciliation.omitted_count ?? 0);
      const available = Math.max(0, 100 - issues.length);
      for (const item of driftItems.slice(0, available)) {
        const id = String(item.id ?? "unknown");
        const state = String(item.state ?? "drift");
        const fields = [...new Set([
          ...(Array.isArray(item.markdown_changed_fields) ? item.markdown_changed_fields : []),
          ...(Array.isArray(item.entity_changed_fields) ? item.entity_changed_fields : []),
          ...(Array.isArray(item.conflicting_fields) ? item.conflicting_fields : []),
        ].filter((field): field is string => typeof field === "string"))].sort();
        issues.push({
          code: "todo_reconciliation_drift",
          path: "TODO.md",
          id,
          artifact: "todo",
          message: `managed TODO '${id}' has ${state} reconciliation drift${fields.length ? ` in ${fields.join(", ")}` : ""}`,
          recovery: "Review the reported authority and run the intended typed TODO mutation once; the writer reconciles one-sided changes atomically and rejects conflicts before effects.",
        });
      }
      additionalOmittedIssues += Math.max(0, driftItems.length - available) + (Number.isSafeInteger(reconciliationOmitted) && reconciliationOmitted > 0 ? reconciliationOmitted : 0);
    } catch (error) {
      if (issues.length < 100) issues.push({ code: "invalid_todo_reconciliation", path: "TODO.md", artifact: "todo", message: (error as Error).message, recovery: "Restore valid bounded managed TODO Markdown, activation metadata, and public baselines, then rerun this read-only check." });
      else additionalOmittedIssues += 1;
    }
  }
  const omittedIssueCount = result.omittedIssueCount + additionalOmittedIssues;
  const valid = result.valid && issues.length === 0 && omittedIssueCount === 0;
  const payload: JsonObject = {
    command: "check validate state",
    target_family: "state",
    status: valid ? "pass" : "fail",
    valid,
    project_root: projectRoot,
    entity_count: result.entityCount,
    issue_count: issues.length + omittedIssueCount,
    omitted_issue_count: omittedIssueCount,
    valid_artifact_values: result.validArtifactValues,
    issues: issues as unknown as JsonValue,
  };
  return payload;
}
