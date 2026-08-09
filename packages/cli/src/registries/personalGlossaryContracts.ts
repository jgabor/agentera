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
  candidateSecretReason: string;
  excerptSensitiveContentAction: string;
  candidateReadCommand: string;
  candidateReadSchemaVersion: string;
  candidateReadDefaultLimit: number;
  candidateReadMaximumLimit: number;
  candidateReadOrder: string;
  candidateReadListProjectionBindingField: string;
  candidateReadSourceFamilies: string[];
  candidateReadProvenanceKinds: string[];
  candidateReadScopes: string[];
  candidateReadMaxSerializedUtf8Bytes: number;
  candidateReadCursorVocabulary: string;
  candidateReadCursorBinding: string[];
  candidateReadCursorInvalidBehavior: string;
  candidateReadCursorUnavailableBehavior: string;
  candidateReadExactRequiredBindings: string[];
  candidateReadExactProjectionBindingField: string;
  candidateReadExactOccurrencesMax: number;
  candidateReadSafeContextMaxUtf8Bytes: number;
  candidateReadExactMaxSerializedUtf8Bytes: number;
  candidateReadCursorAuthority: string;
  candidateReadSafeContextViewAuthority: string;
  candidateReadSafeContextRetentionDays: number;
  candidateReadSafeContextViewExpiry: string;
  candidateReadSafeContextViewMutation: string;
  candidateReadSafeContextViewSnapshot: string;
}

export interface PersonalGlossaryCandidateDecisionContract {
  command: string;
  requestSchemaVersion: string;
  requestFields: string[];
  maxRequestUtf8Bytes: number;
  resultSchemaVersion: string;
  resultFields: string[];
  resultStatuses: string[];
  reasonCodesByOutcome: Record<string, string[]>;
  maxResultUtf8Bytes: number;
  automaticProvenance: string;
  inferredAutomaticAdmission: string;
  qualityGate: string;
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
