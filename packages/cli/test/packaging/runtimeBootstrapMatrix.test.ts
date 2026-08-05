import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, inject, it } from "vitest";

import {
  assertProtectedRootAuthority,
  assertCompleteCompositeRows,
  assertRuntimeMatrixExecutionRegistry,
  EXPECTED_COMPOSITE_ROW_COUNT,
  EXPECTED_COMPOSITE_ROW_SHA256,
  PROTECTED_ROOT_IDENTIFIERS,
  PROTECTED_ROOT_AUTHORITY_COUNT,
  PROTECTED_ROOT_AUTHORITY_SHA256,
  physicalIdentity,
  RUNTIME_MATRIX_AUTHORITY_SHA256,
  runRuntimeBootstrapMatrix,
  runtimeMatrixExecutionRegistry,
  type ProtectedRootPaths,
  type RuntimeMatrixExecutionRegistry,
} from "../helpers/runtimeBootstrapMatrix.js";
import { DEVELOPMENT_RUNTIME_REQUIRED_FILES } from "../../src/core/developmentInvocation.js";

const fixture = inject("packageFixture");
const CHECKOUT_ROOT = path.resolve(import.meta.dirname, "../../../..");

function rootEntries(paths: ProtectedRootPaths): Array<readonly [string, string]> {
  return [
    ["project", paths.project],
    ["home", paths.home],
    ["shared_skill", paths.sharedSkill],
    ["install", paths.install],
    ["package", paths.package],
    ["package_artifact", paths.tarball],
    ["cache", paths.cache],
    ["temporary", paths.temporary],
    ["absence", paths.priorAbsence],
  ];
}

const registryMutations: Array<[
  string,
  (registry: RuntimeMatrixExecutionRegistry) => void,
]> = [
  ["omitted runtime axis", (registry) => { registry.runtimeIds.pop(); }],
  ["replaced runtime axis", (registry) => { registry.runtimeIds[1] = "installed"; }],
  ["duplicate runtime axis", (registry) => { registry.runtimeIds[1] = registry.runtimeIds[0]; }],
  ["omitted state axis", (registry) => { registry.stateIds.pop(); }],
  ["replaced state axis", (registry) => { registry.stateIds[3] = "migrated"; }],
  ["duplicate state axis", (registry) => { registry.stateIds[3] = registry.stateIds[0]; }],
  ["omitted accepted spec", (registry) => { registry.accepted.pop(); }],
  ["replaced accepted spec", (registry) => { registry.accepted[7].id = "recovery-preview"; }],
  ["duplicate accepted spec", (registry) => { registry.accepted[7] = { ...registry.accepted[0], states: [...registry.accepted[0].states] }; }],
  ["omitted rejection spec", (registry) => { registry.rejections.pop(); }],
  ["replaced rejection spec", (registry) => { registry.rejections[19].id = "reject-other-channel"; }],
  ["duplicate rejection spec", (registry) => { registry.rejections[19] = { ...registry.rejections[0], states: [...registry.rejections[0].states] }; }],
  ["accepted state applicability drift", (registry) => { registry.accepted[0].states = ["v2"]; }],
  ["rejection state applicability drift", (registry) => { registry.rejections[0].states = ["clean", "v2", "partial"]; }],
  ["accepted classification drift", (registry) => { registry.accepted[0].classification = "not_exact"; }],
  ["rejection classification drift", (registry) => { registry.rejections[0].classification = "malformed"; }],
];

describe("offline source and extracted-package runtime bootstrap proof", () => {
  it("rejects protected-root and execution-registry origin mutations against fixed authorities", () => {
    expect(PROTECTED_ROOT_IDENTIFIERS).toEqual([
      "project", "home", "shared_skill", "install", "package", "package_artifact", "cache", "temporary", "absence",
    ]);
    expect(PROTECTED_ROOT_AUTHORITY_COUNT).toBe(9);
    expect(PROTECTED_ROOT_AUTHORITY_SHA256).toBe("031fd076c396b44b31fb1d923245976a0d3b2fe1e0037de3ee4b711a08c8fd6e");
    expect(EXPECTED_COMPOSITE_ROW_COUNT).toBe(190);
    expect(EXPECTED_COMPOSITE_ROW_SHA256).toBe("dd3b04ddd46c487b3f0056a16b1b9225fad61cd25988fa907a10520fc41a5da7");
    expect(RUNTIME_MATRIX_AUTHORITY_SHA256).toBe("d8af8891a8dfa27618ecd165989f635c252caae46a7f93abe2503cf546f2d73c");

    const proofRoot = fs.mkdtempSync(path.join(fixture.root, "protected-root-authority-"));
    const paths: ProtectedRootPaths = {
      project: path.join(proofRoot, "project"),
      home: path.join(proofRoot, "home"),
      sharedSkill: path.join(proofRoot, "home/.agents/skills/agentera"),
      install: path.join(proofRoot, "install"),
      package: path.join(proofRoot, "package"),
      tarball: path.join(proofRoot, "agentera.tgz"),
      cache: path.join(proofRoot, "cache"),
      temporary: path.join(proofRoot, "temporary"),
      priorAbsence: path.join(proofRoot, "prior-absence"),
    };
    for (const directory of [
      paths.project, paths.home, paths.sharedSkill, paths.install, paths.package, paths.cache, paths.temporary,
    ]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(paths.tarball, "tarball");
    const roots = rootEntries(paths);
    expect(() => assertProtectedRootAuthority(roots, paths)).not.toThrow();

    const duplicateId = roots.map((entry, index) => index === 8 ? ["project", entry[1]] as const : entry);
    expect(() => assertProtectedRootAuthority(duplicateId, paths)).toThrow(/identifiers must be unique/);
    const duplicatePhysical = roots.map((entry) => entry[0] === "package" ? [entry[0], paths.install] as const : entry);
    expect(() => assertProtectedRootAuthority(duplicatePhysical, paths)).toThrow(/physical identities must be unique/);
    const omitted = roots.slice(1);
    expect(() => assertProtectedRootAuthority(omitted, paths)).toThrow(/exact nine-root authority/);
    const renamed = roots.map((entry) => entry[0] === "package_artifact" ? ["tarball", entry[1]] as const : entry);
    expect(() => assertProtectedRootAuthority(renamed, paths)).toThrow(/exact nine-root authority/);
    const substitute = path.join(proofRoot, "substitute");
    fs.mkdirSync(substitute);
    const substituted = roots.map((entry) => entry[0] === "package" ? [entry[0], substitute] as const : entry);
    expect(() => assertProtectedRootAuthority(substituted, paths)).toThrow(/substituted its fixed physical authority/);

    const alias = path.join(proofRoot, "home-alias");
    fs.symlinkSync(paths.home, alias, "dir");
    const symlinkPaths = { ...paths, sharedSkill: alias };
    const symlinkAlias = rootEntries(symlinkPaths);
    expect(() => assertProtectedRootAuthority(symlinkAlias, symlinkPaths)).toThrow(/physical identities must be unique/);
    const lexicalProjectAlias = path.join(paths.project, "..", path.basename(paths.project));
    const lexicalPaths = { ...paths, temporary: lexicalProjectAlias };
    expect(() => assertProtectedRootAuthority(rootEntries(lexicalPaths), lexicalPaths)).toThrow(/physical identities must be unique/);
    const absenceCollisionPaths = { ...paths, priorAbsence: paths.project };
    expect(() => assertProtectedRootAuthority(rootEntries(absenceCollisionPaths), absenceCollisionPaths)).toThrow(/physical identities must be unique/);

    const realParent = path.join(proofRoot, "real-parent");
    const inner = path.join(realParent, "inner");
    const deep = path.join(inner, "deep");
    fs.mkdirSync(deep, { recursive: true });
    const parentAlias = path.join(proofRoot, "parent-alias");
    fs.symlinkSync(inner, parentAlias, "dir");
    expect(physicalIdentity(`${parentAlias}${path.sep}..`)).toBe(physicalIdentity(realParent));
    expect(physicalIdentity(`${parentAlias}${path.sep}..${path.sep}not-created`))
      .toBe(physicalIdentity(path.join(realParent, "not-created")));
    const existingParentCollision = {
      ...paths,
      install: `${parentAlias}${path.sep}..`,
      package: realParent,
    };
    expect(() => assertProtectedRootAuthority(rootEntries(existingParentCollision), existingParentCollision))
      .toThrow(/physical identities must be unique/);
    const absentParentCollision = {
      ...paths,
      package: `${parentAlias}${path.sep}..${path.sep}not-created`,
      priorAbsence: path.join(realParent, "not-created"),
    };
    expect(() => assertProtectedRootAuthority(rootEntries(absentParentCollision), absentParentCollision))
      .toThrow(/physical identities must be unique/);

    const nestedAlias = path.join(proofRoot, "nested-alias");
    fs.symlinkSync(`${parentAlias}${path.sep}deep`, nestedAlias, "dir");
    expect(physicalIdentity(`${nestedAlias}${path.sep}..${path.sep}..`)).toBe(physicalIdentity(realParent));
    expect(physicalIdentity(`${proofRoot}${path.sep}${path.sep}real-parent${path.sep}.${path.sep}inner${path.sep}..`))
      .toBe(physicalIdentity(realParent));
    expect(physicalIdentity(`${path.relative(process.cwd(), parentAlias)}${path.sep}..`))
      .toBe(physicalIdentity(realParent));
    expect(physicalIdentity(`${realParent}${path.sep}missing${path.sep}child${path.sep}..${path.sep}..${path.sep}not-created`))
      .toBe(physicalIdentity(path.join(realParent, "not-created")));

    const brokenAlias = path.join(proofRoot, "broken-alias");
    fs.symlinkSync(path.join(proofRoot, "missing-target"), brokenAlias, "dir");
    expect(() => physicalIdentity(`${brokenAlias}${path.sep}..`)).toThrow(/cannot resolve symlink/);
    const regularFile = path.join(proofRoot, "regular-file");
    fs.writeFileSync(regularFile, "file");
    expect(() => physicalIdentity(path.join(regularFile, "child"))).toThrow();
    expect(physicalIdentity(path.join(realParent, "absent-a")))
      .not.toBe(physicalIdentity(path.join(realParent, "absent-b")));

    expect(() => assertRuntimeMatrixExecutionRegistry(runtimeMatrixExecutionRegistry())).not.toThrow();
    for (const [name, mutate] of registryMutations) {
      const registry = runtimeMatrixExecutionRegistry();
      mutate(registry);
      expect(() => assertRuntimeMatrixExecutionRegistry(registry), name).toThrow();
    }
  });

  it("preserves every protected root and rejects wrong-channel specifications before child start", { timeout: 300_000 }, () => {
    const summary = runRuntimeBootstrapMatrix(fixture, CHECKOUT_ROOT);
    expect(summary.runtimeCounts).toEqual({
      source: { accepted: 15, rejected: 80 },
      package: { accepted: 15, rejected: 80 },
    });
    expect(summary.stateCounts).toEqual({
      clean: { accepted: 8, rejected: 40 },
      v2: { accepted: 8, rejected: 40 },
      partial: { accepted: 8, rejected: 40 },
      v3: { accepted: 6, rejected: 40 },
    });
    expect(summary.preservationRootsPerRow).toBe(9);
    expect(summary.rows.every((row) => row.preservationRoots === 9)).toBe(true);
    expect(summary.childStartRejections).toBe(0);
    expect(summary.rows.filter((row) => !row.accepted)).toHaveLength(160);
    expect(summary.rows).toHaveLength(190);
    expect(summary.rows.filter((row) => row.id === "recovery-0")).toHaveLength(6);
    expect(summary.rows.filter((row) => row.id === "prime-quoted-lf")).toHaveLength(2);
    expect(summary.rows.filter((row) => row.id === "prime-quoted-cr")).toHaveLength(2);

    expect(() => assertCompleteCompositeRows(summary.rows, summary.expectedCompositeRowIds)).not.toThrow();
    expect(() => assertCompleteCompositeRows(summary.rows.slice(1), summary.expectedCompositeRowIds)).toThrow(/incomplete/);
    const duplicateRow = summary.rows.map((row, index) => index === summary.rows.length - 1 ? summary.rows[0] : row);
    expect(() => assertCompleteCompositeRows(duplicateRow, summary.expectedCompositeRowIds)).toThrow(/unique/);
    const coordinatedOmission = [...summary.expectedCompositeRowIds];
    coordinatedOmission[0] = "source/clean/coordinated-replacement";
    expect(() => assertCompleteCompositeRows(summary.rows, coordinatedOmission)).toThrow(/authority count or digest drifted/);
    expect(summary.authority).toEqual({
      protectedRootCount: 9,
      protectedRootDigest: PROTECTED_ROOT_AUTHORITY_SHA256,
      compositeRowCount: 190,
      compositeRowDigest: EXPECTED_COMPOSITE_ROW_SHA256,
      matrixDigest: RUNTIME_MATRIX_AUTHORITY_SHA256,
    });
  });

  it("proves path-independent extracted content, canonical integrity, manifest, and executable mode", () => {
    const tarball = path.join(fixture.root, fixture.manifest.filename);
    const bytes = fs.readFileSync(tarball);
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    const shasum = createHash("sha1").update(bytes).digest("hex");
    expect(fixture.manifest.filename).toBe("agentera-3.0.0-dev.42.tgz");
    expect(fixture.manifest.integrity).toBe(integrity);
    expect(fixture.manifest.shasum).toBe(shasum);
    const bin = fixture.manifest.files.find(({ path: pathname }) => pathname === "dist/bin/agentera.js");
    expect(bin).toMatchObject({ mode: 0o755 });
    expect(fixture.manifest.files.map(({ path: pathname }) => pathname)).toEqual(expect.arrayContaining([
      "package.json",
      "dist/bin/agentera.js",
      "bundle/.agentera-npx-bundle.json",
      "bundle/registry.json",
      "bundle/skills/agentera/SKILL.md",
      "bundle/references/adapters/package-registry.yaml",
    ]));
    expect(fixture.manifest.files.some(({ path: pathname }) => pathname.endsWith(".js.map"))).toBe(false);
    expect(fixture.pathIndependence.constructionRoots).toHaveLength(2);
    expect(new Set(fixture.pathIndependence.constructionRoots).size).toBe(2);
    expect(fixture.pathIndependence.constructionRoots.every((root) => /[ ;$()[\]]/u.test(root))).toBe(true);
    expect(fixture.pathIndependence.extractedRoots).toHaveLength(2);
    expect(fixture.pathIndependence.forbiddenPathMatches).toEqual([]);
    expect(fixture.pathIndependence.pathNeedleClasses).toHaveLength(19);
    expect(fixture.pathIndependence.pathNeedleClasses).toEqual(expect.arrayContaining([
      "checkout-root:raw",
      "checkout-root:normalized",
      "construction-root-primary:raw",
      "construction-root-primary:normalized",
      "construction-root-secondary:raw",
      "construction-root-secondary:normalized",
      "actual-home:raw",
      "actual-home:normalized",
      "developer-home-explicit:raw",
      "developer-home-explicit:normalized",
      "prohibited-intermediate-tier:raw",
      "prohibited-intermediate-tier:normalized",
      "developer-home-pattern:linux",
      "developer-home-pattern:macos",
      "developer-home-pattern:windows",
    ]));
    expect(fixture.pathIndependence.secondManifest.files).toEqual(fixture.manifest.files);
    expect(fixture.pathIndependence.secondManifest.integrity).toBe(fixture.manifest.integrity);
    expect(fixture.pathIndependence.secondManifest.shasum).toBe(fixture.manifest.shasum);
    expect(fixture.pathIndependence.regularFiles).toBe(fixture.manifest.files.length);
    expect(fixture.pathIndependence.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects every missing source and package surface before the CLI boundary", () => {
    const dispatcher = path.join(CHECKOUT_ROOT, "packages/cli/test/helpers/preCutoverBootstrapDispatcher.mjs");
    const project = path.join(fixture.root, "missing surface project");
    fs.mkdirSync(project);
    const command = "npx -y agentera@next prime --context status --format json";
    expect(DEVELOPMENT_RUNTIME_REQUIRED_FILES).toHaveLength(8);
    let attempts = 0;
    for (const [runtime, root] of Object.entries({ source: fixture.constructionRoot, package: fixture.packageRoot })) {
      for (const [index, relative] of DEVELOPMENT_RUNTIME_REQUIRED_FILES.entries()) {
        attempts += 1;
        const target = path.join(root, relative);
        const held = path.join(fixture.root, `held-${runtime}-${index}`);
        const sentinel = path.join(fixture.root, `missing-${runtime}-${index}.sentinel`);
        fs.renameSync(target, held);
        try {
          const result = spawnSync(process.execPath, [
            dispatcher,
            JSON.stringify({ owner: "prime.status", source: command }),
            command,
            root,
            project,
            sentinel,
            `${sentinel}.environment.json`,
          ], { cwd: project, env: process.env, encoding: "utf8", shell: false });
          expect(result.status, `${runtime}/${relative}`).toBe(64);
          expect(JSON.parse(result.stderr).classification, `${runtime}/${relative}`).toBe("invalid_authority");
          expect(fs.existsSync(sentinel), `${runtime}/${relative}`).toBe(false);
        } finally {
          fs.renameSync(held, target);
        }
      }
    }
    expect(attempts).toBe(16);
  });
});
