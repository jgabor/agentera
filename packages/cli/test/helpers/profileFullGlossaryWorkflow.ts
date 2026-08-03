import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const START = "<!-- agentera:personal-glossary:start -->";
const END = "<!-- agentera:personal-glossary:end -->";
const ACTION_MARKER = /<!-- agentera:profile-full-action:([a-z-]+) -->/g;
const ACTIONS = new Set(["capture-owned-glossary", "write-base-profile", "publish-profile-glossary"]);

type Action = "capture-owned-glossary" | "write-base-profile" | "publish-profile-glossary";
type CommandOutput = { status: string; entry_count: number };

export interface ProfileFullWorkflowObservation {
  profilePath: string;
  servedActions: Action[];
  firstStatus: string;
  replayStatus: string;
  laterStatus: string;
  laterConfidence: number;
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

function invoke(executable: string, args: string[], root: string, input?: string) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    env: isolatedEnv(root),
    encoding: "utf8",
    input,
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
  const profilePath = path.join(root, "profile-data", "PROFILE.md");
  assert.equal(context?.profile, undefined, "prime exposed profile state at startup");
  assert.equal(context?.context?.profile_context?.profile, undefined, "prime exposed profile-derived state at startup");
  assert.equal(context?.startup?.detail_discovery?.schema, "agentera schema --format json", "prime omitted startup detail discovery");
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
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(match[1]);
  } catch {
    throw new Error("malformed owned Glossary section");
  }
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

function request(profilePath: string, asOf: string, fresh: boolean): Record<string, unknown> {
  return {
    schema_version: "agentera.personalGlossaryUpdateRequest.v1",
    profile_path: profilePath,
    as_of: asOf,
    fresh_entries: fresh ? [{
      term: "ship shape",
      meaning: "The complete form of a deliverable.",
      confidence: 80,
      permanence: "durable",
      temporal: { observed_at: "2026-07-01", last_confirmed_at: "2026-07-01" },
      provenance: {
        kind: "personal_explicit_definition",
        evidence: [{ source_id: "source", evidence_anchor: "anchor", signal_type: "correction" }],
      },
    }] : [],
    retained_history: fresh ? [{
      source_id: "source",
      evidence_anchor: "anchor",
      source_kind: "conversation_turn",
      signal_type: "correction",
    }] : [],
  };
}

function publish(executable: string, root: string, profilePath: string, asOf: string, fresh: boolean): CommandOutput {
  const result = invoke(
    executable,
    ["report", "profile-glossary", "--input", "-", "--format", "json"],
    root,
    JSON.stringify(request(profilePath, asOf, fresh)),
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runCycle(
  actions: Action[],
  executable: string,
  root: string,
  profilePath: string,
  base: string,
  asOf: string,
  fresh: boolean,
): { publication: CommandOutput | null; ownedBeforePublication: string | null } {
  let captured: string | null = null;
  let publication: CommandOutput | null = null;
  let ownedBeforePublication: string | null = null;
  for (const action of actions) {
    if (action === "capture-owned-glossary") {
      captured = fs.existsSync(profilePath) ? captureOwnedGlossary(fs.readFileSync(profilePath, "utf8")) : null;
    } else if (action === "write-base-profile") {
      writeBaseProfile(profilePath, base, captured);
    } else {
      ownedBeforePublication = fs.existsSync(profilePath)
        ? captureOwnedGlossary(fs.readFileSync(profilePath, "utf8"))
        : null;
      publication = publish(executable, root, profilePath, asOf, fresh);
    }
  }
  return { publication, ownedBeforePublication };
}

function withoutOwnedGlossary(profile: string): string {
  const start = profile.indexOf(START);
  const end = profile.indexOf(END, start) + END.length;
  assert(start >= 0 && end >= END.length, "missing owned Glossary section");
  return profile.slice(0, start) + profile.slice(end);
}

export function runServedProfileFullWorkflow(executable: string, root: string): ProfileFullWorkflowObservation {
  fs.mkdirSync(path.join(root, ".agentera"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agentera", "state-mode.yaml"), "schemaVersion: agentera.stateMode.v1\nmode: entities\n");
  const { actions, profilePath } = servedContract(executable, root);
  const trap = path.join(root, ".agentera", "glossary.yaml");
  fs.mkdirSync(trap, { recursive: true });

  const firstBase = "# Decision Profile: Served Workflow\n\n## Process\n\nfirst base\n";
  assert.equal(fs.existsSync(profilePath), false, `first-generation profile unexpectedly exists at ${profilePath}`);
  const first = runCycle(actions, executable, root, profilePath, firstBase, "2026-07-01", true);
  assert.equal(first.publication?.status, "changed");
  const established = fs.readFileSync(profilePath, "utf8");
  assert.equal(established.match(/^## Glossary$/gm)?.length, 1);
  assert(established.includes('"term": "ship shape"'));
  const establishedOwned = captureOwnedGlossary(established)!;

  const sameDateBase = "# Decision Profile: Served Workflow\n\n<!-- realistically regenerated -->\n## Process\n\nsame-date base\n";
  const replay = runCycle(actions, executable, root, profilePath, sameDateBase, "2026-07-01", false);
  assert.equal(replay.ownedBeforePublication, establishedOwned, "base regeneration did not preserve exact owned bytes");
  assert.equal(replay.publication?.status, "unchanged_replay");
  const replayed = fs.readFileSync(profilePath, "utf8");
  assert.equal(captureOwnedGlossary(replayed), establishedOwned);
  assert.equal(withoutOwnedGlossary(replayed), `${sameDateBase}\n\n`);

  const laterBase = "# Decision Profile: Served Workflow\n\n<!-- regenerated later -->\n## Decision Patterns\n\n- High confidence: preserve semantic seams.\n\n## Process\n\nlater base\n";
  const later = runCycle(actions, executable, root, profilePath, laterBase, "2026-10-09", false);
  assert.equal(later.ownedBeforePublication, establishedOwned, "later base regeneration did not preserve exact owned bytes");
  assert.equal(later.publication?.status, "changed");
  const decayed = fs.readFileSync(profilePath, "utf8");
  assert(decayed.includes('"confidence": 49'));
  assert(decayed.includes('"permanence": "durable"'));
  assert.equal(withoutOwnedGlossary(decayed), `${laterBase}\n\n`);
  assert.equal(fs.statSync(trap).isDirectory(), true);

  const malformed = [
    "# Existing\n\n## Glossary\nmanual\n",
    `# Existing\n\n${START}\n## Glossary\n`,
    `# Existing\n\n${START}\n## Glossary\n\n\`\`\`json\n{}\n\`\`\`\n${END}\n`,
    `# Existing\n\n${START}\n## Glossary\n\n\`\`\`json\n{}\n\`\`\`\n${END}\n${START}\n`,
  ];
  let malformedCasesRejected = 0;
  for (const original of malformed) {
    fs.writeFileSync(profilePath, original);
    let rejected = false;
    try {
      runCycle(actions, executable, root, profilePath, "# Decision Profile: must not be written\n", "2026-10-09", false);
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true, "malformed existing section was not rejected");
    assert.equal(fs.readFileSync(profilePath, "utf8"), original, "malformed existing section changed before rejection");
    malformedCasesRejected += 1;
  }
  fs.writeFileSync(profilePath, decayed);

  return {
    profilePath,
    servedActions: actions,
    firstStatus: first.publication.status,
    replayStatus: replay.publication.status,
    laterStatus: later.publication.status,
    laterConfidence: 49,
    malformedCasesRejected,
  };
}
