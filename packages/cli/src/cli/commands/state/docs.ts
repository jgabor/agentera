import fs from "node:fs";

import YAML from "yaml";

import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { listTodoDocsEntities } from "../../../state/todoDocsEntities.js";
import { artifactPath, discoverSchemasDir, type SchemaInfo } from "../../appContext.js";
import { registryArtifactPath } from "../../orientation.js";
import { capabilityStartupComplete } from "../../startupCompletenessContract.js";
import { asList, loadArtifact } from "../../stateQuery.js";
import { emitStructured } from "../../structured.js";
import { err, out, type Io, type StateArgs } from "./shared.js";

export function queryDocs(args: StateArgs, schemas: Record<string, SchemaInfo>, io: Io): number {
  const output = out(io);
  const format = args.format ?? "text";
  const profilePath = registryArtifactPath("profile", discoverSchemasDir());
  const profileStatus = fs.existsSync(profilePath) ? "loaded" : "not found";
  const info = schemas.docs;
  if (!info) throw new Error("docs schema is unavailable");
  const singletonPath = artifactPath(info, "docs");
  const data = loadArtifact(singletonPath);
  try {
    const singleton = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    const mapping = asList(singleton.mapping);
    const coverage = singleton.coverage && typeof singleton.coverage === "object" && !Array.isArray(singleton.coverage) ? singleton.coverage : {};
    const conventions = singleton.conventions && typeof singleton.conventions === "object" && !Array.isArray(singleton.conventions) ? singleton.conventions : {};
    const summary = {
      last_audit: singleton.last_audit,
      conventions,
      mapping,
      mapping_entries: mapping.length,
      coverage,
      source_contract: {
        capability_startup_complete: capabilityStartupComplete({ profileStatus }),
        raw_artifact_reads_required: false,
        inventory_authority: "canonical_entity_files",
        singleton_authority: singletonPath,
      },
    };
    const reservedUtf8Bytes = Math.max(Buffer.byteLength(JSON.stringify({ summary }, null, 2)), Buffer.byteLength(YAML.stringify({ summary }))) + 256;
    const response = listTodoDocsEntities(
      process.cwd(),
      "docs",
      args.limit ?? undefined,
      undefined,
      {
        ...(args.topic ? { topic: args.topic } : {}),
        ...(args.status ? { status: args.status } : {}),
      },
      { format, reservedUtf8Bytes },
    );
    const projected = { ...response, summary };
    if (format === "json" || format === "yaml") emitStructured(projected, format, output);
    else {
      output(`Docs: last_audit=${singleton.last_audit ?? "-"}\nMapping: entries=${mapping.length}\n`);
      for (const entry of response.entries as Array<{
        id: string;
        record: Record<string, unknown>;
      }>) {
        output(`${entry.id} document=${entry.record.document} | path=${entry.record.path} | last_updated=${entry.record.last_updated} | status=${entry.record.status}\n`);
      }
    }
    return 0;
  } catch (error) {
    if (!(error instanceof StateRetrievalFailure)) throw error;
    if (format === "json" || format === "yaml") emitStructured(error.body, format, output);
    else err(io)(YAML.stringify(error.body));
    return error.exitCode;
  }
}
