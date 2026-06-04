/**
 * Public surface for the validate-artifact hook. The CLI command
 * (`packages/cli/src/cli/commands/validate.ts`), the smoke checks, and
 * the dispatch entry all import the public classes from this barrel
 * to keep import paths stable as the file is split across the
 * per-responsibility submodules.
 */

import fs from "node:fs";
import path from "node:path";

import { loadYamlMapping } from "../../core/yaml.js";
import { resolvePath } from "../../core/paths.js";
import { normalizeArtifactProtocolId } from "../../registries/artifactProtocolIds.js";
import { DEFAULT_ARTIFACT_PATHS } from "../common.js";
import { ArtifactWrite, RuntimeEventParser } from "./runtime.js";
import { isMapping } from "./schema.js";
import { validateMd } from "./markdown.js";
import {
  artifactForWrite,
  defaultArtifactPath,
  readIfNeeded,
  compactAfterValidWrite,
} from "./traversal.js";
import { schemasDirDefault, validateYamlContent } from "./violations.js";
import { AGENT_FACING_ARTIFACT_IDS, HUMAN_FACING_ARTIFACT_IDS } from "./agentFacing.js";

type Dict = Record<string, any>;

export class ArtifactSchemaValidator {
  schemasDir: string;
  private schemaCache: Map<string, Dict | null>;

  constructor(schemasDir: string = schemasDirDefault()) {
    this.schemasDir = schemasDir;
    this.schemaCache = new Map();
  }

  loadSchema(name: string): Dict | null {
    if (!this.schemaCache.has(name)) {
      const p = path.join(this.schemasDir, `${name}.yaml`);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        this.schemaCache.set(name, loadYamlMapping(fs.readFileSync(p, "utf8")));
      } else {
        this.schemaCache.set(name, null);
      }
    }
    return this.schemaCache.get(name) ?? null;
  }

  validateYaml(content: string, schema: Dict, name: string): string[] {
    return validateYamlContent(content, schema, name);
  }

  validateMarkdown(content: string, name: string, schema: Dict | null = null): string[] {
    return validateMd(content, name, schema);
  }

  validateWrite(write: ArtifactWrite, cwd: string): string[] {
    const absPath = path.isAbsolute(write.file_path) ? write.file_path : path.join(cwd, write.file_path);
    const rel = path.relative(cwd, absPath).replace(/\\/g, "/");
    const basename = path.basename(absPath);
    const artifact = artifactForWrite(absPath, rel, basename, cwd);

    if (artifact && AGENT_FACING_ARTIFACT_IDS.has(artifact)) {
      const schema = this.loadSchema(artifact);
      if (schema === null) return [];
      if (Object.keys(schema).length === 0) return [`${artifact}: schema file is empty or contains no valid definitions`];
      const content = readIfNeeded(write.content, absPath);
      if (content === null) return [];
      let violations = this.validateYaml(content, schema, artifact);
      if (violations.length > 0) return violations;
      return compactAfterValidWrite(artifact, absPath);
    }

    if (artifact && HUMAN_FACING_ARTIFACT_IDS.has(artifact)) {
      const content = readIfNeeded(write.content, absPath);
      if (content === null) return [];
      const schema = this.loadSchema(artifact);
      const violations = this.validateMarkdown(content, artifact, schema);
      if (violations.length > 0) return violations;
      return compactAfterValidWrite(artifact, absPath);
    }

    return [];
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

export function loadSchema(name: string): Dict | null {
  return new ArtifactSchemaValidator().loadSchema(name);
}

export class HookCliAdapter {
  parser: RuntimeEventParser;
  validator: ArtifactSchemaValidator;

  constructor(parser?: RuntimeEventParser, validator?: ArtifactSchemaValidator) {
    this.parser = parser ?? new RuntimeEventParser();
    this.validator = validator ?? new ArtifactSchemaValidator();
  }

  run(raw: string, defaultCwd: string | null = null): [number, string[]] {
    let data: unknown;
    try {
      if (!raw.trim()) return [0, []];
      data = JSON.parse(raw);
    } catch {
      return [0, []];
    }
    if (!isMapping(data)) return [0, []];
    const write = this.parser.parse(data);
    if (write === null) return [0, []];
    const cwd = (data as Dict).cwd ?? defaultCwd ?? process.cwd();
    const violations = this.validator.validateWrite(write, cwd);
    return violations.length > 0 ? [2, violations] : [0, []];
  }

  runExplicit(artifact: string, filePath: string | null, cwd: string): [number, Dict] {
    artifact = artifact.trim();
    const defaultPath = defaultArtifactPath(artifact, cwd);
    const resolvedFile = filePath ? (path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)) : defaultPath;
    const violations = this.validator.validateExplicit(artifact, resolvedFile, cwd);
    const payload: Dict = {
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

export { ArtifactWrite, RuntimeEventParser, resolvePath };
