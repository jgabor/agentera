import fsForHooks from "node:fs";
import { cmdDoctor, DoctorArgs } from "../commands/doctor.js";
import { cmdUpgrade, UpgradeArgs, type UpgradeOnlyPhase } from "../commands/upgrade.js";
import { cmdVerify, VerifyArgs } from "../commands/verify.js";
import { cmdGate } from "../commands/compact.js";
import { cmdReport, ReportArgs } from "../commands/report.js";
import { runSessionStart } from "../../hooks/sessionStart.js";
import { runSessionStop } from "../../hooks/sessionStop.js";
import { runCursorSessionStart } from "../../hooks/cursorSessionStart.js";
import { runCursorPreToolUse } from "../../hooks/cursorPreToolUse.js";
import { HookCliAdapter } from "../../hooks/validateArtifact/index.js";
import { usageMain } from "../../analytics/usageStats.js";
import { validatePathValue } from "../argvalidate.js";
import { printDoctorHelp, printUpgradeHelp, wantsHelp } from "../help.js";
import { parseCompactArgs } from "./check.js";
import { asEnvelopeFormat, classifyParseError, emitDeprecationAlias, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";

export function runGate(argv: string[], io: Io, prog: string): number {
  const parsed = parseCompactArgs(argv);
  if ("error" in parsed) {
    return emitInvalidInput(io, {
      format: "text",
      body: classifyParseError(parsed.error),
    });
  }
  try {
    return cmdGate(parsed, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(parsed.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

export function runDoctor(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  if (wantsHelp(argv)) {
    out(printDoctorHelp() + "\n");
    return 0;
  }
  const args: DoctorArgs = {
    installRoot: null,
    home: null,
    project: null,
    expectedVersion: null,
    expectCommand: [],
    smoke: false,
    allowLiveModel: false,
    format: "text",
  };
  let jsonFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i];
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--install-root")) !== null) args.installRoot = v;
    else if ((v = value("--home")) !== null) args.home = v;
    else if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--expected-version")) !== null) args.expectedVersion = v;
    else if ((v = value("--expect-command")) !== null) (args.expectCommand as string[]).push(v);
    else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')`,
            valid_values: ["text", "json"],
          },
        });
      }
      args.format = v;
    } else if (a === "--json") jsonFlag = true;
    else if (a === "--smoke") args.smoke = true;
    else if (a === "--allow-live-model") args.allowLiveModel = true;
    else {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
  }
  if (jsonFlag) {
    emitDeprecationAlias("doctor --json", "doctor --format json", err);
    args.format = "json";
  }
  try {
    return cmdDoctor(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

export function readStdin(): string {
  try {
    return fsForHooks.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export function runHook(name: string, argv: string[], io: Io): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const raw = io.stdin ? io.stdin() : readStdin();
  // Each hook owns its own stdout newline convention; do not wrap stdout here.
  switch (name) {
    case "session-start":
      return runSessionStart(raw);
    case "session-stop":
      return runSessionStop(raw);
    case "cursor-session-start":
      return runCursorSessionStart(raw);
    case "cursor-pre-tool-use":
      return runCursorPreToolUse(raw);
    case "validate-artifact": {
      const [rc, violations] = new HookCliAdapter().run(raw, null);
      for (const v of violations) err(`${v}\n`);
      return rc;
    }
    default:
      return emitInvalidInput(io, {
        format: "text",
        body: {
          class: "unsupported_target",
          message: `unknown hook '${name}'`,
          valid_values: [
            "session-start",
            "session-stop",
            "cursor-session-start",
            "cursor-pre-tool-use",
            "validate-artifact",
          ],
        },
      });
  }
}

export function runUsage(argv: string[], io: Io, prog: string): number {
  const realOut = io.out ?? ((t: string) => process.stdout.write(t));
  const realErr = io.err ?? ((t: string) => process.stderr.write(t));
  let format = "text";
  let corpus: string | null = null;
  let project: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--format")) !== null) format = v;
    else if ((v = value("--corpus")) !== null) corpus = v;
    else if ((v = value("--project")) !== null) project = v;
    else {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
  }
  if (corpus !== null) {
    try {
      validatePathValue(corpus, "path");
    } catch (e) {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(format),
        body: {
          class: "invalid_format",
          message: `argument --corpus: ${(e as Error).message}`,
        },
      });
    }
  }
  if (format !== "text" && format !== "json") {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(format),
      body: {
        class: "invalid_choice",
        message: `unsupported usage format '${format}'; valid formats: text, json.`,
        valid_values: ["text", "json"],
        syntax: "agentera usage [--format text|json] [--corpus PATH] [--project VALUE]",
        example: "agentera usage --format json --project agentera",
      },
    });
  }
  const engineArgv: string[] = [];
  if (corpus !== null) engineArgv.push("--corpus", corpus);
  if (project !== null) engineArgv.push("--project", project);
  if (format === "json") engineArgv.push("--json");
  return usageMain(engineArgv, {
    out: (t) => realOut(t + "\n"),
    err: (t) => realErr(t + "\n"),
  });
}

export function runUpgrade(argv: string[], io: Io, prog: string): number {
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  if (wantsHelp(argv)) {
    out(printUpgradeHelp() + "\n");
    return 0;
  }
  const args: UpgradeArgs = {
    installRoot: null,
    home: null,
    project: null,
    expectedVersion: null,
    channel: null,
    yes: false,
    dryRun: false,
    only: [],
    force: false,
    format: "text",
  };
  let jsonFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--install-root")) !== null) args.installRoot = v;
    else if ((v = value("--home")) !== null) args.home = v;
    else if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--expected-version")) !== null) args.expectedVersion = v;
    else if ((v = value("--channel")) !== null) args.channel = v;
    else if ((v = value("--target-major")) !== null) {
      void v;
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: {
          class: "unsupported_target",
          message: "--target-major was removed; use --channel with dry-run preview then --yes",
        },
      });
    }
    else if ((v = value("--runtime")) !== null) void v; // accepted; orchestrator uses fixture runtimes
    else if ((v = value("--only")) !== null) {
      if (v !== "artifacts" && v !== "runtime" && v !== "cleanup") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --only: invalid choice: '${v}' (choose from 'artifacts', 'runtime', 'cleanup')`,
            valid_values: ["artifacts", "runtime", "cleanup"],
          },
        });
      }
      (args.only as UpgradeOnlyPhase[]).push(v);
    }
    else if ((v = value("--opencode-config-dir")) !== null) void v; // accepted; ignored
    else if (a === "--yes") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--update-packages") void 0; // deferred for 3.x channel model
    else if (a === "--json") jsonFlag = true;
    else if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')`,
            valid_values: ["text", "json"],
          },
        });
      }
      args.format = v;
    } else {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    }
  }
  if (jsonFlag) args.format = "json";
  try {
    return cmdUpgrade(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

export function runVerify(argv: string[], io: Io, prog: string): number {
  const args: VerifyArgs = {
    family: null,
    target: null,
    format: "text",
    run: false,
    dryRun: false,
    skill: null,
    timeout: 120,
    parallel: 1,
    runtime: "auto",
    fixtures: [],
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--format")) !== null) {
      if (v !== "text" && v !== "json") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')`,
            valid_values: ["text", "json"],
          },
        });
      }
      args.format = v;
    } else if ((v = value("--skill")) !== null) args.skill = v;
    else if ((v = value("--runtime")) !== null) args.runtime = v;
    else if ((v = value("--timeout")) !== null) args.timeout = Number(v);
    else if ((v = value("--parallel")) !== null) args.parallel = Number(v);
    else if (a === "--run") args.run = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    } else {
      positionals.push(a);
    }
  }
  args.family = positionals[0] ?? null;
  args.target = positionals[1] ?? null;
  args.fixtures = positionals.slice(2);
  try {
    return cmdVerify(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}

export function runReport(argv: string[], io: Io, prog: string): number {
  const args: ReportArgs = {
    action: null,
    format: "text",
    project: null,
    dryRun: false,
    consent: null,
    projectRoot: [],
  };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = value("--format")) !== null) args.format = v;
    else if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--consent")) !== null) {
      if (v !== "local-history") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --consent: invalid choice: '${v}' (choose from 'local-history')`,
            valid_values: ["local-history"],
          },
        });
      }
      args.consent = v;
    } else if ((v = value("--project-root")) !== null) (args.projectRoot as string[]).push(v);
    else if ((v = value("--output")) !== null) args.output = v;
    else if ((v = value("--codex-sessions-dir")) !== null) args.codexSessionsDir = v;
    else if ((v = value("--claude-projects-dir")) !== null) args.claudeProjectsDir = v;
    else if ((v = value("--opencode-conversations-dir")) !== null) args.opencodeConversationsDir = v;
    else if ((v = value("--copilot-conversations-dir")) !== null) args.copilotConversationsDir = v;
    else if ((v = value("--cursor-projects-dir")) !== null) args.cursorProjectsDir = v;
    else if ((v = value("--cursor-chats-dir")) !== null) args.cursorChatsDir = v;
    else if (a === "--no-codex") args.noCodex = true;
    else if (a === "--no-claude") args.noClaude = true;
    else if (a === "--no-opencode") args.noOpencode = true;
    else if (a === "--no-copilot") args.noCopilot = true;
    else if (a === "--no-cursor") args.noCursor = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) {
      return emitInvalidInput(io, {
        format: asEnvelopeFormat(args.format),
        body: { class: "unrecognized_argument", message: `unrecognized arguments: ${a}` },
      });
    } else {
      positionals.push(a);
    }
  }
  args.action = positionals[0] ?? null;
  try {
    return cmdReport(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
      body: { class: "unsupported_target", message: (exc as Error).message },
    });
  }
}