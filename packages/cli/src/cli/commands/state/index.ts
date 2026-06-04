/**
 * Public surface for the `state <name>` command family.
 *
 * The `cmdState` entry point validates the incoming args, loads the
 * schema directory, and dispatches to the per-state-family handler
 * in `STATE_COMMAND_HANDLERS`. The `isPortedStateCommand` predicate
 * is the public surface used by `cli/dispatch.ts` to decide whether
 * a top-level token is a state command or a deprecated alias.
 */

import { COMMAND_FILTERS, validateFilterValues } from "../../stateQuery.js";
import { loadSchemas, discoverSchemasDir } from "../../appContext.js";
import { StateArgs, Io, err } from "./shared.js";
import { queryProgress } from "./progress.js";
import { queryPlan } from "./plan.js";
import { queryHealth, healthAuditNumber, latestHealthAudit } from "./health.js";
import { queryDocs } from "./docs.js";
import { queryObjective } from "./objective.js";
import { queryExperiments } from "./experiments.js";
import { queryTodo, normalizeSeverity } from "./todo.js";
import {
  queryDecisions,
  decisionContextEntry,
  decisionSatisfactionContext,
  decisionSourceContract,
  extractDecisionEntries,
  displayFields,
} from "./decisions.js";

export { StateArgs, Io };
export {
  queryProgress,
  queryPlan,
  queryHealth,
  queryDocs,
  queryObjective,
  queryExperiments,
  queryTodo,
  queryDecisions,
  healthAuditNumber,
  latestHealthAudit,
  normalizeSeverity,
  decisionContextEntry,
  decisionSatisfactionContext,
  decisionSourceContract,
  extractDecisionEntries,
  displayFields,
};

const STATE_COMMAND_HANDLERS: Record<
  string,
  (args: StateArgs, schemas: Record<string, any>, io: Io) => number
> = {
  progress: queryProgress,
  plan: queryPlan,
  health: queryHealth,
  docs: queryDocs,
  objective: queryObjective,
  experiments: queryExperiments,
  todo: queryTodo,
  decisions: queryDecisions,
};

export function isPortedStateCommand(command: string): boolean {
  return command in STATE_COMMAND_HANDLERS;
}

export function cmdState(args: StateArgs, io: Io): number {
  const e = err(io);
  try {
    validateFilterValues(args as any, COMMAND_FILTERS[args.command] ?? []);
    if (args.limit !== null && args.limit !== undefined && args.limit < 0) {
      throw new Error("limit must be zero or greater");
    }
    const schemas = loadSchemas(discoverSchemasDir());
    const handler = STATE_COMMAND_HANDLERS[args.command];
    return handler(args, schemas, io);
  } catch (exc) {
    e(`Error: ${(exc as Error).message}\n`);
    return 2;
  }
}
