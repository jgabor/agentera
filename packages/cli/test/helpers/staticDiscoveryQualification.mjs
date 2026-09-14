// Maintainer test harness, not shipped or a new consumer interface.
// Run each distribution in a fresh process; only returned static commands execute.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2]);
const [owner, shard] = process.argv[3].split(":");
const read = fs.readFileSync;
let reads = 0;
fs.readFileSync = function (file, ...args) {
  const name = file instanceof URL ? fileURLToPath(file) : String(file);
  assert(name.startsWith(`${root}/`), `Runtime read outside selected distribution: ${name}`);
  assert(!name.endsWith("/SKILL.md"), `Runtime bootstrap/companion read: ${name}`);
  reads++;
  return read.call(this, file, ...args);
};
for (const method of ["writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "symlinkSync"]) {
  fs[method] = () => {
    throw new Error(`Static discovery attempted ${method}`);
  };
}
const { main } = await import(pathToFileURL(path.join(root, "dist/cli/dispatch.js")).href);
const prefix = "npx -y agentera@next ";
const pending = [];
const seen = new Set();
const observations = [];
const counts = {};
let maxBytes = 0;
let continuations = 0;
let details = 0;

function commandArgs(command) {
  assert(command.startsWith(prefix), command);
  // Parse the producer's shell quoting, without invoking a shell or npx.
  const words = [];
  let word = "",
    quote = "",
    active = false,
    escaped = false;
  for (const char of command.slice(prefix.length)) {
    if (escaped) {
      word += char;
      escaped = false;
      active = true;
    } else if (char === "\\" && quote !== "'") {
      escaped = true;
    } else if (char === quote) {
      quote = "";
    } else if ((char === "'" || char === '"') && !quote) {
      quote = char;
      active = true;
    } else if (/\s/.test(char) && !quote) {
      if (active) words.push(word);
      word = "";
      active = false;
    } else {
      word += char;
      active = true;
    }
  }
  assert(!quote, command);
  if (active) words.push(word);
  return words;
}
function discover(value) {
  if (typeof value === "string" && value.startsWith("agentera ")) value = prefix + value.slice("agentera ".length);
  if (typeof value === "string" && value.startsWith(prefix)) {
    if (value.includes("<") || /\b(?:C|A|V|OP|T|S)\b/.test(value)) return;
    const args = commandArgs(value);
    const staticForm = args[0] === "schema" || (["route", "report", "check"].includes(args[0]) && args[1] === "explain") || (args[0] === "state" && args[2] === "explain") || (args[0] === "prime" && args.includes("--detail")) || (["upgrade", "doctor", "app-home"].includes(args[0]) && args[1] === "--explain");
    const operation = args[args.indexOf("--operation") + 1];
    const selectedShard = shard === undefined || !args.includes("--operation") || [...operation].reduce((sum, char) => sum + char.codePointAt(0), 0) % 3 === Number(shard);
    if (staticForm && args[0] === owner && selectedShard) pending.push(args);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) discover(child);
  }
}
function query(args) {
  let out = "",
    err = "";
  const code = main([process.execPath, "agentera", ...args], {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  assert.equal(err, "", args.join(" "));
  assert.equal(code, 0, `${args.join(" ")}\n${out}`);
  return { out, payload: JSON.parse(out) };
}
const schema = query(["schema"]).payload;
discover(schema);
if (owner === "route") pending.push(["route", "explain"]);
if (owner === "prime") {
  let help = "";
  assert.equal(
    main([process.execPath, "agentera", "prime", "--help"], {
      out: (text) => {
        help += text;
      },
    }),
    0,
  );
  const kinds = help.match(/--detail ([a-z]+(?:\|[a-z]+)+)/)?.[1].split("|");
  assert(kinds, "Prime help must discover detail kinds");
  assert(help.includes("prime --context status"));
  const capabilities = ["status", ...schema.commands.filter((command) => command.kind === "capability_routing").map((command) => command.name)];
  assert.equal(new Set(capabilities).size, 12);
  for (const capability of capabilities) for (const kind of kinds) pending.push(["prime", "--context", capability, "--detail", kind]);
}
while (pending.length) {
  const args = pending.shift().filter((arg, index, all) => !(arg === "--limit" && all[index + 1] === "20") && !(arg === "20" && all[index - 1] === "--limit"));
  const key = JSON.stringify(args);
  if (seen.has(key)) continue;
  seen.add(key);
  assert(seen.size < 10000, "Discovery did not converge");
  const { out, payload } = query(args);
  counts[args[0]] = (counts[args[0]] ?? 0) + 1;
  if (payload.schemaVersion === "agentera.guidanceDetail.v1") {
    maxBytes = Math.max(maxBytes, Buffer.byteLength(out));
    assert(Buffer.byteLength(out) <= 32768, key);
    assert.equal(payload.completeness.returned, payload.items.length, key);
    assert.equal(payload.completeness.omitted, payload.completeness.total - payload.items.length, key);
    if (payload.next_command) continuations++;
    if (payload.completeness.mode === "detail") details++;
    observations.push([args, payload]);
  }
  discover(payload);
}
assert(counts[owner] > 0, `Undiscovered owner ${owner}`);
assert(details > 0);
// Retain selector-level coverage and a semantic digest, not private payloads.
console.log(
  JSON.stringify({
    queries: seen.size,
    counts,
    continuations,
    details,
    maxBytes,
    reads,
    roots: [...seen].map((key) => JSON.parse(key)).filter((args) => !args.includes("--section") && !args.includes("--cursor")),
    commandSha256: createHash("sha256")
      .update(JSON.stringify([...seen]))
      .digest("hex"),
    semanticSha256: createHash("sha256").update(JSON.stringify(observations)).digest("hex"),
  }),
);
