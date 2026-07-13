import { resolvePath } from "../../core/paths.js";
import { resolveSourceRoot } from "../../core/sourceRoot.js";
import { emitStructured } from "../structured.js";
import type { Io } from "../dispatch/shared.js";
import {
  inspectDurability,
  renderDurabilityText,
  type DurabilityArgs,
} from "../../state/durability.js";

export function cmdDurability(args: DurabilityArgs, io: Io = {}): number {
  const output = io.out ?? ((text: string) => process.stdout.write(text));
  const response = inspectDurability(
    resolvePath(args.project ?? process.cwd()),
    args,
    { sourceRoot: resolveSourceRoot() },
  );
  if (args.format === "json" || args.format === "yaml") {
    emitStructured(response, args.format, output);
  } else {
    renderDurabilityText(response, output);
  }
  return 0;
}
