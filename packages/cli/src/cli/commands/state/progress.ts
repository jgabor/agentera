import type { SchemaInfo } from "../../appContext.js";
import { emitStructured } from "../../structured.js";
import { listProgressEntities, renderProgressEntityListText } from "../../../state/progressEntities.js";
import { out, type Io, type StateArgs } from "./shared.js";

export function queryProgress(args: StateArgs, _schemas: Record<string, SchemaInfo>, io: Io): number {
  const format = (args.format ?? "text") as "text" | "json" | "yaml";
  const response = listProgressEntities(
    process.cwd(),
    args.limit ?? undefined,
    { topic: args.topic, status: args.status },
    args.cursor ?? undefined,
    { format },
  );
  const output = out(io);
  if (format === "text") output(renderProgressEntityListText(response));
  else emitStructured(response, format, output);
  return 0;
}
