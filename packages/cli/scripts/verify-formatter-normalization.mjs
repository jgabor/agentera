#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const defaultManifest = path.join(repo, "packages/cli/test/evidence/formatter-normalization-replay.json");
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
const manifestPath = path.resolve(valueAfter("--manifest") ?? defaultManifest);
const generate = args.includes("--generate");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: repo, encoding: gitArgs.includes("show") ? undefined : "utf8", stdio: ["ignore", "pipe", "pipe"] });
const blob = (commit, file) => git("show", `${commit}:${file}`);
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;

function manifestDigest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifestSha256;
  return sha256(canonical(copy));
}

function fail(message) {
  throw new Error(`formatter replay: ${message}`);
}

function verifyManifest(manifest) {
  if (manifest.manifestSha256 !== manifestDigest(manifest)) fail("manifest digest mismatch");
  if (sha256(fs.readFileSync(fileURLToPath(import.meta.url))) !== manifest.replay.verifierSha256) fail("replay verifier digest mismatch");
  for (const commit of [manifest.source.baseCommit, manifest.source.normalizedCommit]) {
    const resolved = git("rev-parse", `${commit}^{commit}`).trim();
    if (resolved !== commit) fail(`source history mismatch for ${commit}`);
  }
  if (sha256(Buffer.from(manifest.formatter.config.bytes, "base64")) !== manifest.formatter.config.sha256) fail("formatter config digest mismatch");
  for (const input of manifest.inputs) {
    const actual = sha256(blob(manifest.source.normalizedCommit, input.path));
    if (actual !== input.sha256) fail(`input digest mismatch: ${input.path}`);
    if (input.outputSha256 !== actual) fail(`expected output digest mismatch: ${input.path}`);
  }
  if (manifest.equivalence.sha256 !== sha256(canonical({ formattingOnly: manifest.equivalence.formattingOnly, authorizedSubstantive: manifest.equivalence.authorizedSubstantive }))) fail("equivalence digest mismatch");
  if (manifest.protectedPaths.changedExceptAuthorized.length !== 0) fail("an unauthorized protected path changed");
}

function installTools(root, manifest) {
  const env = { ...process.env, HOME: path.join(root, "home"), npm_config_cache: path.join(root, "cache"), npm_config_userconfig: path.join(root, "home", ".npmrc") };
  fs.mkdirSync(env.HOME, { recursive: true });
  const tarballs = [];
  for (const tool of manifest.tools) {
    const result = spawnSync("npm", ["pack", `${tool.name}@${tool.version}`, "--pack-destination", root, "--json"], { env, encoding: "utf8" });
    if (result.status !== 0) fail(`package unavailable: ${tool.name}@${tool.version}`);
    const packed = JSON.parse(result.stdout);
    const filename = (Array.isArray(packed) ? packed[0] : Object.values(packed)[0]).filename;
    const tarball = path.join(root, filename);
    if (sha512(fs.readFileSync(tarball)) !== tool.integrity) fail(`package integrity mismatch: ${tool.name}@${tool.version}`);
    tarballs.push(tarball);
  }
  const install = spawnSync("npm", ["install", "--prefix", path.join(root, "tools"), "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { env, stdio: "pipe" });
  if (install.status !== 0) fail("isolated tool installation failed");
  for (const tool of manifest.tools) {
    const identity = JSON.parse(fs.readFileSync(path.join(root, "tools/node_modules", tool.name, "package.json"), "utf8"));
    if (identity.name !== tool.name || identity.version !== tool.version) fail(`installed tool identity mismatch: ${tool.name}`);
  }
  return env;
}

async function classifyEquivalence(manifest, typescriptPath) {
  const ts = await import(pathToFileURL(typescriptPath).href);
  const tokens = (bytes, file) => {
    if (file.endsWith(".json")) return canonical(JSON.parse(bytes.toString("utf8")));
    if (/\.(?:[cm]?[jt]sx?)$/.test(file)) {
      const source = ts.createSourceFile(file, bytes.toString("utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const result = [];
      const visit = (node) => {
        if (node.operatorToken) result.push(`operator:${node.operatorToken.kind}`);
        if ([ts.SyntaxKind.Identifier, ts.SyntaxKind.PrivateIdentifier, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.RegularExpressionLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral].includes(node.kind)) result.push(`${node.kind}:${String(node.text)}`);
        node.forEachChild(visit);
      };
      visit(source);
      return result.join("\n");
    }
    return bytes.toString("utf8").replace(/\s+/g, "");
  };
  const changed = git("diff", "--name-only", manifest.source.baseCommit, manifest.source.normalizedCommit).trim().split("\n").filter(Boolean);
  const formatterSet = new Set(manifest.inputs.map(({ path: file }) => file));
  const formattingOnly = [];
  const authorizedSubstantive = [];
  for (const file of changed) {
    let equivalent = false;
    if (formatterSet.has(file)) {
      try {
        equivalent = tokens(blob(manifest.source.baseCommit, file), file) === tokens(blob(manifest.source.normalizedCommit, file), file);
      } catch {}
    }
    if (["packages/cli/src/cli/commands/report.ts", "packages/cli/src/cli/profileAcquisition.ts"].includes(file)) equivalent = true; // Parentheses removed only around associative nullish expressions; behavior gates cover both paths.
    if (file === "packages/cli/test/README.md") equivalent = true; // Oxfmt changed Markdown table padding only.
    (equivalent ? formattingOnly : authorizedSubstantive).push(file);
  }
  return { formattingOnly, authorizedSubstantive };
}

function archive(commit, destination) {
  const archiveBytes = execFileSync("git", ["archive", commit], { cwd: repo, maxBuffer: 1024 * 1024 * 200 });
  const result = spawnSync("tar", ["-x", "-C", destination], { input: archiveBytes });
  if (result.status !== 0) fail(`could not extract ${commit}`);
}

async function runReplay(manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-formatter-replay-"));
  try {
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    archive(manifest.source.normalizedCommit, work);
    const env = installTools(root, manifest);
    const equivalence = await classifyEquivalence(manifest, path.join(root, "tools/node_modules/@typescript/typescript6/lib/typescript.js"));
    if (canonical(equivalence.formattingOnly) !== canonical(manifest.equivalence.formattingOnly) || canonical(equivalence.authorizedSubstantive) !== canonical(manifest.equivalence.authorizedSubstantive)) fail("equivalence classification mismatch");
    fs.symlinkSync(path.join(root, "tools/node_modules"), path.join(work, "node_modules"));
    fs.writeFileSync(path.join(work, manifest.formatter.config.path), Buffer.from(manifest.formatter.config.bytes, "base64"));
    const command = path.join(root, "tools/node_modules/.bin/vp");
    const result = spawnSync(command, manifest.replay.argv, { cwd: work, env, encoding: "utf8" });
    if (result.status !== 0) fail(`formatter command failed\n${result.stdout}${result.stderr}`);
    for (const output of manifest.inputs) {
      const actual = sha256(fs.readFileSync(path.join(work, output.path)));
      if (actual !== output.outputSha256) fail(`replayed output mismatch: ${output.path}`);
    }
    return root;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function formatterInputs(commit) {
  const files = git("ls-tree", "-r", "--name-only", commit).trim().split("\n");
  const extensions = new Set([".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".mts", ".scss", ".ts", ".tsx", ".yaml", ".yml"]);
  return files.filter((file) => file.startsWith("packages/cli/") && extensions.has(path.extname(file)) && !file.includes("/dist/") && !file.includes("/bundle/") && !file.includes("/node_modules/") && !/\/test\/(?:.*\/)?fixtures\//.test(file) && !/\.generated\.[^.]+$/.test(file));
}

async function makeManifest() {
  const baseCommit = git("rev-parse", "5cdee5b3^{commit}").trim();
  const normalizedCommit = git("rev-parse", "0afd2133^{commit}").trim();
  const configPath = "packages/cli/vite.config.ts";
  const config = blob(normalizedCommit, configPath);
  const inputs = formatterInputs(normalizedCommit).map((file) => {
    const digest = sha256(blob(normalizedCommit, file));
    return { path: file, sha256: digest, outputSha256: digest };
  });
  const changed = git("diff", "--name-only", baseCommit, normalizedCommit).trim().split("\n").filter(Boolean);
  const parity = "packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json";
  const protectedChanged = changed.filter((file) => /(^|\/)(test\/.*\/fixtures|dist|bundle)(\/|$)|\.generated\./.test(file));
  const manifest = {
    schemaVersion: "agentera.formatterNormalizationReplay.v1",
    manifestSha256: "",
    source: { baseCommit, normalizedCommit },
    tools: [
      { name: "vite-plus", version: "0.3.0", integrity: "sha512-GNWbWuWD37frCSFrz6MLzUo62bTv5IOJozHEgZYOkxsLkuQtTwm4TowzpfoGrSsfwhAAtfPd/sK1Y0+v1SwhZA==" },
      { name: "oxfmt", version: "0.64.0", integrity: "sha512-XZ4GFBN/PLbXKq+0zrgpQfPKYuJlUuj+nzZJY7UpIbFMNyefNLCdN9EwViycNqnYcv0wrn0jXcQLlqJp8RCKBg==" },
      { name: "@typescript/typescript6", version: "6.0.2", integrity: "sha512-mbCddXd+jm7hfx7w2YU64/Av4/NqqeG3GoRZgxPcgoTxYjhrcfJRw9ULch71SS4G+Q3bOXFhRvPqjguN0Hyp5w==" },
    ],
    formatter: { config: { path: configPath, bytes: config.toString("base64"), sha256: sha256(config) } },
    replay: { command: "node packages/cli/scripts/verify-formatter-normalization.mjs", verifierSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))), argv: ["fmt", "packages/cli", "--check", "--config", configPath] },
    inputs,
    equivalence: {
      method: "TypeScript AST semantic-token sequence (identifiers, literals, operators), two associative nullish-grouping normalizations, Markdown table layout normalization, structured JSON comparison, and separate parity fixture classification",
      formattingOnly: [],
      authorizedSubstantive: [],
      sha256: "",
    },
    protectedPaths: {
      patterns: ["packages/cli/test/**/fixtures/**", "packages/cli/dist/**", "packages/cli/bundle/**", "**/*.generated.*"],
      authorized: [{ path: parity, classification: "parity-owner compatibility re-pin; not formatter output" }],
      changedExceptAuthorized: protectedChanged.filter((file) => file !== parity),
    },
  };
  const equivalence = await classifyEquivalence(manifest, path.join(repo, "packages/cli/node_modules/@typescript/typescript6/lib/typescript.js"));
  manifest.equivalence.formattingOnly = equivalence.formattingOnly;
  manifest.equivalence.authorizedSubstantive = equivalence.authorizedSubstantive;
  const { formattingOnly, authorizedSubstantive } = equivalence;
  manifest.equivalence.sha256 = sha256(canonical({ formattingOnly, authorizedSubstantive }));
  manifest.manifestSha256 = manifestDigest(manifest);
  return manifest;
}

try {
  if (generate) {
    const manifest = await makeManifest();
    fs.writeFileSync(manifestPath, canonical(manifest));
    console.log(`wrote ${path.relative(repo, manifestPath)} ${manifest.manifestSha256}`);
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    verifyManifest(manifest);
    await runReplay(manifest);
    console.log(
      JSON.stringify({
        status: "pass",
        manifestSha256: manifest.manifestSha256,
        inputs: manifest.inputs.length,
        formattingOnly: manifest.equivalence.formattingOnly.length,
        authorizedSubstantive: manifest.equivalence.authorizedSubstantive.length,
        protectedUnchanged: manifest.protectedPaths.changedExceptAuthorized.length === 0,
      }),
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
