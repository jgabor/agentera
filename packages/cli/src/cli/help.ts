import { CAPABILITY_ROUTING_NAMES } from "./commands/capability.js";

const TOP_LEVEL = [
  "prime",
  "schema",
  "state",
  ...CAPABILITY_ROUTING_NAMES,
  "upgrade",
  "app-home",
  "doctor",
  "report",
  "check",
] as const;

function lines(title: string, items: string[]): string[] {
  return [title, ...items.map((item) => `  ${item}`), ""];
}

export function printTopLevelHelp(): string {
  const choices = TOP_LEVEL.join(",");
  return [
    `usage: agentera [-h] [--version] {${choices}} ...`,
    "",
    "agentera: read project state, upgrade installs, and print priming guidance",
    "",
    ...lines("Agent commands:", [
      "prime               Composite orientation briefing, capability startup context, or static guidance",
      "schema              Runtime CLI/schema introspection",
      "state               Routine artifact reads and advanced artifact query",
      ...CAPABILITY_ROUTING_NAMES.map(
        (name) => `${name.padEnd(19)} Route to ${name} capability guidance`,
      ),
    ]),
    ...lines("User commands:", [
      "upgrade             Plan or apply an idempotent upgrade with semver/channel gate",
      "app-home            Resolve the platform Agentera app-home path",
      "doctor              Check Agentera CLI, app, and runtime status",
      "report              Privacy-gated usage analytics",
      "--version           Print the installed Agentera CLI version",
    ]),
    ...lines("Maintainer commands:", [
      "check               Validation, verification, lint, and repository compaction gates",
    ]),
    "options:",
    "  -h, --help          show this help message and exit",
    "  --version           print the installed Agentera CLI version and exit",
    "",
    "Examples: agentera prime; agentera state plan --format json; agentera check verify eval skills --dry-run; agentera report refresh --dry-run",
  ].join("\n");
}

export function printUpgradeHelp(): string {
  return [
    "usage: agentera upgrade [-h] [--project PROJECT] [--install-root INSTALL_ROOT]",
    "                        [--home HOME] [--channel {stable,development}]",
    "                        [--only {artifacts,runtime,cleanup}] [--dry-run] [--yes]",
    "                        [--force] [--format {text,json}]",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --project PROJECT     Project directory whose .agentera artifacts should be migrated",
    "  --install-root PATH   Agentera app home to wire into runtime configs",
    "  --home HOME           Home directory for runtime config writes/detection",
    "  --channel CHANNEL     Update channel: stable (2.x) or development (3.x npm)",
    "  --only PHASE          Upgrade phase to include; may be repeated",
    "  --dry-run             Plan only and write nothing",
    "  --yes                 Apply pending local upgrade actions",
    "  --force               Overwrite managed runtime files or conflicting backups",
    "  --format {text,json}  Structured output format",
  ].join("\n");
}

export function printAppHomeHelp(): string {
  return [
    "usage: agentera app-home [-h] [--install-root PATH] [--home HOME] [--format {text,json}]",
    "",
    "Resolve the Agentera app-home path for agent/bootstrap callers.",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --install-root PATH   Explicit Agentera app home to resolve",
    "  --home HOME           Home directory for platform default resolution",
    "  --format {text,json}  Structured output format",
  ].join("\n");
}

export function printDoctorHelp(): string {
  return [
    "usage: agentera doctor [-h] [--install-root PATH] [--home HOME] [--project PROJECT]",
    "                       [--expected-version VERSION] [--expect-command CMD]",
    "                       [--smoke] [--allow-live-model] [--format {text,json}]",
    "",
    "options:",
    "  -h, --help              show this help message and exit",
    "  --install-root PATH     Agentera app home to diagnose",
    "  --home HOME             Home directory for runtime detection",
    "  --project PROJECT       Project directory context",
    "  --expected-version VER  Expected app files version",
    "  --expect-command CMD    Required CLI command probe; may be repeated",
    "  --smoke                 Run bounded offline smoke checks (no live model calls by default)",
    "  --allow-live-model      Record permission for future live model smoke probes",
    "  --format {text,json}    Structured output format",
  ].join("\n");
}

export function printStateHelp(sub?: string): string {
  if (sub) {
    return [
      `usage: agentera state ${sub} [-h] [--format {text,json,yaml}] [filters]`,
      "",
      "options:",
      "  -h, --help            show this help message and exit",
      "  --format FORMAT       Output format: text, json, or yaml",
    ].join("\n");
  }
  return [
    "usage: agentera state [-h] {plan,progress,health,todo,decisions,docs,objective,experiments,query} ...",
    "",
    "Routine artifact reads and advanced artifact query.",
  ].join("\n");
}

export function printCheckHelp(sub?: string): string {
  if (sub === "verify") {
    return [
      "usage: agentera check verify [-h] eval {skills,semantic} [--format text|json] [options]",
      "",
      "Evaluation verify gates. Smoke verify is retired on the npm self-contained CLI;",
      "use the stable Python line for smoke maintainer harnesses.",
    ].join("\n");
  }
  if (sub) {
    return [`usage: agentera check ${sub} [-h] [options]`, "", "options:", "  -h, --help            show this help message and exit"].join("\n");
  }
  return [
    "usage: agentera check [-h] {validate,verify,lint,compact} ...",
    "",
    "Validation, verification, lint, and repository compaction gates.",
  ].join("\n");
}

export function printReportHelp(): string {
  return [
    "usage: agentera report [-h] [--format {text,json}] [--project VALUE]",
    "                       | agentera report refresh [--dry-run|--consent local-history]",
    "                         [--no-<runtime> ...] [--accept-coverage-gap]",
    "",
    "Privacy-gated usage analytics over an existing corpus.",
    "",
    "Corpus extraction flags (report refresh with --consent local-history):",
    "  These flags deselect runtimes that would otherwise be included when their",
    "  store exists. Full-mode profile runs a Coverage Audit first; skipping an",
    "  available runtime flags the run until --accept-coverage-gap is passed.",
    "  --no-codex            Skip codex even if ~/.codex/sessions exists",
    "  --no-claude           Skip claude-code even if ~/.claude/projects exists",
    "  --no-opencode         Skip opencode even if the opencode.db store exists",
    "  --no-copilot          Skip github-copilot even if session-store.db exists",
    "  --no-cursor           Skip cursor and cursor-agent stores",
    "  --accept-coverage-gap Proceed despite skipped available runtimes (EX2)",
    "  --coverage-audit-only Run the Coverage Audit summary only; do not extract",
  ].join("\n");
}

export function printPrimeHelp(): string {
  return [
    "usage: agentera prime [-h] [--format {text,json,yaml}] [--context CAPABILITY]",
    "                       [--guidance] [--dashboard] [--orientation] [--fields FIELDS]",
    "",
    "Composite orientation briefing, capability startup context, or static guidance.",
    "",
    "options:",
    "  -h, --help            show this help message and end",
    "  --format FORMAT       Output format: text, json, or yaml",
    "  --context CAPABILITY  Emit startup context for a capability (e.g. plan)",
    "  --guidance            Emit static routing guidance",
    "  --dashboard           Emit the prime orientation dashboard",
    "  --orientation         Emit orientation briefing sections",
    "  --fields FIELDS       Comma-separated field filter for JSON/YAML output",
  ].join("\n");
}

export function printSchemaHelp(): string {
  return [
    "usage: agentera schema [-h] [--format {json,yaml}]",
    "",
    "Runtime CLI and schema introspection.",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --format FORMAT       Output format: json or yaml",
  ].join("\n");
}

export function printCapabilityHelp(capability: string): string {
  return [
    `usage: agentera ${capability} [-h] [--format {text,json,yaml}]`,
    "",
    `Route to ${capability} capability guidance (not a full capability runner).`,
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --format FORMAT       Output format: text, json, or yaml",
    "",
    `Startup context: agentera prime --context ${capability} --format json`,
  ].join("\n");
}

export function printCommandHelp(command: string, rest: string[] = []): string | null {
  const sub = rest.find((a) => !a.startsWith("-") && a !== "--help" && a !== "-h");
  switch (command) {
    case "prime":
      return printPrimeHelp();
    case "schema":
      return printSchemaHelp();
    case "upgrade":
      return printUpgradeHelp();
    case "app-home":
      return printAppHomeHelp();
    case "doctor":
      return printDoctorHelp();
    case "state":
      return printStateHelp(sub);
    case "check":
      return printCheckHelp(sub);
    case "report":
    case "stats":
      return printReportHelp();
    case "verify":
      return printCheckHelp("verify");
    case "--version":
    case "version":
      return "usage: agentera --version [--format {text,json}]\n\nPrint the installed Agentera CLI version.\n";
    default:
      if ((CAPABILITY_ROUTING_NAMES as readonly string[]).includes(command)) {
        return printCapabilityHelp(command);
      }
      return null;
  }
}

export function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

export function splitHelpArgs(argv: string[]): { args: string[]; help: boolean } {
  const idx = argv.findIndex((a) => a === "--help" || a === "-h");
  if (idx === -1) return { args: argv, help: false };
  return { args: argv.filter((_, i) => i !== idx), help: true };
}
