import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

import { runSourceProfileFullWorkflow } from "../helpers/profileFullGlossaryWorkflow.js";

it("drives Profile Full source behavior from the served instruction order", { timeout: 120_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-full-source-workflow-"));
  try {
    const workflowRoot = path.join(root, "workflow");
    const observation = runSourceProfileFullWorkflow(workflowRoot);
    expect(observation).toMatchObject({
      initialBaseHasNoGlossary: true,
      preservedOwnedSection: true,
      malformedCasesRejected: 4,
      missingGenerationPreserved: true,
      miningFailurePreserved: true,
      noCandidatesPreserved: true,
      degradedGenerationPreserved: true,
      perCandidateGetFailurePreserved: true,
      perCandidateDecisionFailurePreserved: true,
      publisherFailurePreserved: true,
      mixedCandidateReads: 1,
      mixedExplicitPublications: 1,
      mixedReviewsQueued: 2,
      mixedAbstentions: 1,
      fallbackUsedDurableQueue: true,
      replayed: true,
      projectGlossaryTrapSurvived: true,
    });
    expect(observation.questionPrompts).toBe(observation.questionPromptMaximum);

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
