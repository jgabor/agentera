import { loadYamlMappingFile } from "../core/yaml.js";
import { projectGlossaryDevelopmentValue } from "../core/developmentInvocation.js";
import { glossaryEntryAuthorityPath } from "./glossaryEntryContract.js";
import type { PersonalGlossaryReviewRecordsContract } from "./personalGlossaryContracts.js";

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : [];
}

/** Load the authority-owned private review persistence, retrieval, and maintenance settings. */
export function personalGlossaryReviewRecordsContract(
  pathname: string = glossaryEntryAuthorityPath(),
): PersonalGlossaryReviewRecordsContract {
  const authority = loadYamlMappingFile(pathname) as Mapping;
  const mining = mapping(authority.personal_mining_authority);
  const records = mapping(mining?.review_records);
  const persistence = mapping(records?.persistence);
  const compatibility = mapping(persistence?.compatibility);
  const queue = mapping(records?.queue);
  const queueCommand = mapping(queue?.command);
  const request = mapping(queue?.request);
  const queueResult = mapping(queue?.result);
  const disposition = mapping(records?.disposition);
  const dispositionCommand = mapping(disposition?.command);
  const dispositionRequest = mapping(disposition?.request);
  const dispositionResult = mapping(disposition?.result);
  const publicationAuthorization = mapping(disposition?.publication_authorization);
  const trustedHostKey = mapping(records?.trusted_host_key);
  const retrieval = mapping(records?.retrieval);
  const retrievalCommand = mapping(retrieval?.command);
  const list = mapping(retrieval?.list);
  const filters = mapping(list?.filters);
  const cursor = mapping(list?.cursor);
  const exact = mapping(retrieval?.exact);
  const maintenance = mapping(records?.maintenance);
  const command = projectGlossaryDevelopmentValue(
    queueCommand?.canonical,
    "review_records.command",
  );
  const retrievalCommandValue = projectGlossaryDevelopmentValue(
    retrievalCommand?.canonical,
    "review_records.command",
  );
  if (command !== retrievalCommandValue) {
    throw new TypeError("invalid development command projection: personal glossary review commands differ");
  }
  const dispositionCommandValue = projectGlossaryDevelopmentValue(
    dispositionCommand?.canonical,
    "review_records.command",
  );
  if (command !== dispositionCommandValue) {
    throw new TypeError("invalid development command projection: personal glossary review disposition commands differ");
  }
  return {
    command,
    queueRequestSchemaVersion:
      typeof request?.schema_version === "string" ? request.schema_version : "",
    queueRequestFields: strings(request?.required_fields),
    queueMaxRequestUtf8Bytes:
      typeof request?.max_utf8_bytes === "number" ? request.max_utf8_bytes : 0,
    queueDecisionOutcome:
      typeof queue?.decision_outcome === "string" ? queue.decision_outcome : "",
    queueCurrentBindings: strings(queue?.current_bindings),
    queueResultSchemaVersion:
      typeof queueResult?.schema_version === "string" ? queueResult.schema_version : "",
    queueResultStatuses: strings(queueResult?.statuses),
    queueMaxResultUtf8Bytes:
      typeof queueResult?.max_utf8_bytes === "number" ? queueResult.max_utf8_bytes : 0,
    queueNoQuestionChannel:
      typeof queue?.no_question_channel === "string" ? queue.no_question_channel : "",
    dispositionRequestSchemaVersion:
      typeof dispositionRequest?.schema_version === "string" ? dispositionRequest.schema_version : "",
    dispositionRequestFields: strings(dispositionRequest?.required_fields),
    dispositionMaxRequestUtf8Bytes:
      typeof dispositionRequest?.max_utf8_bytes === "number" ? dispositionRequest.max_utf8_bytes : 0,
    dispositionResultSchemaVersion:
      typeof dispositionResult?.schema_version === "string" ? dispositionResult.schema_version : "",
    dispositionResultStatuses: strings(dispositionResult?.statuses),
    dispositionMaxResultUtf8Bytes:
      typeof dispositionResult?.max_utf8_bytes === "number" ? dispositionResult.max_utf8_bytes : 0,
    dispositionPublicationAuthorizationDispositions: strings(publicationAuthorization?.dispositions),
    dispositionPublicationAuthorizationFields: strings(publicationAuthorization?.fields),
    trustedHostKeyFile: typeof trustedHostKey?.file === "string" ? trustedHostKey.file : "",
    trustedHostKeySchemaVersion:
      typeof trustedHostKey?.schema_version === "string" ? trustedHostKey.schema_version : "",
    trustedHostKeyFields: strings(trustedHostKey?.fields),
    trustedHostKeyOwner: typeof trustedHostKey?.owner === "string" ? trustedHostKey.owner : "",
    trustedHostKeyAlgorithm:
      typeof trustedHostKey?.public_key_algorithm === "string" ? trustedHostKey.public_key_algorithm : "",
    trustedHostKeyMaxSerializedUtf8Bytes:
      typeof trustedHostKey?.max_serialized_utf8_bytes === "number"
        ? trustedHostKey.max_serialized_utf8_bytes
        : 0,
    storeSchemaVersion:
      typeof persistence?.schema_version === "string" ? persistence.schema_version : "",
    recordSchemaVersion:
      typeof persistence?.record_schema_version === "string" ? persistence.record_schema_version : "",
    storeOwner: typeof persistence?.owner === "string" ? persistence.owner : "",
    storeFile: typeof persistence?.file === "string" ? persistence.file : "",
    storeFields: strings(persistence?.fields),
    recordFields: strings(persistence?.record_fields),
    recordsMax: typeof persistence?.records_max === "number" ? persistence.records_max : 0,
    replayIndexFields: strings(persistence?.replay_index_fields),
    replayEntriesMax:
      typeof persistence?.replay_entries_max === "number" ? persistence.replay_entries_max : 0,
    recordMaxSerializedUtf8Bytes:
      typeof persistence?.record_max_serialized_utf8_bytes === "number"
        ? persistence.record_max_serialized_utf8_bytes
        : 0,
    storeMaxSerializedUtf8Bytes:
      typeof persistence?.max_serialized_utf8_bytes === "number"
        ? persistence.max_serialized_utf8_bytes
        : 0,
    storeOrder: typeof persistence?.order === "string" ? persistence.order : "",
    replay: typeof persistence?.replay === "string" ? persistence.replay : "",
    conflict: typeof persistence?.conflict === "string" ? persistence.conflict : "",
    compatibilityStoreSchemaVersions: strings(compatibility?.accepted_store_schema_versions),
    compatibilityRecordSchemaVersions: strings(compatibility?.accepted_record_schema_versions),
    compatibilityReadMutation: typeof compatibility?.read_mutation === "string" ? compatibility.read_mutation : "",
    compatibilityMigrationOperation:
      typeof compatibility?.migration_operation === "string" ? compatibility.migration_operation : "",
    compatibilityScopeDerivation:
      typeof compatibility?.scope_derivation === "string" ? compatibility.scope_derivation : "",
    compatibilityInvalidBehavior:
      typeof compatibility?.invalid_behavior === "string" ? compatibility.invalid_behavior : "",
    compatibilityPreservedBindings: strings(compatibility?.preserved_bindings),
    compatibilityLegacyDigest:
      typeof compatibility?.legacy_digest === "string" ? compatibility.legacy_digest : "",
    compatibilityMigratedDigest:
      typeof compatibility?.migrated_digest === "string" ? compatibility.migrated_digest : "",
    suppressionBinding: strings(persistence?.suppression_binding),
    suppressionDispositions: strings(persistence?.suppression_dispositions),
    reopenReasons: strings(persistence?.reopen_reasons),
    forbiddenFields: strings(persistence?.forbidden_fields),
    retrievalSchemaVersion:
      typeof retrieval?.schema_version === "string" ? retrieval.schema_version : "",
    retrievalOwner: typeof retrieval?.owner === "string" ? retrieval.owner : "",
    listDefaultLimit: typeof list?.default_limit === "number" ? list.default_limit : 0,
    listMaximumLimit: typeof list?.maximum_limit === "number" ? list.maximum_limit : 0,
    listMaxSerializedUtf8Bytes:
      typeof list?.max_serialized_utf8_bytes === "number" ? list.max_serialized_utf8_bytes : 0,
    listOrder: typeof list?.order === "string" ? list.order : "",
    listStatuses: strings(filters?.status),
    cursorAuthority: typeof cursor?.authority === "string" ? cursor.authority : "",
    cursorVocabulary: typeof cursor?.vocabulary === "string" ? cursor.vocabulary : "",
    cursorBinding: strings(cursor?.binding),
    cursorInvalidBehavior:
      typeof cursor?.invalid_behavior === "string" ? cursor.invalid_behavior : "",
    cursorUnavailableBehavior:
      typeof cursor?.unavailable_behavior === "string" ? cursor.unavailable_behavior : "",
    exactRequiredBindings: strings(exact?.required_bindings),
    exactCurrentBindingField:
      typeof exact?.current_binding_field === "string" ? exact.current_binding_field : "",
    exactMaxSerializedUtf8Bytes:
      typeof exact?.max_serialized_utf8_bytes === "number"
        ? exact.max_serialized_utf8_bytes
        : 0,
    terminalMetadataDays:
      typeof maintenance?.terminal_metadata_days === "number"
        ? maintenance.terminal_metadata_days
        : 0,
    maintenanceExposure:
      typeof maintenance?.exposure === "string" ? maintenance.exposure : "",
    maintenancePurge:
      typeof maintenance?.purge === "string" ? maintenance.purge : "",
    maintenanceForbiddenEffects: strings(maintenance?.forbidden_effects),
  };
}
