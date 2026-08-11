import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  ACTIVATION_CENSUS_AUTHORITY,
  ACTIVATION_CHECK_IDS,
} from "../registries/packagePublication.js";
import {
  ACTIVATION_CANONICAL_TUPLES,
  ACTIVATION_TUPLE_AUTHORITY,
} from "../registries/activationTuples.js";
import { DEVELOPMENT_RUNTIME_REQUIRED_FILES } from "../core/developmentInvocation.js";
import {
  GENERATED_OWNER_EVIDENCE_SCHEMA,
  PACKAGE_OWNER_EVIDENCE_SCHEMA,
  SOURCE_OWNER_EVIDENCE_SCHEMA,
  activationPackageIdentityViolations,
  activationSourceDigest,
  canonicalObservationJson,
  createGeneratedOwnerEvidence,
  createSourceOwnerEvidence,
  observationDigest,
  type ActivationArtifactRecord,
  type ActivationPackageIdentity,
  type ActivationOwnerEvidence,
  type ActivationProducerKind,
} from "./activationArtifactEvidence.js";

export { activationSourceDigest } from "./activationArtifactEvidence.js";

export const ACTIVATION_EVIDENCE_SCHEMA = "agentera.activationEvidence.v1";
export const ACTIVATION_EVIDENCE_FILE = "activation-evidence.json";
export const ACTIVATION_EVIDENCE_MAX_BYTES = 1_048_576;

export interface ActivationEvidenceCheck {
  readonly id: string;
  readonly identities: readonly string[];
  readonly identityDigest: string;
  readonly observationRefs: readonly string[];
  readonly observationDigest: string;
}

export interface ActivationEvidenceManifest {
  readonly schemaVersion: typeof ACTIVATION_EVIDENCE_SCHEMA;
  readonly generation: string;
  readonly currentSourceDigest: string;
  readonly packageArtifact: { readonly filename: string; readonly integrity: string; readonly shasum: string; readonly tarballSha256: string };
  readonly tupleDigest: string;
  readonly producers: {
    readonly source: ActivationOwnerEvidence;
    readonly generated: ActivationOwnerEvidence;
    readonly package: ActivationOwnerEvidence;
  };
  readonly capabilityParityDigest: string;
  readonly packageSemanticParityDigest: string;
  readonly checks: readonly ActivationEvidenceCheck[];
  readonly manifestDigest: string;
}

export interface ActivationEvidenceValidationContext {
  readonly root: string;
  readonly generationRoot: string;
  readonly generation: string;
  readonly productionInputs: unknown;
  readonly expectedManifestDigest: string;
  readonly expectedPackageIdentity: ActivationPackageIdentity | unknown;
}

interface ProductionEvidence {
  classes: Record<string, { dimensions: Record<string, { identities: string[] }> }>;
}

interface ProvenanceAuthority {
  producerKind: ActivationProducerKind;
  artifactClass: string;
  artifactIdentity: string;
}

const CHECK_OBSERVATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "cli.discovery": ["generic.cli.discovery"],
  "cli.behavior": ["generic.cli.behavior"],
  "cli.diagnostics": ["generic.cli.diagnostics"],
  "cli.package_projection": ["generic.cli.package_projection"],
  "cli.instructions": ["generic.cli.instructions"],
  "cli.adversarial": ["generic.cli.adversarial"],
  "capability.discovery": ["capability.source-modules", "capability.source-registry"],
  "capability.behavior": ["capability.generated-served", "capability.generated-routes"],
  "capability.diagnostics": ["capability.generated-modules", "capability.generated-schemas"],
  "capability.package_projection": ["capability.extracted-modules", "capability.extracted-served", "capability.extracted-registry", "capability.extracted-routes", "capability.extracted-schemas"],
  "capability.instructions": ["capability.source-runtime-registry", "capability.generated-runtime-registry", "capability.extracted-runtime-registry"],
  "capability.adversarial": ["capability.source-routes", "capability.source-schemas", "capability.generated-registry"],
  "runtime.discovery": ["generic.runtime.discovery"],
  "runtime.behavior": ["generic.runtime.behavior"],
  "runtime.diagnostics": ["generic.runtime.diagnostics"],
  "runtime.package_projection": ["generic.runtime.package_projection"],
  "runtime.instructions": ["generic.runtime.instructions"],
  "runtime.adversarial": ["generic.runtime.adversarial"],
  "reference.discovery": ["generic.reference.discovery"],
  "reference.behavior": ["generic.reference.behavior"],
  "reference.diagnostics": ["generic.reference.diagnostics"],
  "reference.package_projection": ["generic.reference.package_projection"],
  "reference.instructions": ["generic.reference.instructions"],
  "reference.adversarial": ["generic.reference.adversarial"],
  "state.discovery": ["generic.state.discovery"],
  "state.behavior": ["generic.state.behavior"],
  "state.diagnostics": ["generic.state.diagnostics"],
  "state.package_projection": ["generic.state.package_projection"],
  "state.instructions": ["generic.state.instructions"],
  "state.adversarial": ["generic.state.adversarial"],
  "package.discovery": ["package.source-registry"],
  "package.behavior": ["package.source-construction", "package.generated-construction"],
  "package.diagnostics": ["package.command-policy"],
  "package.package_projection": ["package.generated-registry", "package.extracted-artifact", "package.extracted-registry", "package.extracted-smoke"],
  "package.instructions": ["package.source-selectors", "package.generated-selectors"],
  "package.adversarial": ["package.portability", "package.adversarial"],
  "bootstrap.discovery": ["bootstrap.source-authority"],
  "bootstrap.behavior": ["bootstrap.generated-binder"],
  "bootstrap.diagnostics": ["bootstrap.generated-diagnostics", "bootstrap.extracted-diagnostics"],
  "bootstrap.package_projection": ["bootstrap.extracted-classifications", "bootstrap.source-package-parity"],
  "bootstrap.instructions": ["bootstrap.generated-startup", "bootstrap.generated-declarations", "bootstrap.extracted-startup", "bootstrap.extracted-declarations"],
  "bootstrap.adversarial": ["bootstrap.missing-surface"],
});

const SOURCE_PROVENANCE: Record<string, readonly [string, string]> = {
  "capability.source-modules": ["capability-source-modules", "packages/cli/src/capabilities/*/instructions.ts"],
  "capability.source-runtime-registry": ["capability-source-runtime-registry", "packages/cli/src/capabilities/index.ts#CAPABILITY_INSTRUCTIONS"],
  "capability.source-registry": ["capability-source-registry", "registry.json#skills[0].capabilities"],
  "capability.source-routes": ["capability-source-routes", "packages/cli/src/cli/commands/capability.ts#CAPABILITY_ROUTING_NAMES"],
  "capability.source-schemas": ["capability-source-schemas", "skills/agentera/capabilities/*/schemas"],
  "package.source-registry": ["package-source-registry", "references/adapters/package-registry.yaml#records[agentera]"],
  "package.source-construction": ["package-source-construction", "references/adapters/package-registry.yaml#records[agentera].bundle_surfaces"],
  "package.source-selectors": ["package-source-selectors", "references/adapters/package-registry.yaml#records[agentera].semantic_fields"],
  "bootstrap.source-authority": ["bootstrap-source-authority", "packages/cli/src/validate/bootstrapAuthority.ts#bootstrapMatrixAuthority"],
  "capability.extracted-served": ["capability-extracted-served", "package/dist/bin/agentera.js#prime-context"],
  "package.command-policy": ["package-command-policy", "source-integration/runtime-matrix/classifications"],
  "package.adversarial": ["package-adversarial", "source-integration/runtime-matrix/rejections"],
  "bootstrap.extracted-classifications": ["bootstrap-extracted-classifications", "source-integration/runtime-matrix/rows"],
  "bootstrap.extracted-diagnostics": ["bootstrap-extracted-diagnostics", "source-integration/runtime-matrix/rejection-diagnostics"],
  "bootstrap.source-package-parity": ["bootstrap-source-package-parity", "source-integration/runtime-matrix/parity"],
  "bootstrap.missing-surface": ["bootstrap-missing-surface", "source-integration/runtime-matrix/missing-required-surfaces"],
};

const GENERATED_PROVENANCE: Record<string, readonly [string, string]> = {
  "capability.generated-modules": ["capability-generated-modules", "generation/dist/capabilities/*/instructions.js"],
  "capability.generated-runtime-registry": ["capability-generated-runtime-registry", "generation/dist/capabilities/index.js#CAPABILITY_INSTRUCTIONS"],
  "capability.generated-served": ["capability-generated-served", "generation/dist/bin/agentera.js#prime-context"],
  "capability.generated-registry": ["capability-generated-registry", "generation/bundle/registry.json#skills[0].capabilities"],
  "capability.generated-routes": ["capability-generated-routes", "generation/dist/cli/commands/capability.js#CAPABILITY_ROUTING_NAMES"],
  "capability.generated-schemas": ["capability-generated-schemas", "generation/bundle/skills/agentera/capabilities/*/schemas"],
  "package.generated-construction": ["package-generated-construction", "generation/package-construction-markers"],
  "package.generated-registry": ["package-generated-registry", "generation/bundle/references/adapters/package-registry.yaml#records[agentera]"],
  "package.generated-selectors": ["package-generated-selectors", "generation/bundle/references/adapters/package-registry.yaml#semantic_fields"],
  "bootstrap.generated-binder": ["bootstrap-generated-binder", "generation/dist/core/developmentInvocation.js#bindDevelopmentInvocation"],
  "bootstrap.generated-diagnostics": ["bootstrap-generated-diagnostics", "generation/dist/core/developmentInvocation.js#DevelopmentInvocationError"],
  "bootstrap.generated-startup": ["bootstrap-generated-startup", "generation/dist/bin/agentera.js#startup-producers"],
  "bootstrap.generated-declarations": ["bootstrap-generated-declarations", "generation/bundle/references/adapters/package-registry.yaml#bootstrap_command_authority"],
  "generic.cli.package_projection": ["cli-package-projection", "generation/dist/cli/dispatch/projections.js"],
};

const PACKAGE_PROVENANCE: Record<string, readonly [string, string]> = {
  "capability.extracted-modules": ["capability-extracted-modules", "package/dist/capabilities/*/instructions.js"],
  "capability.extracted-runtime-registry": ["capability-extracted-runtime-registry", "package/dist/capabilities/index.js#CAPABILITY_INSTRUCTIONS"],
  "capability.extracted-registry": ["capability-extracted-registry", "package/bundle/registry.json#skills[0].capabilities"],
  "capability.extracted-routes": ["capability-extracted-routes", "package/dist/cli/commands/capability.js#CAPABILITY_ROUTING_NAMES"],
  "capability.extracted-schemas": ["capability-extracted-schemas", "package/bundle/skills/agentera/capabilities/*/schemas"],
  "package.extracted-artifact": ["package-extracted-artifact", "npm-tarball/extracted-package"],
  "package.extracted-registry": ["package-extracted-registry", "package/bundle/references/adapters/package-registry.yaml#records[agentera]"],
  "package.extracted-smoke": ["package-extracted-smoke", "package/dist/bin/agentera.js#prime-context-status"],
  "package.portability": ["package-portability", "npm-tarball/path-portability"],
  "bootstrap.extracted-startup": ["bootstrap-extracted-startup", "package/dist/bin/agentera.js#startup-producers"],
  "bootstrap.extracted-declarations": ["bootstrap-extracted-declarations", "package/bundle/references/adapters/package-registry.yaml#bootstrap_command_authority"],
};

for (const classId of ["cli", "runtime", "reference", "state"]) {
  for (const dimension of ["discovery", "behavior", "diagnostics", "instructions", "adversarial"]) {
    SOURCE_PROVENANCE[`generic.${classId}.${dimension}`] = [`${classId}-${dimension}-source-observation`, `${classId}.${dimension}`];
  }
}
for (const classId of ["runtime", "reference", "state"]) {
  PACKAGE_PROVENANCE[`generic.${classId}.package_projection`] = [`${classId}-package-projection`, `package/${classId}/projection`];
}

const PROVENANCE: Readonly<Record<string, ProvenanceAuthority>> = Object.freeze(Object.fromEntries([
  ...Object.entries(SOURCE_PROVENANCE).map(([ref, [artifactClass, artifactIdentity]]) => [ref, { producerKind: "source-owner", artifactClass, artifactIdentity }]),
  ...Object.entries(GENERATED_PROVENANCE).map(([ref, [artifactClass, artifactIdentity]]) => [ref, { producerKind: "generated-owner", artifactClass, artifactIdentity }]),
  ...Object.entries(PACKAGE_PROVENANCE).map(([ref, [artifactClass, artifactIdentity]]) => [ref, { producerKind: "package-owner", artifactClass, artifactIdentity }]),
]));

function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function digestIdentities(values: readonly string[]): string { return hash([...values].sort().join("\n")); }

function allRecords(producers: ActivationEvidenceManifest["producers"]): Map<string, ActivationArtifactRecord> {
  const entries = [
    ...Object.entries(producers.source.records),
    ...Object.entries(producers.generated.records),
    ...Object.entries(producers.package.records),
  ];
  return new Map(entries);
}

function capabilityParity(producers: ActivationEvidenceManifest["producers"]): unknown {
  const records = allRecords(producers);
  const bodyRefs = [
    "capability.source-modules", "capability.source-runtime-registry",
    "capability.generated-modules", "capability.generated-runtime-registry", "capability.generated-served",
    "capability.extracted-modules", "capability.extracted-runtime-registry", "capability.extracted-served",
  ];
  const identityRefs = [
    "capability.source-registry", "capability.source-routes", "capability.source-schemas",
    "capability.generated-registry", "capability.generated-routes", "capability.generated-schemas",
    "capability.extracted-registry", "capability.extracted-routes", "capability.extracted-schemas",
  ];
  return {
    bodies: bodyRefs.map((ref) => ({ ref, content: records.get(ref)?.content ?? null })),
    identities: identityRefs.map((ref) => ({ ref, content: records.get(ref)?.content ?? null })),
  };
}

function packageSemanticParity(producers: ActivationEvidenceManifest["producers"]): unknown {
  const records = allRecords(producers);
  return ["package.source-registry", "package.source-selectors", "package.generated-registry", "package.generated-selectors", "package.extracted-registry"]
    .map((ref) => {
      const content = records.get(ref)?.content as any;
      return { ref, content: content?.semanticSelectors ?? content ?? null };
    });
}

function packageArtifact(producers: ActivationEvidenceManifest["producers"]): ActivationEvidenceManifest["packageArtifact"] {
  const content = producers.package.records["package.extracted-artifact"]?.content as any;
  return {
    filename: content?.filename ?? "missing",
    integrity: content?.integrity ?? "missing",
    shasum: content?.shasum ?? "missing",
    tarballSha256: content?.tarballSha256 ?? "missing",
  };
}

export function createActivationEvidenceManifest(options: {
  root: string;
  generation: string;
  productionEvidence: ProductionEvidence;
  sourceEvidence: ActivationOwnerEvidence;
  generatedEvidence: ActivationOwnerEvidence;
  packageEvidence: ActivationOwnerEvidence;
}): ActivationEvidenceManifest {
  const producers = { source: options.sourceEvidence, generated: options.generatedEvidence, package: options.packageEvidence };
  const records = allRecords(producers);
  const checks = ACTIVATION_CHECK_IDS.map((id): ActivationEvidenceCheck => {
    const [classId, dimension] = id.split(".");
    const identities = [...(options.productionEvidence.classes[classId]?.dimensions[dimension]?.identities ?? [])].sort();
    const observationRefs = [...(CHECK_OBSERVATIONS[id] ?? [])];
    return {
      id,
      identities,
      identityDigest: digestIdentities(identities),
      observationRefs,
      observationDigest: observationDigest(observationRefs.map((ref) => records.get(ref)?.content ?? null)),
    };
  });
  const unsigned: Omit<ActivationEvidenceManifest, "manifestDigest"> = {
    schemaVersion: ACTIVATION_EVIDENCE_SCHEMA,
    generation: options.generation,
    currentSourceDigest: activationSourceDigest(options.root),
    packageArtifact: packageArtifact(producers),
    tupleDigest: ACTIVATION_TUPLE_AUTHORITY.total.sha256,
    producers,
    capabilityParityDigest: observationDigest(capabilityParity(producers)),
    packageSemanticParityDigest: observationDigest(packageSemanticParity(producers)),
    checks,
  };
  return { ...unsigned, manifestDigest: observationDigest(unsigned) };
}

function validateOwnerEvidence(
  owner: ActivationOwnerEvidence | undefined,
  producerKind: ActivationProducerKind,
  schemaVersion: string,
  sourceDigest: string,
  generation: string,
  packageIntegrity: string | null,
  violations: string[],
): void {
  if (!owner || owner.schemaVersion !== schemaVersion || owner.producerKind !== producerKind) {
    violations.push(`${producerKind} evidence schema or producer is wrong`);
    return;
  }
  const { evidenceDigest, ...unsigned } = owner;
  if (observationDigest(unsigned) !== evidenceDigest) violations.push(`${producerKind} evidence digest mismatched`);
  if (owner.sourceDigest !== sourceDigest) violations.push(`${producerKind} evidence source provenance is stale or wrong`);
  if (producerKind === "generated-owner" && owner.generation !== generation) violations.push("generated-owner evidence generation is stale or wrong");
  if (producerKind !== "generated-owner" && owner.generation !== null) violations.push(`${producerKind} evidence must not claim a generation`);
  if (producerKind === "package-owner" && owner.packageIntegrity !== packageIntegrity) violations.push("package-owner evidence integrity is wrong");
  if (producerKind !== "package-owner" && owner.packageIntegrity !== null) violations.push(`${producerKind} evidence must not claim package integrity`);
  const expectedRefs = Object.entries(PROVENANCE).filter(([, authority]) => authority.producerKind === producerKind).map(([ref]) => ref).sort();
  const actualRefs = Object.keys(owner.records ?? {}).sort();
  if (canonicalObservationJson(actualRefs) !== canonicalObservationJson(expectedRefs)) violations.push(`${producerKind} evidence records are missing, duplicated, or unknown`);
  for (const [ref, record] of Object.entries(owner.records ?? {})) {
    const authority = PROVENANCE[ref];
    if (!authority || record.producerKind !== authority.producerKind || record.artifactClass !== authority.artifactClass || record.artifactIdentity !== authority.artifactIdentity) {
      violations.push(`activation evidence record '${ref}' has wrong producer or artifact provenance`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(record.artifactContentDigest) || record.observationDigest !== observationDigest(record.content)) {
      violations.push(`activation evidence record '${ref}' content digest mismatched`);
    }
    if (record.generation !== owner.generation || record.packageIntegrity !== owner.packageIntegrity) {
      violations.push(`activation evidence record '${ref}' provenance binding mismatched`);
    }
  }
}

function validateAuthoritativeOwner(
  actual: ActivationOwnerEvidence | undefined,
  authoritative: ActivationOwnerEvidence,
  violations: string[],
): void {
  if (!actual) return;
  for (const [ref, expected] of Object.entries(authoritative.records)) {
    const observed = actual.records?.[ref];
    if (!observed || observed.artifactContentDigest !== expected.artifactContentDigest
      || observed.observationDigest !== expected.observationDigest
      || canonicalObservationJson(observed.content) !== canonicalObservationJson(expected.content)) {
      violations.push(`activation evidence record '${ref}' does not match its authoritative artifact observation`);
    }
  }
}

function validateCapabilityParity(manifest: ActivationEvidenceManifest, violations: string[]): void {
  const records = allRecords(manifest.producers);
  const canonicalIds = ACTIVATION_CANONICAL_TUPLES.filter((tuple) => tuple.class === "capability").map((tuple) => tuple.surface_id).sort();
  const bodyRefs = [
    "capability.source-modules", "capability.source-runtime-registry",
    "capability.generated-modules", "capability.generated-runtime-registry", "capability.generated-served",
    "capability.extracted-modules", "capability.extracted-runtime-registry", "capability.extracted-served",
  ];
  const baseline = records.get(bodyRefs[0])?.content as any;
  for (const ref of bodyRefs) {
    const content = records.get(ref)?.content as any;
    if (canonicalObservationJson(content?.identities) !== canonicalObservationJson(canonicalIds)
      || canonicalObservationJson(content) !== canonicalObservationJson(baseline)
      || !canonicalIds.every((id) => content?.bodies?.[id]?.bytes > 0 && /^[a-f0-9]{64}$/.test(content?.bodies?.[id]?.sha256 ?? ""))) {
      violations.push(`capability body projection '${ref}' does not exactly match all canonical source bodies`);
    }
  }
  for (const ref of [
    "capability.source-registry", "capability.source-routes", "capability.source-schemas",
    "capability.generated-registry", "capability.generated-routes", "capability.generated-schemas",
    "capability.extracted-registry", "capability.extracted-routes", "capability.extracted-schemas",
  ]) {
    if (canonicalObservationJson(records.get(ref)?.content) !== canonicalObservationJson(canonicalIds)) {
      violations.push(`capability identity projection '${ref}' does not exactly match the canonical capability set`);
    }
  }
  if (manifest.capabilityParityDigest !== observationDigest(capabilityParity(manifest.producers))) violations.push("capability parity digest mismatched");
}

function validatePackageSemantics(manifest: ActivationEvidenceManifest, violations: string[]): void {
  const parity = packageSemanticParity(manifest.producers) as Array<{ ref: string; content: unknown }>;
  const canonical = ACTIVATION_CANONICAL_TUPLES.filter((tuple) => tuple.class === "package")
    .map((tuple) => `${tuple.surface_id}\0${tuple.semantic_selector_if_any}`)
    .sort();
  for (const { ref, content } of parity) {
    if (canonicalObservationJson(content) !== canonicalObservationJson(canonical)) {
      violations.push(`package semantic projection '${ref}' does not match the immutable tuple catalog`);
    }
  }
  if (manifest.packageSemanticParityDigest !== observationDigest(parity)) violations.push("package semantic parity digest mismatched");
}

function validateExecutedArtifactSemantics(manifest: ActivationEvidenceManifest, violations: string[]): void {
  const records = allRecords(manifest.producers);
  const smoke = records.get("package.extracted-smoke")?.content as any;
  if (canonicalObservationJson(smoke?.identities) !== canonicalObservationJson(["status"])
    || smoke?.bodies?.status?.bytes <= 0
    || !/^[a-f0-9]{64}$/.test(smoke?.bodies?.status?.sha256 ?? "")) {
    violations.push("extracted package smoke is missing or did not serve status");
  }
  const artifact = records.get("package.extracted-artifact")?.content as any;
  if (!artifact || canonicalObservationJson({
    filename: artifact.filename,
    integrity: artifact.integrity,
    shasum: artifact.shasum,
    tarballSha256: artifact.tarballSha256,
  }) !== canonicalObservationJson(manifest.packageArtifact)) violations.push("extracted package artifact identity does not bind the manifest package identity");
  if (artifact?.manifest?.path !== "package.json" || artifact?.manifest?.type !== "file"
    || !Number.isInteger(artifact?.manifest?.mode) || !/^[a-f0-9]{64}$/.test(artifact?.manifest?.contentDigest ?? "")) {
    violations.push("extracted package manifest path, type, mode, or content digest is invalid");
  }
  const required = artifact?.requiredSurfaces;
  if (!Array.isArray(required)
    || canonicalObservationJson(required.map((entry: any) => entry.path)) !== canonicalObservationJson(DEVELOPMENT_RUNTIME_REQUIRED_FILES)
    || required.some((entry: any) => !["file", "directory"].includes(entry.type) || !Number.isInteger(entry.mode) || (entry.type === "file" && !/^[a-f0-9]{64}$/.test(entry.contentDigest ?? "")))) {
    violations.push("extracted package required-surface evidence is incomplete or malformed");
  }
  if (!Array.isArray(artifact?.extractedTree?.entries)
    || artifact.extractedTree.entries.some((entry: any) => String(entry.path).endsWith(".js.map"))) {
    violations.push("extracted package file manifest contains an unclassified source map or is missing");
  }
  const extractedEntries = artifact?.extractedTree?.entries;
  const supportPaths = artifact?.runtimeSupportPaths;
  const extractedPayload = Array.isArray(extractedEntries) && Array.isArray(supportPaths)
    ? extractedEntries.filter((entry: any) => !supportPaths.includes(entry.path))
    : null;
  if (!Array.isArray(extractedEntries) || extractedEntries.length < 1
    || new Set(extractedEntries.map((entry: any) => entry.path)).size !== extractedEntries.length
    || extractedEntries.some((entry: any) => typeof entry.path !== "string" || !["directory", "file", "symlink"].includes(entry.type) || !Number.isInteger(entry.mode)
      || (entry.type === "file" && (!Number.isInteger(entry.size) || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")))
    || (entry.type === "symlink" && !/^[a-f0-9]{64}$/.test(entry.targetSha256 ?? "")))
    || artifact.extractedTree.digest !== observationDigest(extractedEntries)
    || !Number.isInteger(artifact?.tarballTree?.count) || artifact.tarballTree.count < 1
    || !/^[a-f0-9]{64}$/.test(artifact?.tarballTree?.digest ?? "")
    || !Array.isArray(supportPaths)
    || new Set(supportPaths).size !== supportPaths.length
    || supportPaths.some((entry: any) => entry !== "node_modules")
    || extractedPayload?.length !== artifact.tarballTree.count
    || observationDigest(extractedPayload) !== artifact.tarballTree.digest) {
    violations.push("complete extracted package tree is not bound to the current tarball payload");
  }
  const portability = records.get("package.portability")?.content as any;
  const extractedManifestFiles = Array.isArray(extractedEntries)
    ? extractedEntries
      .filter((entry: any) => entry.type === "file")
      .map((entry: any) => ({ path: entry.path, size: entry.size, mode: entry.mode }))
      .sort((left: any, right: any) => left.path.localeCompare(right.path))
    : null;
  const secondManifest = portability?.secondManifest;
  if (portability?.deterministicPackRuns !== 2
    || !/^[a-f0-9]{64}$/.test(portability?.deterministicTarballSha256 ?? "")
    || portability?.secondTarballSha256 !== portability?.deterministicTarballSha256
    || portability?.constructionRootCount !== 2 || portability?.constructionRootsDistinct !== true
    || portability?.extractedRootCount !== 1 || portability?.extractedRootsDistinct !== true
    || portability?.forbiddenPathMatches?.length !== 0 || !/^[a-f0-9]{64}$/.test(portability?.contentSha256 ?? "")
    || secondManifest?.filename !== manifest.packageArtifact.filename
    || secondManifest?.integrity !== manifest.packageArtifact.integrity
    || secondManifest?.shasum !== manifest.packageArtifact.shasum
    || !Array.isArray(extractedManifestFiles)
    || secondManifest?.files?.count !== extractedManifestFiles.length
    || secondManifest?.files?.digest !== observationDigest(extractedManifestFiles)) {
    violations.push("extracted package portability evidence is incomplete or failed");
  }

  const sourceAuthority = records.get("bootstrap.source-authority")?.content as any;
  const expectedSpecs = [
    ...(sourceAuthority?.accepted ?? []).map((entry: any) => ({ ...entry, accepted: true })),
    ...(sourceAuthority?.rejections ?? []).map((entry: any) => ({ ...entry, accepted: false })),
  ];
  const expectedById = new Map(expectedSpecs.map((entry: any) => [entry.id, entry]));
  const generated = records.get("bootstrap.generated-binder")?.content as any;
  const generatedRows = generated?.rows;
  if (!Array.isArray(generatedRows) || generatedRows.length !== expectedSpecs.length || new Set(generatedRows.map((row: any) => row.id)).size !== expectedSpecs.length
    || generatedRows.some((row: any) => {
      const expected = expectedById.get(row.id) as any;
      return !expected || row.classification !== expected.classification || canonicalObservationJson(row.states) !== canonicalObservationJson(expected.states);
    })) violations.push("generated binder classifications do not match the source bootstrap authority");

  const extractedRows = records.get("bootstrap.extracted-classifications")?.content as any;
  const expectedComposite = expectedSpecs.flatMap((entry: any) => entry.states.map((state: string) => `package/${state}/${entry.id}`)).sort();
  if (!Array.isArray(extractedRows)
    || canonicalObservationJson(extractedRows.map((row: any) => `package/${row.projectState}/${row.id}`).sort()) !== canonicalObservationJson(expectedComposite)
    || extractedRows.some((row: any) => {
      const expected = expectedById.get(row.id) as any;
      return !expected || row.accepted !== expected.accepted || row.classification !== expected.classification || row.preservationRoots !== 9 || row.childStarted !== expected.accepted;
    })) violations.push("extracted package runtime classifications or sentinel results do not match bootstrap authority");
  const expectedCommandPolicy = Array.isArray(extractedRows) ? {
    rowCount: extractedRows.length,
    accepted: extractedRows.filter((row: any) => row.accepted).length,
    rejected: extractedRows.filter((row: any) => !row.accepted).length,
    classifications: Object.fromEntries([...new Set(extractedRows.map((row: any) => row.classification))].sort().map((classification) => [classification, extractedRows.filter((row: any) => row.classification === classification).length])),
    compositeIdentityDigest: observationDigest(extractedRows.map((row: any) => `${row.runtime}/${row.projectState}/${row.id}`).sort()),
  } : null;
  if (canonicalObservationJson(records.get("package.command-policy")?.content) !== canonicalObservationJson(expectedCommandPolicy)) {
    violations.push("extracted package command-policy classification does not bind the executed runtime matrix");
  }

  const diagnostics = records.get("bootstrap.extracted-diagnostics")?.content as any;
  if (!Array.isArray(diagnostics) || diagnostics.length !== expectedComposite.length - expectedSpecs.filter((entry: any) => entry.accepted).flatMap((entry: any) => entry.states).length
    || diagnostics.some((row: any) => row.accepted !== false || !["wrong_channel", "not_exact", "malformed"].includes(row.classification))) {
    violations.push("extracted package rejection diagnostics are incomplete or misclassified");
  }
  const expectedAdversarial = Array.isArray(diagnostics) ? {
    rowCount: diagnostics.length,
    allBlockedBeforeChildStart: diagnostics.every((row: any) => row.childStarted === false),
    classifications: Object.fromEntries([...new Set(diagnostics.map((row: any) => row.classification))].sort().map((classification) => [classification, diagnostics.filter((row: any) => row.classification === classification).length])),
  } : null;
  if (canonicalObservationJson(records.get("package.adversarial")?.content) !== canonicalObservationJson(expectedAdversarial)) {
    violations.push("package adversarial classifications do not bind extracted rejection diagnostics");
  }
  const generatedDiagnostics = records.get("bootstrap.generated-diagnostics")?.content as any;
  if (!Array.isArray(generatedDiagnostics) || generatedDiagnostics.length !== sourceAuthority?.rejections?.length
    || generatedDiagnostics.some((row: any) => !["wrong_channel", "not_exact", "malformed"].includes(row.classification))) {
    violations.push("generated binder rejection diagnostics are incomplete or misclassified");
  }
  for (const ref of ["bootstrap.generated-startup", "bootstrap.extracted-startup"]) {
    const producers = records.get(ref)?.content as any;
    if (!Array.isArray(producers) || producers.length === 0 || producers.some((entry: any) => typeof entry.path !== "string" || !String(entry.value).startsWith("npx -y agentera@next "))) {
      violations.push(`bootstrap startup producer evidence '${ref}' is incomplete`);
    }
  }
  if (canonicalObservationJson(records.get("bootstrap.generated-declarations")?.content)
    !== canonicalObservationJson(records.get("bootstrap.extracted-declarations")?.content)) {
    violations.push("generated and extracted bootstrap command declarations drifted");
  }
  const parity = records.get("bootstrap.source-package-parity")?.content as any;
  if (!parity?.source || !parity?.package || canonicalObservationJson(parity.source) !== canonicalObservationJson(parity.package)
    || canonicalObservationJson(Object.keys(parity.source).sort()) !== canonicalObservationJson(["clean", "partial", "v2", "v3"])) {
    violations.push("source and extracted package runtime classification parity failed");
  }
  if (parity?.packageArtifact?.filename !== manifest.packageArtifact?.filename
    || parity?.packageArtifact?.integrity !== manifest.packageArtifact?.integrity
    || parity?.packageArtifact?.shasum !== manifest.packageArtifact?.shasum
    || parity?.packageArtifact?.tarballSha256 !== manifest.packageArtifact?.tarballSha256) {
    violations.push("source integration package artifact differs from the package owner artifact");
  }
  const missing = records.get("bootstrap.missing-surface")?.content as any;
  if (!Array.isArray(missing) || missing.length !== DEVELOPMENT_RUNTIME_REQUIRED_FILES.length * 2
    || new Set(missing.map((entry: any) => `${entry.runtime}/${entry.relative}`)).size !== missing.length
    || missing.some((entry: any) => !["source", "package"].includes(entry.runtime) || entry.status !== 64 || entry.classification !== "invalid_authority" || entry.childStarted !== false)) {
    violations.push("bootstrap missing-surface failure evidence is incomplete or misclassified");
  }
}

function validateChecks(manifest: ActivationEvidenceManifest, violations: string[]): void {
  const records = allRecords(manifest.producers);
  const provenanceDigests = new Map<string, string>();
  for (const [ref, record] of records) {
    const key = `${record.producerKind}\0${record.artifactContentDigest}\0${record.observationDigest}`;
    const prior = provenanceDigests.get(key);
    if (prior) violations.push(`activation evidence records '${prior}' and '${ref}' alias one producer artifact observation`);
    else provenanceDigests.set(key, ref);
  }
  const ids = manifest.checks?.map((check) => check.id) ?? [];
  if (canonicalObservationJson(ids) !== canonicalObservationJson(ACTIVATION_CHECK_IDS)) violations.push("activation evidence checks are missing, duplicated, unknown, or out of order");
  const used = new Set<string>();
  for (const check of manifest.checks ?? []) {
    const expectedRefs = CHECK_OBSERVATIONS[check.id];
    if (!expectedRefs || canonicalObservationJson(check.observationRefs) !== canonicalObservationJson(expectedRefs)) {
      violations.push(`activation evidence check '${check.id}' producer requirements drifted`);
      continue;
    }
    for (const ref of check.observationRefs) {
      if (used.has(ref)) violations.push(`activation evidence record '${ref}' was aliased across checks`);
      used.add(ref);
      if (!records.has(ref)) violations.push(`activation evidence check '${check.id}' references missing record '${ref}'`);
    }
    const [classId] = check.id.split(".");
    const census = ACTIVATION_CENSUS_AUTHORITY.classes[classId as keyof typeof ACTIVATION_CENSUS_AUTHORITY.classes];
    if (!census || check.identities.length !== census.count || check.identityDigest !== census.sha256 || digestIdentities(check.identities) !== census.sha256) {
      violations.push(`activation evidence check '${check.id}' identity closure failed`);
    }
    if (check.observationDigest !== observationDigest(check.observationRefs.map((ref) => records.get(ref)?.content ?? null))) {
      violations.push(`activation evidence check '${check.id}' observation digest mismatched`);
    }
  }
  if (used.size !== Object.keys(PROVENANCE).length) violations.push("activation evidence contains unconsumed or multiply consumed producer records");
}

export function activationEvidenceViolations(
  actual: unknown,
  expectedOrContext: ActivationEvidenceManifest | ActivationEvidenceValidationContext,
): string[] {
  const manifest = actual as ActivationEvidenceManifest | null;
  if (!manifest || typeof manifest !== "object") return ["activation evidence manifest is missing"];
  const violations: string[] = [];
  const context = "root" in expectedOrContext ? expectedOrContext : null;
  const expected = context ? null : expectedOrContext as ActivationEvidenceManifest;
  const generation = context?.generation ?? expected!.generation;
  const sourceDigest = context ? activationSourceDigest(context.root) : expected!.currentSourceDigest;
  const packageIntegrity = context
    ? (context.expectedPackageIdentity as ActivationPackageIdentity | undefined)?.packageArtifact?.integrity ?? null
    : manifest.packageArtifact?.integrity ?? null;
  if (manifest.schemaVersion !== ACTIVATION_EVIDENCE_SCHEMA) violations.push("activation evidence schema is wrong");
  if (manifest.generation !== generation) violations.push("activation evidence generation is stale or wrong");
  if (manifest.currentSourceDigest !== sourceDigest) violations.push("activation evidence current-source provenance drifted");
  if (manifest.tupleDigest !== ACTIVATION_TUPLE_AUTHORITY.total.sha256) violations.push("activation evidence tuple digest mismatched");
  if (!manifest.packageArtifact || !/^agentera-\d+\.\d+\.\d+(?:-dev\.\d+)?\.tgz$/.test(manifest.packageArtifact.filename)
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(manifest.packageArtifact.integrity)
    || !/^[a-f0-9]{40}$/.test(manifest.packageArtifact.shasum)
    || !/^[a-f0-9]{64}$/.test(manifest.packageArtifact.tarballSha256)) violations.push("activation evidence package artifact identity is malformed");
  validateOwnerEvidence(manifest.producers?.source, "source-owner", SOURCE_OWNER_EVIDENCE_SCHEMA, sourceDigest, generation, null, violations);
  validateOwnerEvidence(manifest.producers?.generated, "generated-owner", GENERATED_OWNER_EVIDENCE_SCHEMA, sourceDigest, generation, null, violations);
  validateOwnerEvidence(manifest.producers?.package, "package-owner", PACKAGE_OWNER_EVIDENCE_SCHEMA, sourceDigest, generation, packageIntegrity, violations);
  validateCapabilityParity(manifest, violations);
  validatePackageSemantics(manifest, violations);
  validateExecutedArtifactSemantics(manifest, violations);
  validateChecks(manifest, violations);
  const { manifestDigest, ...unsigned } = manifest;
  if (manifestDigest !== observationDigest(unsigned)) violations.push("activation evidence manifest digest mismatched");
  if (Buffer.byteLength(`${canonicalObservationJson(manifest)}\n`, "utf8") > ACTIVATION_EVIDENCE_MAX_BYTES) violations.push("activation evidence manifest exceeds its byte bound");
  if (context) {
    const authoritativeSource = createSourceOwnerEvidence(context.root, context.productionInputs);
    const authoritativeGenerated = createGeneratedOwnerEvidence({
      root: context.root,
      generationRoot: context.generationRoot,
      generation: context.generation,
      productionInputs: context.productionInputs,
    });
    validateAuthoritativeOwner(manifest.producers?.source, authoritativeSource, violations);
    validateAuthoritativeOwner(manifest.producers?.generated, authoritativeGenerated, violations);
    if (!/^[a-f0-9]{64}$/.test(context.expectedManifestDigest)) {
      violations.push("trusted release activation evidence digest is missing or malformed");
    } else if (manifest.manifestDigest !== context.expectedManifestDigest) {
      violations.push("activation evidence manifest differs from the trusted release observation");
    }
    violations.push(...activationPackageIdentityViolations(context.expectedPackageIdentity, manifest.producers?.package));
    for (const relative of [".agentera-generation.json", "dist/.agentera-generation.json", "bundle/.agentera-generation.json"]) {
      try {
        if (JSON.parse(fs.readFileSync(path.join(context.generationRoot, relative), "utf8")).id !== generation) violations.push("activation evidence generation marker provenance drifted");
      } catch { violations.push("activation evidence generation marker is missing or malformed"); }
    }
  }
  if (expected && canonicalObservationJson(manifest) !== canonicalObservationJson(expected)) violations.push("activation evidence differs from the expected independently observed manifest");
  return [...new Set(violations)];
}

export function readActivationEvidenceManifest(generationRoot: string): unknown {
  try { return JSON.parse(fs.readFileSync(path.join(generationRoot, ACTIVATION_EVIDENCE_FILE), "utf8")); }
  catch { return null; }
}
