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
const full = args.includes("--full");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const gitText = (...gitArgs) => execFileSync("git", gitArgs, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const gitBytes = (...gitArgs) => execFileSync("git", gitArgs, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
const blob = (commit, file) => gitBytes("show", `${commit}:${file}`);
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;

const TOOLS = [
  { name: "vite-plus", version: "0.3.0", integrity: "sha512-GNWbWuWD37frCSFrz6MLzUo62bTv5IOJozHEgZYOkxsLkuQtTwm4TowzpfoGrSsfwhAAtfPd/sK1Y0+v1SwhZA==" },
  { name: "oxfmt", version: "0.64.0", integrity: "sha512-XZ4GFBN/PLbXKq+0zrgpQfPKYuJlUuj+nzZJY7UpIbFMNyefNLCdN9EwViycNqnYcv0wrn0jXcQLlqJp8RCKBg==" },
  { name: "@typescript/typescript6", version: "6.0.2", integrity: "sha512-mbCddXd+jm7hfx7w2YU64/Av4/NqqeG3GoRZgxPcgoTxYjhrcfJRw9ULch71SS4G+Q3bOXFhRvPqjguN0Hyp5w==" },
  { name: "yaml", version: "2.8.3", integrity: "sha512-AvbaCLOO2Otw/lW5bmh9d/WEdcDFdQp2Z2ZUH3pX9U2ihyUY0nvLv7J6TrWowklRGPYbB/IuIMfYgxaCPg5Bpg==" },
];

const SUBSTANTIVE_ALLOWLIST = [
  { path: ".agentera/entities/plan/plan_task/cninkdteua.yaml", owner: "references/artifacts/state-storage-authority.yaml (typed plan writer)", rationale: "Created the formatter-normalization successor task after the monolith limit blocked its predecessor." },
  { path: ".agentera/entities/plan/plan_task/gwedzsstko.yaml", owner: "references/artifacts/state-storage-authority.yaml (typed plan writer)", rationale: "Recorded the independently audited toolchain-baseline completion." },
  { path: ".agentera/entities/plan/plan_task/obhhyoadbq.yaml", owner: "references/artifacts/state-storage-authority.yaml (typed plan writer)", rationale: "Recorded the formatter task's audited monolith-limit blocker." },
  { path: ".agentera/entities/plan/plan_task/ogzqmopftv.yaml", owner: "references/artifacts/state-storage-authority.yaml (typed plan writer)", rationale: "Superseded the rejected toolchain task with its accepted-risk replacement." },
  { path: ".agentera/entities/progress/progress_cycle/ethomjorgf.yaml", owner: "references/artifacts/state-storage-authority.yaml (typed progress writer)", rationale: "Recorded the initial formatter normalization and its verification results." },
  { path: ".agentera/entities/progress/progress_cycle/feswitlcng.yaml", owner: "references/artifacts/state-storage-authority.yaml (typed progress writer)", rationale: "Recorded the state-module decomposition and closeout checks." },
  { path: ".agentera/entities/progress/progress_cycle/qatpxfmidz.yaml", owner: "references/artifacts/state-storage-authority.yaml (typed progress writer)", rationale: "Recorded the formatter audit correction and monolith blocker." },
  { path: ".agentera/entities/todo/todo_item/bhwgdxohmy.yaml", owner: "references/artifacts/state-storage-authority.yaml (typed TODO writer)", rationale: "Created the tracked task for the formatter-blocking state monoliths." },
  { path: "TODO.md", owner: "references/artifacts/state-storage-authority.yaml (typed TODO writer)", rationale: "Projected TODO bhwgdxohmy into the human-readable ledger." },
  { path: "packages/cli/src/state/entityMigrationContracts.ts", owner: "references/artifacts/state-storage-authority.yaml", rationale: "Extracted migration contracts from entityMigrationPreview.ts to satisfy the governed line limit." },
  { path: "packages/cli/src/state/entityMigrationPreview.ts", owner: "references/artifacts/state-storage-authority.yaml", rationale: "Recomposed migration preview from extracted contract and support modules without changing its public behavior." },
  { path: "packages/cli/src/state/entityMigrationPreviewSupport.ts", owner: "references/artifacts/state-storage-authority.yaml", rationale: "Extracted migration-preview helpers to satisfy the governed line limit." },
  { path: "packages/cli/src/state/planEntities.ts", owner: "references/artifacts/state-storage-authority.yaml", rationale: "Recomposed plan entity handling from an extracted contract module to satisfy the governed line limit." },
  { path: "packages/cli/src/state/planEntityContract.ts", owner: "references/artifacts/state-storage-authority.yaml", rationale: "Extracted plan entity contracts to satisfy the governed line limit." },
  { path: "packages/cli/src/state/todoDocsEntities.ts", owner: "references/artifacts/state-storage-authority.yaml", rationale: "Recomposed TODO/docs entities from extracted write and reconciliation modules to satisfy the governed line limit." },
  { path: "packages/cli/src/state/todoDocsReconciliation.ts", owner: "references/artifacts/state-storage-authority.yaml", rationale: "Extracted TODO/docs reconciliation logic to satisfy the governed line limit." },
  { path: "packages/cli/src/state/todoDocsWrite.ts", owner: "references/artifacts/state-storage-authority.yaml", rationale: "Extracted TODO/docs write logic to satisfy the governed line limit." },
  { path: "packages/cli/test/ci/sandboxNpmCandidate.test.ts", owner: "references/adapters/package-publication.json", rationale: "Made a publication assertion whitespace-tolerant after formatter normalization changed the inspected source layout." },
  { path: "packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json", owner: "packages/cli/scripts/py_ts_parity.sh", rationale: "Re-pinned the Python parity commit to current origin/main; canonical owner evidence proves the old and target full source trees are identical." },
  { path: "packages/cli/test/config/formatterSurface.test.ts", owner: "packages/cli/vite.config.ts formatter contract", rationale: "Added clean/drift and protected-surface coverage for the selected formatter configuration." },
  { path: "packages/cli/vite.config.ts", owner: "packages/cli/vite.config.ts formatter contract", rationale: "Selected the complete maintained formatter surface and bounded width overrides needed for the monolith limit." },
  { path: "references/adapters/package-registry.yaml", owner: "references/adapters/package-registry.yaml", rationale: "Declared the extracted state modules as emitted producers required by package and runtime inventory ownership." },
];

const PROTECTED_PATTERNS = ["packages/cli/test/**/fixtures/**", "packages/cli/dist/**", "packages/cli/bundle/**", "**/*.generated.*"];
const PARITY_PATH = "packages/cli/test/cli/fixtures/oracle/parity-remaining-families.json";
const PARITY_AUTHORITY_FILES = [PARITY_PATH, "packages/cli/scripts/py_ts_parity.sh", "packages/cli/test/scripts/pyTsParity.test.ts", "packages/cli/test/cli/npmParityMatrix.test.ts"];

const CLOSEOUT_GATES = [
  { id: "monolith", command: ["pnpm", "-C", "packages/cli", "exec", "vp", "test", "run", "--config", "vite.config.ts", "test/lint/monolithLint.test.ts"] },
  { id: "parity", command: ["pnpm", "-C", "packages/cli", "exec", "vp", "test", "run", "--config", "vite.config.ts", "test/scripts/pyTsParity.test.ts", "test/cli/npmParityMatrix.test.ts"] },
  {
    id: "behavior",
    command: [
      "pnpm",
      "-C",
      "packages/cli",
      "exec",
      "vp",
      "test",
      "run",
      "--config",
      "vite.config.ts",
      "test/config/formatterSurface.test.ts",
      "test/state/entityMigrationPreview.test.ts",
      "test/state/entityMigrationPreviewCap.test.ts",
      "test/state/planEntities.test.ts",
      "test/state/todoDocsEntities.test.ts",
      "test/runtime/retiredRuntimeSurfacePolicy.test.ts",
    ],
  },
  { id: "typecheck", command: ["pnpm", "-C", "packages/cli", "run", "typecheck"] },
  { id: "build", command: ["pnpm", "-C", "packages/cli", "build"] },
  { id: "package", command: ["pnpm", "-C", "packages/cli", "run", "verify:package"] },
  { id: "source", command: ["pnpm", "-C", "packages/cli", "test"] },
  { id: "compact", command: ["node", "packages/cli/dist/bin/agentera.js", "check", "compact"] },
  { id: "capability", command: ["node", "packages/cli/dist/bin/agentera.js", "check", "validate", "capability-contract"] },
  { id: "retained", command: ["node", "packages/cli/dist/bin/agentera.js", "check", "validate", "retained-references"] },
  { id: "activation", command: ["node", "packages/cli/dist/bin/agentera.js", "check", "validate", "activation-conjunction"] },
];

function fail(message) {
  throw new Error(`formatter replay: ${message}`);
}

function manifestDigest(manifest) {
  const copy = structuredClone(manifest);
  delete copy.manifestSha256;
  return sha256(canonical(copy));
}

function changedPaths(baseCommit, normalizedCommit) {
  return gitText("diff", "--name-only", baseCommit, normalizedCommit).trim().split("\n").filter(Boolean);
}

function digestAt(commit, file) {
  const exists = spawnSync("git", ["cat-file", "-e", `${commit}:${file}`], { cwd: repo, stdio: "ignore" });
  return exists.status === 0 ? sha256(blob(commit, file)) : null;
}

function protectedPath(file) {
  return /(^|\/)(test\/.*\/fixtures|dist|bundle)(\/|$)|\.generated\./.test(file);
}

function parityOwnerEvidence() {
  const fixture = JSON.parse(fs.readFileSync(path.join(repo, PARITY_PATH), "utf8"));
  return {
    files: PARITY_AUTHORITY_FILES.map((file) => ({ path: file, sha256: sha256(fs.readFileSync(path.join(repo, file))) })),
    evidence: fixture.pinEvidence,
  };
}

function verifyParityOwner(manifest) {
  if (canonical(manifest.parityOwner.files.map(({ path: file }) => file)) !== canonical(PARITY_AUTHORITY_FILES)) fail("parity owner file inventory mismatch");
  for (const file of manifest.parityOwner.files) {
    if (sha256(fs.readFileSync(path.join(repo, file.path))) !== file.sha256) fail(`parity owner digest mismatch: ${file.path}`);
  }
  const fixture = JSON.parse(fs.readFileSync(path.join(repo, PARITY_PATH), "utf8"));
  if (canonical(fixture.pinEvidence) !== canonical(manifest.parityOwner.evidence)) fail("parity owner evidence mismatch");
  if (fixture.python_commit !== fixture.pinEvidence.target_python_commit) fail("parity target does not match the canonical fixture pin");
  if (Object.values(fixture.families).some((family) => family.python_commit !== fixture.python_commit)) fail("per-family parity target mismatch");
  const result = spawnSync("bash", [path.join(repo, "packages/cli/scripts/py_ts_parity.sh"), "--check", "--json"], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) fail(`parity owner replay failed\n${result.stdout}${result.stderr}`);
  const payload = JSON.parse(result.stdout.trim().split("\n").at(-1));
  const source = fixture.pinEvidence.sourceEquivalence;
  if (
    payload.drift !== "none" ||
    payload.pinned !== fixture.pinEvidence.target_python_commit ||
    payload.main !== fixture.pinEvidence.target_python_commit ||
    payload.owner_evidence?.previous !== fixture.pinEvidence.previous_python_commit ||
    payload.owner_evidence?.target !== fixture.pinEvidence.target_python_commit ||
    payload.owner_evidence?.source_equivalent !== true ||
    payload.owner_evidence?.previous_sha256 !== source.previousSha256 ||
    payload.owner_evidence?.target_sha256 !== source.targetSha256
  ) {
    fail("parity owner replay result mismatch");
  }
}

function verifyManifest(manifest) {
  if (manifest.schemaVersion !== "agentera.formatterNormalizationReplay.v2") fail("unsupported manifest schema");
  if (manifest.manifestSha256 !== manifestDigest(manifest)) fail("manifest digest mismatch");
  if (sha256(fs.readFileSync(fileURLToPath(import.meta.url))) !== manifest.replay.verifierSha256) fail("replay verifier digest mismatch");
  if (canonical(manifest.tools) !== canonical(TOOLS)) fail("tool inventory mismatch");
  if (canonical(manifest.closeout.gates) !== canonical(CLOSEOUT_GATES)) fail("closeout gate inventory mismatch");
  for (const commit of [manifest.source.baseCommit, manifest.source.normalizedCommit]) {
    if (gitText("rev-parse", `${commit}^{commit}`).trim() !== commit) fail(`source history mismatch for ${commit}`);
  }
  const changed = changedPaths(manifest.source.baseCommit, manifest.source.normalizedCommit);
  if (manifest.source.changedPathsSha256 !== sha256(canonical(changed))) fail("changed-source inventory mismatch");
  const configBytes = Buffer.from(manifest.formatter.config.bytes, "base64");
  if (sha256(configBytes) !== manifest.formatter.config.sha256) fail("formatter config digest mismatch");
  if (!configBytes.equals(blob(manifest.source.normalizedCommit, manifest.formatter.config.path))) fail("formatter config source mismatch");
  for (const input of manifest.inputs) {
    if (digestAt(manifest.source.baseCommit, input.path) !== input.baseSha256) fail(`base input digest mismatch: ${input.path}`);
    const actual = digestAt(manifest.source.normalizedCommit, input.path);
    if (actual !== input.sha256) fail(`input digest mismatch: ${input.path}`);
    if (input.outputSha256 !== actual) fail(`expected output digest mismatch: ${input.path}`);
  }
  const metadata = manifest.equivalence.authorizedSubstantive.map(({ path: file, owner, rationale }) => ({ path: file, owner, rationale }));
  if (canonical(metadata) !== canonical(SUBSTANTIVE_ALLOWLIST)) fail("substantive allowlist metadata mismatch");
  for (const entry of manifest.equivalence.authorizedSubstantive) {
    if (digestAt(manifest.source.baseCommit, entry.path) !== entry.baseSha256 || digestAt(manifest.source.normalizedCommit, entry.path) !== entry.normalizedSha256) fail(`substantive source digest mismatch: ${entry.path}`);
  }
  const declared = [...manifest.equivalence.formattingOnly, ...metadata.map(({ path: file }) => file)].sort();
  if (canonical(declared) !== canonical([...changed].sort())) fail("changed path is missing or stale in the equivalence classification");
  const equivalence = {
    method: manifest.equivalence.method,
    formattingOnly: manifest.equivalence.formattingOnly,
    authorizedSubstantive: manifest.equivalence.authorizedSubstantive,
  };
  if (manifest.equivalence.sha256 !== sha256(canonical(equivalence))) fail("equivalence digest mismatch");
  if (canonical(manifest.protectedPaths.patterns) !== canonical(PROTECTED_PATTERNS)) fail("protected pattern mismatch");
  const protectedChanged = changed.filter(protectedPath);
  if (canonical(protectedChanged) !== canonical([PARITY_PATH])) fail("protected path change mismatch");
  if (canonical(manifest.protectedPaths.authorized) !== canonical([{ path: PARITY_PATH, owner: "packages/cli/scripts/py_ts_parity.sh", evidence: "parityOwner" }])) fail("protected authorization mismatch");
  verifyParityOwner(manifest);
}

function installTools(root, manifest) {
  const home = path.join(root, "home");
  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_userconfig: path.join(home, ".npmrc"),
    npm_config_globalconfig: path.join(root, "global.npmrc"),
    npm_config_prefix: path.join(root, "npm-prefix"),
  };
  fs.mkdirSync(home, { recursive: true });
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
  const install = spawnSync("npm", ["install", "--prefix", path.join(root, "tools"), "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], { env, encoding: "utf8" });
  if (install.status !== 0) fail(`isolated tool installation failed\n${install.stdout}${install.stderr}`);
  for (const tool of manifest.tools) {
    const identity = JSON.parse(fs.readFileSync(path.join(root, "tools/node_modules", tool.name, "package.json"), "utf8"));
    if (identity.name !== tool.name || identity.version !== tool.version) fail(`installed tool identity mismatch: ${tool.name}`);
  }
  return env;
}

function sortedStructure(value) {
  if (Array.isArray(value)) return value.map(sortedStructure);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortedStructure(entry)]),
    );
  return value;
}

function markdownStructure(text) {
  return text.split("\n").map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return line;
    return trimmed
      .slice(1, -1)
      .split("|")
      .map((cell) => {
        const value = cell.trim();
        return /^:?-{3,}:?$/.test(value) ? value.replace(/-{3,}/, "-") : value;
      });
  });
}

async function classifyEquivalence(manifest, typescriptPath, yamlPath) {
  const importedTypeScript = await import(pathToFileURL(typescriptPath).href);
  const ts = importedTypeScript.default ?? importedTypeScript;
  const importedYaml = await import(pathToFileURL(yamlPath).href);
  const YAML = importedYaml.default ?? importedYaml;
  const textKinds = new Set([
    ts.SyntaxKind.Identifier,
    ts.SyntaxKind.PrivateIdentifier,
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NumericLiteral,
    ts.SyntaxKind.BigIntLiteral,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
  ]);
  const codeStructure = (bytes, file) => {
    const extension = path.extname(file);
    const kind = extension === ".tsx" ? ts.ScriptKind.TSX : extension === ".jsx" ? ts.ScriptKind.JSX : [".js", ".mjs", ".cjs"].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, bytes.toString("utf8"), ts.ScriptTarget.Latest, true, kind);
    if (source.parseDiagnostics.length > 0) fail(`could not parse source for structural comparison: ${file}`);
    const unwrap = (node) => {
      while (ts.isParenthesizedExpression(node) || node.kind === ts.SyntaxKind.ParenthesizedType) node = node.expression ?? node.type;
      return node;
    };
    const nullish = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken;
    const serialize = (rawNode) => {
      const node = unwrap(rawNode);
      if (nullish(node)) {
        const operands = [];
        const flatten = (rawOperand) => {
          const operand = unwrap(rawOperand);
          if (nullish(operand)) {
            flatten(operand.left);
            flatten(operand.right);
          } else {
            operands.push(serialize(operand));
          }
        };
        flatten(node);
        return ["associative-nullish-chain", operands];
      }
      const children = [];
      node.forEachChild((child) => {
        children.push(serialize(child));
      });
      return textKinds.has(node.kind) ? [node.kind, String(node.text), children] : [node.kind, children];
    };
    return JSON.stringify(serialize(source));
  };
  const structure = (bytes, file) => {
    const text = bytes.toString("utf8");
    if (file.endsWith(".json")) return canonical(sortedStructure(JSON.parse(text)));
    if (/\.(?:[cm]?[jt]sx?)$/.test(file)) return codeStructure(bytes, file);
    if (/\.ya?ml$/.test(file)) {
      const document = YAML.parseDocument(text, { prettyErrors: false, uniqueKeys: true });
      if (document.errors.length > 0) fail(`could not parse data for structural comparison: ${file}`);
      return canonical(sortedStructure(document.toJS()));
    }
    if (file.endsWith(".md")) return canonical(markdownStructure(text));
    return text;
  };
  const changed = changedPaths(manifest.source.baseCommit, manifest.source.normalizedCommit);
  const formatterSet = new Set(manifest.inputs.map(({ path: file }) => file));
  const formattingOnly = [];
  const substantive = [];
  for (const file of changed) {
    let equivalent = false;
    if (formatterSet.has(file)) {
      try {
        equivalent = structure(blob(manifest.source.baseCommit, file), file) === structure(blob(manifest.source.normalizedCommit, file), file);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("formatter replay:")) throw error;
      }
    }
    (equivalent ? formattingOnly : substantive).push(file);
  }
  return { formattingOnly, substantive };
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
    const tools = path.join(root, "tools/node_modules");
    const equivalence = await classifyEquivalence(manifest, path.join(tools, "@typescript/typescript6/lib/typescript.js"), path.join(tools, "yaml/dist/index.js"));
    if (canonical(equivalence.formattingOnly) !== canonical(manifest.equivalence.formattingOnly)) fail("formatting-only classification mismatch");
    if (canonical(equivalence.substantive) !== canonical(manifest.equivalence.authorizedSubstantive.map(({ path: file }) => file))) fail("undeclared or stale substantive path");
    fs.symlinkSync(tools, path.join(work, "node_modules"));
    fs.writeFileSync(path.join(work, manifest.formatter.config.path), Buffer.from(manifest.formatter.config.bytes, "base64"));
    const command = path.join(tools, ".bin/vp");
    const result = spawnSync(command, manifest.replay.argv, { cwd: work, env, encoding: "utf8", maxBuffer: 1024 * 1024 * 20 });
    if (result.status !== 0) fail(`formatter command failed\n${result.stdout}${result.stderr}`);
    for (const output of manifest.inputs) {
      const actual = sha256(fs.readFileSync(path.join(work, output.path)));
      if (actual !== output.outputSha256) fail(`replayed output mismatch: ${output.path}`);
    }
    return {
      command: [command, ...manifest.replay.argv],
      status: result.status,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function formatterInputs(commit) {
  const files = gitText("ls-tree", "-r", "--name-only", commit).trim().split("\n");
  const extensions = new Set([".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".mts", ".scss", ".ts", ".tsx", ".yaml", ".yml"]);
  return files.filter((file) => file.startsWith("packages/cli/") && extensions.has(path.extname(file)) && !file.includes("/dist/") && !file.includes("/bundle/") && !file.includes("/node_modules/") && !/\/test\/(?:.*\/)?fixtures\//.test(file) && !/\.generated\.[^.]+$/.test(file));
}

function workspaceDigest() {
  const files = gitBytes("ls-files", "--cached", "--others", "--exclude-standard", "-z").toString("utf8").split("\0").filter(Boolean).sort();
  const digest = createHash("sha256");
  for (const file of files) {
    const absolute = path.join(repo, file);
    const stat = fs.lstatSync(absolute);
    const body = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
    for (const field of [Buffer.from(file), Buffer.from(String(stat.mode & 0o777)), Buffer.from(stat.isSymbolicLink() ? "link" : "file"), body]) {
      digest.update(`${field.length}:`);
      digest.update(field);
    }
  }
  return digest.digest("hex");
}

async function makeManifest() {
  const baseCommit = gitText("rev-parse", "5cdee5b3^{commit}").trim();
  const normalizedCommit = gitText("rev-parse", "0afd2133^{commit}").trim();
  const configPath = "packages/cli/vite.config.ts";
  const config = blob(normalizedCommit, configPath);
  const inputs = formatterInputs(normalizedCommit).map((file) => {
    const digest = sha256(blob(normalizedCommit, file));
    return { path: file, baseSha256: digestAt(baseCommit, file), sha256: digest, outputSha256: digest };
  });
  const changed = changedPaths(baseCommit, normalizedCommit);
  const manifest = {
    schemaVersion: "agentera.formatterNormalizationReplay.v2",
    manifestSha256: "",
    source: { baseCommit, normalizedCommit, changedPathsSha256: sha256(canonical(changed)) },
    tools: TOOLS,
    formatter: { config: { path: configPath, bytes: config.toString("base64"), sha256: sha256(config) } },
    inputs,
    replay: {
      command: "node packages/cli/scripts/verify-formatter-normalization.mjs",
      fullCommand: "node packages/cli/scripts/verify-formatter-normalization.mjs --full",
      verifierSha256: sha256(fs.readFileSync(fileURLToPath(import.meta.url))),
      argv: ["fmt", "packages/cli", "--check", "--config", configPath],
    },
    parityOwner: parityOwnerEvidence(),
    equivalence: {
      method: "TypeScript/JavaScript AST structure with trivia and redundant parentheses removed and nullish-coalescing chains flattened associatively; parsed and key-sorted JSON/YAML; Markdown table-cell structure; every non-equivalent path requires an owner and rationale",
      formattingOnly: [],
      authorizedSubstantive: SUBSTANTIVE_ALLOWLIST.map((entry) => ({ ...entry, baseSha256: digestAt(baseCommit, entry.path), normalizedSha256: digestAt(normalizedCommit, entry.path) })),
      sha256: "",
    },
    protectedPaths: {
      patterns: PROTECTED_PATTERNS,
      authorized: [{ path: PARITY_PATH, owner: "packages/cli/scripts/py_ts_parity.sh", evidence: "parityOwner" }],
    },
    closeout: { gates: CLOSEOUT_GATES },
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentera-formatter-classify-"));
  try {
    installTools(root, manifest);
    const tools = path.join(root, "tools/node_modules");
    const classification = await classifyEquivalence(manifest, path.join(tools, "@typescript/typescript6/lib/typescript.js"), path.join(tools, "yaml/dist/index.js"));
    const allowed = manifest.equivalence.authorizedSubstantive.map(({ path: file }) => file);
    if (canonical(classification.substantive) !== canonical(allowed)) fail(`substantive allowlist mismatch\nactual: ${classification.substantive.join("\n")}`);
    manifest.equivalence.formattingOnly = classification.formattingOnly;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const { method, formattingOnly, authorizedSubstantive } = manifest.equivalence;
  manifest.equivalence.sha256 = sha256(canonical({ method, formattingOnly, authorizedSubstantive }));
  manifest.manifestSha256 = manifestDigest(manifest);
  return manifest;
}

function runCloseout(manifest, formatterResult, sourceSha256) {
  const gates = [];
  for (const gate of manifest.closeout.gates) {
    const [command, ...commandArgs] = gate.command;
    const result = spawnSync(command, commandArgs, { cwd: repo, encoding: "utf8", maxBuffer: 1024 * 1024 * 200 });
    if (result.error) fail(`${gate.id} gate could not start: ${result.error.message}`);
    const record = {
      id: gate.id,
      command: gate.command,
      status: result.status,
      signal: result.signal,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
    };
    gates.push(record);
    if (result.status !== 0) fail(`${gate.id} gate failed with status ${result.status}\n${result.stdout}${result.stderr}`);
  }
  const sourceAfterSha256 = workspaceDigest();
  if (sourceAfterSha256 !== sourceSha256) fail("closeout gates changed tracked or untracked source");
  const receipt = {
    schemaVersion: "agentera.formatterNormalizationCloseout.v1",
    manifestSha256: manifest.manifestSha256,
    sourceSha256,
    sourceAfterSha256,
    formatter: formatterResult,
    gates,
  };
  return { ...receipt, receiptSha256: sha256(canonical(receipt)) };
}

try {
  if (generate) {
    const manifest = await makeManifest();
    fs.writeFileSync(manifestPath, canonical(manifest));
    console.log(`wrote ${path.relative(repo, manifestPath)} ${manifest.manifestSha256}`);
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    verifyManifest(manifest);
    const sourceSha256 = workspaceDigest();
    const formatterResult = await runReplay(manifest);
    if (workspaceDigest() !== sourceSha256) fail("isolated replay changed tracked or untracked source");
    if (full) {
      console.log(JSON.stringify(runCloseout(manifest, formatterResult, sourceSha256)));
    } else {
      console.log(
        JSON.stringify({
          status: "pass",
          manifestSha256: manifest.manifestSha256,
          inputs: manifest.inputs.length,
          formattingOnly: manifest.equivalence.formattingOnly.length,
          authorizedSubstantive: manifest.equivalence.authorizedSubstantive.length,
          protectedUnchangedExceptOwnerAuthorizedParity: true,
          parityOwnerEvidence: manifest.parityOwner.evidence.sourceEquivalence.targetSha256,
          sourceUnchanged: true,
        }),
      );
    }
  }
} catch (error) {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
}
