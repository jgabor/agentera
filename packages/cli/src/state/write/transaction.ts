import { amendDecisionEntity, appendDecisionEntity, updateDecisionSatisfactionEntity } from "../decisionEntities.js";
import { appendHealthEntity } from "../healthEntities.js";
import { mutateObjectiveEntity, publishExperimentEntity } from "../objectiveExperimentEntities.js";
import { mutatePlanEntities } from "../planEntities.js";
import { withEntityWriterLock } from "../entityStorage.js";
import { appendProgressEntity } from "../progressEntities.js";
import { requireEntityStateBinding } from "../stateMode.js";
import { mutateTodoDocsEntity } from "../todoDocsEntities.js";
import { publishGlossary } from "./glossaryPublication.js";
import type { StateMutationOptions } from "./mutation.js";
import { assertMutationGrammarParity, type StateWriteEnvelope, type StateWriteRequest } from "./operations.js";

export type { StateWriteEnvelope, StateWriteRequest } from "./operations.js";

export function executeStateWrite(
  req: StateWriteRequest,
  _options: StateMutationOptions = {},
): StateWriteEnvelope {
  assertMutationGrammarParity();
  const binding = requireEntityStateBinding(req.projectRoot);
  const publicationContext = binding.publicationContext;
  try {
    if (req.artifact === "glossary") return publishGlossary(req, binding.root, _options);
    if (req.artifact === "progress") return withEntityWriterLock(publicationContext, () => appendProgressEntity(req, { publicationContext }));
    if (req.artifact === "decisions") {
      if (req.spec.verb === "append") return appendDecisionEntity(req, { publicationContext });
      return withEntityWriterLock(publicationContext, () => req.spec.verb === "update"
        ? updateDecisionSatisfactionEntity(req, { publicationContext })
        : amendDecisionEntity(req, { publicationContext }));
    }
    if (req.artifact === "health") {
      return appendHealthEntity(req, { publicationContext });
    }
    if (req.artifact === "plan") return withEntityWriterLock(publicationContext, () => mutatePlanEntities(req, { publicationContext }));
    if (req.artifact === "objective") return mutateObjectiveEntity(req, { publicationContext });
    if (req.artifact === "experiments") return publishExperimentEntity(req, { publicationContext });
    return mutateTodoDocsEntity(req, { publicationContext });
  } finally {
    publicationContext.close();
  }
}
