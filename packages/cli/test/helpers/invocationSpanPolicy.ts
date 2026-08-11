import { createHash } from "node:crypto";

import YAML from "yaml";

export type BootstrapAuthorityLocation =
  | { line: number; column: number }
  | { structured_path: string; offset?: number };

export interface BootstrapAuthorityDiagnostic {
  path: string;
  location: BootstrapAuthorityLocation;
  decoded_offsets?: { start: number; end: number };
  raw_document_offsets?: { start: number; end: number } | null;
  token?: { raw: string; normalized: string };
  channel?: InvocationChannel;
  command_boundary?: { start: number; end: number };
  traits?: InvocationSpan["traits"];
  candidate: { raw: string; normalized: string } | null;
  violation: string;
  correction: string;
}

export type InvocationChannel = "bare" | "development" | "stable" | "other" | "malformed";
export type InvocationCompositionKind =
  | "background"
  | "backtick_substitution"
  | "command_substitution"
  | "group"
  | "operator"
  | "process_substitution"
  | "redirection";

export interface InvocationSpan {
  identity: string;
  source_path: string;
  region: string;
  structured_path: string | null;
  decoded_offsets: { start: number; end: number };
  raw_document_offsets: { start: number; end: number } | null;
  line_column: { line: number; column: number } | null;
  token: { raw: string; normalized: string };
  channel: InvocationChannel;
  command_boundary: { start: number; end: number };
  candidate: { raw: string; normalized: string };
  command_portion: {
    boundary: { start: number; end: number };
    raw: string;
    normalized: string;
  };
  container: {
    kind: "scalar" | "inline_code" | "quote" | "group" | "command_substitution" | "process_substitution";
    start: number;
    end: number;
  };
  nesting: {
    depth: number;
    containers: Array<{ kind: InvocationSpan["container"]["kind"]; start: number; end: number }>;
  };
  offset_map: number[];
  traits: {
    argument_bearing: boolean;
    backticked: boolean;
    composed: boolean;
    composition_kinds: InvocationCompositionKind[];
    wrapped: boolean;
    malformed: boolean;
  };
}

export type ScalarClassificationCategory = "identity_only" | "argument_bearing" | "other_vocabulary";
export type ScalarClassificationKind = "bounded_descriptive" | "exact_exemption";

export interface ScalarClassificationDeclaration {
  path: string;
  region: string;
  category: ScalarClassificationCategory;
  classification: ScalarClassificationKind;
  normalized_sha256: string;
  reason: string;
}

interface ScalarSurface {
  sourcePath: string;
  region: string;
  structuredPath: string | null;
  value: string;
  document: string;
  documentOffsetMap: number[] | null;
  markdown: boolean;
  fencedShell: boolean;
  key: string | null;
}

interface Container {
  kind: InvocationSpan["container"]["kind"];
  start: number;
  contentStart: number;
  end: number;
  contentEnd: number;
}

export interface AuthorityScanResult {
  diagnostics: BootstrapAuthorityDiagnostic[];
  spans: InvocationSpan[];
  classifications: Array<{
    path: string;
    region: string;
    category: ScalarClassificationCategory;
    classification: ScalarClassificationKind | "canonical_development" | "stable_pair" | "wholly_negated" | "bounded_descriptive" | "rejected";
    normalized_sha256: string;
    occurrence_count: number;
  }>;
  usedDeclarations: Set<string>;
}

const STABLE_HEADING = "## Stable v2 line";
const DEVELOPMENT_HEADING = "## Upgrading v2 to v3 development channel";
export const STABLE_COMMANDS = [
  "npx -y agentera@latest upgrade --dry-run",
  "npx -y agentera@latest upgrade --yes",
] as const;

const INVOCATION_TOKEN = /(?<![\w@./-])agentera(?:@(?:\$\([^\r\n)]*\)|[A-Za-z0-9._${}-]|\\.|"[^"\r\n]*"|'[^'\r\n]*')+)?(?=(?:[\p{White_Space}`"';|&()<>\]}]|[.,!?:](?:[\p{White_Space}]|$)|$))/gu;
const SHELL_WRAPPER = /^(?:env|command|exec|sudo|bash|sh|zsh|fish|timeout|xargs|nice|stdbuf|watch|time|eval)$/u;
const IDENTITY_KEYS = new Set(["id", "name", "names", "owner", "package_order"]);
const NEGATION_PRODUCTIONS = [
  /(?:^\s*|[.;]\s*)(?:Do not|do not)\s+(?:run|invoke|execute|use|call|introduce)\s*[`'"]?\s*$/u,
  /(?:^\s*|[.;]\s*)(?:and\s+)?(?:Never|never)\s+(?:run|invoke|execute|use|call)\s*[`'"]?\s*$/u,
  /(?:^\s*|[.;]\s*)(?:(?:MUST|must|should)\s+NOT|(?:must|should)\s+not)\s+(?:run|invoke|execute|use|call)\s*[`'"]?\s*$/u,
  /(?:^\s*|[.;—]\s*)(?:Never|never)\s+spawn\s+by\s+running\s*[`'"]?\s*$/u,
  /(?:No unsupported|no)\s*[`'"]?\s*$/u,
  /forbade a top-level\s*[`'"]?\s*$/u,
] as const;

const DESCRIPTIVE_PRODUCTIONS = [
  /^(?:\.?[~A-Za-z0-9_@${}-]+\/)*\.?agentera(?:\.js|\/[^\s]+|\.schema\.v[0-9]+)$/u,
  /^(?:the\s+)?agentera (?:CLI|package|identity|label|name|namespace)$/iu,
  /^(?:When to use agentera:|If `agentera <state>` returns empty:)$/u,
  /^(?:usage:\s+agentera(?:\s+[a-z-]+)?\s+\[-h\]|agentera:\s+read and write project state, upgrade installs, and print priming guidance)$/u,
  /^agentera\s+\S+\s+namespace\s+(?:is|are)\s+descriptive\.?$/iu,
  /^(?:The\s+)?(?:stable\s+)?package (?:identity|name|label) is `agentera@latest`\.?$/iu,
] as const;

function normalizeWhitespace(value: string): string {
  return value.normalize("NFKC")
    .replace(/\\\r?\n[\p{White_Space}]*/gu, " ")
    .replace(/[\p{White_Space}]+/gu, " ")
    .trim();
}

export function normalizedScalarSha256(value: string): string {
  return createHash("sha256").update(normalizeWhitespace(value)).digest("hex");
}

function normalizeToken(raw: string, decodedStart: number): { value: string; offsetMap: number[] } {
  let value = "";
  const offsetMap: number[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "'" || character === '"') {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (character === "\\" && index + 1 < raw.length) {
      if (raw[index + 1] === "\r" && raw[index + 2] === "\n") { index += 2; continue; }
      if (raw[index + 1] === "\n") { index += 1; continue; }
      index += 1;
    }
    const normalized = raw[index].normalize("NFKC");
    for (const part of normalized) {
      value += part;
      offsetMap.push(decodedStart + index);
    }
  }
  if (quote) value += "\u0000";
  return { value, offsetMap };
}

function channelFor(normalizedToken: string): InvocationChannel {
  if (normalizedToken.includes("\u0000") || !/^agentera(?:@[A-Za-z0-9._${}-]+)?$/u.test(normalizedToken)) return "malformed";
  if (normalizedToken === "agentera") return "bare";
  if (normalizedToken === "agentera@next") return "development";
  if (normalizedToken === "agentera@latest") return "stable";
  return "other";
}

function inlineCodeRanges(surface: ScalarSurface): Array<{ start: number; end: number }> {
  if (surface.fencedShell || /^\s*(?:npx\s+-y\s+agentera|agentera(?:@\S+)?\s)/u.test(surface.value)) return [];
  const executableKey = /^(?:command|commands|run|exec|invocation)$/iu.test(surface.key ?? "");
  const value = surface.value;
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "`" || value[index - 1] === "\\") continue;
    const end = value.indexOf("`", index + 1);
    if (end < 0) break;
    const prefix = value.slice(0, index).trimEnd();
    if (prefix.endsWith("=") || prefix.endsWith("$") || (executableKey && prefix.length === 0)) {
      index = end;
      continue;
    }
    ranges.push({ start: index, end });
    index = end;
  }
  return ranges;
}

function lexicalContainers(value: string, inlineRanges: readonly { start: number; end: number }[]): Container[] {
  const containers: Container[] = [];
  const stack: Array<Container & { closer: string }> = [];
  const inlineStarts = new Map(inlineRanges.map((range) => [range.start, range.end]));
  for (let index = 0; index < value.length; index += 1) {
    const inlineEnd = inlineStarts.get(index);
    if (inlineEnd !== undefined) {
      containers.push({ kind: "inline_code", start: index, contentStart: index + 1, end: inlineEnd + 1, contentEnd: inlineEnd });
      index = inlineEnd;
      continue;
    }
    const top = stack.at(-1);
    const character = value[index];
    if (top && (top.kind === "quote" || top.kind === "command_substitution") && top.closer !== ")" && top.closer !== "}") {
      if (character === "\\") { index += 1; continue; }
      if (character === top.closer) {
        top.end = index + 1;
        top.contentEnd = index;
        containers.push(stack.pop()!);
      }
      continue;
    }
    if (character === "\\") { index += 1; continue; }
    if (character === "'" || character === '"') {
      if (character === "'" && /[\p{L}\p{N}]/u.test(value[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(value[index + 1] ?? "")) continue;
      stack.push({ kind: "quote", start: index, contentStart: index + 1, end: value.length, contentEnd: value.length, closer: character });
      continue;
    }
    if (character === "`") {
      stack.push({ kind: "command_substitution", start: index, contentStart: index + 1, end: value.length, contentEnd: value.length, closer: "`" });
      continue;
    }
    const process = (character === "<" || character === ">") && value[index + 1] === "(";
    const command = character === "$" && value[index + 1] === "(";
    if (process || command) {
      stack.push({ kind: process ? "process_substitution" : "command_substitution", start: index, contentStart: index + 2, end: value.length, contentEnd: value.length, closer: ")" });
      index += 1;
      continue;
    }
    if (character === "(" || character === "{") {
      stack.push({ kind: "group", start: index, contentStart: index + 1, end: value.length, contentEnd: value.length, closer: character === "(" ? ")" : "}" });
      continue;
    }
    if (top && character === top.closer) {
      top.end = index + 1;
      top.contentEnd = index;
      containers.push(stack.pop()!);
    }
  }
  while (stack.length > 0) containers.push(stack.pop()!);
  return containers.sort((left, right) => left.start - right.start || right.end - left.end);
}

function containsOffset(container: Container, offset: number): boolean {
  return container.contentStart <= offset && offset < container.contentEnd;
}

function lineColumn(document: string, offset: number): { line: number; column: number } {
  const prefix = document.slice(0, offset);
  const line = (prefix.match(/\n/gu)?.length ?? 0) + 1;
  const previousBreak = prefix.lastIndexOf("\n");
  return { line, column: offset - previousBreak };
}

function rawOffsets(surface: ScalarSurface, decodedStart: number, decodedEnd: number): { start: number; end: number } | null {
  const map = surface.documentOffsetMap;
  if (!map || map[decodedStart] === undefined || map[decodedEnd - 1] === undefined) return null;
  return { start: map[decodedStart], end: map[decodedEnd - 1] + 1 };
}

interface ShellOperator {
  start: number;
  end: number;
  raw: string;
  composed: boolean;
}

interface ShellRedirection { start: number; end: number }

interface ShellSegment {
  start: number;
  end: number;
  operatorBefore: ShellOperator | null;
  operatorAfter: ShellOperator | null;
}

function shellSegments(value: string, lower: number, upper: number, containers: readonly Container[]): {
  segments: ShellSegment[];
  redirections: ShellRedirection[];
} {
  const operators: ShellOperator[] = [];
  const redirections: ShellRedirection[] = [];
  let quote: "'" | '"' | null = null;
  let squareDepth = 0;
  for (let index = lower; index < upper; index += 1) {
    if (containers.some((container) => container.start <= index && index < container.end
      && container.kind !== "scalar" && container.contentStart > lower)) continue;
    const character = value[index];
    if (character === "\\") { index += 1; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "[") { squareDepth += 1; continue; }
    if (character === "]" && squareDepth > 0) { squareDepth -= 1; continue; }
    if (character === "<" && /^[^>\s]+>/u.test(value.slice(index + 1))) {
      index = value.indexOf(">", index);
      continue;
    }
    if ((character === "<" || character === ">") && value[index + 1] !== "(") {
      const operator = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/u.exec(value.slice(index))?.[0];
      if (operator) {
        let start = index;
        while (start > lower && /[0-9]/u.test(value[start - 1])) start -= 1;
        if (start < index && start > lower && !/[\s;&|({]/u.test(value[start - 1])) start = index;
        redirections.push({ start, end: index + operator.length });
        index += operator.length - 1;
        continue;
      }
    }
    if (character === "#" && /\s/u.test(value[index - 1] ?? "")) {
      const newline = value.indexOf("\n", index);
      if (newline < 0 || newline >= upper) break;
      index = newline - 1;
      continue;
    }
    if (squareDepth === 0 && (character === "\n" || character === ";" || character === "|" || character === "&")) {
      const width = value[index + 1] === character && (character === "|" || character === "&") ? 2 : 1;
      operators.push({ start: index, end: index + width, raw: value.slice(index, index + width), composed: character !== "\n" });
      index += width - 1;
    }
  }
  const segments: ShellSegment[] = [];
  let start = lower;
  let operatorBefore: ShellOperator | null = null;
  for (const operator of operators) {
    segments.push({ start, end: operator.start, operatorBefore, operatorAfter: operator });
    start = operator.end;
    operatorBefore = operator;
  }
  segments.push({ start, end: upper, operatorBefore, operatorAfter: null });
  return { segments, redirections };
}

function commandWindow(value: string, tokenStart: number, tokenEnd: number, containers: readonly Container[], markdown: boolean): {
  start: number;
  end: number;
  container: Container;
  nested: Container[];
  composed: boolean;
  compositionKinds: InvocationCompositionKind[];
  commandStart: number;
  commandEnd: number;
  wrapped: boolean;
  malformed: boolean;
} {
  const nested = containers.filter((container) => {
    if (!containsOffset(container, tokenStart)) return false;
    if (container.kind !== "group") return true;
    const prefix = value.slice(container.contentStart, tokenStart).trim();
    return prefix === "" || /^(?:npx\s+-y|(?:env|command|exec|sudo|bash|sh|zsh|fish|timeout|time|eval)\b.*)$/u.test(prefix);
  });
  const active = nested.at(-1) ?? { kind: "scalar" as const, start: 0, contentStart: 0, end: value.length, contentEnd: value.length };
  const lower = active.contentStart;
  const upper = active.contentEnd;
  const shell = shellSegments(value, lower, upper, containers);
  const segment = shell.segments.find(({ start, end }) => start <= tokenStart && tokenStart < end)
    ?? { start: lower, end: upper, operatorBefore: null, operatorAfter: null };
  const before = value.slice(segment.start, tokenStart);
  const npx = /(?:^|[;&|\s(])npx[ \t]+-y[ \t]+$/u.exec(before);
  let start = npx ? segment.start + npx.index + (npx[0].startsWith("npx") ? 0 : 1) : tokenStart;
  while (/\s/u.test(value[start] ?? "")) start += 1;

  let end = segment.end;
  let quote: "'" | '"' | null = null;
  let angle = false;
  for (let index = tokenEnd; index < upper; index += 1) {
    const redirection = shell.redirections.find(({ start: redirectionStart, end: redirectionEnd }) =>
      redirectionStart <= index && index < redirectionEnd);
    if (redirection) {
      index = redirection.end - 1;
      continue;
    }
    const character = value[index];
    if (character === "\\") { index += 1; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "<") { angle = true; continue; }
    if (character === ">" && angle) { angle = false; continue; }
    if (angle) continue;
    if (character === "#" && /\s/u.test(value[index - 1] ?? "")) { end = index; break; }
    const shellPipe = character === "|" && (value[index + 1] === "|" || /\s/u.test(value[index - 1] ?? "") || /\s/u.test(value[index + 1] ?? ""));
    if (character === "\n" || character === ";" || shellPipe || character === "&") { end = index; break; }
    if (character === "," && /^,\s*(?:and\s+)?(?:then|finally|instead)\b/iu.test(value.slice(index))) { end = index; break; }
  }
  while (end > tokenEnd && /[\s.!?:]/u.test(value[end - 1])) end -= 1;

  const prefix = value.slice(segment.start, start).trim().replace(/^[-*+]\s+/u, "");
  const wrapperTokens = normalizeWhitespace(prefix).split(" ").filter(Boolean);
  const shellWrapper = wrapperTokens.some((token) => SHELL_WRAPPER.test(token) || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token) || token === "$" || token === ">");
  const structuralContainer = nested.some(({ kind }) => kind === "quote" || kind === "group" || kind === "command_substitution" || kind === "process_substitution");
  const tableRow = markdown && /^\s*\|/u.test(value);
  const suffixLexicalContainers = containers.filter((container) => container.start >= tokenEnd && container.start < end);
  const suffixContainers = suffixLexicalContainers.filter((container) =>
    ["command_substitution", "process_substitution", "group"].includes(container.kind));
  const suffixRedirections = shell.redirections.filter((redirection) => tokenEnd <= redirection.start && redirection.start < end);
  const compositionKinds = new Set<InvocationCompositionKind>();
  for (const container of [...nested, ...suffixContainers]) {
    if (container.kind === "command_substitution") {
      compositionKinds.add(value[container.start] === "`" ? "backtick_substitution" : "command_substitution");
    } else if (container.kind === "process_substitution") compositionKinds.add("process_substitution");
    else if (container.kind === "group") compositionKinds.add("group");
  }
  if (suffixRedirections.length > 0) compositionKinds.add("redirection");
  for (const operator of [segment.operatorBefore, segment.operatorAfter]) {
    if (!tableRow && operator?.composed) compositionKinds.add(operator.raw === "&" ? "background" : "operator");
  }
  const suffixCompositionStarts = [
    ...suffixContainers.map(({ start: containerStart }) => ({ start: containerStart, word: true })),
    ...suffixRedirections.map(({ start: redirectionStart }) => ({ start: redirectionStart, word: false })),
    ...(segment.operatorAfter?.composed && !tableRow ? [{ start: segment.operatorAfter.start, word: false }] : []),
  ].sort((left, right) => left.start - right.start);
  let commandEnd = Math.min(end, suffixCompositionStarts[0]?.start ?? end);
  const malformedSuffixStart = suffixLexicalContainers
    .filter(({ end: containerEnd, contentEnd }) => containerEnd === value.length && contentEnd === value.length)
    .map(({ start: containerStart }) => containerStart)
    .sort((left, right) => left - right)[0];
  if (malformedSuffixStart !== undefined) commandEnd = Math.min(commandEnd, malformedSuffixStart);
  if (suffixCompositionStarts[0]?.word) {
    while (commandEnd > start && !/[\s;&|]/u.test(value[commandEnd - 1])) commandEnd -= 1;
  }
  while (commandEnd > tokenEnd && /\s/u.test(value[commandEnd - 1])) commandEnd -= 1;
  const composed = suffixContainers.length > 0 || suffixRedirections.length > 0
    || (!tableRow && Boolean(segment.operatorBefore?.composed || segment.operatorAfter?.composed));
  if (segment.operatorAfter?.composed && !tableRow) {
    const newline = value.indexOf("\n", segment.operatorAfter.end);
    const chainEnd = newline >= 0 && newline < upper ? newline : upper;
    const followingInvocations = [...value.slice(segment.operatorAfter.end, chainEnd).matchAll(INVOCATION_TOKEN)];
    if (followingInvocations.length === 0) end = chainEnd;
    else if (value.slice(tokenStart, tokenEnd) === "agentera@next"
      && /^\s*npx\s+-y\s+$/u.test(value.slice(start, tokenStart))) end = segment.operatorAfter.end;
  }
  const malformed = [...nested, ...suffixLexicalContainers]
    .some(({ end: containerEnd, contentEnd }) => containerEnd === value.length && contentEnd === value.length);
  const inlineOnly = nested.length > 0 && nested.every(({ kind }) => kind === "inline_code");
  return {
    start,
    end,
    container: active,
    nested,
    composed,
    compositionKinds: [...compositionKinds].sort(),
    commandStart: start,
    commandEnd,
    wrapped: shellWrapper || (structuralContainer && !inlineOnly),
    malformed,
  };
}

function candidateNormalized(raw: string, tokenRaw: string, tokenNormalized: string): string {
  return normalizeWhitespace(raw.replace(tokenRaw, tokenNormalized));
}

export function discoverInvocationSpans(surface: ScalarSurface): InvocationSpan[] {
  const inlineRanges = inlineCodeRanges(surface);
  const containers = lexicalContainers(surface.value, inlineRanges);
  const spans: InvocationSpan[] = [];
  for (const match of surface.value.matchAll(INVOCATION_TOKEN)) {
    const start = match.index!;
    const end = start + match[0].length;
    const normalized = normalizeToken(match[0], start);
    const window = commandWindow(surface.value, start, end, containers, surface.markdown);
    const shellQuoteStarts = [...surface.value.slice(0, start).matchAll(/\bbash -c\s+(?:\\+)?["']/gu)]
      .map((entry) => entry.index! + entry[0].length - 1);
    const nestedClose = shellQuoteStarts.length === 0 ? -1 : surface.value.slice(end, window.end).search(/\\+["']/u);
    let boundaryStart = window.start;
    let boundaryEnd = nestedClose < 0 ? window.end : end + nestedClose;
    const enclosingComposition = match[0] === "agentera@next" && /^\s*npx\s+-y\s+$/u.test(surface.value.slice(window.start, start))
      ? window.nested.find((container) =>
      ["command_substitution", "process_substitution", "group"].includes(container.kind)
      && [...surface.value.slice(container.contentStart, container.contentEnd).matchAll(INVOCATION_TOKEN)].length === 1)
      : undefined;
    if (enclosingComposition) {
      boundaryStart = enclosingComposition.start;
      boundaryEnd = enclosingComposition.end;
    }
    const rawCandidate = surface.value.slice(boundaryStart, boundaryEnd).trim();
    const rawDocument = rawOffsets(surface, start, end);
    const point = rawDocument ? lineColumn(surface.document, rawDocument.start) : null;
    const lexicalNested = window.nested
      .filter(({ kind }) => shellQuoteStarts.length === 0 || kind !== "quote")
      .map(({ kind, start: containerStart, end: containerEnd }) => ({ kind, start: containerStart, end: containerEnd }));
    const syntheticNested = shellQuoteStarts.map((containerStart) => ({ kind: "quote" as const, start: containerStart, end: window.container.end }));
    const nested = [...syntheticNested, ...lexicalNested].sort((left, right) => left.start - right.start || right.end - left.end);
    const primary = syntheticNested.at(-1);
    const container = primary ?? (window.container.kind === "scalar"
      ? { kind: "scalar" as const, start: 0, end: surface.value.length }
      : { kind: window.container.kind, start: window.container.start, end: window.container.end });
    const normalizedCandidate = candidateNormalized(rawCandidate, match[0], normalized.value.replace("\u0000", ""));
    const commandPortionEnd = Math.min(window.commandEnd, boundaryEnd);
    const commandRaw = surface.value.slice(window.commandStart, commandPortionEnd).trim();
    const normalizedCommand = candidateNormalized(commandRaw, match[0], normalized.value.replace("\u0000", ""));
    const suffix = normalizedCommand.slice(normalizedCommand.indexOf(normalized.value.replace("\u0000", "")) + normalized.value.replace("\u0000", "").length).trim();
    spans.push({
      identity: `${surface.sourcePath}\u0000${surface.region}\u0000${start}:${end}`,
      source_path: surface.sourcePath,
      region: surface.region,
      structured_path: surface.structuredPath,
      decoded_offsets: { start, end },
      raw_document_offsets: rawDocument,
      line_column: point,
      token: { raw: match[0], normalized: normalized.value.replace("\u0000", "") },
      channel: channelFor(normalized.value),
      command_boundary: { start: boundaryStart, end: boundaryEnd },
      candidate: { raw: rawCandidate, normalized: normalizedCandidate },
      command_portion: {
        boundary: { start: window.commandStart, end: commandPortionEnd },
        raw: commandRaw,
        normalized: normalizedCommand,
      },
      container,
      nesting: { depth: nested.length, containers: nested },
      offset_map: normalized.offsetMap,
      traits: {
        argument_bearing: suffix.length > 0,
        backticked: surface.value[start - 1] === "`",
        composed: window.composed,
        composition_kinds: window.compositionKinds,
        wrapped: window.wrapped,
        malformed: window.malformed || normalized.value.includes("\u0000"),
      },
    });
  }
  return spans;
}

function declarationKey(path: string, region: string): string {
  return `${path}\u0000${region}`;
}

function scalarCategory(surface: ScalarSurface, spans: readonly InvocationSpan[]): ScalarClassificationCategory {
  const leaf = surface.structuredPath?.match(/\["([^"]+)"\]$/u)?.[1] ?? surface.key;
  if (normalizeWhitespace(surface.value) === "agentera" && leaf !== "producers") return "identity_only";
  if (spans.some(({ traits }) => traits.argument_bearing)) return "argument_bearing";
  return "other_vocabulary";
}

function boundedDescriptive(surface: ScalarSurface, span: InvocationSpan): boolean {
  const normalized = normalizeWhitespace(surface.value);
  const leaf = surface.structuredPath?.match(/\["([^"]+)"\]$/u)?.[1] ?? surface.key;
  if (normalized === "agentera" && (leaf === null || IDENTITY_KEYS.has(leaf))) return true;
  if (normalized === "agentera" && leaf === "producers") return true;
  if (DESCRIPTIVE_PRODUCTIONS.some((production) => production.test(normalized))) return true;
  if (/^usage: agentera(?: [a-z-]+)? \[-h\](?: \[[^\]]+\]| \{[^}]+\}| \.\.\.)+$/u.test(normalized)) return true;
  const spanTail = normalizeWhitespace(surface.value.slice(span.decoded_offsets.start));
  if (/^agentera (?:suite|CLI|package|workflow|skill|capabilities)(?:[.,;:]|$)/iu.test(spanTail)) return true;
  if (/^agentera\s+[—-]\s+\S/u.test(spanTail)) return true;
  if (/^agentera\s+\S+\s+namespace\s+(?:is|are)\s+descriptive\.?$/iu.test(spanTail)) return true;
  const tokenStart = span.decoded_offsets.start;
  const tokenEnd = span.decoded_offsets.end;
  const opening = surface.value.lastIndexOf("`", tokenStart);
  const closing = surface.value.indexOf("`", tokenEnd);
  if (opening >= 0 && closing >= tokenEnd && surface.value.slice(opening + 1, closing) === span.candidate.raw) {
    const previousStop = Math.max(surface.value.lastIndexOf(";", opening - 1), surface.value.lastIndexOf(".", opening - 1));
    const prefix = normalizeWhitespace(surface.value.slice(previousStop + 1, opening));
    const tail = normalizeWhitespace(surface.value.slice(closing + 1, closing + 96));
    return !/\b(?:run|invoke|execute|use|call|destroy)\b/iu.test(prefix)
      && /^(?:CLI|labels?|names?|namespaces?|identities|packages?|schemas?|source(?: data)?|commands?|diagnostic\s+(?:name|label)|is\s+(?:a|the)\s+(?:diagnostic\s+)?(?:name|label|namespace))(?:\s|[.,;:]|$)/iu.test(tail);
  }
  return false;
}

function whollyNegated(surface: ScalarSurface, span: InvocationSpan): boolean {
  const previousBoundary = Math.max(
    surface.value.lastIndexOf(";", span.command_boundary.start - 1),
    surface.value.lastIndexOf(".", span.command_boundary.start - 1),
  );
  const prefix = surface.value.slice(previousBoundary + 1, span.command_boundary.start);
  return NEGATION_PRODUCTIONS.some((production) => production.test(prefix));
}

function exactDevelopment(span: InvocationSpan): boolean {
  return span.channel === "development"
    && span.token.raw === "agentera@next"
    && /^npx -y agentera@next [\x21-\x7e]+(?: [\x21-\x7e]+)*$/u.test(span.candidate.raw)
    && !span.traits.composed
    && !span.traits.wrapped
    && !span.traits.malformed;
}

function developmentVocabulary(surface: ScalarSurface, span: InvocationSpan): boolean {
  return span.channel === "development"
    && span.token.raw === "agentera@next"
    && span.candidate.raw === "npx -y agentera@next"
    && span.container.kind === "inline_code";
}

function stableVocabulary(surface: ScalarSurface, span: InvocationSpan): boolean {
  return span.channel === "stable" && !span.traits.argument_bearing && boundedDescriptive(surface, span);
}

function violationFor(span: InvocationSpan): string {
  if (span.channel === "stable") return "stable_channel_outside_exemption";
  if (span.traits.malformed) return "malformed_command_context";
  if (span.traits.composed) return "command_composition";
  if (span.nesting.containers.some(({ kind }) => kind === "command_substitution" || kind === "process_substitution")) return "command_substitution";
  if (span.nesting.containers.some(({ kind }) => kind === "group")) return "command_grouping";
  if (span.traits.wrapped) return "command_wrapper";
  if (span.channel === "bare") return "bare_executable";
  if (span.channel === "development") return "noncanonical_development_executable";
  if (span.channel === "malformed") return "malformed_channel";
  return "unsupported_channel_executable";
}

function correctionFor(span: InvocationSpan): string {
  const normalizedToken = span.token.normalized;
  const tokenAt = span.command_portion.normalized.indexOf(normalizedToken);
  const argumentsPart = tokenAt < 0 ? "" : span.command_portion.normalized.slice(tokenAt + normalizedToken.length).trim();
  return `npx -y agentera@next${argumentsPart ? ` ${argumentsPart}` : ""}`;
}

function diagnostic(surface: ScalarSurface, span: InvocationSpan, violation: string): BootstrapAuthorityDiagnostic {
  const location: BootstrapAuthorityLocation = surface.structuredPath
    ? { structured_path: surface.structuredPath, offset: span.decoded_offsets.start }
    : span.line_column ?? { line: 1, column: span.decoded_offsets.start + 1 };
  return {
    path: surface.sourcePath,
    location,
    decoded_offsets: span.decoded_offsets,
    raw_document_offsets: span.raw_document_offsets,
    token: span.token,
    channel: span.channel,
    command_boundary: span.command_boundary,
    traits: span.traits,
    candidate: span.candidate,
    violation,
    correction: correctionFor(span),
  };
}

function malformedDiagnostic(sourcePath: string, format: string, message: string): BootstrapAuthorityDiagnostic {
  return {
    path: sourcePath,
    location: { structured_path: "$" },
    candidate: null,
    violation: `malformed_${format}`,
    correction: `Correct the ${format.toUpperCase()} structure before command-authority validation: ${message.split("\n")[0]}`,
  };
}

function structuredPath(parent: string, key: string | number): string {
  return typeof key === "number" ? `${parent}[${key}]` : `${parent}[${JSON.stringify(key)}]`;
}

function quotedOffsetMap(raw: string, base: number, quote: "'" | '"'): { decoded: string; map: number[] } {
  let decoded = "";
  const map: number[] = [];
  for (let index = 1; index < raw.length - 1; index += 1) {
    const at = base + index;
    if (quote === "'" && raw[index] === "'" && raw[index + 1] === "'") {
      decoded += "'"; map.push(at); index += 1; continue;
    }
    if (quote === '"' && raw[index] === "\\") {
      const escape = raw[index + 1];
      const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
      if (escape === "u" && /^[a-f0-9]{4}$/iu.test(raw.slice(index + 2, index + 6))) {
        decoded += String.fromCharCode(Number.parseInt(raw.slice(index + 2, index + 6), 16));
        map.push(at); index += 5; continue;
      }
      if (simple[escape] !== undefined) { decoded += simple[escape]; map.push(at); index += 1; continue; }
    }
    decoded += raw[index]; map.push(at);
  }
  return { decoded, map };
}

function scalarDocumentOffsetMap(document: string, node: any, rawBase: number): number[] | null {
  if (!Array.isArray(node?.range) || typeof node.value !== "string") return null;
  const start = Number(node.range[0]);
  const end = Number(node.range[1]);
  const raw = document.slice(start, end);
  if (raw.startsWith('"') && raw.endsWith('"')) {
    const result = quotedOffsetMap(raw, rawBase + start, '"');
    if (result.decoded === node.value) return result.map;
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    const result = quotedOffsetMap(raw, rawBase + start, "'");
    if (result.decoded === node.value) return result.map;
  }
  if (raw === node.value) return Array.from({ length: node.value.length }, (_, index) => rawBase + start + index);

  const tokenSource = String(node.srcToken?.source ?? raw);
  const tokenBase = rawBase + Number(node.srcToken?.offset ?? start);
  const map: number[] = [];
  let cursor = 0;
  for (const character of node.value) {
    if (/\s/u.test(character)) {
      while (cursor < tokenSource.length && !/\s/u.test(tokenSource[cursor])) cursor += 1;
    } else {
      while (cursor < tokenSource.length && tokenSource[cursor] !== character) cursor += 1;
    }
    if (cursor >= tokenSource.length) return null;
    map.push(tokenBase + cursor);
    cursor += 1;
  }
  return map;
}

function structuredSurfaces(
  sourcePath: string,
  content: string,
  format: "yaml" | "json",
  rawBase = 0,
  rootPath = "$",
): { surfaces: ScalarSurface[]; diagnostics: BootstrapAuthorityDiagnostic[] } {
  try {
    const document = YAML.parseDocument(content, { schema: format === "json" ? "json" : "core", uniqueKeys: true, keepSourceTokens: true });
    if (document.errors.length > 0) return { surfaces: [], diagnostics: [malformedDiagnostic(sourcePath, format, document.errors[0].message)] };
    try {
      const resolved = document.toJS({ maxAliasCount: 100 });
      const ancestry = new WeakSet<object>();
      const detectCycle = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return false;
        if (ancestry.has(value)) return true;
        ancestry.add(value);
        const cyclic = (Array.isArray(value) ? value : Object.values(value)).some(detectCycle);
        ancestry.delete(value);
        return cyclic;
      };
      if (detectCycle(resolved)) return { surfaces: [], diagnostics: [malformedDiagnostic(sourcePath, "yaml_alias_cycle", "recursive alias value")] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aliasFormat = /recursive|cycle/iu.test(message) ? "yaml_alias_cycle" : format;
      return { surfaces: [], diagnostics: [malformedDiagnostic(sourcePath, aliasFormat, message)] };
    }
    const surfaces: ScalarSurface[] = [];
    const walk = (node: any, currentPath: string, key: string | null): void => {
      if (YAML.isScalar(node)) {
        if (typeof node.value !== "string") return;
        surfaces.push({
          sourcePath,
          region: currentPath,
          structuredPath: currentPath,
          value: node.value,
          document: content,
          documentOffsetMap: scalarDocumentOffsetMap(content, node, rawBase),
          markdown: false,
          fencedShell: false,
          key,
        });
        return;
      }
      if (YAML.isSeq(node)) {
        node.items.forEach((entry: any, index: number) => walk(entry, structuredPath(currentPath, index), key));
        return;
      }
      if (YAML.isMap(node)) {
        node.items.forEach((pair: any) => {
          const childKey = String(pair.key?.value ?? pair.key?.toString?.() ?? "");
          walk(pair.value, structuredPath(currentPath, childKey), childKey);
        });
      }
    };
    walk(document.contents, rootPath, null);
    return { surfaces, diagnostics: [] };
  } catch (error) {
    return { surfaces: [], diagnostics: [malformedDiagnostic(sourcePath, format, error instanceof Error ? error.message : String(error))] };
  }
}

function stableSequenceDiagnostic(sourcePath: string, line: number, violation: string): BootstrapAuthorityDiagnostic {
  return {
    path: sourcePath,
    location: { line, column: 1 },
    candidate: null,
    violation,
    correction: `Keep exactly these adjacent ordered lines only in ${STABLE_HEADING}: ${STABLE_COMMANDS.join(" ; ")}`,
  };
}

function boundedNonInvocationMarkdown(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  return /^#{1,6}\s+(?:agentera(?: priming guide)?|Routing: agentera vs native tools)$/u.test(normalized)
    || /^~\/\.agents\/skills\/agentera \+ agentera CLI$/u.test(normalized);
}

function markdownSurfaces(sourcePath: string, content: string): { surfaces: ScalarSurface[]; diagnostics: BootstrapAuthorityDiagnostic[] } {
  const diagnostics: BootstrapAuthorityDiagnostic[] = [];
  const surfaces: ScalarSurface[] = [];
  const lines = content.split(/\r?\n/u);
  const lineStarts: number[] = [];
  let cursor = 0;
  for (const line of lines) { lineStarts.push(cursor); cursor += line.length + 1; }
  let bodyStart = 0;
  if (lines[0] === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line === "---");
    if (end < 0) return { surfaces: [], diagnostics: [malformedDiagnostic(sourcePath, "markdown_frontmatter", "missing closing --- boundary")] };
    const startOffset = lineStarts[1] ?? 4;
    const frontmatter = lines.slice(1, end).join("\n");
    const parsed = structuredSurfaces(sourcePath, frontmatter, "yaml", startOffset, "#frontmatter");
    surfaces.push(...parsed.surfaces.map((surface) => ({ ...surface, document: content })));
    diagnostics.push(...parsed.diagnostics);
    bodyStart = end + 1;
  }

  const stableIndexes = lines.flatMap((line, index) => line === STABLE_HEADING ? [index] : []);
  const developmentIndexes = lines.flatMap((line, index) => line === DEVELOPMENT_HEADING ? [index] : []);
  if (sourcePath === "UPGRADE.md" || sourcePath.endsWith("/UPGRADE.md")) {
    const nextSection = stableIndexes.length === 1 ? lines.findIndex((line, index) => index > stableIndexes[0] && /^##\s+/u.test(line)) : -1;
    const validBoundary = stableIndexes.length === 1 && developmentIndexes.length === 1 && nextSection === developmentIndexes[0];
    if (!validBoundary) diagnostics.push(stableSequenceDiagnostic(sourcePath, (stableIndexes[0] ?? 0) + 1, "stable_v2_section_boundary"));
  }

  let fenceLanguage: string | null = null;
  for (let index = bodyStart; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^\s*```\s*([\w-]*)/u.exec(line);
    if (fence) { fenceLanguage = fenceLanguage === null ? fence[1] : null; continue; }
    if (!line.trim()) continue;
    const commandShaped = /^\s*(?:npx\s+-y\s+agentera|agentera(?:@\S+)?\s|(?:env|command|exec|sudo|bash|sh|zsh|fish|timeout|time|eval)\s)/u.test(line);
    const fencedShell = fenceLanguage !== null && (
      /^(?:bash|sh|shell|zsh|fish|console)$/u.test(fenceLanguage)
      || commandShaped
    );
    if (fenceLanguage !== null && !fencedShell && boundedNonInvocationMarkdown(line.trim())) continue;
    if (boundedNonInvocationMarkdown(line.trim())) continue;
    let endLine = index;
    while (/\\\s*$/u.test(lines[endLine]) && endLine + 1 < lines.length) endLine += 1;
    const value = lines.slice(index, endLine + 1).join("\n");
    surfaces.push({
      sourcePath,
      region: `line:${index + 1}`,
      structuredPath: null,
      value,
      document: content,
      documentOffsetMap: Array.from({ length: value.length }, (_, offset) => lineStarts[index] + offset),
      markdown: true,
      fencedShell,
      key: null,
    });
    index = endLine;
  }
  return { surfaces, diagnostics };
}

function stableInvocationAuthority(sourcePath: string, content: string, spans: readonly InvocationSpan[]): {
  allowed: Set<string>;
  diagnostics: BootstrapAuthorityDiagnostic[];
} {
  const allowed = new Set<string>();
  if (!(sourcePath === "UPGRADE.md" || sourcePath.endsWith("/UPGRADE.md"))) return { allowed, diagnostics: [] };
  const lines = content.split(/\r?\n/u);
  const lineStarts: number[] = [];
  let cursor = 0;
  for (const line of lines) { lineStarts.push(cursor); cursor += line.length + 1; }
  const stable = lines.flatMap((line, index) => line === STABLE_HEADING ? [index] : []);
  const development = lines.flatMap((line, index) => line === DEVELOPMENT_HEADING ? [index] : []);
  const nextSection = stable.length === 1 ? lines.findIndex((line, index) => index > stable[0] && /^##\s+/u.test(line)) : -1;
  if (stable.length !== 1 || development.length !== 1 || nextSection !== development[0]) return { allowed, diagnostics: [] };
  const sectionStart = lineStarts[stable[0] + 1] ?? content.length;
  const sectionEnd = lineStarts[development[0]] ?? content.length;
  const sectionSpans = spans.filter(({ raw_document_offsets }) => raw_document_offsets
    && sectionStart <= raw_document_offsets.start && raw_document_offsets.end <= sectionEnd);
  const exact = sectionSpans.length === 2
    && sectionSpans.every((span, index) => span.candidate.raw === STABLE_COMMANDS[index]
      && span.channel === "stable" && !span.traits.composed && !span.traits.wrapped && !span.traits.malformed)
    && sectionSpans[0].line_column !== null && sectionSpans[1].line_column !== null
    && sectionSpans[1].line_column.line === sectionSpans[0].line_column.line + 1;
  if (!exact) return {
    allowed,
    diagnostics: [stableSequenceDiagnostic(sourcePath, stable[0] + 1, "stable_v2_sequence")],
  };
  sectionSpans.forEach(({ identity }) => allowed.add(identity));
  return { allowed, diagnostics: [] };
}

export function scanBootstrapAuthority(
  sourcePath: string,
  content: string,
  declarations: readonly ScalarClassificationDeclaration[] = [],
  requireDeclarations = false,
): AuthorityScanResult {
  const extension = sourcePath.split("#", 1)[0].match(/\.[^.]+$/u)?.[0].toLowerCase() ?? ".md";
  const parsed = extension === ".md"
    ? markdownSurfaces(sourcePath, content)
    : extension === ".yaml" || extension === ".yml"
      ? structuredSurfaces(sourcePath, content, "yaml")
      : extension === ".json"
        ? structuredSurfaces(sourcePath, content, "json")
        : { surfaces: [] as ScalarSurface[], diagnostics: [{
          path: sourcePath,
          location: { structured_path: "$" } as BootstrapAuthorityLocation,
          candidate: null,
          violation: "unclassified_format",
          correction: "Declare an inspectable path exemption or add a parse-aware scanner.",
        }] };
  const diagnostics = [...parsed.diagnostics];
  const spans: InvocationSpan[] = [];
  const classifications: AuthorityScanResult["classifications"] = [];
  const usedDeclarations = new Set<string>();
  const byKey = new Map(declarations.filter(({ path }) => path === sourcePath).map((entry) => [declarationKey(entry.path, entry.region), entry]));
  const discovered = parsed.surfaces.map((surface) => ({ surface, spans: discoverInvocationSpans(surface) }));
  const stableAuthority = stableInvocationAuthority(sourcePath, content, discovered.flatMap(({ spans: entries }) => entries));
  diagnostics.push(...stableAuthority.diagnostics);

  for (const { surface, spans: scalarSpans } of discovered) {
    if (scalarSpans.length === 0) continue;
    spans.push(...scalarSpans);
    const declaration = byKey.get(declarationKey(sourcePath, surface.region));
    const digest = normalizedScalarSha256(surface.value);
    const category = scalarCategory(surface, scalarSpans);
    const noncanonical = scalarSpans.filter((span) => !(exactDevelopment(span) || developmentVocabulary(surface, span)) && !stableAuthority.allowed.has(span.identity));
    const isMeasuredScalar = noncanonical.length > 0;
    const intrinsicallyClassified = noncanonical.every((span) => whollyNegated(surface, span)
      || boundedDescriptive(surface, span) || stableVocabulary(surface, span));
    let declarationUsable = false;
    if (declaration) {
      const key = declarationKey(declaration.path, declaration.region);
      if (!isMeasuredScalar) declarationUsable = false;
      else if (!declaration.reason.trim()) diagnostics.push({ path: sourcePath, location: surface.structuredPath ? { structured_path: surface.structuredPath } : scalarSpans[0].line_column ?? { line: 1, column: 1 }, candidate: null, violation: "scalar_classification_reason_missing", correction: "Add a non-empty reason to the exact scalar classification." });
      else if (declaration.normalized_sha256 !== digest) diagnostics.push({ path: sourcePath, location: surface.structuredPath ? { structured_path: surface.structuredPath } : scalarSpans[0].line_column ?? { line: 1, column: 1 }, candidate: null, violation: "scalar_classification_stale", correction: `Update or remove the classification after reviewing normalized scalar digest ${digest}.` });
      else if (declaration.category !== category) diagnostics.push({ path: sourcePath, location: surface.structuredPath ? { structured_path: surface.structuredPath } : scalarSpans[0].line_column ?? { line: 1, column: 1 }, candidate: null, violation: "scalar_classification_category_mismatch", correction: `Classify the scalar as ${category} after reviewing its complete value.` });
      else declarationUsable = true;
      if (declarationUsable) {
        usedDeclarations.add(key);
      }
    } else if (requireDeclarations && isMeasuredScalar && !intrinsicallyClassified) {
      diagnostics.push({
        path: sourcePath,
        location: surface.structuredPath ? { structured_path: surface.structuredPath } : scalarSpans[0].line_column ?? { line: 1, column: 1 },
        candidate: scalarSpans[0].candidate,
        violation: "scalar_classification_missing",
        correction: "Canonicalize the guidance or add one exact path, region, normalized digest, classification, and reason.",
      });
    }

    let scalarClass: AuthorityScanResult["classifications"][number]["classification"] = "rejected";
    for (const span of scalarSpans) {
      if (stableAuthority.allowed.has(span.identity)) {
        scalarClass = "stable_pair";
        continue;
      }
      if (exactDevelopment(span) || developmentVocabulary(surface, span)) {
        scalarClass = "canonical_development";
        continue;
      }
      if (stableVocabulary(surface, span)) {
        scalarClass = "bounded_descriptive";
        continue;
      }
      if (declarationUsable && declaration?.classification === "exact_exemption") {
        scalarClass = "exact_exemption";
        continue;
      }
      if (span.channel === "stable") {
        diagnostics.push(diagnostic(surface, span, "stable_channel_outside_exemption"));
        continue;
      }
      if (whollyNegated(surface, span)) {
        scalarClass = "wholly_negated";
        continue;
      }
      if (declarationUsable && declaration?.classification === "bounded_descriptive"
        && (declaration.category !== "argument_bearing" || boundedDescriptive(surface, span))) {
        scalarClass = "bounded_descriptive";
        continue;
      }
      if (boundedDescriptive(surface, span)) {
        scalarClass = "bounded_descriptive";
        continue;
      }
      diagnostics.push(diagnostic(surface, span, violationFor(span)));
    }
    classifications.push({
      path: sourcePath,
      region: surface.region,
      category,
      classification: scalarClass,
      normalized_sha256: digest,
      occurrence_count: scalarSpans.length,
    });
  }
  return { diagnostics, spans, classifications, usedDeclarations };
}

export const NEGATION_GRAMMAR_PRODUCTION_COUNT = NEGATION_PRODUCTIONS.length;
export const DESCRIPTIVE_GRAMMAR_PRODUCTION_COUNT = DESCRIPTIVE_PRODUCTIONS.length + 4;
