import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProfileDirOverride } from "../core/envPaths.js";
import { expanduser } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadNativeResourceCleanupContract, type NativeResourceCleanupContract } from "../runtime/nativeResourceCleanup.js";
import { defaultAppHome } from "../state/installRoot.js";
import { classifyProjectState } from "../state/stateMode.js";
import { applyAppContentRefresh } from "./appContentRefresh.js";
import { loadProductV1ResetAuthority } from "./productV1ResetAuthority.js";

export interface ProductV1ResetOptions {
  project?: string | null;
  installRoot?: string | null;
  home?: string | null;
  env?: Record<string, string | undefined>;
}

interface ScopePath {
  path: string;
  type: "absent" | "directory" | "file" | "symlink" | "other";
  sha256?: string;
  link_target?: string;
}

export interface ProductV1ResetScopeTarget {
  declared: string;
  operation?: "remove_path" | "remove_in_file_selector";
  path?: string;
  selector?: { kind: "contains" | "key"; value: string };
  entries?: ScopePath[];
  file_state?: { type: "absent" | "file"; sha256?: string };
}

export interface ProductV1ResetDependencies {
  runtimeContract?: NativeResourceCleanupContract;
  afterEffect?: (effect: string) => void;
}

export interface ProductV1ResetResult {
  schemaVersion: "agentera.productV1ResetApply.v1";
  status: "complete";
  authorization: string;
  validated_scope: ProductV1ResetValidatedScope;
  effects_performed: true;
}

export interface ProductV1ResetValidatedScope {
  roots: Record<string, string>;
  deletions: Array<{
    id: string;
    owner: string;
    root: string;
    targets: ProductV1ResetScopeTarget[];
  }>;
  recreations: Array<{
    id: string;
    owner: string;
    root: string;
    targets: ProductV1ResetScopeTarget[];
  }>;
}

export interface ProductV1ResetPreview {
  schemaVersion: "agentera.productV1ResetPreview.v1";
  mode: "preview";
  status: "review_required";
  evidence: string[];
  roots: Record<string, string>;
  deletions: ProductV1ResetValidatedScope["deletions"];
  recreations: ProductV1ResetValidatedScope["recreations"];
  irreversible_loss: string[];
  authorization: string;
  mutation_performed: false;
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function lstat(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function existingAncestor(target: string): string {
  let candidate = target;
  while (lstat(candidate) === null) {
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}

function safeRoot(name: string, value: string): string {
  const absolute = path.resolve(expanduser(value));
  if (lstat(absolute)?.isSymbolicLink()) throw new Error(`${name} must not be a symbolic link: ${absolute}`);
  const ancestor = existingAncestor(absolute);
  const resolved = path.join(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
  if (resolved !== absolute) throw new Error(`${name} resolves through an alias outside its declared root: ${absolute}`);
  return absolute;
}

function resolvedRoots(options: ProductV1ResetOptions): Record<string, string> {
  const env = options.env ?? process.env;
  const home = safeRoot("runtime home", options.home ?? os.homedir());
  const project = safeRoot("project root", options.project ?? process.cwd());
  const installCandidate = options.installRoot ?? env.AGENTERA_HOME ?? env.AGENTERA_DEFAULT_INSTALL_ROOT ?? defaultAppHome(env, home);
  const installRoot = safeRoot("install root", installCandidate);
  const profileRoot = safeRoot("profile root", resolveProfileDirOverride(env) ?? installRoot);
  return { project, profile_root: profileRoot, install_root: installRoot, runtime_home: home };
}

function assertContained(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`reset target is outside its declared root: ${target}`);
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean).slice(0, -1)) {
    current = path.join(current, part);
    if (lstat(current)?.isSymbolicLink()) {
      throw new Error(`reset target resolves through a symbolic link: ${current}`);
    }
  }
}

function snapshot(target: string): ScopePath[] {
  if (lstat(target) === null) return [{ path: target, type: "absent" }];
  const result: ScopePath[] = [];
  const visit = (current: string): void => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      result.push({ path: current, type: "symlink", link_target: fs.readlinkSync(current) });
      return;
    }
    if (stat.isDirectory()) {
      result.push({ path: current, type: "directory" });
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
      return;
    }
    if (stat.isFile()) {
      result.push({ path: current, type: "file", sha256: hash(fs.readFileSync(current)) });
      return;
    }
    result.push({ path: current, type: "other" });
  };
  visit(target);
  return result;
}

function inFileState(target: string): { type: "absent" | "file"; sha256?: string } {
  const stat = lstat(target);
  if (stat === null) return { type: "absent" };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`in-file reset target must be a regular file, not a link or directory: ${target}`);
  }
  return { type: "file", sha256: hash(fs.readFileSync(target)) };
}

function expandTemplate(template: string, roots: Record<string, string>): string {
  return path.resolve(template.replaceAll("{project}", roots.project).replaceAll("{home}", roots.runtime_home).replaceAll("{install_root}", roots.install_root));
}

function runtimeTargets(roots: Record<string, string>, contract: NativeResourceCleanupContract): ProductV1ResetScopeTarget[] {
  const targets: ProductV1ResetScopeTarget[] = [];
  for (const resource of contract.diagnosticResources) {
    const names = resource.names.length > 0 ? resource.names : [null];
    for (const name of names)
      for (const destination of resource.destinations) {
        // Product-v1 reset remains bound to its own declared roots; configured
        // OpenCode migration roots belong only to retired-resource cleanup.
        if (destination.includes("{opencode_config}")) continue;
        const declared = name === null ? destination : destination.replaceAll("{name}", name);
        const target = expandTemplate(declared, roots);
        const root = declared.startsWith("{project}") ? roots.project : declared.startsWith("{install_root}") ? roots.install_root : roots.runtime_home;
        assertContained(root, target);
        targets.push(
          resource.contains === null
            ? { declared, operation: "remove_path", path: target, entries: snapshot(target) }
            : {
                declared,
                operation: "remove_in_file_selector",
                path: target,
                selector: { kind: "contains", value: resource.contains },
                file_state: inFileState(target),
              },
        );
      }
  }
  for (const unit of contract.configuration) {
    const target = expandTemplate(unit.destination, roots);
    assertContained(roots.runtime_home, target);
    targets.push({
      declared: unit.destination,
      operation: "remove_in_file_selector",
      path: target,
      selector: { kind: "key", value: unit.key },
      file_state: inFileState(target),
    });
  }
  return targets;
}

function evidence(project: string, installRoot: string, manifest: string): string[] {
  const authority = loadProductV1ResetAuthority();
  const found = authority.projectArtifacts.filter((item) => item.triggersReset && fs.existsSync(path.join(project, item.path))).map((item) => path.join(project, item.path));
  const registryPath = path.join(installRoot, manifest);
  if (fs.existsSync(registryPath)) {
    try {
      const value = JSON.parse(fs.readFileSync(registryPath, "utf8")) as {
        skills?: Array<{ version?: unknown }>;
      };
      if (typeof value.skills?.[0]?.version === "string" && /^1\./.test(value.skills[0].version)) found.push(registryPath);
    } catch {
      /* malformed state is not product-generation evidence */
    }
  }
  return found.sort();
}

export function previewProductV1Reset(options: ProductV1ResetOptions = {}, dependencies: ProductV1ResetDependencies = {}): ProductV1ResetPreview {
  const roots = resolvedRoots(options);
  const project = roots.project!;
  const installRoot = roots.install_root!;
  const authority = loadProductV1ResetAuthority();
  const foundEvidence = evidence(project, installRoot, authority.installationPackage.manifest);
  if (foundEvidence.length === 0) throw new Error("product-v1 reset requires declared product-v1 generation evidence");

  const rootFor = (name: string): string => (name === "runtime_declared_roots" ? roots.runtime_home! : roots[name]!);
  const deletions = authority.scope
    .filter((item) => item.action === "delete")
    .map((item) => ({
      id: item.id,
      owner: item.owner,
      root: rootFor(item.boundedRoot),
      targets:
        item.boundedRoot === "runtime_declared_roots"
          ? runtimeTargets(roots, dependencies.runtimeContract ?? loadNativeResourceCleanupContract())
          : item.targets.map((declared) => {
              const target = path.resolve(rootFor(item.boundedRoot), declared);
              assertContained(rootFor(item.boundedRoot), target);
              return {
                declared,
                operation: "remove_path" as const,
                path: target,
                entries: snapshot(target),
              };
            }),
    }));
  const recreations = authority.scope
    .filter((item) => item.action === "recreate")
    .map((item) => ({
      id: item.id,
      owner: item.owner,
      root: rootFor(item.boundedRoot),
      targets: item.targets.map((declared) => ({ declared })),
    }));
  const unsigned = {
    schemaVersion: "agentera.productV1ResetPreview.v1" as const,
    mode: "preview" as const,
    status: "review_required" as const,
    evidence: foundEvidence,
    roots,
    deletions,
    recreations,
    irreversible_loss: deletions.map(({ id }) => `${id}: permanently removes only the listed paths and in-file selectors; no backup, rollback, or restore is available.`),
    mutation_performed: false as const,
  };
  return { ...unsigned, authorization: `sha256:${hash(JSON.stringify(unsigned))}` };
}

const RESET_JOURNAL = ".agentera-product-v1-reset.json";
const RESET_JOURNAL_STAGING = `${RESET_JOURNAL}.staging`;
const SELECTOR_STAGING_SUFFIX = ".agentera-product-v1-reset.staging";

type ResetStage = "prepared" | "deleting" | "initializing" | "complete";

interface SelectorState {
  path: string;
  before: "absent" | string;
  after: "absent" | string;
}

interface ResetJournal {
  schemaVersion: "agentera.productV1ResetJournal.v1";
  preview: ProductV1ResetPreview;
  selector_states: SelectorState[];
  stage: ResetStage;
  digest: string;
}

function validatedScope(preview: ProductV1ResetPreview): ProductV1ResetValidatedScope {
  return { roots: preview.roots, deletions: preview.deletions, recreations: preview.recreations };
}

function journalPath(project: string): string {
  return path.join(project, RESET_JOURNAL);
}

function journalStagingPath(project: string): string {
  return path.join(project, RESET_JOURNAL_STAGING);
}

function selectorStagingPath(target: string): string {
  return `${target}${SELECTOR_STAGING_SUFFIX}`;
}

function journalDigest(journal: Omit<ResetJournal, "stage" | "digest">): string {
  return hash(JSON.stringify(journal));
}

function assertRegularJournalFile(target: string): void {
  const stat = lstat(target);
  if (stat === null) return;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`product-v1 reset journal is not a regular file: ${target}`);
}

function parseJournal(project: string, authorization: string): ResetJournal | null {
  const target = journalPath(project);
  if (lstat(target) === null) return null;
  assertRegularJournalFile(target);
  const journal = JSON.parse(fs.readFileSync(target, "utf8")) as ResetJournal;
  if (journal.schemaVersion !== "agentera.productV1ResetJournal.v1" || journal.preview?.authorization !== authorization) {
    throw new Error("product-v1 reset journal does not match the approved operation");
  }
  const { authorization: _stored, ...unsigned } = journal.preview;
  if (`sha256:${hash(JSON.stringify(unsigned))}` !== authorization) throw new Error("product-v1 reset journal scope is corrupt");
  if (!["prepared", "deleting", "initializing", "complete"].includes(journal.stage)) throw new Error("product-v1 reset journal stage is corrupt");
  const digestInput = {
    schemaVersion: journal.schemaVersion,
    preview: journal.preview,
    selector_states: journal.selector_states,
  };
  if (journal.digest !== journalDigest(digestInput)) throw new Error("product-v1 reset journal is corrupt");
  return journal;
}

function writeJournal(project: string, journal: ResetJournal): void {
  const staging = journalStagingPath(project);
  assertRegularJournalFile(staging);
  fs.rmSync(staging, { force: true });
  fs.writeFileSync(staging, JSON.stringify(journal) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(staging, journalPath(project));
}

function journalFor(preview: ProductV1ResetPreview, stage: ResetStage): ResetJournal {
  const selector_states = selectorStates(validatedScope(preview));
  const base = {
    schemaVersion: "agentera.productV1ResetJournal.v1" as const,
    preview,
    selector_states,
  };
  return { ...base, stage, digest: journalDigest(base) };
}

function setJournalStage(project: string, journal: ResetJournal, stage: ResetStage): ResetJournal {
  const updated = { ...journal, stage };
  writeJournal(project, updated);
  return updated;
}

function removeTomlSection(lines: string[], header: string): string[] {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactHeader = new RegExp(`^\\s*${escaped}\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => exactHeader.test(line));
  if (start < 0) return lines;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[.+\]\s*(?:#.*)?$/.test(lines[end]!)) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)];
}

function removeTomlKey(lines: string[], dottedKey: string): string[] {
  const parts = dottedKey.split(".");
  const key = parts.pop()!;
  const section = parts.join(".");
  let current = "";
  return lines.filter((line) => {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) current = header[1]!.trim();
    return !(current === section && new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(line));
  });
}

function transformedSelectors(original: string, selectors: NonNullable<ProductV1ResetScopeTarget["selector"]>[]): string {
  const trailingNewline = original.endsWith("\n");
  let lines = original.split("\n");
  if (trailingNewline) lines.pop();
  for (const selector of selectors) {
    if (selector.kind === "key") lines = removeTomlKey(lines, selector.value);
    else if (selector.value.startsWith("[") && selector.value.endsWith("]")) lines = removeTomlSection(lines, selector.value);
    else lines = removeTomlKey(lines, selector.value);
  }
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

function selectorGroups(scope: ProductV1ResetValidatedScope): Map<string, NonNullable<ProductV1ResetScopeTarget["selector"]>[]> {
  const groups = new Map<string, NonNullable<ProductV1ResetScopeTarget["selector"]>[]>();
  for (const deletion of scope.deletions)
    for (const target of deletion.targets) {
      if (target.operation === "remove_in_file_selector" && target.path && target.selector) {
        groups.set(target.path, [...(groups.get(target.path) ?? []), target.selector]);
      }
    }
  return groups;
}

function selectorStates(scope: ProductV1ResetValidatedScope): SelectorState[] {
  return [...selectorGroups(scope)].map(([target, selectors]) => {
    const stat = lstat(target);
    if (stat === null) return { path: target, before: "absent", after: "absent" };
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`in-file reset target must be a regular file: ${target}`);
    const original = fs.readFileSync(target, "utf8");
    const approved = scope.deletions.flatMap((deletion) => deletion.targets).find((candidate) => candidate.path === target)?.file_state?.sha256;
    if (approved !== hash(original)) throw new Error("product-v1 reset scope changed after preview; run a new preview and review its authorization");
    return {
      path: target,
      before: hash(original),
      after: hash(transformedSelectors(original, selectors)),
    };
  });
}

function cleanSelectorStaging(states: SelectorState[]): void {
  for (const state of states) fs.rmSync(selectorStagingPath(state.path), { force: true });
}

function removeSelectors(target: string, selectors: NonNullable<ProductV1ResetScopeTarget["selector"]>[], afterEffect?: ProductV1ResetDependencies["afterEffect"]): void {
  const stat = lstat(target);
  if (stat === null) return;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`in-file reset target must remain a regular file: ${target}`);
  const original = fs.readFileSync(target, "utf8");
  const updated = transformedSelectors(original, selectors);
  if (updated === original) return;
  const staging = selectorStagingPath(target);
  const mode = stat.mode & 0o7777;
  fs.writeFileSync(staging, updated, { flag: "wx", mode });
  fs.chmodSync(staging, mode);
  afterEffect?.(`selector-staged:${target}`);
  fs.renameSync(staging, target);
}

function sameScopePath(left: ScopePath, right: ScopePath): boolean {
  return left.path === right.path && left.type === right.type && left.sha256 === right.sha256 && left.link_target === right.link_target;
}

function validateRemovePath(target: ProductV1ResetScopeTarget, exact: boolean): void {
  const approved = target.entries ?? [];
  const current = snapshot(target.path!);
  if (current.length === 1 && current[0]!.type === "absent") {
    if (exact && !(approved.length === 1 && approved[0]!.type === "absent")) throw new Error(`reset retry target changed after approval: ${target.path}`);
    return;
  }
  const approvedByPath = new Map(approved.map((entry) => [entry.path, entry]));
  if (current.some((entry) => !approvedByPath.has(entry.path) || !sameScopePath(entry, approvedByPath.get(entry.path)!))) {
    throw new Error(`reset retry target has a new or changed entry: ${target.path}`);
  }
  if (exact && (current.length !== approved.length || approved.some((entry) => !current.some((candidate) => sameScopePath(candidate, entry))))) {
    throw new Error(`reset retry target changed after approval: ${target.path}`);
  }
}

function validateSelectorState(state: SelectorState, stage: ResetStage): void {
  const stat = lstat(state.path);
  if (stat === null) {
    if (stage === "prepared" && state.before !== "absent") throw new Error(`reset retry selector target changed after approval: ${state.path}`);
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`reset retry selector target changed after approval: ${state.path}`);
  const current = hash(fs.readFileSync(state.path));
  const allowed = stage === "initializing" ? [state.after] : stage === "prepared" ? [state.before] : [state.before, state.after];
  if (!allowed.includes(current)) throw new Error(`reset retry selector target has changed: ${state.path}`);
}

function validateRetryState(journal: ResetJournal): void {
  const scope = validatedScope(journal.preview);
  const exact = journal.stage === "prepared";
  for (const deletion of scope.deletions)
    for (const target of deletion.targets) {
      if (target.operation === "remove_path" && target.path) {
        if (journal.stage === "initializing") {
          const current = snapshot(target.path);
          if (!(current.length === 1 && current[0]!.type === "absent")) {
            throw new Error(`reset retry target reappeared after deletion: ${target.path}`);
          }
        } else validateRemovePath(target, exact);
      }
    }
  for (const state of journal.selector_states) validateSelectorState(state, journal.stage);
}

function loadResetJournal(options: ProductV1ResetOptions, authorization: string, dependencies: ProductV1ResetDependencies, project: string): { journal: ResetJournal; retry: boolean } {
  const target = journalPath(project);
  const staging = journalStagingPath(project);
  const hasTarget = lstat(target) !== null;
  const hasStaging = lstat(staging) !== null;
  if (hasStaging) assertRegularJournalFile(staging);

  if (hasTarget) {
    try {
      const journal = parseJournal(project, authorization)!;
      if (hasStaging) fs.rmSync(staging, { force: true });
      return { journal, retry: true };
    } catch (error) {
      try {
        const preview = approvedProductV1ResetPreview(options, authorization, dependencies);
        const journal = journalFor(preview, "prepared");
        writeJournal(project, journal);
        return { journal, retry: true };
      } catch {
        throw new Error(`product-v1 reset journal cannot be recovered after effects may have begun: ${(error as Error).message}`);
      }
    }
  }

  const preview = approvedProductV1ResetPreview(options, authorization, dependencies);
  const journal = journalFor(preview, "prepared");
  writeJournal(project, journal);
  return { journal, retry: false };
}

function initializeFreshV3(scope: ProductV1ResetValidatedScope): void {
  const sourceRoot = resolveSourceRoot();
  applyAppContentRefresh(scope.roots.install_root!, sourceRoot);
  const skill = path.join(scope.roots.runtime_home!, ".agents", "skills", "agentera");
  assertContained(scope.roots.runtime_home!, skill);
  fs.rmSync(skill, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.symlinkSync(path.join(scope.roots.install_root!, "skills", "agentera"), skill);
  if (classifyProjectState(scope.roots.project!, sourceRoot).state !== "fresh_uninitialized") {
    throw new Error("canonical fresh-v3 project initialization did not produce fresh_uninitialized state");
  }
}

export function applyProductV1Reset(options: ProductV1ResetOptions, authorization: string, dependencies: ProductV1ResetDependencies = {}): ProductV1ResetResult {
  const roots = resolvedRoots(options);
  let { journal, retry } = loadResetJournal(options, authorization, dependencies, roots.project!);
  if (JSON.stringify(journal.preview.roots) !== JSON.stringify(roots)) {
    throw new Error("product-v1 reset retry roots do not match the approved operation");
  }
  if (retry) cleanSelectorStaging(journal.selector_states);
  if (!retry) {
    dependencies.afterEffect?.("journal");
  }
  const scope = validatedScope(journal.preview);
  if (journal.stage !== "complete") validateRetryState(journal);

  if (journal.stage === "prepared") journal = setJournalStage(roots.project!, journal, "deleting");
  if (journal.stage === "deleting") {
    for (const deletion of scope.deletions)
      for (const target of deletion.targets) {
        const targetRoot = target.declared.startsWith("{project}") ? scope.roots.project! : target.declared.startsWith("{install_root}") ? scope.roots.install_root! : deletion.id === "runtime.resources" ? scope.roots.runtime_home! : deletion.root;
        if (target.path) assertContained(targetRoot, target.path);
        if (target.operation === "remove_path" && target.path) {
          if (retry) validateRemovePath(target, false);
          fs.rmSync(target.path, { recursive: true, force: true });
          dependencies.afterEffect?.(`delete:${deletion.id}:${target.declared}`);
        }
      }
    for (const [target, approvedSelectors] of selectorGroups(scope)) {
      if (retry)
        validateSelectorState(
          journal.selector_states.find((state) => state.path === target)!,
          "deleting",
        );
      removeSelectors(target, approvedSelectors, dependencies.afterEffect);
      dependencies.afterEffect?.(`selectors:${target}`);
    }
    journal = setJournalStage(roots.project!, journal, "initializing");
  }

  if (journal.stage === "initializing") {
    initializeFreshV3(scope);
    journal = setJournalStage(roots.project!, journal, "complete");
    dependencies.afterEffect?.("initialize:fresh-v3");
  }
  cleanSelectorStaging(journal.selector_states);
  fs.rmSync(journalStagingPath(roots.project!), { force: true });
  fs.rmSync(journalPath(roots.project!), { force: true });
  return {
    schemaVersion: "agentera.productV1ResetApply.v1",
    status: "complete",
    authorization,
    validated_scope: scope,
    effects_performed: true,
  };
}

export function authorizeProductV1Reset(
  options: ProductV1ResetOptions,
  authorization: string,
  dependencies: ProductV1ResetDependencies = {},
): {
  schemaVersion: "agentera.productV1ResetAuthorization.v1";
  status: "authorized";
  authorization: string;
  validated_scope: ProductV1ResetValidatedScope;
  effects_performed: false;
} {
  const current = approvedProductV1ResetPreview(options, authorization, dependencies);
  return {
    schemaVersion: "agentera.productV1ResetAuthorization.v1",
    status: "authorized",
    authorization,
    validated_scope: validatedScope(current),
    effects_performed: false,
  };
}

function approvedProductV1ResetPreview(options: ProductV1ResetOptions, authorization: string, dependencies: ProductV1ResetDependencies): ProductV1ResetPreview {
  const current = previewProductV1Reset(options, dependencies);
  if (authorization !== current.authorization) {
    throw new Error("product-v1 reset scope changed after preview; run a new preview and review its authorization");
  }
  return current;
}
