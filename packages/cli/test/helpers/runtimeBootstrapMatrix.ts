import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect } from "vitest";

import { preCutoverCommand } from "../../src/cli/preCutoverCommand.js";
import { DEVELOPMENT_CHILD_PATH } from "../../src/core/developmentInvocation.js";
import { commandText, fullEntityUpgradePreviewCommand } from "../../src/upgrade/upgradeCommands.js";
import {
  BOOTSTRAP_ACCEPTED_SPECS,
  BOOTSTRAP_PROJECT_STATE_IDS,
  BOOTSTRAP_REJECTION_SPECS,
  BOOTSTRAP_RUNTIME_IDS,
  bootstrapMatrixAuthority,
} from "../../src/validate/bootstrapAuthority.js";
import type { PackageFixture } from "../packaging/packageSetup.js";

const DISPATCHER = path.resolve(import.meta.dirname, "preCutoverBootstrapDispatcher.mjs");
const DANGER = `space ; $() & 'quote' [雪]`;

export const RUNTIME_ID_AUTHORITY = BOOTSTRAP_RUNTIME_IDS;
export const PROJECT_STATE_ID_AUTHORITY = BOOTSTRAP_PROJECT_STATE_IDS;

type ProjectState = (typeof PROJECT_STATE_ID_AUTHORITY)[number];
type RuntimeName = (typeof RUNTIME_ID_AUTHORITY)[number];

export const ACCEPTED_OPERATION_AUTHORITY = BOOTSTRAP_ACCEPTED_SPECS;
export const REJECTION_SPEC_AUTHORITY = Object.freeze(BOOTSTRAP_REJECTION_SPECS.map(({ candidate: _candidate, ...entry }) => Object.freeze(entry)));
const ACCEPTED_EXECUTION_SPECS = BOOTSTRAP_ACCEPTED_SPECS;
const REJECTION_EXECUTION_SPECS = BOOTSTRAP_REJECTION_SPECS;

export interface RuntimeMatrixExecutionRegistry {
  runtimeIds: string[];
  stateIds: string[];
  accepted: Array<{ id: string; states: string[]; classification: string }>;
  rejections: Array<{ id: string; states: string[]; classification: string }>;
}

export function runtimeMatrixExecutionRegistry(): RuntimeMatrixExecutionRegistry {
  return bootstrapMatrixAuthority();
}

interface TreeEntry {
  path: string;
  type: "absent" | "directory" | "file" | "symlink" | "other";
  mode?: number;
  sha256?: string;
  target?: string;
  entries?: string[];
}

export interface RowObservation {
  id: string;
  runtime: RuntimeName;
  projectState: ProjectState;
  accepted: boolean;
  exit: number | null;
  classification: string;
  outcome: string | null;
  recoveryCount: number;
  childStarted: boolean;
  preservationRoots: number;
}

export interface RuntimeBootstrapMatrixSummary {
  rows: RowObservation[];
  runtimeCounts: Record<RuntimeName, { accepted: number; rejected: number }>;
  stateCounts: Record<ProjectState, { accepted: number; rejected: number }>;
  preservationRootsPerRow: number;
  childStartRejections: number;
  packageArtifact: { filename: string; integrity: string; shasum: string; files: number };
  expectedCompositeRowIds: string[];
  runtimeObservationDigests: Record<RuntimeName, Record<ProjectState, string>>;
  authority: {
    protectedRootCount: number;
    protectedRootDigest: string;
    compositeRowCount: number;
    compositeRowDigest: string;
    matrixDigest: string;
  };
}

type ProtectedRootKind = "directory" | "file" | "absent";

export interface ProtectedRootPaths {
  project: string;
  home: string;
  sharedSkill: string;
  install: string;
  package: string;
  tarball: string;
  cache: string;
  temporary: string;
  priorAbsence: string;
}

interface ProtectedRootAuthorityEntry {
  readonly id: string;
  readonly pathKey: keyof ProtectedRootPaths;
  readonly kind: ProtectedRootKind;
}

export const PROTECTED_ROOT_AUTHORITY: readonly ProtectedRootAuthorityEntry[] = Object.freeze([
  Object.freeze({ id: "project", pathKey: "project", kind: "directory" }),
  Object.freeze({ id: "home", pathKey: "home", kind: "directory" }),
  Object.freeze({ id: "shared_skill", pathKey: "sharedSkill", kind: "directory" }),
  Object.freeze({ id: "install", pathKey: "install", kind: "directory" }),
  Object.freeze({ id: "package", pathKey: "package", kind: "directory" }),
  Object.freeze({ id: "package_artifact", pathKey: "tarball", kind: "file" }),
  Object.freeze({ id: "cache", pathKey: "cache", kind: "directory" }),
  Object.freeze({ id: "temporary", pathKey: "temporary", kind: "directory" }),
  Object.freeze({ id: "absence", pathKey: "priorAbsence", kind: "absent" }),
]);

export const PROTECTED_ROOT_IDENTIFIERS = Object.freeze(PROTECTED_ROOT_AUTHORITY.map(({ id }) => id));
export const PROTECTED_ROOT_AUTHORITY_COUNT = 9;
export const PROTECTED_ROOT_AUTHORITY_SHA256 = "031fd076c396b44b31fb1d923245976a0d3b2fe1e0037de3ee4b711a08c8fd6e";
export const EXPECTED_COMPOSITE_ROW_COUNT = 190;
export const EXPECTED_COMPOSITE_ROW_SHA256 = "dd3b04ddd46c487b3f0056a16b1b9225fad61cd25988fa907a10520fc41a5da7";
export const RUNTIME_MATRIX_AUTHORITY_SHA256 = "d8af8891a8dfa27618ecd165989f635c252caae46a7f93abe2503cf546f2d73c";

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function absoluteSpelling(target: string): string {
  if (target.length === 0) throw new Error("protected-root physical identity requires a non-empty path");
  if (path.isAbsolute(target)) return target;
  if (path.parse(target).root !== "") {
    throw new Error("protected-root physical identity rejects drive-relative paths");
  }
  return `${process.cwd()}${path.sep}${target}`;
}

export function physicalIdentity(target: string): string {
  const absolute = absoluteSpelling(target);
  const unresolved: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      // Native realpath must see the original '.', separators, and '..' so it
      // applies symlink semantics before any unresolved suffix is normalized.
      return path.resolve(fs.realpathSync.native(cursor), ...unresolved);
    } catch (error) {
      // Only absence permits ancestor walking. Broken links, cycles, ENOTDIR,
      // permission failures, and other ambiguous errors fail closed.
      if (errorCode(error) !== "ENOENT") throw error;
      try {
        if (fs.lstatSync(cursor).isSymbolicLink()) {
          throw new Error(`protected-root physical identity cannot resolve symlink '${cursor}'`);
        }
      } catch (lstatError) {
        if (errorCode(lstatError) !== "ENOENT") throw lstatError;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      unresolved.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function pathKind(target: string): ProtectedRootKind | "other" {
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if (new Set(["ENOENT", "ENOTDIR"]).has(errorCode(error) ?? "")) {
      try {
        fs.lstatSync(target);
        return "other";
      } catch {
        return "absent";
      }
    }
    throw error;
  }
}

function stableAuthorityDigest(): string {
  return digest(JSON.stringify({
    runtimes: RUNTIME_ID_AUTHORITY,
    states: PROJECT_STATE_ID_AUTHORITY,
    accepted: ACCEPTED_OPERATION_AUTHORITY,
    rejections: REJECTION_SPEC_AUTHORITY,
  }));
}

function assertStableAuthorities(): void {
  const protectedRootDigest = digest(JSON.stringify(PROTECTED_ROOT_AUTHORITY));
  if (PROTECTED_ROOT_AUTHORITY.length !== PROTECTED_ROOT_AUTHORITY_COUNT
    || protectedRootDigest !== PROTECTED_ROOT_AUTHORITY_SHA256) {
    throw new Error("protected-root authority count or digest drifted");
  }
  if (stableAuthorityDigest() !== RUNTIME_MATRIX_AUTHORITY_SHA256) {
    throw new Error("runtime matrix identity, classification, or applicability authority drifted");
  }
}

export function assertProtectedRootAuthority(
  roots: ReadonlyArray<readonly [string, string]>,
  paths: ProtectedRootPaths,
): void {
  assertStableAuthorities();
  const identifiers = roots.map(([identifier]) => identifier);
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error("protected-root identifiers must be unique");
  }
  if (identifiers.length !== PROTECTED_ROOT_AUTHORITY.length
    || PROTECTED_ROOT_AUTHORITY.some(({ id }) => !identifiers.includes(id))) {
    throw new Error("protected-root identifiers must match the exact nine-root authority");
  }
  const actualById = new Map(roots);
  const actualPhysical = roots.map(([id, target]) => [id, physicalIdentity(target)] as const);
  const physicalOwners = new Map<string, string>();
  for (const [id, identity] of actualPhysical) {
    const owner = physicalOwners.get(identity);
    if (owner !== undefined) {
      throw new Error(`protected-root physical identities must be unique: ${owner} and ${id}`);
    }
    physicalOwners.set(identity, id);
  }
  for (const { id, pathKey, kind } of PROTECTED_ROOT_AUTHORITY) {
    const actual = actualById.get(id);
    if (actual === undefined || physicalIdentity(actual) !== physicalIdentity(paths[pathKey])) {
      throw new Error(`protected-root '${id}' substituted its fixed physical authority`);
    }
    if (pathKind(actual) !== kind) {
      throw new Error(`protected-root '${id}' must retain ${kind} snapshot semantics`);
    }
  }
}

function compositeRowId(row: Pick<RowObservation, "runtime" | "projectState" | "id">): string {
  return `${row.runtime}/${row.projectState}/${row.id}`;
}

export function assertCompleteCompositeRows(
  rows: ReadonlyArray<Pick<RowObservation, "runtime" | "projectState" | "id">>,
  expectedIds: readonly string[] = expectedCompositeRowAuthority().ids,
): void {
  const actualIds = rows.map(compositeRowId);
  if (new Set(actualIds).size !== actualIds.length) throw new Error("composite runtime matrix row IDs must be unique");
  if (new Set(expectedIds).size !== expectedIds.length) throw new Error("expected composite runtime matrix row IDs must be unique");
  const expectedDigest = digest([...expectedIds].sort().join("\n"));
  if (expectedIds.length !== EXPECTED_COMPOSITE_ROW_COUNT || expectedDigest !== EXPECTED_COMPOSITE_ROW_SHA256) {
    throw new Error("expected composite runtime matrix authority count or digest drifted");
  }
  if (actualIds.length !== expectedIds.length
    || [...actualIds].sort().some((id, index) => id !== [...expectedIds].sort()[index]))
    throw new Error("composite runtime matrix rows are incomplete");
}

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertExactAxis(name: string, actual: readonly string[], expected: readonly string[]): void {
  if (new Set(actual).size !== actual.length) throw new Error(`${name} execution IDs must be unique`);
  if (actual.length !== expected.length
    || [...actual].sort().some((id, index) => id !== [...expected].sort()[index])) {
    throw new Error(`${name} execution IDs must match fixed authority`);
  }
}

function assertExactSpecs(
  name: string,
  actual: ReadonlyArray<{ id: string; states: readonly string[]; classification: string }>,
  expected: readonly MatrixSpecAuthority[],
): void {
  assertExactAxis(`${name} spec`, actual.map(({ id }) => id), expected.map(({ id }) => id));
  const byId = new Map(actual.map((spec) => [spec.id, spec]));
  for (const authority of expected) {
    const spec = byId.get(authority.id);
    if (spec === undefined) throw new Error(`${name} spec '${authority.id}' is missing`);
    if (new Set(spec.states).size !== spec.states.length) {
      throw new Error(`${name} spec '${authority.id}' state applicability must be unique`);
    }
    assertExactAxis(
      `${name} spec '${authority.id}' state applicability`,
      spec.states,
      authority.states,
    );
    if (spec.classification !== authority.classification) {
      throw new Error(`${name} spec '${authority.id}' classification must match fixed authority`);
    }
  }
}

export function assertRuntimeMatrixExecutionRegistry(registry: RuntimeMatrixExecutionRegistry): void {
  assertStableAuthorities();
  assertExactAxis("runtime", registry.runtimeIds, RUNTIME_ID_AUTHORITY);
  assertExactAxis("project-state", registry.stateIds, PROJECT_STATE_ID_AUTHORITY);
  assertExactSpecs("accepted operation", registry.accepted, ACCEPTED_OPERATION_AUTHORITY);
  assertExactSpecs("rejection", registry.rejections, REJECTION_SPEC_AUTHORITY);
}

function expectedCompositeRowAuthority(): { ids: string[]; digest: string } {
  assertStableAuthorities();
  const ids: string[] = [];
  for (const runtime of RUNTIME_ID_AUTHORITY) {
    for (const state of PROJECT_STATE_ID_AUTHORITY) {
      for (const spec of ACCEPTED_OPERATION_AUTHORITY) {
        if (spec.states.includes(state)) ids.push(`${runtime}/${state}/${spec.id}`);
      }
      for (const spec of REJECTION_SPEC_AUTHORITY) {
        if (spec.states.includes(state)) ids.push(`${runtime}/${state}/${spec.id}`);
      }
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("expected composite runtime matrix authority IDs must be unique");
  }
  const rowDigest = digest([...ids].sort().join("\n"));
  if (ids.length !== EXPECTED_COMPOSITE_ROW_COUNT || rowDigest !== EXPECTED_COMPOSITE_ROW_SHA256) {
    throw new Error("expected composite runtime matrix authority count or digest drifted");
  }
  return { ids, digest: rowDigest };
}

function assertAcceptedApplicability(id: string, state: ProjectState): void {
  const spec = ACCEPTED_EXECUTION_SPECS.find((candidate) => candidate.id === id);
  if (spec === undefined || !spec.states.includes(state)) {
    throw new Error(`accepted operation '${id}' is not registered for project state '${state}'`);
  }
}

function snapshot(target: string): TreeEntry[] {
  if (!fs.existsSync(target) && !fs.lstatSync(path.dirname(target)).isSymbolicLink()) {
    return [{ path: ".", type: "absent" }];
  }
  const result: TreeEntry[] = [];
  const visit = (current: string, relative: string): void => {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      result.push({ path: relative, type: "absent" });
      return;
    }
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      result.push({ path: relative, type: "symlink", mode, target: fs.readlinkSync(current) });
      return;
    }
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(current).sort();
      result.push({ path: relative, type: "directory", mode, entries });
      for (const entry of entries) visit(path.join(current, entry), relative === "." ? entry : `${relative}/${entry}`);
      return;
    }
    if (stat.isFile()) {
      result.push({ path: relative, type: "file", mode, sha256: digest(fs.readFileSync(current)) });
      return;
    }
    result.push({ path: relative, type: "other", mode });
  };
  visit(target, ".");
  return result;
}

function snapshots(roots: ReadonlyArray<readonly [string, string]>): Record<string, TreeEntry[]> {
  return Object.fromEntries(roots.map(([label, root]) => [label, snapshot(root)]));
}

function seedDecoys(root: string): void {
  const decoys = path.join(root, `decoys ${DANGER}`);
  fs.mkdirSync(path.join(decoys, "directory"), { recursive: true });
  fs.writeFileSync(path.join(decoys, "bytes.bin"), Buffer.from([0, 1, 2, 255]));
  fs.symlinkSync("bytes.bin", path.join(decoys, "link"));
  fs.symlinkSync("missing-target", path.join(decoys, "broken-link"));
}

function seedProject(project: string, state: ProjectState, v2Fixture: string): void {
  fs.mkdirSync(project, { recursive: true });
  if (state === "v2") fs.cpSync(v2Fixture, project, { recursive: true });
  if (state === "partial") {
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.copyFileSync(path.join(v2Fixture, ".agentera/plan.yaml"), path.join(project, ".agentera/plan.yaml"));
  }
  if (state === "v3") {
    fs.mkdirSync(path.join(project, ".agentera"));
    fs.writeFileSync(path.join(project, ".agentera/state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  }
  seedDecoys(project);
}

function normalized(value: unknown, replacements: readonly string[]): unknown {
  const text = JSON.stringify(value);
  const normalizedText = replacements.reduce((body, item, index) => {
    const placeholder = `<PATH_${index}>`;
    return body
      .split(JSON.stringify(commandText([item])).slice(1, -1)).join(placeholder)
      .split(JSON.stringify(item).slice(1, -1)).join(placeholder)
      .split(item).join(placeholder);
  }, text);
  return JSON.parse(normalizedText);
}

function readOnlyRecoveries(prime: any, doctor: any): string[] {
  const commands = new Set<string>();
  for (const command of prime.capability_context?.context?.status_context?.fallback_commands ?? []) {
    if (typeof command === "string") commands.add(command);
  }
  for (const command of [prime.project_integration?.dry_run_command, doctor.dryRunCommand]) {
    if (typeof command === "string") commands.add(command);
  }
  return [...commands].filter((command) => command.includes("npx -y agentera@next") && !command.includes("--yes"));
}

function normalizedProcessOutput(text: string): unknown {
  const value = text.trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isolatedEnvironment(paths: {
  home: string;
  data: string;
  config: string;
  cache: string;
  state: string;
  tmp: string;
  appHome: string;
  maliciousBin: string;
}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: paths.home,
    XDG_DATA_HOME: paths.data,
    XDG_CONFIG_HOME: paths.config,
    XDG_CACHE_HOME: paths.cache,
    XDG_STATE_HOME: paths.state,
    TMPDIR: paths.tmp,
    AGENTERA_HOME: paths.appHome,
    PATH: `${paths.maliciousBin}${path.delimiter}${process.env.PATH ?? ""}`,
    NPM_TOKEN: "runtime-proof-secret",
    npm_config_registry: "https://registry.invalid/never-contact",
    NODE_OPTIONS: "",
    AGENTERA_UNSAFE_MARKER: "runtime-proof-unsafe",
    DO_NOT_TRACK: "1",
  };
}

export function runRuntimeBootstrapMatrix(
  fixture: PackageFixture,
  checkoutRoot: string,
): RuntimeBootstrapMatrixSummary {
  const executionRegistry = runtimeMatrixExecutionRegistry();
  assertRuntimeMatrixExecutionRegistry(executionRegistry);
  const expectedAuthority = expectedCompositeRowAuthority();
  const runtimeBindings: ReadonlyArray<{ id: RuntimeName; root: string }> = [
    { id: "source", root: fixture.constructionRoot },
    { id: "package", root: fixture.packageRoot },
  ];
  assertExactAxis("runtime binding", runtimeBindings.map(({ id }) => id), RUNTIME_ID_AUTHORITY);
  const matrixRoot = path.join(fixture.root, `runtime matrix ${DANGER}`);
  const evidenceRoot = path.join(fixture.root, "runtime-matrix-evidence");
  fs.mkdirSync(matrixRoot);
  fs.mkdirSync(evidenceRoot);
  const v2Fixture = path.join(checkoutRoot, "packages/cli/test/upgrade/fixtures/v2-yaml-project");
  const artifact = path.join(fixture.root, fixture.manifest.filename);
  const rows: RowObservation[] = [];
  const parity = new Map<string, unknown>();
  const runtimeObservationDigests = {
    source: {} as Record<ProjectState, string>,
    package: {} as Record<ProjectState, string>,
  };
  let evidenceSequence = 0;

  for (const { id: runtime, root: originalRoot } of runtimeBindings) {
    const runtimeRoot = path.join(matrixRoot, `${runtime} install ${DANGER}`);
    fs.cpSync(originalRoot, runtimeRoot, { recursive: true, verbatimSymlinks: true });
    const home = path.join(matrixRoot, `${runtime} HOME ${DANGER}`);
    const paths = {
      home,
      data: path.join(matrixRoot, `${runtime} data ${DANGER}`),
      config: path.join(matrixRoot, `${runtime} config ${DANGER}`),
      cache: path.join(matrixRoot, `${runtime} npm cache ${DANGER}`),
      state: path.join(matrixRoot, `${runtime} state ${DANGER}`),
      tmp: path.join(matrixRoot, `${runtime} command temp ${DANGER}`),
      appHome: path.join(runtimeRoot, "bundle"),
      maliciousBin: path.join(home, "user-owned-bin"),
    };
    for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
    const userOwnedExecutable = path.join(paths.maliciousBin, "agentera-runtime-user-owned-proof");
    fs.writeFileSync(userOwnedExecutable, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    const skill = path.join(home, ".agents/skills/agentera");
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.cpSync(path.join(runtimeRoot, "bundle/skills/agentera"), skill, { recursive: true });
    seedDecoys(home);
    seedDecoys(paths.cache);
    seedDecoys(paths.tmp);
    const env = isolatedEnvironment(paths);

    for (const projectState of BOOTSTRAP_PROJECT_STATE_IDS) {
      const quotedSeparator = projectState === "clean" ? "\n" : projectState === "v2" ? "\r" : "";
      const quotedPathKind = projectState === "clean" ? "lf" : projectState === "v2" ? "cr" : null;
      const project = path.join(matrixRoot, `${runtime} ${projectState} project${quotedSeparator}${DANGER}`);
      seedProject(project, projectState, v2Fixture);
      const absent = path.join(project, `prior absence ${DANGER}`);
      const protectedRootPaths: ProtectedRootPaths = {
        project,
        home,
        sharedSkill: skill,
        install: runtimeRoot,
        package: fixture.packageRoot,
        tarball: artifact,
        cache: paths.cache,
        temporary: paths.tmp,
        priorAbsence: absent,
      };
      const protectedRoots = [
        ["project", project],
        ["home", home],
        ["shared_skill", skill],
        ["install", runtimeRoot],
        ["package", fixture.packageRoot],
        ["package_artifact", artifact],
        ["cache", paths.cache],
        ["temporary", paths.tmp],
        ["absence", absent],
      ] as const;
      assertProtectedRootAuthority(protectedRoots, protectedRootPaths);

      const dispatch = (
        id: string,
        identity: { owner: string; source: string },
        candidate: string,
        expected: { accepted: boolean; classification: string; exit?: number; argv?: string[] },
      ): SpawnSyncReturns<string> => {
        const sentinel = path.join(evidenceRoot, `${evidenceSequence}-${runtime}-${projectState}-${id}.sentinel`);
        const environmentEvidence = `${sentinel}.environment.json`;
        evidenceSequence += 1;
        const before = snapshots(protectedRoots);
        const result = spawnSync(process.execPath, [
          DISPATCHER,
          JSON.stringify(identity),
          candidate,
          runtimeRoot,
          project,
          sentinel,
          environmentEvidence,
        ], { cwd: project, env, encoding: "utf8", shell: false });
        const after = snapshots(protectedRoots);
        expect(after, `${runtime}/${projectState}/${id} preservation`).toEqual(before);
        const childStarted = fs.existsSync(sentinel);
        expect(childStarted, `${runtime}/${projectState}/${id} child start`).toBe(expected.accepted);
        let classification = "accepted";
        if (expected.accepted) {
          expect(result.status, `${runtime}/${projectState}/${id}\n${result.stderr}\n${result.stdout}`).toBe(expected.exit ?? 0);
          const evidence = JSON.parse(fs.readFileSync(environmentEvidence, "utf8"));
          expect(evidence.unsafeNames, `${runtime}/${projectState}/${id} scrubbed env`).toEqual([]);
          expect(evidence.path, `${runtime}/${projectState}/${id} approved PATH`).toBe(DEVELOPMENT_CHILD_PATH);
          expect(evidence.userOwnedResolution, `${runtime}/${projectState}/${id} user executable resolution`).toBe("ENOENT");
          expect(evidence.cwd, `${runtime}/${projectState}/${id} exact child cwd`).toBe(project);
          expect(Array.isArray(evidence.argv), `${runtime}/${projectState}/${id} argv`).toBe(true);
          if (expected.argv) expect(evidence.argv, `${runtime}/${projectState}/${id} exact argv`).toEqual(expected.argv);
          if (candidate.includes(project)) {
            expect(evidence.argv, `${runtime}/${projectState}/${id} project argv`).toContain(project);
            expect(evidence.argv.filter((value: string) => value === project)).toHaveLength(1);
          }
          for (const [key, value] of Object.entries({
            HOME: paths.home,
            XDG_DATA_HOME: paths.data,
            XDG_CONFIG_HOME: paths.config,
            XDG_CACHE_HOME: paths.cache,
            XDG_STATE_HOME: paths.state,
            TMPDIR: paths.tmp,
            AGENTERA_HOME: paths.appHome,
          })) expect(evidence.isolated[key]).toBe(digest(value));
        } else {
          expect(result.status, `${runtime}/${projectState}/${id}`).toBe(64);
          expect(fs.existsSync(environmentEvidence)).toBe(false);
          const diagnostic = JSON.parse(result.stderr.trim());
          classification = diagnostic.classification;
          expect(classification, `${runtime}/${projectState}/${id}`).toBe(expected.classification);
        }
        rows.push({
          id,
          runtime,
          projectState,
          accepted: expected.accepted,
          exit: result.status,
          classification,
          outcome: null,
          recoveryCount: 0,
          childStarted,
          preservationRoots: protectedRoots.length,
        });
        return result;
      };

      const primeCommand = preCutoverCommand("prime --context status --format json");
      const primeId = quotedPathKind ? `prime-quoted-${quotedPathKind}` : "prime";
      assertAcceptedApplicability(primeId, projectState);
      const prime = dispatch(primeId, { owner: "prime.status", source: primeCommand }, primeCommand, {
        accepted: true,
        classification: "accepted",
        argv: ["prime", "--context", "status", "--format", "json"],
      });
      const primePayload = JSON.parse(prime.stdout);
      const expectedOutcome = projectState === "v3" ? "ok" : "blocked";
      const expectedCutoverState = projectState === "clean"
        ? "unknown"
        : projectState === "v2"
          ? "legacy"
          : projectState;
      expect(primePayload.capability_context.startup.outcome).toBe(expectedOutcome);
      expect(Buffer.byteLength(prime.stdout, "utf8")).toBeLessThanOrEqual(25_000);
      expect(primePayload.capability_context.startup.state_cutover).toMatchObject({
        project_state: expectedCutoverState,
        status: projectState === "v3" ? "complete" : "required",
      });
      if (projectState === "v3") {
        expect(primePayload.capability_context.context.status_context.fallback_commands ?? []).toEqual([]);
      }

      const recommended = primePayload.capability_context.context.status_context.next_action.capability;
      const startupCommand = preCutoverCommand(`prime --context ${recommended} --format json`);
      assertAcceptedApplicability("recommended-startup", projectState);
      const startup = dispatch("recommended-startup", { owner: `prime.recommended.${recommended}`, source: startupCommand }, startupCommand, { accepted: true, classification: "accepted" });
      expect(JSON.parse(startup.stdout).capability_context.startup.outcome).toBe(expectedOutcome);

      const doctorCommand = commandText([
        "npx", "-y", "agentera@next", "doctor", "--format", "json",
        "--home", home, "--project", project, "--install-root", paths.appHome,
      ]);
      const doctorId = quotedPathKind ? `doctor-quoted-${quotedPathKind}` : "doctor";
      assertAcceptedApplicability(doctorId, projectState);
      const doctor = dispatch(doctorId, { owner: "doctor.status", source: doctorCommand }, doctorCommand, {
        accepted: true,
        classification: "accepted",
        argv: ["doctor", "--format", "json", "--home", home, "--project", project, "--install-root", paths.appHome],
      });
      const doctorPayload = JSON.parse(doctor.stdout);
      expect(doctorPayload).toMatchObject({ status: "up_to_date", shared_skill: { status: "pass" } });

      const recoveries = readOnlyRecoveries(primePayload, doctorPayload);
      const recoveryObservations: unknown[] = [];
      if (projectState !== "v3") recoveries.unshift(fullEntityUpgradePreviewCommand(project));
      expect(recoveries.every((command) => !command.includes("--yes"))).toBe(true);
      recoveries.forEach((command, index) => {
        const recoveryId = `recovery-${index}`;
        assertAcceptedApplicability(recoveryId, projectState);
        const recovery = dispatch(recoveryId, { owner: `recovery.${index}`, source: command }, command, {
          accepted: true,
          classification: "accepted",
          exit: projectState === "v3" ? 0 : 1,
        });
        expect(recovery.status).toBe(projectState === "v3" ? 0 : 1);
        const stdout = normalizedProcessOutput(recovery.stdout);
        const stderr = normalizedProcessOutput(recovery.stderr);
        const body = stdout && typeof stdout === "object" ? stdout : stderr;
        recoveryObservations.push({
          command,
          status: recovery.status,
          classification: "accepted",
          outputClassification: body && typeof body === "object" && "error" in body
            ? (body as { error?: { class?: unknown } }).error?.class ?? null
            : null,
          stdout,
          stderr,
        });
      });
      for (const row of rows.filter((row) => row.runtime === runtime && row.projectState === projectState && row.accepted)) {
        row.outcome = expectedOutcome;
        row.recoveryCount = recoveries.length;
      }

      for (const { id, candidate, classification, states } of REJECTION_EXECUTION_SPECS) {
        if (!states.includes(projectState)) continue;
        dispatch(id, { owner: "prime.status", source: primeCommand }, candidate!, { accepted: false, classification });
      }

      const normalizedObservation = normalized({
        prime: primePayload,
        startup: JSON.parse(startup.stdout),
        doctor: doctorPayload,
        recoveries,
        recoveryObservations,
      }, [runtimeRoot, project, home, ...Object.values(paths)]);
      const parityKey = projectState;
      if (runtime === "source") parity.set(parityKey, normalizedObservation);
      else expect(normalizedObservation, `${projectState} source/package parity`).toEqual(parity.get(parityKey));
      runtimeObservationDigests[runtime][projectState] = digest(JSON.stringify(normalizedObservation));
    }
  }

  const runtimeCounts = Object.fromEntries((["source", "package"] as const).map((runtime) => [runtime, {
    accepted: rows.filter((row) => row.runtime === runtime && row.accepted).length,
    rejected: rows.filter((row) => row.runtime === runtime && !row.accepted).length,
  }])) as RuntimeBootstrapMatrixSummary["runtimeCounts"];
  const stateCounts = Object.fromEntries(PROJECT_STATE_ID_AUTHORITY.map((state) => [state, {
    accepted: rows.filter((row) => row.projectState === state && row.accepted).length,
    rejected: rows.filter((row) => row.projectState === state && !row.accepted).length,
  }])) as RuntimeBootstrapMatrixSummary["stateCounts"];
  assertCompleteCompositeRows(rows, expectedAuthority.ids);
  return {
    rows,
    runtimeCounts,
    stateCounts,
    preservationRootsPerRow: 9,
    childStartRejections: rows.filter((row) => !row.accepted && row.childStarted).length,
    packageArtifact: {
      filename: fixture.manifest.filename,
      integrity: fixture.manifest.integrity,
      shasum: fixture.manifest.shasum,
      files: fixture.manifest.files.length,
    },
    expectedCompositeRowIds: expectedAuthority.ids,
    runtimeObservationDigests,
    authority: {
      protectedRootCount: PROTECTED_ROOT_AUTHORITY_COUNT,
      protectedRootDigest: PROTECTED_ROOT_AUTHORITY_SHA256,
      compositeRowCount: EXPECTED_COMPOSITE_ROW_COUNT,
      compositeRowDigest: expectedAuthority.digest,
      matrixDigest: RUNTIME_MATRIX_AUTHORITY_SHA256,
    },
  };
}
