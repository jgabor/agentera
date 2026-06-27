import { type Dict, hashLabel, loadContract, parseTimestamp } from "./contract.js";
import {
  argumentsText,
  capabilityInvocation,
  extractText,
  introCapability,
  recordLabel,
} from "./helpers.js";
import {
  BOUNDARY_DEGRADATION_REASONS,
  STATE_EVENT_CLASSES,
  boundedRuntimeStatus,
  classifyStartupEvent,
  startupConversationKey,
} from "./threshold.js";

function hasTranscriptBearingField(record: Dict): boolean {
  if ("transcript" in record) return true;
  const data = record.data;
  return Boolean(data && typeof data === "object" && !Array.isArray(data) && "transcript" in data);
}

function boundedReason(reason: string, contract: Dict): string {
  const reasons = Array.isArray(contract.degradation_reasons) ? contract.degradation_reasons : [];
  const allowed = new Set([...reasons, ...BOUNDARY_DEGRADATION_REASONS]);
  return allowed.has(reason) ? reason : "malformed_record";
}

function estimatedToolArgumentTokens(record: Dict): number {
  return Math.ceil(Buffer.byteLength(argumentsText(record), "utf8") / 4);
}

function timestampUtc(value: unknown): Date | null {
  return parseTimestamp(value);
}

function newSequence(conversationKey: string, capability: string | null, salt: string): Dict {
  const counts: Record<string, number> = {};
  for (const eventClass of [...STATE_EVENT_CLASSES].sort()) counts[eventClass] = 0;
  return {
    conversation: hashLabel("session", conversationKey, salt),
    capability: capability || "unknown",
    start_anchor: "first_cli_state_call_after_capability_invocation",
    events: [],
    counts,
    cli_artifact_labels: [],
    raw_artifact_labels_after_cli: [],
    redundant_raw_artifact_labels: [],
    estimated_raw_after_cli_tokens_by_artifact: {},
    estimated_redundant_raw_tokens_by_artifact: {},
    degradation_reasons: [],
  };
}

function eventOutput(
  record: Dict,
  opts: {
    eventClass: string;
    phase: string;
    salt: string;
    artifactLabel?: string | null;
    stateCommand?: string | null;
    redundantWithCli?: boolean | null;
  },
): Dict {
  const item: Dict = {
    record: recordLabel(record, opts.salt),
    event_class: STATE_EVENT_CLASSES.has(opts.eventClass) ? opts.eventClass : "non_state_context",
    phase: opts.phase,
  };
  if (opts.artifactLabel) item.artifact_label = opts.artifactLabel;
  if (opts.stateCommand) item.state_command = opts.stateCommand;
  if (opts.redundantWithCli !== undefined && opts.redundantWithCli !== null) {
    item.redundant_with_cli = opts.redundantWithCli;
  }
  return item;
}

export function classifyStartupRecords(corpus: Dict, opts: { salt: string; contract?: Dict | null }): Dict {
  const salt = opts.salt;
  const loaded = opts.contract ?? loadContract();
  const boundaryInfo =
    loaded.boundary && typeof loaded.boundary === "object" && !Array.isArray(loaded.boundary) ? loaded.boundary : {};
  const boundary = timestampUtc(boundaryInfo.committed_at);
  const records = corpus && typeof corpus === "object" && !Array.isArray(corpus) ? (corpus.records ?? []) : [];
  const degradations: Dict[] = [];
  const groups = new Map<string, Dict[]>();
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      degradations.push({ reason: boundedReason("malformed_record", loaded) });
      continue;
    }
    if (hasTranscriptBearingField(record)) {
      degradations.push({ record: recordLabel(record, salt), reason: "privacy_redaction_required" });
      continue;
    }
    const timestamp = timestampUtc(record.timestamp);
    if (timestamp === null) {
      degradations.push({ record: recordLabel(record, salt), reason: "missing_timestamp" });
      continue;
    }
    if (boundary !== null && timestamp.getTime() <= boundary.getTime()) {
      degradations.push({ record: recordLabel(record, salt), reason: "pre_boundary_record" });
      continue;
    }
    const key = startupConversationKey(record);
    if (key === null) {
      degradations.push({ record: recordLabel(record, salt), reason: "missing_conversation_key" });
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(record);
  }

  const sequences: Dict[] = [];
  for (const [conversationKey, items] of groups) {
    items.sort((a, b) => {
      const ta = String(a.timestamp ?? "");
      const tb = String(b.timestamp ?? "");
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    const state = {
      active: null as Dict | null,
      segmentCapability: null as string | null,
      segmentOpen: false,
      segmentHadStateSequence: false,
      cliArtifactsSeen: new Set<string>(),
    };

    const closeActive = (): void => {
      if (state.active !== null) {
        state.active.cli_artifact_labels = [...state.cliArtifactsSeen].sort();
        sequences.push(state.active);
        state.segmentHadStateSequence = true;
        state.active = null;
        state.cliArtifactsSeen = new Set();
      }
    };

    for (const record of items) {
      const text = extractText(record);
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data : {};
      const actor = data.actor;
      if (actor === "user") {
        closeActive();
        if (state.segmentOpen && !state.segmentHadStateSequence) {
          degradations.push({
            conversation: hashLabel("session", conversationKey, salt),
            reason: "no_agentera_state_sequence",
          });
        }
        state.segmentCapability = capabilityInvocation(text);
        state.segmentOpen = state.segmentCapability !== null;
        state.segmentHadStateSequence = false;
        continue;
      }

      if (!state.segmentOpen) {
        const introCap = actor === "assistant" ? introCapability(text) : null;
        if (introCap) {
          state.segmentCapability = introCap;
          state.segmentOpen = true;
        } else {
          continue;
        }
      }

      const [eventClass, artifactLabel, stateCommand, cliArtifactLabels] = classifyStartupEvent(record);
      if (eventClass === "non_state_context") continue;
      if (eventClass === "cli_state_call" && state.active === null) {
        state.active = newSequence(conversationKey, state.segmentCapability, salt);
      }
      if (state.active === null) continue;
      // cast: state.active is built by newSequence with typed array/counter/estimate fields
      const active = state.active as Dict & {
        counts: Record<string, number>;
        events: Dict[];
        raw_artifact_labels_after_cli: string[];
        redundant_raw_artifact_labels: string[];
        estimated_raw_after_cli_tokens_by_artifact: Record<string, number>;
        estimated_redundant_raw_tokens_by_artifact: Record<string, number>;
      };
      if (eventClass === "cli_state_call") {
        for (const label of cliArtifactLabels) state.cliArtifactsSeen.add(label);
      }
      const redundant =
        eventClass === "raw_artifact_access" && artifactLabel
          ? state.cliArtifactsSeen.has(artifactLabel)
          : null;
      const phase = eventClass === "implementation_boundary" ? "implementation_boundary" : "state_gathering";
      active.counts[eventClass] += 1;
      active.events.push(
        eventOutput(record, {
          eventClass,
          phase,
          salt,
          artifactLabel,
          stateCommand,
          redundantWithCli: redundant,
        }),
      );
      if (eventClass === "raw_artifact_access" && artifactLabel) {
        active.raw_artifact_labels_after_cli.push(artifactLabel);
        const estimatedTokens = estimatedToolArgumentTokens(record);
        const rawEstimates = active.estimated_raw_after_cli_tokens_by_artifact;
        rawEstimates[artifactLabel] = (rawEstimates[artifactLabel] ?? 0) + estimatedTokens;
        if (redundant) {
          active.redundant_raw_artifact_labels.push(artifactLabel);
          const redundantEstimates = active.estimated_redundant_raw_tokens_by_artifact;
          redundantEstimates[artifactLabel] = (redundantEstimates[artifactLabel] ?? 0) + estimatedTokens;
        }
      }
      if (eventClass === "implementation_boundary") {
        closeActive();
        state.segmentOpen = false;
        state.segmentCapability = null;
        state.segmentHadStateSequence = false;
      }
    }
    closeActive();
    if (state.segmentOpen && !state.segmentHadStateSequence) {
      degradations.push({
        conversation: hashLabel("session", conversationKey, salt),
        reason: "no_agentera_state_sequence",
      });
    }
  }
  return {
    contract_version: loaded.version,
    boundary_source: boundaryInfo.source,
    state_gathering_sequences: sequences,
    degradations,
  };
}
