import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectV1ArtifactPairs } from "../../../upgrade/migrateArtifactsV2ToV3.js";
import { summarizeProjectIntegration } from "../../../upgrade/projectIntegration.js";
import type { SchemaInfo } from "../../appContext.js";
import {
  checkProfileStaleness,
  issueCounts,
  parseProfileHeaderDates,
  registryArtifactPath,
  selectStatusReadiness,
  statePresence,
} from "../../orientation.js";
import { buildOrientationAttention } from "../../orientation/attention.js";
import { corpusCoverageSummary } from "../../orientation/corpusCoverage.js";
import { profileSignalsStatus } from "../../../analytics/profileSignals.js";
import type { NextAction, OrientationState, ProfileSummary, ReadinessHint } from "../../contracts/orientationState.js";
import { statusBundleContext } from "./bundleStatus.js";
import type { PrimeOpts } from "./types.js";
import { v1MigrationSummary } from "./v1Migration.js";
import { diagnoseCanonicalSkill } from "../../../setup/sharedSkill.js";
import { collectEntityOrientation } from "./collectEntityOrientation.js";

const EMPTY_SCHEMAS: Record<string, SchemaInfo> = Object.freeze({});

export function collectOrientationState(opts: PrimeOpts): OrientationState {
  const env = opts.env ?? process.env;
  const home = opts.home ? opts.home : os.homedir();
  const project = process.cwd();
  const { bundle, channel, install, successorAnnounced } = statusBundleContext(opts);
  const sourceRoot = bundle.sourceRoot;
  const schemasDir = path.join(sourceRoot, "skills", "agentera", "schemas", "artifacts");
  const schemas = EMPTY_SCHEMAS;
  let savedContext = false;
  try {
    savedContext = fs.readdirSync(path.join(project, ".agentera")).some((f) => f.endsWith(".yaml"));
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
  const boundedSignals = profileSignalsStatus(env, process.platform);
  profileDict.bounded_signals = boundedSignals as unknown as ProfileSummary["bounded_signals"];
  const v1Artifacts = detectV1ArtifactPairs(project);
  const v1Migration = v1MigrationSummary(v1Artifacts, { sourceRoot, home, env });
  const entity = collectEntityOrientation(project, sourceRoot);
  const plan = entity.plan;
  const docs = entity.docs;
  const progress = entity.progress;
  const health = entity.health;
  const history = entity.history;
  const objective = entity.objective;
  const presence = statePresence(plan, docs, progress, health, objective);
  const todoItems = entity.todoItems;
  const counts = issueCounts(todoItems);
  const decision = entity.decision;
  const decisionAttention = entity.decisionAttention;
  const corpusCoverage = corpusCoverageSummary(env, process.platform);
  const sharedSkill = diagnoseCanonicalSkill(home);
  const projectIntegration = summarizeProjectIntegration({
    project,
    sourceRoot,
    home,
    env,
    installRoot: String(bundle.appHome),
    bundleStatus: String(bundle.status),
    retryCommand: bundle.retryCommand,
    crossMajorBoundaryDetected: bundle.crossMajorBoundaryDetected ?? false,
    channel: bundle.updateChannel ?? null,
    resolvedChannel: channel,
    installClassification: install,
    successorAnnounced,
    precomputedV1Artifacts: v1Artifacts,
  });
  const readiness = selectStatusReadiness(plan, health, objective, todoItems, decision, savedContext);
  const nextAction = selectProjectIntegrationNextAction(readiness, projectIntegration);

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
    shared_skill: sharedSkill,
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
    history,
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
    shared_skill: sharedSkill,
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
    history,
  };
}

/** Promote `newRecommended` to position 1, demoting the prior recommendation
 *  (and its alternatives) into `alternatives`. Used when a project-integration
 *  override (upgrade, major-boundary block) takes precedence over the
 *  state-derived cascade; the demoted candidates remain visible as what to do
 *  once the override is resolved. */
export function selectProjectIntegrationNextAction(
  readiness: ReadinessHint,
  projectIntegration: OrientationState["project_integration"],
): ReadinessHint {
  if (projectIntegration.recommendation === "upgrade") {
    return withRecommended(readiness, {
      object:
        (projectIntegration.pending_artifacts as number) > 0
          ? "Upgrade Agentera artifacts"
          : "Upgrade Agentera",
      capability: "status",
      reason: projectIntegration.dry_run_command
        ? `${projectIntegration.message} Exact preview: ${projectIntegration.dry_run_command}`
        : projectIntegration.message,
      phase: "build",
    });
  }
  if (projectIntegration.major_boundary_block) {
    return withRecommended(readiness, {
      object: "Await v3 successor announcement",
      capability: "status",
      reason: projectIntegration.major_boundary_block,
      phase: "audit",
    });
  }
  return readiness;
}

function withRecommended(hint: ReadinessHint, newRecommended: NextAction): ReadinessHint {
  return {
    recommended: newRecommended,
    alternatives: [hint.recommended, ...hint.alternatives],
  };
}
