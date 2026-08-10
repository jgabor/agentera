export const SOURCE_OWNER_EVIDENCE_SCHEMA = "agentera.activationSourceOwnerEvidence.v1";
export const PACKAGE_OWNER_EVIDENCE_SCHEMA = "agentera.activationPackageOwnerEvidence.v1";
export const GENERATED_OWNER_EVIDENCE_SCHEMA = "agentera.activationGeneratedOwnerEvidence.v1";
export const PACKAGE_IDENTITY_SCHEMA = "agentera.activationPackageIdentity.v1";
export const PACKAGE_SNAPSHOT_SCHEMA = "agentera.activationPackageSnapshot.v1";
export const PACKAGE_SNAPSHOT_DIRECTORY = ".activation-package-snapshot";
export const OWNER_EVIDENCE_MAX_BYTES = 262_144;
export const PACKAGE_IDENTITY_MAX_BYTES = 16_384;
export const PACKAGE_SNAPSHOT_MARKER_MAX_BYTES = 16_384;
export const PACKAGE_SNAPSHOT_TARBALL_MAX_BYTES = 64 * 1024 * 1024;
export const PACKAGE_SNAPSHOT_EXTRACTED_MAX_BYTES = 128 * 1024 * 1024;
export const PACKAGE_SNAPSHOT_MAX_ENTRIES = 4_096;

export type ActivationProducerKind = "source-owner" | "generated-owner" | "package-owner";

export interface ActivationArtifactRecord {
  producerKind: ActivationProducerKind;
  artifactClass: string;
  artifactIdentity: string;
  artifactContentDigest: string;
  generation: string | null;
  packageIntegrity: string | null;
  content: unknown;
  observationDigest: string;
}

export interface ActivationOwnerEvidence {
  schemaVersion: string;
  producerKind: ActivationProducerKind;
  sourceDigest: string;
  generation: string | null;
  packageIntegrity: string | null;
  records: Record<string, ActivationArtifactRecord>;
  evidenceDigest: string;
}

export interface ActivationPackageArtifactIdentity {
  filename: string;
  integrity: string;
  shasum: string;
  tarballSha256: string;
}

export interface ActivationPackageIdentity {
  schemaVersion: typeof PACKAGE_IDENTITY_SCHEMA;
  packageEvidenceDigest: string;
  packageArtifact: ActivationPackageArtifactIdentity;
  packageArtifactObservationDigest: string;
  extractedTree: { count: number; digest: string };
  tarballTree: { count: number; digest: string };
  identityDigest: string;
}

export interface FinalizedPackageOwnerEvidence {
  evidence: ActivationOwnerEvidence;
  packageIdentity: ActivationPackageIdentity;
}

export interface SourcePackageExecutionEvidence {
  fixture: any;
  runtimeSummary: any;
  missingSurfaceResults: unknown[];
}
