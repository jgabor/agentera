import fs from "node:fs";
import path from "node:path";

import { parseToml } from "../../core/toml.js";
import { pathExists } from "../../core/paths.js";
import { DEFAULT_CONFIG_PATH, InstallRootError, resolveInstallRoot } from "./installRoot.js";
import { planAgentDescriptorChanges, writeAgentDescriptorChanges, defaultAgentsDirForConfig } from "./agents.js";
import { planChange } from "./state.js";

type Env = Record<string, string | undefined>;

function readTextOrNull(p: string): string | null {
  if (!pathExists(p)) return null;
  return fs.readFileSync(p, "utf8");
}

export interface CodexCliIo {
  /** Raw stdout sink; receives exact strings (including any newlines). */
  out?: (text: string) => void;
  /** Raw stderr sink; receives exact strings (including any newlines). */
  err?: (text: string) => void;
  env?: Env;
}

export function codexMain(argv: string[] = [], io: CodexCliIo = {}): number {
  const writeOut = io.out ?? ((text: string) => process.stdout.write(text));
  const writeErr = io.err ?? ((text: string) => process.stderr.write(text));
  const out = (line: string) => writeOut(line + "\n");
  const err = (line: string) => writeErr(line + "\n");
  const env = io.env ?? process.env;

  const args = {
    installRoot: null as string | null,
    configFile: DEFAULT_CONFIG_PATH,
    agentsDir: null as string | null,
    dryRun: false,
    force: false,
    enableAgents: false,
  };

  const valueFlag = (a: string, name: string): string | null => {
    if (a === name) return "__NEXT__";
    if (a.startsWith(name + "=")) return a.slice(name.length + 1);
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let v: string | null;
    if ((v = valueFlag(a, "--install-root")) !== null) {
      args.installRoot = v === "__NEXT__" ? argv[++i] : v;
    } else if ((v = valueFlag(a, "--config-file")) !== null) {
      args.configFile = v === "__NEXT__" ? argv[++i] : v;
    } else if ((v = valueFlag(a, "--agents-dir")) !== null) {
      args.agentsDir = v === "__NEXT__" ? argv[++i] : v;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--force") {
      args.force = true;
    } else if (a === "--enable-agents") {
      args.enableAgents = true;
    } else {
      err(`setup_codex: error: unrecognized arguments: ${a}`);
      return 2;
    }
  }

  // Step 1: resolve and verify the Agentera directory.
  let installRoot: string;
  try {
    installRoot = resolveInstallRoot(args.installRoot, env);
  } catch (errx) {
    if (errx instanceof InstallRootError) {
      err(errx.message);
      return 2;
    }
    throw errx;
  }

  // Step 2: read current config (None if absent).
  const configPath = args.configFile;
  let currentText: string | null;
  try {
    currentText = readTextOrNull(configPath);
  } catch (errx) {
    err(`error reading ${configPath}: ${(errx as Error).message}`);
    return 2;
  }

  // Step 3: parse-check existing content.
  if (currentText !== null && currentText.trim()) {
    try {
      parseToml(currentText);
    } catch (errx) {
      err(
        `error: ${configPath} is not valid TOML (${(errx as Error).message}). ` +
          "Repair it manually before running this helper.",
      );
      return 2;
    }
  }

  // Step 4: plan the AGENTERA_HOME change and runtime-native descriptors.
  const outcome = planChange(currentText, installRoot, { force: args.force });
  let agentsDir: string;
  try {
    agentsDir = args.agentsDir ?? defaultAgentsDirForConfig(configPath);
  } catch (errx) {
    err(`error: ${(errx as Error).message}`);
    return 2;
  }
  const descriptorChanges = planAgentDescriptorChanges(installRoot, agentsDir, { force: args.force });
  const pendingDescriptors = descriptorChanges.filter((c) => c.action === "pending");
  const blockedDescriptors = descriptorChanges.filter((c) => c.action === "blocked");

  if (args.enableAgents) {
    err(
      "--enable-agents is deprecated in Agentera v2; no [agents.*] " +
        "blocks will be written; runtime-native descriptor files are managed separately.",
    );
  }

  // Step 5: dispatch on the outcome.
  if (outcome.action === "conflict") {
    err(outcome.message);
    if (outcome.diff) err(outcome.diff);
    return 2;
  }

  if (blockedDescriptors.length > 0) {
    for (const change of blockedDescriptors) {
      err(`error: ${change.target}: ${change.message}`);
    }
    return 2;
  }

  if (outcome.action === "noop" && pendingDescriptors.length === 0) {
    out(outcome.message);
    return 0;
  }

  if (args.dryRun) {
    out(outcome.message);
    if (outcome.diff) {
      writeOut(outcome.diff);
      if (!outcome.diff.endsWith("\n")) out("");
    }
    for (const change of pendingDescriptors) {
      out(`${change.message}: ${change.target}`);
    }
    return 1;
  }

  try {
    if (outcome.action !== "noop") {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, outcome.newText, "utf8");
    }
    writeAgentDescriptorChanges(pendingDescriptors);
  } catch (errx) {
    err(`error writing Codex setup targets: ${(errx as Error).message}`);
    return 2;
  }

  if (outcome.action !== "noop") {
    out(`wrote ${configPath}: ${outcome.message.replaceAll("would ", "")}`);
  } else {
    out(outcome.message);
  }
  for (const change of pendingDescriptors) {
    out(`wrote ${change.target}: ${change.message.replaceAll("would ", "")}`);
  }
  return 0;
}
