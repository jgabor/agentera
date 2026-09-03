import { cmdQuery, QueryArgs } from "../commands/query.js";
import { makeArgvValueReader } from "./argvParser.js";
import { asEnvelopeFormat, classifyParseError, detectTopLevelFormat, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";
import { runStateWrite } from "../commands/state/write.js";
import { runStateGet } from "../commands/state/get.js";
import { runStateList } from "../commands/state/list.js";
import { runPlanTasks } from "../commands/state/planTasks.js";
import { runPlans } from "../commands/state/plans.js";
import { runExperimentRecords } from "../commands/state/experimentRecords.js";
import { runtimeEntityFamilyForStateCommand } from "../../state/entityListRuntimeRegistry.js";
import { entityListFamily, entityListValidValues } from "../../state/entityRetrievalHelp.js";
import { emitStructured } from "../structured.js";
import { verbsForArtifact } from "../../state/write/operations.js";

function canonicalReadCorrection(familyKey: Parameters<typeof entityListFamily>[0], argv: string[], io: Io): number {
  const family = entityListFamily(familyKey);
  const recoveryCommand = family.bareRecovery ?? family.example;
  const format = detectTopLevelFormat(argv);
  const body = {
    schemaVersion: "agentera.stateFailure.v1",
    status: "fail",
    error: {
      class: "invalid_request",
      message: `bare state ${family.commandTokens.join(" ")} is not a canonical record-family read`,
      syntax: `${family.syntax} | ${family.get}`,
      valid_values: ["list", "get", ...entityListValidValues(family)],
      example: recoveryCommand,
      recovery: `Run \`${recoveryCommand}\`; no state was changed.`,
      artifact: family.key,
    },
  } as const;
  emitStructured(body, format, io.out ?? ((text) => process.stdout.write(text)));
  return 2;
}

export function runState(command: string, argv: string[], io: Io, prog: string): number {
  const runtime = runtimeEntityFamilyForStateCommand(command, argv);
  if (runtime) {
    const offset = runtime.commandTokens.length - 1;
    const familyArgv = argv.slice(offset);
    const verb = familyArgv[0];
    if (verb === "list" || verb === "get") {
      if (runtime.parser === "generic") return verb === "list" ? runStateList(command, familyArgv.slice(1), io) : runStateGet(command, familyArgv.slice(1), io);
      if (runtime.parser === "plans") return runPlans(familyArgv, io);
      if (runtime.parser === "plan_tasks") return runPlanTasks(familyArgv, io);
      return runExperimentRecords(familyArgv, io);
    }
    const family = entityListFamily(runtime.key as Parameters<typeof entityListFamily>[0]);
    const writeVerb = verb !== undefined && verbsForArtifact(command).some((candidate) => candidate === verb);
    if (writeVerb && runtime.commandTokens.length === 1) return runStateWrite(command, argv, io);
    if (family.bareRead === "alias") return runStateList(command, familyArgv, io);
    return canonicalReadCorrection(family.key, familyArgv, io);
  }
  if (argv[0] && verbsForArtifact(command).some((candidate) => candidate === argv[0])) {
    return runStateWrite(command, argv, io);
  }
  return emitInvalidInput(io, {
    format: detectTopLevelFormat(argv),
    body: {
      class: "unsupported_target",
      message: `unsupported state artifact or operation '${command} ${argv[0] ?? ""}'`.trim(),
    },
  });
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
    format: "json",
    fields: null,
  };
  let i = 0;
  const value = makeArgvValueReader(
    argv,
    () => i,
    (n) => {
      i = n;
    },
  );
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
      if (v !== "json") {
        return { error: `argument --format: invalid choice: '${v}' (choose from 'json')` };
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
      format: detectTopLevelFormat(argv),
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
