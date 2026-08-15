import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveProfileDirOverride } from "../core/envPaths.js";
import { expanduser } from "../core/paths.js";
import {
  loadNativeResourceCleanupContract,
  type NativeResourceCleanupContract,
} from "../runtime/nativeResourceCleanup.js";
import { defaultAppHome } from "../state/installRoot.js";
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
}

export interface ProductV1ResetValidatedScope {
  roots: Record<string, string>;
  deletions: Array<{ id: string; owner: string; root: string; targets: ProductV1ResetScopeTarget[] }>;
  recreations: Array<{ id: string; owner: string; root: string; targets: ProductV1ResetScopeTarget[] }>;
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
  try { return fs.lstatSync(target); } catch (error) {
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
  return path.resolve(template
    .replaceAll("{project}", roots.project)
    .replaceAll("{home}", roots.runtime_home)
    .replaceAll("{install_root}", roots.install_root));
}

function runtimeTargets(roots: Record<string, string>, contract: NativeResourceCleanupContract): ProductV1ResetScopeTarget[] {
  const targets: ProductV1ResetScopeTarget[] = [];
  for (const resource of contract.diagnosticResources) {
    const names = resource.names.length > 0 ? resource.names : [null];
    for (const name of names) for (const destination of resource.destinations) {
      const declared = name === null ? destination : destination.replaceAll("{name}", name);
      const target = expandTemplate(declared, roots);
      const root = declared.startsWith("{project}") ? roots.project
        : declared.startsWith("{install_root}") ? roots.install_root : roots.runtime_home;
      assertContained(root, target);
      targets.push(resource.contains === null
        ? { declared, operation: "remove_path", path: target, entries: snapshot(target) }
        : {
            declared,
            operation: "remove_in_file_selector",
            path: target,
            selector: { kind: "contains", value: resource.contains },
            file_state: inFileState(target),
          });
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
  const found = authority.projectArtifacts
    .filter((item) => item.triggersReset && fs.existsSync(path.join(project, item.path)))
    .map((item) => path.join(project, item.path));
  const registryPath = path.join(installRoot, manifest);
  if (fs.existsSync(registryPath)) {
    try {
      const value = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { skills?: Array<{ version?: unknown }> };
      if (typeof value.skills?.[0]?.version === "string" && /^1\./.test(value.skills[0].version)) found.push(registryPath);
    } catch { /* malformed state is not product-generation evidence */ }
  }
  return found.sort();
}

export function previewProductV1Reset(
  options: ProductV1ResetOptions = {},
  dependencies: ProductV1ResetDependencies = {},
): ProductV1ResetPreview {
  const env = options.env ?? process.env;
  const home = safeRoot("runtime home", options.home ?? os.homedir());
  const project = safeRoot("project root", options.project ?? process.cwd());
  const installCandidate = options.installRoot ?? env.AGENTERA_HOME ?? env.AGENTERA_DEFAULT_INSTALL_ROOT
    ?? defaultAppHome(env, home);
  const installRoot = safeRoot("install root", installCandidate);
  const profileRoot = safeRoot("profile root", resolveProfileDirOverride(env) ?? installRoot);
  const roots = { project, profile_root: profileRoot, install_root: installRoot, runtime_home: home };
  const authority = loadProductV1ResetAuthority();
  const foundEvidence = evidence(project, installRoot, authority.installationPackage.manifest);
  if (foundEvidence.length === 0) throw new Error("product-v1 reset requires declared product-v1 generation evidence");

  const rootFor = (name: string): string => name === "runtime_declared_roots" ? home : roots[name as keyof typeof roots];
  const deletions = authority.scope.filter((item) => item.action === "delete").map((item) => ({
    id: item.id,
    owner: item.owner,
    root: rootFor(item.boundedRoot),
    targets: item.boundedRoot === "runtime_declared_roots"
      ? runtimeTargets(roots, dependencies.runtimeContract ?? loadNativeResourceCleanupContract())
      : item.targets.map((declared) => {
      const target = path.resolve(rootFor(item.boundedRoot), declared);
      assertContained(rootFor(item.boundedRoot), target);
      return { declared, operation: "remove_path" as const, path: target, entries: snapshot(target) };
    }),
  }));
  const recreations = authority.scope.filter((item) => item.action === "recreate").map((item) => ({
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
  const current = previewProductV1Reset(options, dependencies);
  if (authorization !== current.authorization) {
    throw new Error("product-v1 reset scope changed after preview; run a new preview and review its authorization");
  }
  return {
    schemaVersion: "agentera.productV1ResetAuthorization.v1",
    status: "authorized",
    authorization,
    validated_scope: {
      roots: current.roots,
      deletions: current.deletions,
      recreations: current.recreations,
    },
    effects_performed: false,
  };
}
