import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const START = "<!-- agentera:personal-glossary:start -->";
const END = "<!-- agentera:personal-glossary:end -->";
const ACTION_MARKER = /<!-- agentera:profile-full-action:([a-z-]+) -->/g;
const ACTIONS = new Set(["capture-owned-glossary", "write-base-profile"]);

type Action = "capture-owned-glossary" | "write-base-profile";

export interface ProfileFullWorkflowObservation {
  profilePath: string;
  servedActions: Action[];
  initialBaseHasNoGlossary: boolean;
  preservedOwnedSection: boolean;
  malformedCasesRejected: number;
}

function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    AGENTERA_HOME: path.join(root, "app-home"),
    AGENTERA_PROFILE_DIR: path.join(root, "profile-data"),
  };
  for (const directory of [env.HOME, env.XDG_DATA_HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.AGENTERA_HOME, env.AGENTERA_PROFILE_DIR]) {
    fs.mkdirSync(directory!, { recursive: true });
  }
  for (const key of Object.keys(env)) {
    if (/^AGENTERA_.*SOURCE.*ROOT$/.test(key)) delete env[key];
  }
  delete env.AGENTERA_BOOTSTRAP_SOURCE_ROOT;
  return env;
}

function invoke(executable: string, args: string[], root: string) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    env: isolatedEnv(root),
    encoding: "utf8",
  });
}

function servedContract(executable: string, root: string): { actions: Action[]; profilePath: string } {
  const prime = invoke(executable, ["prime", "--context", "profile", "--format", "json"], root);
  assert.equal(prime.status, 0, prime.stderr || prime.stdout);
  const context = JSON.parse(prime.stdout)?.capability_context;
  const instructions = context?.instructions;
  assert.equal(typeof instructions, "string", "prime omitted the served Profile instruction body");
  const markers = [...instructions.matchAll(ACTION_MARKER)].map((match: RegExpMatchArray) => match[1]);
  assert(markers.length > 0, "served Profile instructions contain no Profile Full action markers");
  assert.equal(new Set(markers).size, markers.length, "served Profile instructions contain duplicate action markers");
  for (const marker of markers) assert(ACTIONS.has(marker), `served Profile instructions contain unknown action '${marker}'`);
  assert(!instructions.includes("report profile-glossary"), "Profile Full retained the retired direct publication grammar");
  assert(instructions.includes("does not invoke"), "Profile Full claims personal publication authority");
  const profilePath = path.join(root, "profile-data", "PROFILE.md");
  return { actions: markers as Action[], profilePath };
}

function captureOwnedGlossary(profile: string): string | null {
  const starts = profile.split(START).length - 1;
  const ends = profile.split(END).length - 1;
  const headings = [...profile.matchAll(/^## Glossary\s*$/gm)].length;
  if (starts === 0 && ends === 0 && headings === 0) return null;
  if (starts !== 1 || ends !== 1 || headings !== 1) throw new Error("malformed or ambiguous owned Glossary section");
  const start = profile.indexOf(START);
  const end = profile.indexOf(END, start) + END.length;
  const owned = profile.slice(start, end);
  const match = new RegExp(`^${START}\\n## Glossary\\n\\n` + "```json\\n([\\s\\S]+)\\n```\\n" + `${END}$`).exec(owned);
  if (!match) throw new Error("malformed owned Glossary section");
  const document = JSON.parse(match[1]) as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(document)) !== JSON.stringify(["schema_version", "as_of", "confidence_basis", "entries"]) ||
    document.schema_version !== "agentera.personalGlossarySection.v1"
  ) throw new Error("malformed owned Glossary section");
  return owned;
}

function writeBaseProfile(profilePath: string, base: string, existing: string | null): void {
  if (base.includes(START) || base.includes(END) || /^## Glossary\s*$/m.test(base)) {
    throw new Error("generated base contains a Glossary section");
  }
  fs.writeFileSync(
    profilePath,
    existing === null ? base : `${base}${base.endsWith("\n") ? "\n" : "\n\n"}${existing}\n`,
  );
}

function runCycle(actions: Action[], profilePath: string, base: string): string | null {
  let captured: string | null = null;
  for (const action of actions) {
    if (action === "capture-owned-glossary") {
      captured = fs.existsSync(profilePath) ? captureOwnedGlossary(fs.readFileSync(profilePath, "utf8")) : null;
    } else {
      writeBaseProfile(profilePath, base, captured);
    }
  }
  return captured;
}

function ownedSection(): string {
  return `${START}\n## Glossary\n\n\`\`\`json\n${JSON.stringify({
    schema_version: "agentera.personalGlossarySection.v1",
    as_of: "2026-08-10",
    confidence_basis: { "ship shape": 80 },
    entries: [{
      term: "ship shape",
      meaning: "the complete form of a deliverable",
      confidence: 80,
      permanence: "durable",
      temporal: { observed_at: "2026-08-10", last_confirmed_at: "2026-08-10" },
      provenance: { kind: "personal_explicit_definition", evidence: [{ source_id: "source", evidence_anchor: "anchor", signal_type: "correction" }] },
    }],
  }, null, 2)}\n\`\`\`\n${END}`;
}

export function runServedProfileFullWorkflow(executable: string, root: string): ProfileFullWorkflowObservation {
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  const { actions, profilePath } = servedContract(executable, root);

  const initialBase = "# Decision Profile: Served Workflow\n\n## Process\n\nfirst base\n";
  assert.equal(runCycle(actions, profilePath, initialBase), null);
  const initial = fs.readFileSync(profilePath, "utf8");
  assert.equal(initial, initialBase);

  const establishedOwned = ownedSection();
  fs.writeFileSync(profilePath, `${initialBase}\n${establishedOwned}\n`);
  const regeneratedBase = "# Decision Profile: Served Workflow\n\n## Decision Patterns\n\n- High confidence: preserve semantic seams.\n\n## Process\n\nregenerated base\n";
  assert.equal(runCycle(actions, profilePath, regeneratedBase), establishedOwned);
  const regenerated = fs.readFileSync(profilePath, "utf8");
  assert.equal(captureOwnedGlossary(regenerated), establishedOwned);
  assert.equal(regenerated.replace(establishedOwned, ""), `${regeneratedBase}\n\n`);

  const malformed = [
    "# Existing\n\n## Glossary\nmanual\n",
    `# Existing\n\n${START}\n## Glossary\n`,
    `# Existing\n\n${START}\n## Glossary\n\n\`\`\`json\n{}\n\`\`\`\n${END}\n`,
    `# Existing\n\n${START}\n## Glossary\n\n\`\`\`json\n{}\n\`\`\`\n${END}\n${START}\n`,
  ];
  let malformedCasesRejected = 0;
  for (const original of malformed) {
    fs.writeFileSync(profilePath, original);
    assert.throws(() => runCycle(actions, profilePath, "# Decision Profile: must not be written\n"));
    assert.equal(fs.readFileSync(profilePath, "utf8"), original);
    malformedCasesRejected += 1;
  }
  fs.writeFileSync(profilePath, regenerated);

  return {
    profilePath,
    servedActions: actions,
    initialBaseHasNoGlossary: !initial.includes("## Glossary"),
    preservedOwnedSection: captureOwnedGlossary(fs.readFileSync(profilePath, "utf8")) === establishedOwned,
    malformedCasesRejected,
  };
}
