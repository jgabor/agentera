import { cmdState, StateArgs } from "../commands/state/index.js";
import { COMMAND_FILTERS } from "../stateQuery.js";
import { cmdQuery, QueryArgs } from "../commands/query.js";
import { makeArgvValueReader } from "./argvParser.js";
import { asEnvelopeFormat, classifyParseError, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";

export function parseStateArgs(command: string, argv: string[]): StateArgs | { error: string } {
  const args: StateArgs = {
    command,
    topic: null,
    status: null,
    dimension: null,
    severity: null,
    limit: 5,
    format: "text",
    fields: null,
  };
  const allowed = new Set([...(COMMAND_FILTERS[command] ?? []), "format", "fields"]);
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
    const named = (flag: string, key: string): boolean => allowed.has(key) && (a === flag || a.startsWith(flag + "="));
    let v: string | null;
    if (named("--topic", "topic")) args.topic = value("--topic");
    else if (named("--status", "status")) args.status = value("--status");
    else if (named("--dimension", "dimension")) args.dimension = value("--dimension");
    else if (named("--severity", "severity")) args.severity = value("--severity");
    else if (named("--limit", "limit")) {
      v = value("--limit");
      const n = Number(v);
      if (!Number.isInteger(n)) return { error: `argument --limit: invalid int value: '${v}'` };
      args.limit = n;
    } else if (a === "--format" || a.startsWith("--format=")) {
      v = value("--format");
      if (v !== "text" && v !== "json" && v !== "yaml") {
        return { error: `argument --format: invalid choice: '${v}' (choose from 'text', 'json', 'yaml')` };
      }
      args.format = v;
    } else if (a === "--fields" || a.startsWith("--fields=")) args.fields = value("--fields");
    else return { error: `unrecognized arguments: ${a}` };
  }
  return args;
}

export function runState(command: string, argv: string[], io: Io, prog: string): number {
  const parsed = parseStateArgs(command, argv);
  if ("error" in parsed) {
    return emitInvalidInput(io, {
      format: "text",
      body: classifyParseError(parsed.error),
    });
  }
  try {
    return cmdState(parsed, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(parsed.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

export function parseQueryArgs(argv: string[]): QueryArgs | { error: string } {
  const args: QueryArgs = {
    query: null,
    list_artifacts: false,
    topic: null,
    severity: null,
    dimension: null,
    status: null,
    limit: null,
    format: "text",
    fields: null,
  };
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null;
    if (a === "--list-artifacts") args.list_artifacts = true;
    else if ((v = value("--topic")) !== null) args.topic = v;
    else if ((v = value("--severity")) !== null) args.severity = v;
    else if ((v = value("--dimension")) !== null) args.dimension = v;
    else if ((v = value("--status")) !== null) args.status = v;
    else if ((v = value("--limit")) !== null) {
      const n = Number(v);
      if (!Number.isInteger(n)) return { error: `argument --limit: invalid int value: '${v}'` };
      args.limit = n;
    } else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json" && v !== "yaml") {
        return { error: `argument --format: invalid choice: '${v}' (choose from 'text', 'json', 'yaml')` };
      }
      args.format = v;
    } else if ((v = value("--fields")) !== null) args.fields = v;
    else if (a.startsWith("--")) return { error: `unrecognized arguments: ${a}` };
    else if (args.query === null) args.query = a;
    else return { error: `unrecognized arguments: ${a}` };
  }
  return args;
}

export function runQuery(argv: string[], io: Io, prog: string): number {
  const parsed = parseQueryArgs(argv);
  if ("error" in parsed) {
    return emitInvalidInput(io, {
      format: "text",
      body: classifyParseError(parsed.error),
    });
  }
  try {
    return cmdQuery(parsed, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(parsed.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}