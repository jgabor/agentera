/**
 * Artifact validation used by the explicit `agentera check validate artifact`
 * command and state publication.
 */

import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../../core/yaml.js";
import { resolvePath } from "../../core/paths.js";
import { normalizeArtifactProtocolId } from "../../registries/artifactProtocolIds.js";
import { DEFAULT_ARTIFACT_PATHS } from "../common.js";
import { validateMd } from "./markdown.js";
import {
  defaultArtifactPath,
  readIfNeeded,
} from "./traversal.js";
import { schemasDirDefault, validateYamlContent } from "./violations.js";
import { AGENT_FACING_ARTIFACT_IDS, HUMAN_FACING_ARTIFACT_IDS } from "./agentFacing.js";

import type { JsonObject } from "../../core/jsonValue.js";

export class ArtifactSchemaValidator {
  schemasDir: string;
  private schemaCache: Map<string, JsonObject | null>;

  constructor(schemasDir: string = schemasDirDefault()) {
    this.schemasDir = schemasDir;
    this.schemaCache = new Map();
  }

  loadSchema(name: string): JsonObject | null {
    if (!this.schemaCache.has(name)) {
      const p = path.join(this.schemasDir, `${name}.yaml`);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        // cast: artifact schema parsed from a YAML schema file
        this.schemaCache.set(name, loadYamlMapping(fs.readFileSync(p, "utf8")) as JsonObject);
      } else {
        this.schemaCache.set(name, null);
      }
    }
    return this.schemaCache.get(name) ?? null;
  }

  validateYaml(content: string, schema: JsonObject, name: string): string[] {
    return validateYamlContent(content, schema, name);
  }

  validateMarkdown(content: string, name: string, schema: JsonObject | null = null): string[] {
    return validateMd(content, name, schema);
  }

  validateExplicit(artifact: string, filePath: string, cwd: string): string[] {
    const content = readIfNeeded(null, filePath);
    if (content === null) return [`${artifact}: cannot read artifact file '${filePath}'`];
    const protocolId = normalizeArtifactProtocolId(artifact);
    if (protocolId === null) {
      return [`${artifact}: unsupported artifact protocol id`];
    }
    if (AGENT_FACING_ARTIFACT_IDS.has(protocolId)) {
      const schema = this.loadSchema(protocolId);
      if (schema === null) return [`${protocolId}: schema '${protocolId}' is not available`];
      if (Object.keys(schema).length === 0) {
        return [`${protocolId}: schema '${protocolId}' file is empty or contains no valid definitions`];
      }
      return this.validateYaml(content, schema, protocolId);
    }
    if (HUMAN_FACING_ARTIFACT_IDS.has(protocolId)) {
      const schema = this.loadSchema(protocolId);
      return this.validateMarkdown(content, artifact, schema);
    }
    return [
      `${artifact}: unsupported artifact; expected one of: ${Object.keys(DEFAULT_ARTIFACT_PATHS).sort().join(", ")}`,
    ];
  }
}

export function loadSchema(name: string): JsonObject | null {
  return new ArtifactSchemaValidator().loadSchema(name);
}

export class ArtifactValidationAdapter {
  validator: ArtifactSchemaValidator;

  constructor(validator?: ArtifactSchemaValidator) {
    this.validator = validator ?? new ArtifactSchemaValidator();
  }

  runExplicit(artifact: string, filePath: string | null, cwd: string): [number, JsonObject] {
    artifact = artifact.trim();
    const defaultPath = defaultArtifactPath(artifact, cwd);
    const resolvedFile = filePath ? (path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)) : defaultPath;
    const violations = this.validator.validateExplicit(artifact, resolvedFile, cwd);
    const payload: JsonObject = {
      command: "validate-artifact",
      status: violations.length > 0 ? "fail" : "pass",
      artifact,
      file: resolvedFile,
      docs_mapped_default: defaultPath || null,
      path_source: filePath ? "provided" : "docs_mapped_default",
      violations,
    };
    return violations.length > 0 ? [2, payload] : [0, payload];
  }
}

export { resolvePath };
