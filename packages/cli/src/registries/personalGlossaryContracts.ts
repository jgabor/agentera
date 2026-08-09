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

export interface PersonalGlossaryReviewRecordsContract {
  command: string;
  queueRequestSchemaVersion: string;
  queueRequestFields: string[];
  queueMaxRequestUtf8Bytes: number;
  queueDecisionOutcome: string;
  queueCurrentBindings: string[];
  queueResultSchemaVersion: string;
  queueResultStatuses: string[];
  queueMaxResultUtf8Bytes: number;
  queueNoQuestionChannel: string;
  dispositionRequestSchemaVersion: string;
  dispositionRequestFields: string[];
  dispositionMaxRequestUtf8Bytes: number;
  dispositionResultSchemaVersion: string;
  dispositionResultStatuses: string[];
  dispositionMaxResultUtf8Bytes: number;
  dispositionPublicationAuthorizationDispositions: string[];
  dispositionPublicationAuthorizationFields: string[];
  trustedHostKeyFile: string;
  trustedHostKeySchemaVersion: string;
  trustedHostKeyFields: string[];
  trustedHostKeyOwner: string;
  trustedHostKeyAlgorithm: string;
  trustedHostKeyMaxSerializedUtf8Bytes: number;
  storeSchemaVersion: string;
  recordSchemaVersion: string;
  storeOwner: string;
  storeFile: string;
  storeFields: string[];
  recordFields: string[];
  recordsMax: number;
  replayIndexFields: string[];
  replayEntriesMax: number;
  recordMaxSerializedUtf8Bytes: number;
  storeMaxSerializedUtf8Bytes: number;
  storeOrder: string;
  replay: string;
  conflict: string;
  compatibilityStoreSchemaVersions: string[];
  compatibilityRecordSchemaVersions: string[];
  compatibilityReadMutation: string;
  compatibilityMigrationOperation: string;
  compatibilityScopeDerivation: string;
  compatibilityInvalidBehavior: string;
  compatibilityPreservedBindings: string[];
  compatibilityLegacyDigest: string;
  compatibilityMigratedDigest: string;
  suppressionBinding: string[];
  suppressionDispositions: string[];
  reopenReasons: string[];
  forbiddenFields: string[];
  retrievalSchemaVersion: string;
  retrievalOwner: string;
  listDefaultLimit: number;
  listMaximumLimit: number;
  listMaxSerializedUtf8Bytes: number;
  listOrder: string;
  listStatuses: string[];
  cursorAuthority: string;
  cursorVocabulary: string;
  cursorBinding: string[];
  cursorInvalidBehavior: string;
  cursorUnavailableBehavior: string;
  exactRequiredBindings: string[];
  exactCurrentBindingField: string;
  exactMaxSerializedUtf8Bytes: number;
  terminalMetadataDays: number;
  maintenanceExposure: string;
  maintenancePurge: string;
  maintenanceForbiddenEffects: string[];
}

export interface ConfirmedVariantGuardContract {
  excludedDirectories: string[];
}

export interface PersonalGlossaryOutputContract {
  command: string;
  requestSchemaVersion: string;
  requestFields: string[];
  requestOptionalFields: string[];
  maxRequestUtf8Bytes: number;
  resultSchemaVersion: string;
  resultFields: string[];
  maxResultUtf8Bytes: number;
  sectionSchemaVersion: string;
  outputStatuses: string[];
  reviewAuthorizationFields: string[];
  reviewAuthorizationDispositions: string[];
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
