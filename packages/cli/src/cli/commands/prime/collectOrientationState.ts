import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectV1ArtifactPairs } from "../../../upgrade/migrateArtifactsV2ToV3.js";
import { summarizeProjectIntegration } from "../../../upgrade/projectIntegration.js";
import { resolveSourceRootStrict } from "../../../upgrade/appModel.js";
import { discoverSchemasDir, loadSchemas } from "../../appContext.js";
import {
  activeObjectiveSummary,
  checkProfileStaleness,
  decisionFollowUp,
  decisionReviewAttention,
  docsSummary,
  healthSummary,
  issueCounts,
  loadTodoItems,
  parseProfileHeaderDates,
  planSummary,
  progressSummary,
  registryArtifactPath,
  selectStatusReadiness,
  statePresence,
} from "../../orientation.js";
import { buildOrientationAttention } from "../../orientation/attention.js";
import { corpusCoverageSummary } from "../../orientation/corpusCoverage.js";
import type { NextAction, OrientationState, ProfileSummary, ReadinessHint } from "../../contracts/orientationState.js";
import { statusBundleStatus } from "./bundleStatus.js";
import type { PrimeOpts } from "./types.js";
import { v1MigrationSummary } from "./v1Migration.js";

export function collectOrientationState(opts: PrimeOpts): OrientationState {
  const env = opts.env ?? process.env;
  const home = opts.home ? opts.home : os.homedir();
  const sourceRoot = resolveSourceRootStrict(env);
  const schemasDir = discoverSchemasDir();
  const schemas = loadSchemas(schemasDir);
  const bundle = statusBundleStatus(opts);
  let savedContext = false;
  try {
    savedContext = fs.readdirSync(path.join(process.cwd(), ".agentera")).some((f) => f.endsWith(".yaml"));
  } catch {
    savedContext = false;
  }
  const mode = savedContext ? "returning" : "fresh";
  const profile = registryArtifactPath("profile", schemasDir, env);
  const profileExists = fs.existsSync(profile);
  const profileStatus = profileExists ? "loaded" : "not found";
  const profileStaleness = profileExists ? checkProfileStaleness(profile, env) : null;
  const profileDict: ProfileSummary = { status: profileStatus, path: profile };
  if (profileStatus === "not found") profileDict.suggested_action = "Run profile to generate PROFILE.md";
  if (profileStaleness !== null) {
    const [isStale, daysSince, staleDays] = profileStaleness;
    profileDict.days_since_generated = daysSince;
    profileDict.stale = isStale;
    profileDict.stale_threshold_days = staleDays;
    if (profileExists) {
      try {
        const headerDates = parseProfileHeaderDates(fs.readFileSync(profile, "utf8"));
        if (headerDates.generatedDate) profileDict.generated_date = headerDates.generatedDate;
        if (headerDates.validatedDate) profileDict.validated_date = headerDates.validatedDate;
      } catch {
        // profile metadata is optional for prime output
      }
    }
    if (isStale) profileDict.suggested_action = "Run profile to refresh PROFILE.md";
  }
  const v1Artifacts = detectV1ArtifactPairs(process.cwd());
  const v1Migration = v1MigrationSummary(v1Artifacts, { sourceRoot, home, env });
  const plan = planSummary(schemas);
  const docs = docsSummary(schemas, { profileStatus });
  const progress = progressSummary(schemas);
  const health = healthSummary(schemas, env);
  const objective = activeObjectiveSummary();
  const presence = statePresence(plan, docs, progress, health, objective);
  const todoItems = loadTodoItems(schemas);
  const counts = issueCounts(todoItems);
  const decision = decisionFollowUp(schemas);
  const decisionAttention = decisionReviewAttention(schemas);
  const corpusCoverage = corpusCoverageSummary(env, process.platform);
  const project = process.cwd();
  const projectIntegration = summarizeProjectIntegration({
    project,
    sourceRoot,
    home,
    env,
    installRoot: String(bundle.appHome),
    bundleStatus: String(bundle.status),
    crossMajorBoundaryDetected: bundle.crossMajorBoundaryDetected ?? false,
  });
  const readiness = selectStatusReadiness(plan, health, objective, todoItems, decision, savedContext);
  const nextAction: ReadinessHint =
    projectIntegration.recommendation === "upgrade"
      ? withRecommended(
          readiness,
          {
            object:
              (projectIntegration.pending_artifacts as number) > 0
                ? "Upgrade Agentera artifacts"
                : (projectIntegration.pending_runtime as number) > 0
                  ? "Upgrade Agentera runtime wiring"
                  : "Upgrade Agentera",
            capability: "status",
            reason: projectIntegration.message,
            phase: "build",
          },
        )
      : projectIntegration.major_boundary_block
        ? withRecommended(readiness, {
            object: "Await v3 successor announcement",
            capability: "status",
            reason: projectIntegration.major_boundary_block,
            phase: "audit",
          })
        : readiness;

  const attention = buildOrientationAttention({
    schemas_dir: schemasDir,
    schemas,
    app: bundle,
    mode,
    profile_dict: profileDict,
    profile_status: profileStatus,
    profile,
    v1_migration: v1Migration,
    project_integration: projectIntegration,
    plan,
    docs,
    progress,
    health,
    objective,
    state_presence: presence,
    corpus_coverage: corpusCoverage,
    todo_items: todoItems,
    counts,
    decision_attention: decisionAttention,
    next_action: nextAction,
    attention: [],
  });

  return {
    schemas_dir: schemasDir,
    schemas,
    app: bundle,
    mode,
    profile_dict: profileDict,
    profile_status: profileStatus,
    profile,
    v1_migration: v1Migration,
    project_integration: projectIntegration,
    plan,
    docs,
    progress,
    health,
    objective,
    state_presence: presence,
    corpus_coverage: corpusCoverage,
    todo_items: todoItems,
    counts,
    decision_attention: decisionAttention,
    next_action: nextAction,
    attention,
  };
}

/** Promote `newRecommended` to position 1, demoting the prior recommendation
 *  (and its alternatives) into `alternatives`. Used when a project-integration
 *  override (upgrade, major-boundary block) takes precedence over the
 *  state-derived cascade; the demoted candidates remain visible as what to do
 *  once the override is resolved. */
function withRecommended(hint: ReadinessHint, newRecommended: NextAction): ReadinessHint {
  return {
    recommended: newRecommended,
    alternatives: [hint.recommended, ...hint.alternatives],
  };
}
