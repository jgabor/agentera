import { dumpYamlMapping } from "../core/yaml.js";
import type { JsonObject } from "../core/jsonValue.js";
import { validateArtifactBytes } from "./write/validate.js";

export function healthEntityViolations(record: JsonObject): ReturnType<typeof validateArtifactBytes> {
  const violations = validateArtifactBytes("health", dumpYamlMapping({ audits: [{ number: 1, ...record }] }));
  if (record.appended_at !== undefined) {
    const value = record.appended_at;
    let canonical = false;
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      try { canonical = new Date(value).toISOString() === value; } catch { /* invalid timestamp */ }
    }
    if (!canonical) violations.push("appended_at must be a canonical UTC ISO-8601 timestamp");
  }
  return violations;
}
