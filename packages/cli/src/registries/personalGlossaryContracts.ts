export interface PersonalGlossaryAdmissionContract {
  explicitSignalTypes: string[];
  explicitGrammarIds: string[];
  explicitProvenanceFields: string[];
  inferredSignalTypes: string[];
  inferredSourceKinds: string[];
  conversationSignalTypes: string[];
  conversationSourceKinds: string[];
  conversationAuthorClasses: string[];
  conversationEvidenceFields: string[];
  conversationExpectedEvidenceContextFields: string[];
  conversationMinimumEvidenceCount: number;
  conversationCompletenessAuthority: string;
  conversationAdmission: string;
  insufficientRecovery: string;
}

export interface PersonalGlossaryCandidateProjectionContract {
  schemaVersion: string;
  owner: string;
  candidatesMax: number;
  projectIdsMaxPerCandidate: number;
  sourceExcerptMaxUtf8Bytes: number;
  pendingExcerptDays: number;
  sourceFamilies: Record<string, string[]>;
  selectionAlgorithm: string;
  tieBreak: string;
  projectIdentitySchemaVersion: string;
  storageFile: string;
}

export interface ConfirmedVariantGuardContract {
  excludedDirectories: string[];
}

export interface PersonalGlossaryOutputContract {
  command: string;
  requestSchemaVersion: string;
  sectionSchemaVersion: string;
  outputStatuses: string[];
}

export interface PersonalProfileGroundingContract {
  command: string;
  schemaVersion: string;
  maxProfileUtf8Bytes: number;
  validityStatuses: string[];
  validityClasses: string[];
  freshnessStates: string[];
  repairRecovery: string;
  absentRecovery: string;
}
