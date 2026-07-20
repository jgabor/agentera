import { amendDecisionEntity, appendDecisionEntity, updateDecisionSatisfactionEntity } from "../decisionEntities.js";
import { appendHealthEntity } from "../healthEntities.js";
import { mutateObjectiveEntity, publishExperimentEntity } from "../objectiveExperimentEntities.js";
import { mutatePlanEntities } from "../planEntities.js";
import { appendProgressEntity } from "../progressEntities.js";
import { requireEntityStateBinding } from "../stateMode.js";
import { mutateTodoDocsEntity } from "../todoDocsEntities.js";
import { reject } from "./errors.js";
import type { StateMutationOptions } from "./mutation.js";
import type { StateWriteEnvelope, StateWriteRequest } from "./operations.js";

export type { StateWriteEnvelope, StateWriteRequest } from "./operations.js";

export function executeStateWrite(
  req: StateWriteRequest,
  _options: StateMutationOptions = {},
): StateWriteEnvelope {
  const binding = requireEntityStateBinding(req.projectRoot);
  const publicationContext = binding.publicationContext;
  try {
    if (req.artifact === "progress") return appendProgressEntity(req, { publicationContext });
    if (req.artifact === "decisions") {
      if (req.spec.verb === "append") return appendDecisionEntity(req, { publicationContext });
      if (req.spec.verb === "update") return updateDecisionSatisfactionEntity(req, { publicationContext });
      return amendDecisionEntity(req, { publicationContext });
    }
    if (req.artifact === "health") {
      if (req.spec.verb === "repair") {
        reject({
          class: "unsupported_target",
          message: "canonical health audit entities are immutable and cannot be row-deduplicated; run agentera check validate state to diagnose malformed or duplicate ownership before repairing entity files",
        });
      }
      return appendHealthEntity(req, { publicationContext });
    }
    if (req.artifact === "plan") return mutatePlanEntities(req, { publicationContext });
    if (req.artifact === "objective") return mutateObjectiveEntity(req, { publicationContext });
    if (req.artifact === "experiments") return publishExperimentEntity(req, { publicationContext });
    return mutateTodoDocsEntity(req, { publicationContext });
  } finally {
    publicationContext.close();
  }
}
