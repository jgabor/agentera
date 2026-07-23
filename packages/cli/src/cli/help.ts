import { CAPABILITY_ROUTING_NAMES } from "./commands/capability.js";
import { verbsForArtifact } from "../state/write/operations.js";
import { entityMigrateHelp } from "./commands/entityMigrate.js";

const TOP_LEVEL = [
  "prime",
  "schema",
  "route",
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
    "agentera: read and write project state, upgrade installs, and print priming guidance",
    "",
    ...lines("Agent commands:", [
      "prime               Composite orientation briefing, capability startup context, or static guidance",
      "schema              Runtime CLI/schema introspection",
      "route               Privacy-safe request-to-capability routing",
      "state               Routine artifact reads, writes, and advanced artifact query",
      ...CAPABILITY_ROUTING_NAMES.map(
        (name) => `${name.padEnd(19)} Route to ${name} capability guidance`,
      ),
    ]),
    ...lines("User commands:", [
      "upgrade             Preview or apply app/project migration and explicit legacy cleanup",
      "app-home            Resolve the platform Agentera app-home path",
      "doctor              Check Agentera CLI, app, and shared-skill status",
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
    "                        [--legacy-cleanup {claude}]",
    "                        [--only {artifacts,runtime,cleanup}] [--dry-run] [--yes]",
    "                        [--force] [--verify] [--format {text,json}]",
    "",
    "options:",
    "  -h, --help            show this help message and exit",
    "  --project PROJECT     Project directory whose .agentera artifacts should be migrated",
    "  --install-root PATH   Agentera app home to inspect or update",
    "  --home HOME           Home directory for shared-skill detection and explicit legacy cleanup",
    "  --channel CHANNEL     Update channel: stable (2.x) or development (3.x npm)",
    "  --legacy-cleanup ID   Explicitly include legacy-only retired Claude cleanup",
    "  --only PHASE          Upgrade phase to include; may be repeated",
    "  --dry-run             Strict read-only preview; no files, locks, caches, native commands, or telemetry",
    "  --yes                 Explicitly approve app/project migration or selected legacy cleanup",
    "  --force               Replace only where the migration contract explicitly permits it",
    "  --verify              Verify the current install; full v2-to-v3 apply verifies state and startup automatically",
    "  --format {text,json}  Structured output format",
    "",
    "v2-to-v3 development upgrade (one-way):",
    "  Optional preview: npx -y agentera@next upgrade --channel development --project \"$PWD\" --dry-run",
    "  Full apply:       npx -y agentera@next upgrade --channel development --project \"$PWD\" --yes",
    "  Apply requires a Git worktree whose complete v2 migration source is tracked and unchanged at HEAD.",
    "  Cross-major apply is always full: --only cannot be used; there is no rollback, restore, or non-Git workflow.",
    "",
    "active integration:",
    "  Agentera uses the shared skill at ~/.agents/skills/agentera plus the CLI.",
    "  Current runtime selectors and native plugin, hook, agent, command, descriptor, and marketplace writes are retired.",
    "  Claude cleanup remains explicit: agentera upgrade --legacy-cleanup claude --dry-run|--yes",
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
    "  --home HOME             Home directory for shared-skill diagnosis",
    "  --project PROJECT       Project directory context",
    "  --expected-version VER  Expected app files version",
    "  --expect-command CMD    Required CLI command probe; may be repeated",
    "  --smoke                 Run bounded offline smoke checks (no live model calls by default)",
    "  --allow-live-model      Record permission for future live model smoke probes",
    "  --format {text,json}    Structured output format",
    "",
    "Reports read-only app, project-state, shared-skill, and CLI evidence.",
  ].join("\n");
}

export function printStateHelp(sub?: string): string {
  const stateCommands = stateCommandNames();
  if (sub === "migrate") return entityMigrateHelp();
  if (sub === "plan") {
    return [
      "usage: agentera state plan [-h] [--format {text,json,yaml}] [filters]",
      "       agentera state plan tasks list [PLAN_ID] [--limit N] [--cursor TOKEN] --format json",
      "       agentera state plan tasks get --id ID --format json",
      "       agentera state plan list [--status open|complete|archived] [--limit N] [--cursor TOKEN] --format json",
      "       agentera state plan get --id ID --format json",
      `       agentera state plan {${verbsForArtifact("plan").join(",")}} [write flags]`,
      "",
      "Plan and task reads use bare canonical IDs from entity list results.",
      "Plan list is bounded and cursor-paginated; plan get requires --id.",
      "Invalid historical archives remain non-fatal compatibility diagnostics unless selected.",
      "Task list accepts an optional bare plan ID and otherwise defaults to the sole open plan; task get requires --id.",
      "Only the displayed bare-ID selectors are accepted.",
      "List limits are 1 through 100; structured pages are at most 32,768 UTF-8 bytes and omit whole entries only.",
      "Legacy plan identity collisions return a structured ambiguous error.",
      "",
      "Discover writes: agentera state plan explain --format json",
    ].join("\n");
  }
  if (sub === "experiments") {
    return [
      "usage: agentera state experiments [-h] [--format {text,json,yaml}] [filters]",
      "       agentera state experiments list --objective ID [--limit N] [--cursor TOKEN] --format json",
      "       agentera state experiments get --id ID [--objective ID] --format json",
      "       agentera state experiments publish --objective ID [--id ID] --input EXPERIMENT.yaml --format json",
      "       (publish also accepts --dry-run and --format text)",
      "",
      "Publish is the validated mutation authority and atomically writes one schema-valid experiment.",
      "A byte-equivalent identity retry is idempotent; collisions and pre-publication failures preserve current bytes.",
      "List merges retained projection and immutable archive identities newest-first with bounded opaque snapshot cursors.",
      "Get verifies archive detail first, then reports full, summary-only, or unavailable detail truthfully.",
      "List limits are 1 through 100; structured pages are at most 32,768 UTF-8 bytes and omit whole entries only.",
      "List and publish require one bare objective ID; get requires one bare experiment ID and may verify objective ownership.",
      "Legacy objective/path collisions return a structured ambiguous error.",
      "",
      "Discover writes: agentera state experiments explain --verb publish --format json",
    ].join("\n");
  }
  if (sub === "objective") {
    return [
      "usage: agentera state objective [-h] [--format {text,json,yaml}]",
      "       agentera state objective list [--limit N] [--cursor TOKEN] --format json",
      "       agentera state objective get --id ID --format json",
      "       agentera state objective create --input OBJECTIVE.yaml --format json",
      "       agentera state objective update --id ID --input OBJECTIVE.yaml --format json",
      "",
      "Objective create publishes one independent entity; update replaces that entity through rollback-safe publication.",
      "Bare objective queries infer an active objective only when exactly one exists.",
      "",
      "Discover writes: agentera state objective explain --format json",
    ].join("\n");
  }
  if (sub === "todo") {
    return [
      "usage: agentera state todo [-h] [--severity LEVEL] [--status STATUS] [--format {text,json,yaml}]",
      "       agentera state todo list [--limit N] [--cursor TOKEN] --format json",
      "       agentera state todo get --id ID --format json",
      '       agentera state todo create --severity LEVEL --description TEXT --format json',
      "       agentera state todo update --id ID [--severity LEVEL] [--description TEXT] --format json",
      "       agentera state todo resolve --id ID --format json",
      "",
      "Each TODO item is one independently mutable canonical entity. IDs are bare ten-letter project-wide identities.",
      "Default and list views are bounded in severity/status order; exact get returns complete detail.",
       "Marker-absent repositories must complete migration before ordinary TODO access.",
      "",
      "Discover writes: agentera state todo explain --format json",
    ].join("\n");
  }
  if (sub === "docs") {
    return [
      "usage: agentera state docs [-h] [--topic TOPIC] [--status STATUS] [--format {text,json,yaml}]",
      "       agentera state docs list [--limit N] [--cursor TOKEN] --format json",
      "       agentera state docs get --id ID --format json",
      "       agentera state docs create --input ENTRY.yaml --format json",
      "       agentera state docs update --id ID --input ENTRY.yaml --format json",
      "",
      "Each documentation inventory entry is one independently mutable canonical entity; path is record data, not identity.",
      "Mappings, conventions, coverage, and editorial configuration retain whole-document authority in .agentera/docs.yaml.",
      "Default and list views are bounded by path then ID; exact get returns complete detail.",
      "",
      "Discover writes: agentera state docs explain --format json",
    ].join("\n");
  }
  if (sub) {
    const verbs = verbsForArtifact(sub);
    return [
      `usage: agentera state ${sub} [-h] [--format {text,json,yaml}] [filters]`,
      "       agentera state <artifact> get --id ID --format {text,json,yaml}",
      "       agentera state <artifact> list [--limit N] [--cursor TOKEN] --format {text,json,yaml}",
      ...(verbs.length ? [`       agentera state ${sub} {${verbs.join(",")}} [write flags]`] : []),
      ...(verbs.length
        ? [
            "",
            `Discover writes: agentera state ${sub} explain --format json`,
            `Per verb:        agentera state ${sub} explain --verb VERB --format json`,
          ]
        : []),
      "",
      "options:",
      "  -h, --help            show this help message and exit",
      "  --format FORMAT       Output format: text, json, or yaml",
    ].join("\n");
  }
  return [
    `usage: agentera state [-h] {${stateCommands.join(",")}} ...`,
    "",
    "Routine artifact reads, writes, and advanced artifact query.",
    "Discover typed writes: agentera state <artifact> explain --format json",
  ].join("\n");
}

export function stateCommandNames(): string[] {
  return [
    "progress",
    "plan",
    "health",
    "docs",
    "objective",
    "experiments",
    "todo",
    "decisions",
    "migrate",
    "query",
  ];
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
  if (sub === "durability") {
    return [
      "usage: agentera check durability [-h] [--project PATH] [--artifact ARTIFACT]",
      "                                [--number N|--id ID] [--limit N] --format {text,json,yaml}",
      "",
      "Read-only local archive and optional reachable Git durability evidence.",
      "This is an explicit migration/readiness diagnostic, not ordinary retrieval grammar.",
      "Git is never required for local state writes and no remote is contacted.",
      "",
      "options:",
      "  -h, --help            show this help message and exit",
      "  --project PATH        Project directory to inspect",
      "  --artifact ARTIFACT   progress, decisions, or health",
      "  --number N            Positive archive entry number; requires --artifact",
      "  --id ID                Bare canonical entity ID after cutover; requires --artifact",
      "  --limit N             Bound returned archive entries (maximum 100)",
      "  --format FORMAT       Output format: text, json, or yaml",
    ].join("\n");
  }
  if (sub) {
    return [
      `usage: agentera check ${sub} [-h] [options]`,
      "",
      "options:",
      "  -h, --help            show this help message and exit",
    ].join("\n");
  }
  return [
    "usage: agentera check [-h] {validate,verify,lint,compact,durability} ...",
    "",
    "Validation, verification, lint, and repository compaction gates.",
  ].join("\n");
}

export function printReportHelp(): string {
  return [
    "usage: agentera report [-h] [--format {text,json}] [--project VALUE] [--sources {active,all}]",
    "                       | agentera report refresh [--dry-run|--consent local-history]",
    "                         [--import-source claude]",
    "                         [--no-<runtime> ...] [--accept-coverage-gap]",
    "",
    "Privacy-gated usage analytics over an existing corpus.",
    "Default analytics use --sources active and exclude historical imports.",
    "Use --sources all to include historical records with visible provenance.",
    "",
    "Corpus extraction flags (report refresh with --consent local-history):",
    "  These flags deselect runtimes that would otherwise be included when their",
    "  store exists. Full-mode profile runs a Coverage Audit first; skipping an",
    "  available runtime flags the run until --accept-coverage-gap is passed.",
    "  --no-codex            Skip codex even if ~/.codex/sessions exists",
    "  --no-opencode         Skip opencode even if the opencode.db store exists",
    "  --no-copilot          Skip github-copilot even if session-store.db exists",
    "  --no-cursor           Skip Cursor IDE and CLI stores",
    "  --import-source claude Explicitly import local Claude history as historical data.",
    "                         Transcripts can contain secrets, file contents, and command output.",
    "                         Import is read-only, active_runtime=false, and excluded by default analytics.",
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
    "",
    "JSON output uses bounded surfaces: bare prime is at most 12000 UTF-8 bytes and status context at most 25000; source_contract includes artifact_writes discovery metadata and omitted detail has named recovery commands.",
  ].join("\n");
}

export function printSchemaHelp(): string {
  return [
    "usage: agentera schema [-h] [--format {json,yaml}]",
    "",
    "Runtime CLI and schema introspection.",
    "Includes the state_writer operation matrix and per-artifact write_interface metadata.",
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

export function printRouteHelp(): string {
  return [
    "usage: agentera route <request|receipt> --input PATH [--format json]",
    "",
    "Route one transient request or validate one semantic API receipt through the shared hybrid contract.",
    "Request text is accepted only from the structured YAML or JSON input document, never argv.",
    "Use --input - to read the document from stdin. Output is JSON on stdout.",
    "",
    "input document: { version: agentera.route_request.v1, request: <string> }",
    "receipt input: { request: <string>, receipt: <complete nullable API receipt> }",
    "A receipt result authorizes only its reported startup command; clarify starts none.",
  ].join("\n");
}

export function printCommandHelp(command: string, rest: string[] = []): string | null {
  const sub = rest.find((a) => !a.startsWith("-") && a !== "--help" && a !== "-h");
  if (command === "state" && rest.filter((item) => !item.startsWith("-")).slice(0, 2).join(" ") === "migrate entities") return entityMigrateHelp();
  switch (command) {
    case "prime":
      return printPrimeHelp();
    case "schema":
      return printSchemaHelp();
    case "route":
      return printRouteHelp();
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
