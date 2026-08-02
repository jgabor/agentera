/**
 * Public surface for the `state <name>` command family.
 *
 * Record-family retrieval dispatch is owned by entityListRuntimeRegistry.
 * This module retains the specialized projections used by startup collectors
 * and compatibility code; it does not enumerate public retrieval routes.
 */

import { StateArgs, Io } from "./shared.js";
import { queryProgress } from "./progress.js";
import { queryPlan } from "./plan.js";
import { queryHealth } from "./health.js";
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
  hydrateDecisionEntries,
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
  normalizeSeverity,
  decisionContextEntry,
  decisionSatisfactionContext,
  decisionSourceContract,
  extractDecisionEntries,
  hydrateDecisionEntries,
  displayFields,
};
