import { ArtifactSchemaValidator } from "../../hooks/validateArtifact/index.js";

export function validateArtifactBytes(artifact: string, content: string, validator = new ArtifactSchemaValidator()): string[] {
  const schema = validator.loadSchema(artifact);
  if (!schema) return [`${artifact}: schema '${artifact}' is not available`];
  return validator.validateYaml(content, schema, artifact);
}
