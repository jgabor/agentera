import type { SchemaInfo } from "../../appContext.js";
import { emitStructured } from "../../structured.js";
import { listHealthEntities } from "../../../state/healthEntities.js";
import YAML from "yaml";
import { out, type Io, type StateArgs } from "./shared.js";

export function queryHealth(args: StateArgs, _schemas: Record<string, SchemaInfo>, io: Io): number {
  const format = args.format ?? "text";
  const response = listHealthEntities(process.cwd(), args.limit ?? 1, args.dimension ?? undefined, args.cursor ?? undefined, { format });
  const output = out(io);
  if (format === "text") output(YAML.stringify(response));
  else emitStructured(response, format as "json" | "yaml", output);
  return 0;
}
