import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProfileDirOverride } from "../core/envPaths.js";
import { expanduser } from "../core/paths.js";
import { resolveSourceRoot } from "../core/sourceRoot.js";
import { loadNativeResourceCleanupContract, type NativeResourceCleanupContract } from "../runtime/nativeResourceCleanup.js";
import { classifyProjectState } from "../state/stateMode.js";
import { applyAppContentRefresh } from "./appContentRefresh.js";
import { assessProductV1Evidence, loadProductV1ResetAuthority, productV1EvidencePaths, productV1InstallRootCandidate } from "./productV1ResetAuthority.js";
import { hostSkillPath, loadHostSkillSource, runHostSkillLifecycle } from "../setup/hostSkillLifecycle.js";
import { observeLifecyclePath, removeLifecycleResource, secureLifecycleRemovalAvailable } from "../runtime/lifecyclePublication.js";
import { PROFILE_FILE_MEMBERS, USER_DATA_CATALOG_DIRS } from "../migrate/v2HandoffManifest.js";

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
  identity?: { device: string; inode: string };
}

export interface ProductV1ResetScopeTarget {
  declared: string;
  operation?: "remove_path" | "remove_in_file_selector";
  path?: string;
  selector?: { kind: "contains" | "key"; value: string };
  entries?: ScopePath[];
  file_state?: { type: "absent" | "file"; sha256?: string };
  delivery?: { sourceRoot: string; fingerprint: string; files: string[] };
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

/** Top-level names the bounded preview names per deletion before it reports an omitted count. */
export const PRODUCT_V1_RESET_SUMMARY_NAME_LIMIT = 12;

/** Stdout bound for the default preview; above it the preview keeps counts and user data but drops other names. */
export const PRODUCT_V1_RESET_PREVIEW_BYTE_BUDGET = 8192;

export type ProductV1ResetUserDataKind = "profile" | "history" | "usage_report" | "sessions" | "benchmarks" | "extracted_evidence";

// The handoff catalog owns the user-data names. Doctor also preserves the legacy
// root corpus.json, which is extracted evidence. Doctor's other preserved names
// (TODO, changelog, design, handoff manifest) are not user data.
const LEGACY_ROOT_EVIDENCE_FILE = "corpus.json";
const USER_DATA_KINDS: Record<(typeof PROFILE_FILE_MEMBERS)[number] | (typeof USER_DATA_CATALOG_DIRS)[number] | typeof LEGACY_ROOT_EVIDENCE_FILE, ProductV1ResetUserDataKind> = {
  "PROFILE.md": "profile",
  "USAGE.md": "usage_report",
  history: "history",
  sessions: "sessions",
  benchmarks: "benchmarks",
  intermediate: "extracted_evidence",
  corpus: "extracted_evidence",
  [LEGACY_ROOT_EVIDENCE_FILE]: "extracted_evidence",
};

export const PRODUCT_V1_RESET_USER_DATA_NAMES: readonly string[] = Object.keys(USER_DATA_KINDS);

function userDataKind(name: string): ProductV1ResetUserDataKind | null {
  return Object.hasOwn(USER_DATA_KINDS, name) ? USER_DATA_KINDS[name as keyof typeof USER_DATA_KINDS] : null;
}

export interface ProductV1ResetUserDataEntry {
  scope: string;
  kind: ProductV1ResetUserDataKind;
  path: string;
  type: ScopePath["type"];
  entry_count: number;
}

/** A path relative to one entry of the preview's `roots` map, so the summary prints each root once. */
export interface ProductV1ResetRootPath {
  root: string;
  path: string;
}

export interface ProductV1ResetSummaryUserDataEntry extends ProductV1ResetRootPath {
  kind: ProductV1ResetUserDataKind;
  type: ScopePath["type"];
  entry_count: number;
}

export interface ProductV1ResetDeletionSummary {
  id: string;
  root: string;
  entry_count: number;
  shared_with?: string;
  entries: Record<string, number>;
  omitted_count: number;
}

/** Bounded view of a preview. It carries the preview's authorization, which binds the complete snapshot. */
export interface ProductV1ResetPreviewSummary {
  schemaVersion: ProductV1ResetPreview["schemaVersion"];
  mode: "preview";
  status: "review_required";
  detail: "summary";
  name_limit: number;
  evidence: ProductV1ResetRootPath[];
  roots: Record<string, string>;
  user_data: ProductV1ResetSummaryUserDataEntry[];
  deletions: ProductV1ResetDeletionSummary[];
  recreations: Array<{ id: string; root: string; targets: string[] }>;
  irreversible_loss: string[];
  authorization: string;
  mutation_performed: false;
}

/** Complete view of a preview: every deleted entry, with a tree shared by two scopes listed once. */
export interface ProductV1ResetPreviewFullDetail extends Omit<ProductV1ResetPreview, "deletions"> {
  detail: "full";
  user_data: ProductV1ResetUserDataEntry[];
  deletions: Array<{
    id: string;
    owner: string;
    root: string;
    targets: Array<ProductV1ResetScopeTarget | { declared: string; operation?: ProductV1ResetScopeTarget["operation"]; path?: string; shared_with: string }>;
  }>;
}

function present(entries: ScopePath[] | undefined): ScopePath[] {
  return (entries ?? []).filter((entry) => entry.type !== "absent");
}

/** First deletion that already lists the same whole-tree target, so a shared tree appears once. */
function sharedTargets(preview: ProductV1ResetPreview): Map<ProductV1ResetScopeTarget, string> {
  const owners = new Map<string, string>();
  const shared = new Map<ProductV1ResetScopeTarget, string>();
  for (const deletion of preview.deletions)
    for (const target of deletion.targets) {
      if (target.operation !== "remove_path" || !target.path) continue;
      const owner = owners.get(target.path);
      if (owner !== undefined) shared.set(target, owner);
      else owners.set(target.path, deletion.id);
    }
  return shared;
}

function collectUserData(preview: ProductV1ResetPreview, shared: Map<ProductV1ResetScopeTarget, string>): ProductV1ResetUserDataEntry[] {
  const result: ProductV1ResetUserDataEntry[] = [];
  for (const deletion of preview.deletions)
    for (const target of deletion.targets) {
      if (target.declared !== "." || !target.path || shared.has(target)) continue;
      const byName = new Map<string, ProductV1ResetUserDataEntry>();
      for (const entry of present(target.entries)) {
        const name = path.relative(target.path, entry.path).split(path.sep)[0]!;
        const kind = name === "" ? null : userDataKind(name);
        if (kind === null) continue;
        const existing = byName.get(name);
        if (existing) existing.entry_count += 1;
        else byName.set(name, { scope: deletion.id, kind, path: path.join(target.path, name), type: entry.type, entry_count: 1 });
      }
      result.push(...[...byName.values()].sort((left, right) => left.path.localeCompare(right.path)));
    }
  return result;
}

function selectorName(target: ProductV1ResetScopeTarget): string {
  return `${target.declared} (${target.selector!.kind}: ${target.selector!.value})`;
}

const ROOT_PREFERENCE = ["project", "install_root", "profile_root", "runtime_home"];

/** The most specific root containing `target`; equal roots resolve in ROOT_PREFERENCE order. */
function rootPath(roots: Record<string, string>, target: string): ProductV1ResetRootPath {
  let best: ProductV1ResetRootPath | null = null;
  let bestLength = -1;
  for (const name of [...ROOT_PREFERENCE, ...Object.keys(roots).filter((key) => !ROOT_PREFERENCE.includes(key))]) {
    const root = roots[name];
    if (root === undefined) continue;
    const relative = path.relative(root, target);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    if (root.length > bestLength) {
      best = { root: name, path: relative === "" ? "." : relative };
      bestLength = root.length;
    }
  }
  return best ?? { root: "absolute", path: target };
}

function scopeRootNames(): Map<string, string> {
  return new Map(loadProductV1ResetAuthority().scope.map((item) => [item.id, item.boundedRoot === "runtime_declared_roots" ? "runtime_home" : item.boundedRoot]));
}

export function summarizeProductV1ResetPreview(preview: ProductV1ResetPreview, nameLimit: number = PRODUCT_V1_RESET_SUMMARY_NAME_LIMIT): ProductV1ResetPreviewSummary {
  const shared = sharedTargets(preview);
  const rootNames = scopeRootNames();
  const rootName = (id: string, root: string): string => rootNames.get(id) ?? rootPath(preview.roots, root).root;
  const deletions = preview.deletions.map((deletion): ProductV1ResetDeletionSummary => {
    const counts = new Map<string, number>();
    let entryCount = 0;
    let sharedWith: string | undefined;
    for (const target of deletion.targets) {
      const owner = shared.get(target);
      if (owner !== undefined) {
        sharedWith = owner;
        continue;
      }
      if (target.operation === "remove_in_file_selector") {
        if (target.file_state?.type !== "file") continue;
        counts.set(selectorName(target), 1);
        entryCount += 1;
        continue;
      }
      const entries = present(target.entries);
      entryCount += entries.length;
      if (entries.length === 0) continue;
      if (target.declared !== ".") {
        counts.set(target.declared, (counts.get(target.declared) ?? 0) + entries.length);
        continue;
      }
      for (const entry of entries) {
        const name = path.relative(target.path!, entry.path).split(path.sep)[0]!;
        if (name === "" || userDataKind(name) !== null) continue;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    const names = [...counts.keys()].sort();
    return {
      id: deletion.id,
      root: rootName(deletion.id, deletion.root),
      entry_count: entryCount,
      ...(sharedWith !== undefined ? { shared_with: sharedWith } : {}),
      entries: Object.fromEntries(names.slice(0, nameLimit).map((name) => [name, counts.get(name)!])),
      omitted_count: Math.max(0, names.length - nameLimit),
    };
  });
  return {
    schemaVersion: preview.schemaVersion,
    mode: preview.mode,
    status: preview.status,
    detail: "summary",
    name_limit: nameLimit,
    evidence: preview.evidence.map((item) => rootPath(preview.roots, item)),
    roots: preview.roots,
    user_data: collectUserData(preview, shared).map((entry) => ({ kind: entry.kind, root: rootName(entry.scope, path.dirname(entry.path)), path: path.basename(entry.path), type: entry.type, entry_count: entry.entry_count })),
    deletions,
    recreations: preview.recreations.map((item) => ({ id: item.id, root: rootName(item.id, item.root), targets: item.targets.map((target) => target.declared) })),
    irreversible_loss: preview.irreversible_loss,
    authorization: preview.authorization,
    mutation_performed: preview.mutation_performed,
  };
}

export function fullDetailProductV1ResetPreview(preview: ProductV1ResetPreview): ProductV1ResetPreviewFullDetail {
  const shared = sharedTargets(preview);
  return {
    ...preview,
    detail: "full",
    user_data: collectUserData(preview, shared),
    deletions: preview.deletions.map((deletion) => ({
      ...deletion,
      targets: deletion.targets.map((target) => {
        const owner = shared.get(target);
        return owner === undefined ? target : { declared: target.declared, operation: target.operation, path: target.path, shared_with: owner };
      }),
    })),
  };
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
  const installRoot = safeRoot("install root", productV1InstallRootCandidate(options.installRoot, env, home));
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
  const skill = hostSkillPath(roots.runtime_home!);
  const observed = observeLifecyclePath(skill, [roots.runtime_home!]);
  if (observed.unsafeReason || !["missing", "symlink", "directory"].includes(observed.kind)) throw new Error("Unsafe reset host destination; preserve it for manual recovery.");
  if (observed.kind === "directory" && fs.readdirSync(skill).some((name) => name !== "SKILL.md")) throw new Error("Reset preserves full copied host trees and unowned extras. First preview and explicitly approve upgrade --shared-skill conversion, or perform separately approved manual recovery.");
  const targets: ProductV1ResetScopeTarget[] = [
    {
      declared: "{home}/.agents/skills/agentera",
      operation: "remove_path",
      path: skill,
      entries: hostSnapshot(skill, roots.runtime_home!),
    },
  ];
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

function hostSnapshot(skill: string, home: string): ScopePath[] {
  return snapshot(skill).map((entry) => {
    const observed = observeLifecyclePath(entry.path, [home]);
    if (observed.unsafeReason || observed.kind === "other" || (observed.kind === "file" && fs.lstatSync(entry.path).nlink !== 1)) throw new Error("Unsafe reset host entry; preserve it for manual recovery.");
    return { ...entry, ...(observed.identity ? { identity: observed.identity } : {}) };
  });
}

export function previewProductV1Reset(options: ProductV1ResetOptions = {}, dependencies: ProductV1ResetDependencies = {}): ProductV1ResetPreview {
  const roots = resolvedRoots(options);
  const project = roots.project!;
  const installRoot = roots.install_root!;
  const authority = loadProductV1ResetAuthority();
  const foundEvidence = productV1EvidencePaths(assessProductV1Evidence({ project, installRoot }, authority));
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
      targets: item.targets.map((declared) => ({
        declared,
        ...(item.id === "runtime.canonical-skill"
          ? {
              path: hostSkillPath(roots.runtime_home!),
              delivery: {
                sourceRoot: resolveSourceRoot(),
                fingerprint: loadHostSkillSource(resolveSourceRoot()).fingerprint,
                files: ["SKILL.md"],
              },
            }
          : {}),
      })),
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
  return left.path === right.path && left.type === right.type && left.sha256 === right.sha256 && left.link_target === right.link_target && JSON.stringify(left.identity) === JSON.stringify(right.identity);
}

function validateRemovePath(target: ProductV1ResetScopeTarget, exact: boolean): void {
  const approved = target.entries ?? [];
  const current = target.declared === "{home}/.agents/skills/agentera" ? hostSnapshot(target.path!, path.resolve(target.path!, "../../..")) : snapshot(target.path!);
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
  const delivery = scope.recreations.find((item) => item.id === "runtime.canonical-skill")?.targets[0]?.delivery;
  if (!delivery || delivery.sourceRoot !== sourceRoot || delivery.fingerprint !== loadHostSkillSource(sourceRoot).fingerprint) throw new Error("Reset one-file delivery authority changed; preserve the reset journal and review recovery.");
  applyAppContentRefresh(scope.roots.install_root!, sourceRoot);
  const installed = runHostSkillLifecycle({
    home: scope.roots.runtime_home!,
    appHome: scope.roots.install_root!,
    sourceRoot,
    apply: true,
  });
  if (installed.status === "non_success") throw new Error(`Reset one-file delivery requires recovery: ${installed.reason}`);
  if (classifyProjectState(scope.roots.project!, sourceRoot).state !== "fresh_uninitialized") {
    throw new Error("canonical fresh-v3 project initialization did not produce fresh_uninitialized state");
  }
}

export function applyProductV1Reset(options: ProductV1ResetOptions, authorization: string, dependencies: ProductV1ResetDependencies = {}): ProductV1ResetResult {
  if (!secureLifecycleRemovalAvailable()) throw new Error("Reset one-file delivery requires Linux safe publication; nothing changed.");
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
  const delivery = scope.recreations.find((item) => item.id === "runtime.canonical-skill")?.targets[0]?.delivery;
  if (!delivery || delivery.sourceRoot !== resolveSourceRoot() || delivery.fingerprint !== loadHostSkillSource(resolveSourceRoot()).fingerprint) throw new Error("Reset one-file delivery authority changed; preserve the journal and review recovery before further effects.");
  if (journal.stage !== "complete") validateRetryState(journal);

  if (journal.stage === "prepared") journal = setJournalStage(roots.project!, journal, "deleting");
  if (journal.stage === "deleting") {
    for (const deletion of scope.deletions)
      for (const target of deletion.targets) {
        const targetRoot = target.declared.startsWith("{project}") ? scope.roots.project! : target.declared.startsWith("{install_root}") ? scope.roots.install_root! : deletion.id === "runtime.resources" ? scope.roots.runtime_home! : deletion.root;
        if (target.path) assertContained(targetRoot, target.path);
        if (target.operation === "remove_path" && target.path) {
          if (retry) validateRemovePath(target, false);
          if (target.path === hostSkillPath(scope.roots.runtime_home!)) {
            for (const entry of [...hostSnapshot(target.path, scope.roots.runtime_home!)].reverse()) {
              if (entry.type === "absent") continue;
              if (!(target.entries ?? []).some((approved) => JSON.stringify(approved) === JSON.stringify(entry))) throw new Error("Reset host changed after approval; preserve it for manual recovery.");
              const observed = observeLifecyclePath(entry.path, [scope.roots.runtime_home!]);
              if (observed.kind !== "directory" && observed.kind !== "file" && observed.kind !== "symlink") throw new Error("Reset host entry changed before removal.");
              removeLifecycleResource({ id: "reset.host-skill", destination: entry.path, kind: observed.kind }, observed);
            }
          } else fs.rmSync(target.path, { recursive: true, force: true });
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
