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
