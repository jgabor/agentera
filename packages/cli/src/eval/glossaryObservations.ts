type Mapping = Record<string, unknown>;

export const GLOSSARY_OBSERVATIONS_SCHEMA_VERSION =
  "agentera.personalGlossaryEvaluationObservations.v1";

function mapping(value: unknown): Mapping | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Mapping)
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : [];
}

function isLowerSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

type ObservationListSpec = {
  key: "discovery" | "scope" | "inferred_review" | "explicit_admission";
  observedField: string;
  kind: "boolean" | "scope";
};

const OBSERVATION_LIST_SPECS: readonly ObservationListSpec[] = [
  { key: "discovery", observedField: "observed_discovered", kind: "boolean" },
  { key: "scope", observedField: "observed_scope", kind: "scope" },
  { key: "inferred_review", observedField: "observed_reviewed", kind: "boolean" },
  { key: "explicit_admission", observedField: "observed_admitted", kind: "boolean" },
];

/** Validate a separately supplied evaluated-observation set against frozen IDs and labels. */
export function validateGlossaryObservations(
  authority: Mapping,
  holdout: Mapping,
  observations: Mapping,
): string[] {
  const errors: string[] = [];
  if (observations.schema_version !== GLOSSARY_OBSERVATIONS_SCHEMA_VERSION) {
    errors.push("observations schema_version is invalid");
  }
  if (observations.holdout_id !== holdout.holdout_id) {
    errors.push("observations holdout_id does not match the frozen holdout");
  }
  const expectedDigest = mapping(authority.holdout)?.fixture_sha256;
  if (!isLowerSha256(observations.holdout_fixture_sha256) || observations.holdout_fixture_sha256 !== expectedDigest) {
    errors.push("observations holdout_fixture_sha256 does not match the frozen holdout digest");
  }
  const allowedTopLevel = new Set([
    "schema_version",
    "holdout_id",
    "holdout_fixture_sha256",
    ...OBSERVATION_LIST_SPECS.map(({ key }) => key),
  ]);
  for (const field of Object.keys(observations)) {
    if (!allowedTopLevel.has(field)) errors.push(`observations.${field} is not an allowed field`);
  }
  const scopeLabels = strings(mapping(mapping(authority.metrics)?.scope_accuracy)?.labels);
  for (const { key, observedField, kind } of OBSERVATION_LIST_SPECS) {
    const expectedRecords = Array.isArray(holdout[key]) ? holdout[key] : [];
    const expectedIds = new Set(
      expectedRecords.flatMap((value) => {
        const record = mapping(value);
        return record && nonEmptyString(record.id) ? [record.id] : [];
      }),
    );
    const records = observations[key];
    if (!Array.isArray(records)) {
      errors.push(`observations.${key} must be a list`);
      continue;
    }
    const seenIds = new Set<string>();
    for (const [index, value] of records.entries()) {
      const source = `observations.${key}[${index}]`;
      const record = mapping(value);
      if (!record) {
        errors.push(`${source} must be a mapping`);
        continue;
      }
      const allowedFields = new Set(["id", observedField]);
      for (const field of Object.keys(record)) {
        if (!allowedFields.has(field)) errors.push(`${source}.${field} is not an allowed field`);
      }
      const id = record.id;
      if (!nonEmptyString(id)) {
        errors.push(`${source}.id must be a non-empty string`);
      } else if (seenIds.has(id)) {
        errors.push(`${source}.id is duplicated`);
      } else if (!expectedIds.has(id)) {
        errors.push(`${source}.id is unknown to the frozen holdout`);
      } else {
        seenIds.add(id);
      }
      if (kind === "boolean") {
        if (typeof record[observedField] !== "boolean") {
          errors.push(`${source}.${observedField} must be boolean`);
        }
      } else if (!scopeLabels.includes(String(record[observedField] ?? ""))) {
        errors.push(`${source}.${observedField} is not an allowed scope label`);
      }
    }
    for (const expectedId of expectedIds) {
      if (!seenIds.has(expectedId)) errors.push(`observations.${key} is missing frozen id ${expectedId}`);
    }
  }
  return errors;
}
