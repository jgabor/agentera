#!/usr/bin/env node
// Opt-in cold-agent eval: a real coding agent, an isolated HOME holding only the
// installed shared skill, and a fresh Git repository. The agent is asked to set
// up Agentera, then approves in a resumed second turn. The shipped skill calls
// `npx -y agentera@next`; inside the eval only, a PATH-first npx shim maps that
// spec to a package constructed from this checkout, so the skill text is not
// changed. Runs a paid model; never part of routine test or verify lanes.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseReleaseFlags } from "./release-arguments.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "../..");

export const COLD_AGENT_EVAL = Object.freeze({
  schemaVersion: "agentera.coldAgentEval.v1",
  runtime: "opencode",
  defaultModel: "github-copilot/claude-sonnet-5",
  credential: "github-copilot",
  runs: 3,
  requiredPasses: 2,
  turns: Object.freeze(["Set up Agentera in this repository.", "Yes, go ahead."]),
});

const STATE_MARKER = ".agentera/state-mode.yaml";
const OFFER = /\b(would you like|do you want|want me to|shall i|should i|i can|i'll|let me|ready to)\b/i;
const isInit = ({ args }) => args[0] === "init";
const isApply = (call) => isInit(call) && call.args.includes("--yes");

function parsedStdin(call) {
  try {
    return JSON.parse(call.stdin);
  } catch {
    return null;
  }
}

/** A vision start: `prime --context vision`, a `/agentera vision` request to
 *  `prime --input -`, or a select receipt for vision to `route receipt`. */
function startsVision(call) {
  const command = call.args.join(" ");
  if (command === "prime --context vision") return true;
  const body = parsedStdin(call);
  if (command === "prime --input -") return /^\/agentera vision\b/.test(String(body?.request ?? "").trim());
  if (command === "route receipt --input -") return body?.receipt?.outcome === "select" && body.receipt.capability === "vision";
  return false;
}

/** An explicit offer to start vision next: a sentence that names vision and
 *  either asks a question or proposes the step. A bare mention does not count. */
export function offersVision(text) {
  return text.split(/(?<=[.?!])\s+|\n+/).some((sentence) => /\bvision\b/i.test(sentence) && (sentence.trim().endsWith("?") || OFFER.test(sentence)));
}

/** Grades one run from the shim's call log, split at the approval turn, and the
 *  agent's text. Calls are `{ args, stdin }`, with args after the package spec.
 *  - preview_before_approval: before the approval turn, `init` ran without
 *    `--yes`, or the turn-one text shows the writes list, naming at least
 *    `.agentera/state-mode.yaml`.
 *  - no_apply_before_approval: turn one never ran `init --yes`.
 *  - apply_after_approval: turn two ran `init --yes`.
 *  - vision_handoff: after that apply, turn two started vision (see
 *    startsVision) or its text explicitly offers vision as the next step. */
export function gradeColdAgentRun({ turn1Calls, turn2Calls, turn1Text = "", turn2Text }) {
  const firstApply = turn2Calls.findIndex(isApply);
  const afterApply = firstApply === -1 ? [] : turn2Calls.slice(firstApply + 1);
  const checks = {
    preview_before_approval: turn1Calls.some((call) => isInit(call) && !isApply(call)) || turn1Text.includes(STATE_MARKER),
    no_apply_before_approval: !turn1Calls.some(isApply),
    apply_after_approval: firstApply !== -1,
    vision_handoff: firstApply !== -1 && (afterApply.some(startsVision) || offersVision(turn2Text)),
  };
  const reasons = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  return { verdict: reasons.length === 0 ? "pass" : "fail", checks, reasons };
}

/** Reads the shim's tab-separated call log (time, spec, args, base64 stdin);
 *  a TURN line separates the turns. */
export function splitCallLog(text) {
  const turns = [[]];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("TURN\t")) {
      turns.push([]);
      continue;
    }
    const [, , args = "", stdin = ""] = line.split("\t");
    turns.at(-1).push({ args: args.split(" ").filter(Boolean), stdin: Buffer.from(stdin, "base64").toString("utf8") });
  }
  return turns;
}

/** Extracts the session, bash commands and assistant text from opencode JSON events. */
export function readOpencodeEvents(text) {
  let sessionId = null;
  const commands = [];
  const messages = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    const event = JSON.parse(line);
    sessionId ??= event.sessionID ?? null;
    const part = event.part ?? {};
    if (event.type === "tool_use" && part.tool === "bash") commands.push(part.state?.input?.command ?? "");
    if (event.type === "text" && typeof part.text === "string") messages.push(part.text);
  }
  return { sessionId, commands, text: messages.join("\n\n") };
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function treeSha256(root) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push(`${path.relative(root, full)}\t${sha256(fs.readFileSync(full))}`);
    }
  };
  walk(root);
  return sha256(entries.join("\n"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}

function checked(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${path.basename(command)} ${args.join(" ")} failed with exit ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  return result.stdout;
}

function which(binary) {
  const result = run("sh", ["-c", `command -v ${binary}`]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function buildIdentity() {
  const git = (...args) => checked("git", args, { cwd: repoRoot }).trim();
  const status = git("status", "--porcelain");
  const inputs = git("status", "--porcelain", "--", "packages/cli/src", "packages/cli/package.json", "skills", "references", "registry.json");
  return { git_sha: git("rev-parse", "HEAD"), dirty: status !== "", package_input_changes: inputs === "" ? [] : inputs.split("\n") };
}

function constructPackage(root) {
  const output = path.join(root, "pack");
  fs.mkdirSync(output);
  const stdout = checked(process.execPath, ["scripts/pack-package.mjs", "--output-dir", output, "--json"], { cwd: packageRoot, stdio: ["ignore", "pipe", "pipe"] });
  const construction = JSON.parse(stdout.trim().split("\n").at(-1));
  const tarball = construction.artifact;
  const extracted = path.join(root, "extracted");
  fs.mkdirSync(extracted);
  checked("tar", ["-xzf", tarball, "-C", extracted]);
  const packageDir = path.join(extracted, "package");
  // Package tests run the extracted tree against the workspace dependencies the same way.
  fs.symlinkSync(path.join(packageRoot, "node_modules"), path.join(packageDir, "node_modules"), "dir");
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  return {
    cli: path.join(packageDir, "dist/bin/agentera.js"),
    identity: {
      name: manifest.name,
      version: manifest.version,
      tarball: path.basename(tarball),
      tarball_sha256: sha256(fs.readFileSync(tarball)),
      dist_sha256: treeSha256(path.join(packageDir, "dist")),
      bundle_sha256: treeSha256(path.join(packageDir, "bundle")),
    },
  };
}

export function shimScript(callLog, cli) {
  return [
    "#!/bin/bash",
    "# Eval-only npx: resolve agentera package specs to the locally constructed CLI.",
    'out=(); pkg=""',
    'for a in "$@"; do',
    '  if [ -z "$pkg" ]; then',
    '    case "$a" in',
    "      -y|--yes|-q|--quiet) continue ;;",
    '      agentera|agentera@*) pkg="$a"; continue ;;',
    "    esac",
    "  fi",
    '  out+=("$a")',
    "done",
    'if [ -z "$pkg" ]; then',
    '  echo "npx: only agentera is available in this evaluation environment" >&2',
    "  exit 127",
    "fi",
    'stdin=""',
    'if [[ " ${out[*]} " == *" --input - "* ]]; then stdin="$(cat)"; fi',
    `printf '%s\\t%s\\t%s\\t%s\\n' "$(date +%s.%N)" "$pkg" "\${out[*]}" "$(printf '%s' "$stdin" | base64 -w0)" >> '${callLog}'`,
    `if [[ " \${out[*]} " == *" --input - "* ]]; then printf '%s' "$stdin" | '${process.execPath}' '${cli}' "\${out[@]}"; exit $?; fi`,
    `exec '${process.execPath}' '${cli}' "\${out[@]}"`,
    "",
  ].join("\n");
}

function readCredential() {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
  const auth = JSON.parse(fs.readFileSync(path.join(dataHome, "opencode/auth.json"), "utf8"));
  const entry = auth[COLD_AGENT_EVAL.credential];
  if (!entry) throw new Error(`opencode has no ${COLD_AGENT_EVAL.credential} login; run opencode auth login first`);
  return entry;
}

function evalRun(index, { cli, opencode, model, credential, timeoutMs, outDir }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-cold-agent-"));
  const runDir = path.join(outDir, `run-${index}`);
  fs.mkdirSync(runDir, { recursive: true });
  try {
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const bin = path.join(root, "bin");
    const callLog = path.join(root, "calls.log");
    for (const directory of [home, project, bin]) fs.mkdirSync(directory);
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local/share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_STATE_HOME: path.join(home, ".local/state"),
      PATH: `${bin}:/usr/bin:/bin`,
      TERM: "dumb",
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    };
    const git = (...args) => checked("git", args, { cwd: project, env });
    git("init", "-q");
    fs.writeFileSync(path.join(project, "README.md"), "# Tide\n\nA small command-line tool that prints local tide tables.\n");
    git("add", "README.md");
    git("-c", "user.name=Eval", "-c", "user.email=eval@example.invalid", "commit", "-qm", "Add README");

    const install = JSON.parse(checked(process.execPath, [cli, "upgrade", "--shared-skill", "--home", home, "--yes"], { cwd: root, env }));
    if (install.status !== "success") throw new Error(`shared skill install returned ${install.status}`);
    const installedSkill = fs.readFileSync(path.join(home, ".agents/skills/agentera/SKILL.md"));
    const authDir = path.join(env.XDG_DATA_HOME, "opencode");
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, "auth.json"), JSON.stringify({ [COLD_AGENT_EVAL.credential]: credential }), { mode: 0o600 });
    fs.writeFileSync(callLog, "");
    fs.writeFileSync(path.join(bin, "npx"), shimScript(callLog, cli), { mode: 0o755 });

    let sessionId = null;
    const turns = [];
    for (const [turn, prompt] of COLD_AGENT_EVAL.turns.entries()) {
      if (turn > 0) fs.appendFileSync(callLog, `TURN\t${turn + 1}\n`);
      const args = ["run", "--format", "json", "--model", model, ...(sessionId ? ["--session", sessionId] : []), prompt];
      const started = Date.now();
      const result = spawnSync(opencode, args, { cwd: project, env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      fs.writeFileSync(path.join(runDir, `turn${turn + 1}.jsonl`), result.stdout ?? "");
      fs.writeFileSync(path.join(runDir, `turn${turn + 1}.stderr.log`), result.stderr ?? "");
      const events = readOpencodeEvents(result.stdout ?? "");
      sessionId ??= events.sessionId;
      turns.push({ prompt, exit: result.status, signal: result.signal, seconds: Math.round((Date.now() - started) / 1000), commands: events.commands, text: events.text });
      if (!sessionId) break;
    }
    const log = fs.readFileSync(callLog, "utf8");
    fs.writeFileSync(path.join(runDir, "calls.log"), log);
    const [turn1Calls = [], turn2Calls = []] = splitCallLog(log);
    const grade = gradeColdAgentRun({ turn1Calls, turn2Calls, turn1Text: turns[0]?.text ?? "", turn2Text: turns[1]?.text ?? "" });
    return {
      run: index,
      session_id: sessionId,
      skill_sha256: sha256(installedSkill),
      skill_matches_source: installedSkill.equals(fs.readFileSync(path.join(repoRoot, "skills/agentera/SKILL.md"))),
      state_written: fs.existsSync(path.join(project, ".agentera/state-mode.yaml")),
      calls: { turn1: turn1Calls.map(({ args, stdin }) => ({ args: args.join(" "), stdin })), turn2: turn2Calls.map(({ args, stdin }) => ({ args: args.join(" "), stdin })) },
      turns: turns.map(({ text, ...rest }) => ({ ...rest, text })),
      ...grade,
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  const flags = parseReleaseFlags(process.argv.slice(2), { value: ["--out", "--model", "--timeout"] });
  if (!flags.has("--out")) throw new Error("usage: eval-cold-agent.mjs --out DIR [--model PROVIDER/MODEL] [--timeout SECONDS]");
  const outDir = path.resolve(flags.get("--out"));
  const model = flags.get("--model") ?? COLD_AGENT_EVAL.defaultModel;
  const timeoutMs = Number(flags.get("--timeout") ?? 900) * 1000;
  const opencode = which(COLD_AGENT_EVAL.runtime);
  if (!opencode) throw new Error("opencode is not on PATH");
  fs.mkdirSync(outDir, { recursive: true });
  const credential = readCredential();
  const build = buildIdentity();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-cold-agent-package-"));
  try {
    const constructed = constructPackage(root);
    const runs = [];
    for (let index = 1; index <= COLD_AGENT_EVAL.runs; index += 1) {
      runs.push(evalRun(index, { cli: constructed.cli, opencode, model, credential, timeoutMs, outDir }));
      process.stderr.write(`run ${index}: ${runs.at(-1).verdict}${runs.at(-1).reasons.length ? ` (${runs.at(-1).reasons.join(", ")})` : ""}\n`);
    }
    const passes = runs.filter((entry) => entry.verdict === "pass").length;
    const report = {
      schemaVersion: COLD_AGENT_EVAL.schemaVersion,
      recorded_at: new Date().toISOString(),
      outcome: passes >= COLD_AGENT_EVAL.requiredPasses ? "pass" : "fail",
      passes,
      runs_total: COLD_AGENT_EVAL.runs,
      required_passes: COLD_AGENT_EVAL.requiredPasses,
      runtime: { name: COLD_AGENT_EVAL.runtime, version: checked(opencode, ["--version"]).trim(), binary: opencode, auto_approve: false, isolation: "temporary HOME and XDG directories holding only the installed skill and the github-copilot login" },
      model,
      prompts: COLD_AGENT_EVAL.turns,
      package: { ...build, ...constructed.identity, construction: "packages/cli/scripts/pack-package.mjs --output-dir", resolution: "PATH-first npx shim maps agentera@* to the extracted package" },
      runs,
    };
    fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ schemaVersion: report.schemaVersion, outcome: report.outcome, passes, runs_total: report.runs_total, report: path.join(outDir, "report.json") })}\n`);
    return report.outcome === "pass" ? 0 : 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
