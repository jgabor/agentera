import { dumpYamlMapping } from "../core/yaml.js";
import type { JsonObject } from "../core/jsonValue.js";
import { validateArtifactBytes } from "./write/validate.js";

export function healthEntityViolations(record: JsonObject): ReturnType<typeof validateArtifactBytes> {
  return validateArtifactBytes("health", dumpYamlMapping({ audits: [{ number: 1, ...record }] }));
}
