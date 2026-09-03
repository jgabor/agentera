import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { GlobalSetupContext } from "vitest/node";

import { generatedSourceIdentity, readGeneratedSourceIdentity, sameGeneratedSourceIdentity } from "../../scripts/generated-output.mjs";
import { waitForVerificationBarrier } from "../../scripts/verification-barrier.mjs";
import { DEVELOPMENT_RUNTIME_REQUIRED_FILES } from "../../src/core/developmentInvocation.js";
import { finalizePackageOwnerEvidence, writeContentAddressedOwnerEvidence, writeContentAddressedPackageIdentity } from "../../src/validate/activationArtifactEvidence.js";

export interface PackFile {
  path: string;
  size: number;
  mode: number;
}

export interface PackEntry {
  name: string;
  version: string;
  filename: string;
  files: PackFile[];
  size: number;
  unpackedSize: number;
  integrity: string;
  shasum: string;
}

export interface PackageFixture {
  root: string;
  constructionRoot: string;
  packageRoot: string;
  manifest: PackEntry;
  sourceIdentity: ReturnType<typeof generatedSourceIdentity>;
  deterministicBytes: {
    packRuns: 2;
    sha256: string;
    secondSha256: string;
  };
  pathIndependence: {
    constructionRoots: string[];
    extractedRoots: string[];
    regularFiles: number;
    contentSha256: string;
    forbiddenPathMatches: string[];
    pathNeedleClasses: string[];
    secondManifest: PackEntry;
  };
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("npm_config_")));
  return {
    ...env,
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: scrubbedEnv() });
  if (result.status !== 0) {
    throw new Error(`package verification boundary failed during ${command} ${args.join(" ")}:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function parseManifest(stdout: string): PackEntry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("package verification boundary failed: npm pack returned invalid JSON");
  }
  const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
  if (entries.length !== 1) {
    throw new Error(`package verification boundary failed: npm pack returned ${entries.length} entries; expected one`);
  }
  const entry = entries[0] as Partial<PackEntry>;
  if (typeof entry.name !== "string" || typeof entry.version !== "string" || typeof entry.filename !== "string" || !Array.isArray(entry.files) || !Number.isSafeInteger(entry.size) || !Number.isSafeInteger(entry.unpackedSize) || typeof entry.integrity !== "string" || typeof entry.shasum !== "string") {
    throw new Error("package verification boundary failed: npm pack omitted manifest integrity");
  }
  return entry as PackEntry;
}

interface RegularFileEntry {
  path: string;
  size: number;
  mode: number;
  sha256: string;
}

function regularFileManifest(root: string): RegularFileEntry[] {
  const entries: RegularFileEntry[] = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile())
        entries.push({
          path: path.relative(root, target).split(path.sep).join("/"),
          size: stat.size,
          mode: stat.mode & 0o777,
          sha256: createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
        });
    }
  };
  visit(root);
  return entries;
}

export interface PathNeedle {
  class: string;
  bytes: Buffer;
}

export function pathNeedles(needleClass: string, value: string): PathNeedle[] {
  return [
    { class: `${needleClass}:raw`, bytes: Buffer.from(value) },
    { class: `${needleClass}:normalized`, bytes: Buffer.from(path.normalize(path.resolve(value))) },
  ];
}

const developerHomePatterns: ReadonlyArray<{ class: string; pattern: RegExp }> = [
  {
    class: "developer-home-pattern:linux",
    pattern: /\/home\/(?!user(?:name)?(?:\/|$)|example(?:\/|$))[a-z_][a-z0-9._-]*(?:\/|$)/giu,
  },
  {
    class: "developer-home-pattern:macos",
    pattern: /\/Users\/(?!user(?:name)?(?:\/|$)|example(?:\/|$))[a-z_][a-z0-9._-]*(?:\/|$)/giu,
  },
  {
    class: "developer-home-pattern:windows",
    pattern: /[a-z]:[\\/]Users[\\/](?!user(?:name)?(?:[\\/]|$)|example(?:[\\/]|$))[^\\/\s"']+(?:[\\/]|$)/giu,
  },
];

function forbiddenPathMatches(root: string, needles: readonly PathNeedle[]): string[] {
  const matches = new Set<string>();
  for (const entry of regularFileManifest(root)) {
    const bytes = fs.readFileSync(path.join(root, entry.path));
    for (const needle of needles) {
      if (bytes.includes(needle.bytes)) matches.add(`${entry.path}:${needle.class}`);
    }
    const text = bytes.toString("utf8");
    for (const pattern of developerHomePatterns) {
      pattern.pattern.lastIndex = 0;
      if (pattern.pattern.test(text)) matches.add(`${entry.path}:${pattern.class}`);
    }
  }
  return [...matches].sort();
}

export function assertNoForbiddenPathMatches(root: string, needles: readonly PathNeedle[]): string[] {
  const matches = forbiddenPathMatches(root, needles);
  if (matches.length > 0) {
    throw new Error(`package verification boundary failed: extracted file matched portable-path needle class: ${matches.join(", ")}`);
  }
  return matches;
}

export function assertDeterministicPackagePair(firstBytes: Buffer, secondBytes: Buffer, firstManifest: PackEntry, secondManifest: PackEntry): void {
  if (!firstBytes.equals(secondBytes) || JSON.stringify(firstManifest.files) !== JSON.stringify(secondManifest.files) || firstManifest.integrity !== secondManifest.integrity || firstManifest.shasum !== secondManifest.shasum) {
    throw new Error("package verification boundary failed: independent construction roots produced different package bytes");
  }
}

function stageConstructionInputs(packageRoot: string, constructionRoot: string): void {
  fs.mkdirSync(constructionRoot, { recursive: true });
  for (const file of ["package.json", "README.md"]) {
    fs.copyFileSync(path.join(packageRoot, file), path.join(constructionRoot, file));
  }
  fs.copyFileSync(path.resolve(packageRoot, "../..", "LICENSE"), path.join(constructionRoot, "LICENSE"));
}

export async function createPackageFixture(): Promise<{
  fixture: PackageFixture;
  cleanup: () => void;
}> {
  waitForVerificationBarrier();
  const packageRoot = path.resolve(import.meta.dirname, "../..");
  const checkoutRoot = path.resolve(packageRoot, "../..");
  const sourceIdentity = generatedSourceIdentity(packageRoot);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-package-verification-"));
  const constructionRoot = path.join(root, "construction one ; [source]");
  const secondConstructionRoot = path.join(root, "construction two $ (source)");
  try {
    stageConstructionInputs(packageRoot, constructionRoot);
    stageConstructionInputs(packageRoot, secondConstructionRoot);
    run(process.execPath, ["scripts/build-package.mjs", "--output-root", constructionRoot], packageRoot);
    run(process.execPath, ["scripts/build-package.mjs", "--output-root", secondConstructionRoot], packageRoot);
    for (const construction of [constructionRoot, secondConstructionRoot]) {
      if (!sameGeneratedSourceIdentity(readGeneratedSourceIdentity(construction), sourceIdentity)) {
        throw new Error("package verification boundary failed: construction source identity drifted");
      }
    }
    const manifest = parseManifest(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], constructionRoot));
    const secondPackRoot = path.join(root, "second package ; [$]");
    fs.mkdirSync(secondPackRoot);
    const secondManifest = parseManifest(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", secondPackRoot], secondConstructionRoot));
    const tarball = path.join(root, manifest.filename);
    const secondTarball = path.join(secondPackRoot, secondManifest.filename);
    const tarballBytes = fs.readFileSync(tarball);
    const secondTarballBytes = fs.readFileSync(secondTarball);
    const tarballSha256 = createHash("sha256").update(tarballBytes).digest("hex");
    const secondTarballSha256 = createHash("sha256").update(secondTarballBytes).digest("hex");
    assertDeterministicPackagePair(tarballBytes, secondTarballBytes, manifest, secondManifest);
    run("tar", ["-xzf", path.join(root, manifest.filename), "-C", root], root);
    const extractedPackage = path.join(root, "package");
    if (!sameGeneratedSourceIdentity(readGeneratedSourceIdentity(extractedPackage), sourceIdentity)) {
      throw new Error("package verification boundary failed: extracted package source identity drifted");
    }
    const firstContent = regularFileManifest(extractedPackage);
    const contentSha256 = createHash("sha256").update(JSON.stringify(firstContent)).digest("hex");
    const pathScanNeedles = [...pathNeedles("checkout-root", checkoutRoot), ...pathNeedles("construction-root-primary", constructionRoot), ...pathNeedles("construction-root-secondary", secondConstructionRoot), ...pathNeedles("extraction-root-primary", extractedPackage), ...pathNeedles("actual-home", os.homedir())];
    const pathMatches = assertNoForbiddenPathMatches(extractedPackage, pathScanNeedles);
    // Both constructed and extracted runtimes use the checkout's already
    // installed dependency graph. Package verification must never consult a
    // registry or mutate npm's user cache.
    fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(extractedPackage, "node_modules"), "dir");
    // Package parity executes the freshly constructed output, not checkout dist.
    // The source construction deliberately has no installed dependencies, so give
    // it the checkout's already-installed dependency graph after packing it.
    fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(constructionRoot, "node_modules"), "dir");
    const fixture: PackageFixture = {
      root,
      constructionRoot,
      packageRoot: extractedPackage,
      manifest,
      sourceIdentity,
      deterministicBytes: {
        packRuns: 2,
        sha256: tarballSha256,
        secondSha256: secondTarballSha256,
      },
      pathIndependence: {
        constructionRoots: [constructionRoot, secondConstructionRoot],
        extractedRoots: [extractedPackage],
        regularFiles: firstContent.length,
        contentSha256,
        forbiddenPathMatches: pathMatches,
        pathNeedleClasses: [...new Set([...pathScanNeedles.map((needle) => needle.class), ...developerHomePatterns.map((pattern) => pattern.class)])].sort(),
        secondManifest,
      },
    };
    const evidenceOutput = process.env.AGENTERA_ACTIVATION_PACKAGE_EVIDENCE_OUTPUT;
    const identityOutput = process.env.AGENTERA_ACTIVATION_PACKAGE_IDENTITY_OUTPUT;
    const snapshotOutput = process.env.AGENTERA_ACTIVATION_PACKAGE_SNAPSHOT_OUTPUT;
    if (evidenceOutput || identityOutput || snapshotOutput) {
      if (!evidenceOutput || !identityOutput || !snapshotOutput) {
        throw new Error("package verification boundary failed: activation package outputs must be configured together");
      }
      const { evidence, packageIdentity } = await finalizePackageOwnerEvidence({
        root: checkoutRoot,
        fixture,
        requiredFiles: DEVELOPMENT_RUNTIME_REQUIRED_FILES,
        snapshotDirectory: snapshotOutput,
      });
      writeContentAddressedOwnerEvidence(evidenceOutput, evidence);
      writeContentAddressedPackageIdentity(identityOutput, packageIdentity);
    }
    return { fixture, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export default async function setup({ provide }: GlobalSetupContext): Promise<() => void> {
  const { fixture, cleanup } = await createPackageFixture();
  provide("packageFixture", fixture);
  return cleanup;
}

declare module "vitest" {
  export interface ProvidedContext {
    packageFixture: PackageFixture;
  }
}
