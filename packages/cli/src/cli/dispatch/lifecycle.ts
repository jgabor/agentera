import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cmdAppHome, AppHomeArgs } from "../commands/appHome.js";
import { cmdDoctor, DoctorArgs } from "../commands/doctor.js";
import { cmdUpgrade, UpgradeArgs, type UpgradeOnlyPhase } from "../commands/upgrade.js";
import { cmdVerify, VerifyArgs } from "../commands/verify.js";
import { cmdGate } from "../commands/compact.js";
import { cmdReport, ReportArgs } from "../commands/report.js";
import { runGlossaryAdviceCommand } from "../commands/glossaryAdvice.js";
import { runPersonalGlossaryCommand } from "../commands/personalGlossary.js";
import { runPersonalGlossaryCandidateReadsCommand } from "../commands/personalGlossaryCandidateReads.js";
import { runPersonalGlossaryDecisionCommand } from "../commands/personalGlossaryDecision.js";
import { runProfileGroundingCommand } from "../commands/profileGrounding.js";
import { preCutoverCommand } from "../preCutoverCommand.js";
import { usageMain } from "../../analytics/usageStats.js";
import { validatePathValue } from "../argvalidate.js";
import { printAppHomeHelp, printDoctorHelp, printUpgradeHelp, wantsHelp } from "../help.js";
import { makeArgvValueReader } from "./argvParser.js";
import { parseCompactArgs } from "./check.js";
import { asEnvelopeFormat, classifyParseError, detectTopLevelFormat, emitDeprecationAlias, type Io } from "./shared.js";
import { emitInvalidInput } from "../errors.js";
import { migrationProject } from "../migrationRequired.js";
import { fullEntityUpgradeCommand } from "../../upgrade/upgradeCommands.js";
import { nativeResourceCleanupIds, resolveNativeResourceCleanupId } from "../../runtime/nativeResourceCleanup.js";

function rejectUnsupportedUpgradeFlag(
  io: Io,
  format: string,
  message: string,
  recovery?: string,
): number {
  return emitInvalidInput(io, {
    format: asEnvelopeFormat(format),
    body: { class: "unsupported_target", message, recovery },
  });
}

export function runGate(argv: string[], io: Io, prog: string): number {
  const parsed = parseCompactArgs(argv);
  if ("error" in parsed) {
    return emitInvalidInput(io, {
      format: detectTopLevelFormat(argv),
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

export function runAppHome(argv: string[], io: Io, prog: string): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  if (wantsHelp(argv)) {
    out(printAppHomeHelp() + "\n");
    return 0;
  }
  const args: AppHomeArgs = {
    installRoot: null,
    home: null,
    format: "text",
  };
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null;
    if ((v = value("--install-root")) !== null) args.installRoot = v;
    else if ((v = value("--home")) !== null) args.home = v;
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
  try {
    return cmdAppHome(args, io);
  } catch (exc) {
    return emitInvalidInput(io, {
      format: asEnvelopeFormat(args.format),
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
    retiredResource: null,
    smoke: false,
    allowLiveModel: false,
    format: "text",
  };
  let jsonFlag = false;
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null;
    if ((v = value("--install-root")) !== null) args.installRoot = v;
    else if ((v = value("--home")) !== null) args.home = v;
    else if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--expected-version")) !== null) args.expectedVersion = v;
    else if ((v = value("--expect-command")) !== null) (args.expectCommand as string[]).push(v);
    else if ((v = value("--retired-resource")) !== null) args.retiredResource = v;
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

export function runUsage(argv: string[], io: Io, prog: string): number {
  const realOut = io.out ?? ((t: string) => process.stdout.write(t));
  const realErr = io.err ?? ((t: string) => process.stderr.write(t));
  let format = "text";
  let corpus: string | null = null;
  let project: string | null = null;
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
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
    verify: false,
    runtime: null,
    legacyCleanup: null,
    format: "text",
  };
  let jsonFlag = false;
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null;
    if ((v = value("--install-root")) !== null) args.installRoot = v;
    else if ((v = value("--home")) !== null) args.home = v;
    else if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--expected-version")) !== null) args.expectedVersion = v;
    else if ((v = value("--channel")) !== null) args.channel = v;
    else if ((v = value("--target-major")) !== null) {
      return rejectUnsupportedUpgradeFlag(
        io,
        args.format ?? "text",
        "--target-major was removed; use --channel with dry-run preview then --yes",
        fullEntityUpgradeCommand(migrationProject(argv)),
      );
    } else if ((v = value("--runtime")) !== null) {
      return emitInvalidInput(io, {
        format: detectTopLevelFormat(argv),
        body: {
          class: "invalid_choice",
          message:
            `argument --runtime ${v} is retired; Agentera now uses the shared skill at ` +
            "~/.agents/skills/agentera plus the CLI. Remove --runtime and rerun the app/project upgrade. " +
             "For explicit Agentera-owned native resource cleanup, use --legacy-cleanup RESOURCE_ID.",
        },
      });
    } else if ((v = value("--legacy-cleanup")) !== null) {
      const validValues = nativeResourceCleanupIds();
      const selectedResource = resolveNativeResourceCleanupId(v);
      if (!selectedResource) {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --legacy-cleanup: invalid choice: '${v}' (choose from ${validValues.map((id) => `'${id}'`).join(", ")})`,
            valid_values: validValues,
          },
        });
      }
      args.legacyCleanup = selectedResource.id;
    } else if ((v = value("--only")) !== null) {
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
    else if ((v = value("--opencode-config-dir")) !== null) {
      return rejectUnsupportedUpgradeFlag(
        io,
        args.format ?? "text",
        "--opencode-config-dir is not yet supported by the TypeScript upgrade command",
      );
    } else if (a === "--yes") args.yes = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--verify") args.verify = true;
    else if (a === "--update-packages") {
      return rejectUnsupportedUpgradeFlag(
        io,
        args.format ?? "text",
        "--update-packages is retired; Agentera does not manage host package installation or updates",
      );
    }
    else if (["--restore", "--rollback", "--downgrade"].includes(a)) {
      return rejectUnsupportedUpgradeFlag(
        io,
        args.format ?? "text",
        `${a} was removed; v2-to-v3 upgrade is one-way and apply must run as one full upgrade --yes`,
        fullEntityUpgradeCommand(migrationProject(argv)),
      );
    }
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
    observations: null,
  };
  const positionals: string[] = [];
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
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
    else if ((v = value("--observations")) !== null) args.observations = v;
    else if (a === "--run") args.run = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) {
      return emitInvalidInput(io, {
        format: detectTopLevelFormat(argv),
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
  if (argv[0] === "personal-glossary-decision") {
    if (prog !== "agentera report") {
      return emitInvalidInput(io, {
        format: "json",
        body: {
          class: "unsupported_target",
          message: "personal-glossary-decision has no stats alias",
          valid_values: ["report personal-glossary-decision"],
          recovery: `Run ${preCutoverCommand("report personal-glossary-decision --input - --format json")}; no bytes were changed.`,
        },
      });
    }
    return runPersonalGlossaryDecisionCommand(argv.slice(1), io);
  }
  if (argv[0] === "personal-glossary-candidates") {
    if (prog !== "agentera report") {
      return emitInvalidInput(io, {
        format: "json",
        body: {
          class: "unsupported_target",
          message: "personal-glossary-candidates has no stats alias",
          valid_values: ["report personal-glossary-candidates"],
          recovery: `Run ${preCutoverCommand("report personal-glossary-candidates list --limit 20 --format json")}; no projection bytes were changed.`,
        },
      });
    }
    return runPersonalGlossaryCandidateReadsCommand(argv.slice(1), io);
  }
  if (argv[0] === "glossary-advice") {
    if (prog !== "agentera report") {
      return emitInvalidInput(io, {
        format: "json",
        body: {
          class: "unsupported_target",
          message: "glossary-advice has no stats alias",
          valid_values: ["report glossary-advice"],
          recovery: `Run ${preCutoverCommand("report glossary-advice --input - --format json")}; no state was changed.`,
        },
      });
    }
    return runGlossaryAdviceCommand(argv.slice(1), io);
  }
  if (argv[0] === "profile-grounding") {
    if (prog !== "agentera report") {
      return emitInvalidInput(io, {
        format: "json",
        body: {
          class: "unsupported_target",
          message: "profile-grounding has no stats alias",
          valid_values: ["report profile-grounding"],
          recovery: `Run ${preCutoverCommand("report profile-grounding --format json")}; no profile bytes were changed.`,
        },
      });
    }
    return runProfileGroundingCommand(argv.slice(1), io);
  }
  if (argv[0] === "profile-glossary") {
    if (prog !== "agentera report") {
      return emitInvalidInput(io, {
        format: "json",
        body: {
          class: "unsupported_target",
          message: "profile-glossary has no stats alias",
          valid_values: ["report profile-glossary"],
          recovery: `Run ${preCutoverCommand("report profile-glossary --input PATH --format json")} with the same input; no profile bytes were changed.`,
        },
      });
    }
    return runPersonalGlossaryCommand(argv.slice(1), io);
  }
  const args: ReportArgs = {
    action: null,
    format: "text",
    project: null,
    sources: "active",
    dryRun: false,
    consent: null,
    projectRoot: [],
    importSources: [],
  };
  const positionals: string[] = [];
  let i = 0;
  const value = makeArgvValueReader(argv, () => i, (n) => {
    i = n;
  });
  for (; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null;
    if ((v = value("--format")) !== null) args.format = v;
    else if ((v = value("--project")) !== null) args.project = v;
    else if ((v = value("--sources")) !== null) {
      if (v !== "active" && v !== "all") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: { class: "invalid_choice", message: `argument --sources: invalid choice: '${v}' (choose from 'active', 'all')`, valid_values: ["active", "all"] },
        });
      }
      args.sources = v;
    }
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
    else if ((v = value("--import-source")) !== null) {
      if (v !== "claude") {
        return emitInvalidInput(io, {
          format: asEnvelopeFormat(args.format),
          body: {
            class: "invalid_choice",
            message: `argument --import-source: invalid choice: '${v}' (choose from 'claude')`,
            valid_values: ["claude"],
          },
        });
      }
      if (!(args.importSources as string[]).includes(v)) (args.importSources as string[]).push(v);
    }
    else if ((v = value("--opencode-conversations-dir")) !== null) args.opencodeConversationsDir = v;
    else if ((v = value("--copilot-conversations-dir")) !== null) args.copilotConversationsDir = v;
    else if ((v = value("--cursor-projects-dir")) !== null) args.cursorProjectsDir = v;
    else if ((v = value("--cursor-chats-dir")) !== null) args.cursorChatsDir = v;
    else if (a === "--no-codex") args.noCodex = true;
    else if (a === "--no-opencode") args.noOpencode = true;
    else if (a === "--no-copilot") args.noCopilot = true;
    else if (a === "--no-cursor") args.noCursor = true;
    else if (a === "--accept-coverage-gap") args.acceptCoverageGap = true;
    else if (a === "--coverage-audit-only") args.coverageAuditOnly = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--")) {
      return emitInvalidInput(io, {
        format: detectTopLevelFormat(argv),
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

function resolveCliVersion(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "package.json"),
    path.resolve(moduleDir, "..", "..", "..", "package.json"),
  ];
  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg.version === "string" && pkg.version) {
        return pkg.version;
      }
    } catch {
      continue;
    }
  }
  return "unknown";
}

export function runVersion(argv: string[], io: Io): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t));
  const err = io.err ?? ((t: string) => process.stderr.write(t));
  let format: "text" | "json" = "text";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") {
      const v = argv[++i];
      if (v !== "text" && v !== "json") {
        return emitInvalidInput(io, {
          format: "text",
          body: {
            class: "invalid_choice",
            message: `argument --format: invalid choice: '${v}' (choose from 'text', 'json')`,
            valid_values: ["text", "json"],
          },
        });
      }
      format = v;
    } else if (a === "--help" || a === "-h") {
      out("usage: agentera --version [--format {text,json}]\n\nPrint the installed Agentera CLI version.\n");
      return 0;
    } else {
      err(`agentera --version: unrecognized argument: ${a}\n`);
      return 2;
    }
  }
  const version = resolveCliVersion();
  if (format === "json") {
    out(JSON.stringify({ version }) + "\n");
  } else {
    out(version + "\n");
  }
  return 0;
}
