import type { SchemaInfo } from "../../appContext.js";
import { emitStructured } from "../../structured.js";
import { currentPlanEntityView } from "../../../state/planEntities.js";
import YAML from "yaml";
import { out, type Io, type StateArgs } from "./shared.js";

export function queryPlan(args: StateArgs, _schemas: Record<string, SchemaInfo>, io: Io): number {
  const format = args.format ?? "text";
  const response = currentPlanEntityView(
    process.cwd(),
    args.limit ?? undefined,
    args.cursor ?? undefined,
    args.status ?? undefined,
    { format },
  );
  const output = out(io);
  if (format === "text") output(YAML.stringify(response));
  else emitStructured(response, format as "json" | "yaml", output);
  return 0;
}
