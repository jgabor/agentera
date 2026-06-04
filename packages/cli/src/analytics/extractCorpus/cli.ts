import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { pyJsonIndent } from "../../core/pyjson.js";
import {
  type Dict,
  type Env,
  defaultOutputPath,
} from "./core.js";
import { buildCorpus } from "./corpus.js";
import {
  resolveCopilotStorePath,
  resolveCursorChatsPath,
  resolveCursorProjectsPath,
  resolveOpencodeDbPath,
} from "./cursorSessions.js";

export interface ExtractArgs {
  output: string;
  projectRoot: string[];
  codexSessionsDir: string;
  claudeProjectsDir: string;
  opencodeConversationsDir: string | null;
  copilotConversationsDir: string | null;
  cursorProjectsDir: string | null;
  cursorChatsDir: string | null;
  noCodex: boolean;
  noClaude: boolean;
  noOpencode: boolean;
  noCopilot: boolean;
  noCursor: boolean;
}

export function parseExtractArgs(argv: string[], env: Env = process.env, platform: NodeJS.Platform = process.platform): ExtractArgs {
  const home = os.homedir();
  const args: ExtractArgs = {
    output: defaultOutputPath(env, platform),
    projectRoot: [],
    codexSessionsDir: path.join(home, ".codex", "sessions"),
    claudeProjectsDir: path.join(home, ".claude", "projects"),
    opencodeConversationsDir: null,
    copilotConversationsDir: null,
    cursorProjectsDir: null,
    cursorChatsDir: null,
    noCodex: false,
    noClaude: false,
    noOpencode: false,
    noCopilot: false,
    noCursor: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = (name: string): string | null => {
      if (a === name) return argv[++i] ?? null;
      if (a.startsWith(name + "=")) return a.slice(name.length + 1);
      return null;
    };
    let v: string | null;
    if ((v = val("--output")) !== null) args.output = v;
    else if ((v = val("--project-root")) !== null) args.projectRoot.push(v);
    else if ((v = val("--codex-sessions-dir")) !== null) args.codexSessionsDir = v;
    else if ((v = val("--claude-projects-dir")) !== null) args.claudeProjectsDir = v;
    else if ((v = val("--opencode-conversations-dir")) !== null) args.opencodeConversationsDir = v;
    else if ((v = val("--copilot-conversations-dir")) !== null) args.copilotConversationsDir = v;
    else if ((v = val("--cursor-projects-dir")) !== null) args.cursorProjectsDir = v;
    else if ((v = val("--cursor-chats-dir")) !== null) args.cursorChatsDir = v;
    else if (a === "--no-codex") args.noCodex = true;
    else if (a === "--no-claude") args.noClaude = true;
    else if (a === "--no-opencode") args.noOpencode = true;
    else if (a === "--no-copilot") args.noCopilot = true;
    else if (a === "--no-cursor") args.noCursor = true;
    else throw new Error(`extract-corpus: unrecognized argument: ${a}`);
  }
  return args;
}

export interface ExtractMainIo {
  out?: (text: string) => void;
  err?: (text: string) => void;
  env?: Env;
  platform?: NodeJS.Platform;
  cwd?: string;
}

/** Engine entry point mirroring scripts/extract_corpus.py main(). */
export function extractCorpusMain(argv: string[], io: ExtractMainIo = {}): number {
  const out = io.out ?? ((t: string) => process.stdout.write(t + "\n"));
  const err = io.err ?? ((t: string) => process.stderr.write(t + "\n"));
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const cwd = io.cwd ?? process.cwd();
  let args: ExtractArgs;
  try {
    args = parseExtractArgs(argv, env, platform);
  } catch (exc) {
    err((exc as Error).message);
    return 2;
  }
  const projectRoots = args.projectRoot.length > 0 ? args.projectRoot : [cwd];
  const skipCursor = args.noCursor;
  const corpus = buildCorpus({
    projectRoots,
    codexSessionsDir: args.noCodex ? null : args.codexSessionsDir,
    claudeProjectsDir: args.noClaude ? null : args.claudeProjectsDir,
    opencodeConversationsDir: args.noOpencode ? null : args.opencodeConversationsDir || resolveOpencodeDbPath(env),
    copilotConversationsDir: args.noCopilot ? null : args.copilotConversationsDir || resolveCopilotStorePath(env),
    cursorProjectsDir: skipCursor ? null : args.cursorProjectsDir || resolveCursorProjectsPath(env),
    cursorChatsDir: skipCursor ? null : args.cursorChatsDir || resolveCursorChatsPath(env),
  });
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, pyJsonIndent(corpus) + "\n", "utf-8");
  const total = corpus.metadata.total_records;
  const familyBits = Object.entries(corpus.metadata.families)
    .map(([name, summary]) => `${name}=${(summary as Dict).count}`)
    .join(", ");
  out(`wrote corpus: ${args.output} (${total} records; ${familyBits})`);
  return 0;
}
