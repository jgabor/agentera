/**
 * Public surface for the compaction hook.
 *
 * Re-exports the API consumed by `cli/commands/compact.ts` and the
 * test suite. The actual implementation lives in the per-
 * responsibility submodules:
 *
 *   dryRun.ts     one-line formatters and SPECS metadata
 *   retention.ts  sort, select, and decision-satisfaction helpers
 *   parse.ts      markdown entry parsing
 *   apply.ts      writers (compactYamlFile, compactFile, detectOverflow)
 *   status.ts     read-only status reporting (computeCompactionStatus,
 *                 checkCompaction, fixCompaction, runCompaction)
 */

import { applyRetentionCaps as _applyRetentionCaps } from "../common.js";
import { compactFile, compactYamlFile, detectOverflow, compactEntries } from "./apply.js";
import { checkCompaction, computeCompactionStatus, fixCompaction, runCompaction } from "./status.js";
import {
  parseEntries,
  parseFullEntries,
  parseOnelineEntries,
  splitArchive,
  extractResolvedSection,
  parseTodoResolved,
  countTodoResolvedEntries,
  normalizeTodoResolvedLayout,
} from "./parse.js";
import { SPECS, COMPACTABLE_YAML_ARTIFACTS, NON_COMPACTABLE_ARTIFACTS, YAML_SPEC_BY_ARTIFACT, formatTodoOneline } from "./dryRun.js";
import {
  overLimitCount,
  stableSortBy,
  yamlArchiveEntry,
  yamlArchiveEntries,
  yamlRecentFullAndOlder,
  yamlSortEntries,
  decisionProtectedOverflowCount,
  selectDecisionActiveEntries,
  selectDecisionArchiveEntries,
} from "./retention.js";
import { CompactResult, CompactionOperation, CompactionStatus, ArtifactSpec } from "./types.js";

export { CompactResult, CompactionOperation, CompactionStatus, ArtifactSpec };
export {
  compactFile,
  compactYamlFile,
  detectOverflow,
  compactEntries,
  checkCompaction,
  computeCompactionStatus,
  fixCompaction,
  runCompaction,
  parseEntries,
  parseFullEntries,
  parseOnelineEntries,
  splitArchive,
  extractResolvedSection,
  parseTodoResolved,
  SPECS,
  COMPACTABLE_YAML_ARTIFACTS,
  NON_COMPACTABLE_ARTIFACTS,
  YAML_SPEC_BY_ARTIFACT,
  formatTodoOneline,
  countTodoResolvedEntries,
  normalizeTodoResolvedLayout,
  overLimitCount,
  stableSortBy,
  yamlArchiveEntry,
  yamlArchiveEntries,
  yamlRecentFullAndOlder,
  yamlSortEntries,
  decisionProtectedOverflowCount,
  selectDecisionActiveEntries,
  selectDecisionArchiveEntries,
};

void _applyRetentionCaps;
