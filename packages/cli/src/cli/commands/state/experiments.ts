import type { SchemaInfo } from "../../appContext.js";
import { emitStructured } from "../../structured.js";
import { listCurrentExperimentEntities } from "../../../state/objectiveExperimentEntities.js";
import YAML from "yaml";
import { out, type Io, type StateArgs } from "./shared.js";

export function queryExperiments(args: StateArgs, _schemas: Record<string, SchemaInfo>, io: Io): number {
  const format = args.format ?? "text";
  const response = listCurrentExperimentEntities(
    process.cwd(),
    args.objective ?? undefined,
    args.limit ?? undefined,
    args.cursor ?? undefined,
    { topic: args.topic ?? undefined, status: args.status ?? undefined },
    { format },
  );
  const output = out(io);
  if (format === "text") output(YAML.stringify(response));
  else emitStructured(response, format as "json" | "yaml", output);
  return 0;
}
