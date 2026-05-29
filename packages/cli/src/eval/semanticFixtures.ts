import fs from "node:fs";

/**
 * Semantic fixture contract validation for offline skill evals. Faithful TS
 * port of scripts/semantic_fixtures.py. Defines the fixture shape only.
 */

type Dict = Record<string, any>;

export const REQUIRED_SECTIONS = [
  "Prompt",
  "Seeded Project State",
  "Captured Output",
  "Expected Facts",
] as const;

export interface SemanticFixture {
  prompt: string;
  seededState: Dict;
  capturedOutput: string;
  toolTrace: Dict;
  expectedFacts: Dict;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function loadFixture(path: string): [SemanticFixture | null, string[]] {
  return validateFixtureText(fs.readFileSync(path, "utf8"));
}

export function validateFixtureText(text: string): [SemanticFixture | null, string[]] {
  const sections = parseSections(text);
  const errors: string[] = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!(section in sections)) {
      errors.push(`missing section: ${section}`);
    }
  }

  const prompt = (sections.Prompt ?? "").trim();
  if ("Prompt" in sections && !prompt) {
    errors.push("malformed section: Prompt: must be non-empty");
  }

  let seededState: Dict = {};
  if ("Seeded Project State" in sections) {
    const [state, stateErrors] = validateSeededState(sections["Seeded Project State"]);
    seededState = state;
    errors.push(...stateErrors);
  }

  const capturedOutput = (sections["Captured Output"] ?? "").trim();
  if ("Captured Output" in sections && !capturedOutput) {
    errors.push("malformed section: Captured Output: must be non-empty");
  }

  let toolTrace: Dict = { calls: [] };
  if ("Tool Trace" in sections) {
    const [trace, traceErrors] = validateToolTrace(sections["Tool Trace"]);
    toolTrace = trace;
    errors.push(...traceErrors);
  }

  let expectedFacts: Dict = {};
  if ("Expected Facts" in sections) {
    const [facts, factErrors] = validateExpectedFacts(sections["Expected Facts"]);
    expectedFacts = facts;
    errors.push(...factErrors);
  }

  if (errors.length > 0) {
    return [null, errors];
  }
  return [{ prompt, seededState, capturedOutput, toolTrace, expectedFacts }, []];
}

function parseSections(text: string): Record<string, string> {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = match[1];
      if (!(current in sections)) {
        sections[current] = [];
      }
      continue;
    }
    if (current !== null) {
      sections[current].push(line);
    }
  }
  const out: Record<string, string> = {};
  for (const [name, lines] of Object.entries(sections)) {
    out[name] = lines.join("\n").trim();
  }
  return out;
}

function validateSeededState(sectionText: string): [Dict, string[]] {
  const [data, errors] = loadJsonSection("Seeded Project State", sectionText);
  if (errors.length > 0) {
    return [{}, errors];
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return [{}, ["malformed section: Seeded Project State: JSON must be an object"]];
  }
  const files = (data as Dict).files;
  if (!Array.isArray(files)) {
    return [{}, ["malformed section: Seeded Project State: files must be a list"]];
  }
  for (let index = 0; index < files.length; index++) {
    const item = files[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [{}, [`malformed section: Seeded Project State: files[${index}] must be an object`]];
    }
    if (!nonEmptyString(item.path)) {
      return [{}, [`malformed section: Seeded Project State: files[${index}].path must be non-empty`]];
    }
    if (typeof item.content !== "string") {
      return [{}, [`malformed section: Seeded Project State: files[${index}].content must be a string`]];
    }
  }
  return [data as Dict, []];
}

function validateExpectedFacts(sectionText: string): [Dict, string[]] {
  const [data, jsonErrors] = loadJsonSection("Expected Facts", sectionText);
  if (jsonErrors.length > 0) {
    return [{}, jsonErrors];
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return [{}, ["malformed section: Expected Facts: JSON must be an object"]];
  }
  const d = data as Dict;
  const errors: string[] = [];
  errors.push(...validateStringList(d, "required_output", false));
  errors.push(...validateStringList(d, "forbidden_output", false));
  errors.push(...validateStringList(d, "required_tool_calls", false));
  errors.push(...validateStringList(d, "forbidden_tool_calls", false));
  errors.push(...validateToolCallCounts(d.tool_call_counts));

  const hasOutputFact = Boolean(d.required_output?.length || d.forbidden_output?.length);
  const hasToolFact = Boolean(
    d.required_tool_calls?.length ||
      d.forbidden_tool_calls?.length ||
      (d.tool_call_counts && Object.keys(d.tool_call_counts).length),
  );
  const hasArtifactFact = "artifact_expectations" in d;
  if (!hasOutputFact && !hasToolFact && !hasArtifactFact) {
    errors.push("malformed section: Expected Facts: must declare at least one expected fact");
  }

  if (hasArtifactFact) {
    errors.push(...validateArtifactExpectations(d.artifact_expectations));
  }

  return [d, errors];
}

function validateToolTrace(sectionText: string): [Dict, string[]] {
  const [data, errors] = loadJsonSection("Tool Trace", sectionText);
  if (errors.length > 0) {
    return [{}, errors];
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return [{}, ["malformed section: Tool Trace: JSON must be an object"]];
  }
  const calls = (data as Dict).calls;
  if (!Array.isArray(calls) || !calls.every((item) => nonEmptyString(item))) {
    return [{}, ["malformed section: Tool Trace: calls must be non-empty strings"]];
  }
  return [data as Dict, []];
}

function validateArtifactExpectations(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["malformed section: Expected Facts: artifact_expectations must be an object"];
  }
  const writes = (value as Dict).writes;
  if (writes === "none") {
    return [];
  }
  if (!Array.isArray(writes)) {
    return ["malformed section: Expected Facts: artifact_expectations.writes must be 'none' or a list"];
  }
  for (let index = 0; index < writes.length; index++) {
    const item = writes[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [`malformed section: Expected Facts: artifact_expectations.writes[${index}] must be an object`];
    }
    if (!nonEmptyString(item.path)) {
      return [`malformed section: Expected Facts: artifact_expectations.writes[${index}].path must be non-empty`];
    }
    if ("contains" in item) {
      const contains = item.contains;
      if (!Array.isArray(contains) || !contains.every((s: unknown) => nonEmptyString(s))) {
        return [
          `malformed section: Expected Facts: artifact_expectations.writes[${index}].contains must be non-empty strings`,
        ];
      }
    }
  }
  return [];
}

function validateToolCallCounts(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return ["malformed section: Expected Facts: tool_call_counts must be an object"];
  }
  for (const [key, count] of Object.entries(value as Dict)) {
    if (!nonEmptyString(key)) {
      return ["malformed section: Expected Facts: tool_call_counts keys must be non-empty strings"];
    }
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
      return [`malformed section: Expected Facts: tool_call_counts[${pyRepr(key)}] must be a non-negative integer`];
    }
  }
  return [];
}

function validateStringList(data: Dict, key: string, required: boolean): string[] {
  if (!(key in data)) {
    return required ? [`malformed section: Expected Facts: ${key} is required`] : [];
  }
  const value = data[key];
  if (!Array.isArray(value) || !value.every((item) => nonEmptyString(item))) {
    return [`malformed section: Expected Facts: ${key} must be non-empty strings`];
  }
  return [];
}

function loadJsonSection(sectionName: string, text: string): [unknown, string[]] {
  const block = extractJsonBlock(text);
  if (block === null) {
    return [null, [`malformed section: ${sectionName}: expected fenced json block`]];
  }
  try {
    return [JSON.parse(block), []];
  } catch {
    // Best-effort line number; the offline-eval path always feeds valid JSON.
    return [null, [`malformed section: ${sectionName}: invalid JSON`]];
  }
}

function extractJsonBlock(text: string): string | null {
  const match = /```json\s*\n([\s\S]*?)\n```/.exec(text);
  if (!match) {
    return null;
  }
  return match[1];
}

/** Mirror Python repr() for strings used in diagnostics. */
export function pyRepr(value: string): string {
  if (value.includes("'") && !value.includes('"')) {
    return `"${value}"`;
  }
  return "'" + value.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}
