import type { JsonObject } from "../../../core/jsonValue.js";
import { StateRetrievalFailure } from "../../../state/directRetrieval.js";
import { currentObjectiveEntity } from "../../../state/objectiveExperimentEntities.js";
import type { SchemaInfo } from "../../appContext.js";
import { emitStructured } from "../../structured.js";
import { formatEntry } from "../../stateQuery.js";
import { err, out, type Io, type StateArgs } from "./shared.js";

export function queryObjective(args: StateArgs, _schemas: Record<string, SchemaInfo>, io: Io): number {
  const output = out(io);
  try {
    const response = currentObjectiveEntity(process.cwd());
    if (args.format === "json" || args.format === "yaml") emitStructured(response, args.format, output);
    else output(formatEntry((response.entries as JsonObject[])[0], ["id", "artifact"]) + "\n");
    return 0;
  } catch (error) {
    if (!(error instanceof StateRetrievalFailure)) throw error;
    if (args.format === "json" || args.format === "yaml") emitStructured(error.body, args.format, output);
    else err(io)(`Error: ${error.body.error.message}\nRecovery: ${error.body.error.recovery}\n`);
    return error.exitCode;
  }
}
