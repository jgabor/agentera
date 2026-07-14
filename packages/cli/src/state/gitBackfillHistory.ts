import path from "node:path";

import type {
  GitCommandResult,
  GitCommandRunner,
  GitContext,
  HistoricalIssue,
  Occurrence,
  OccurrenceBase,
  ScanResult,
} from "./gitBackfill.js";

interface TreeEntry {
  blobId: string;
  path: string;
}

export interface GitBackfillHistoryCallbacks {
  projectionGitPath: (scan: ScanResult, gitRoot: string, artifactId: string) => string | undefined;
  displayPath: (projectRoot: string, gitRoot: string, gitPath: string) => string | undefined;
  parseTreeEntry: (stdout: string) => TreeEntry | undefined;
  occurrenceFromProjection: (
    bytes: string,
    occurrence: OccurrenceBase,
    artifactId: string,
    sourceRoot: string,
    targetIds: Set<string>,
    invalid: Map<string, HistoricalIssue[]>,
    add: (item: Occurrence) => void,
  ) => void;
  addGroup: (groups: ScanResult["groups"], occurrence: Occurrence) => void;
  markBounded: (scan: ScanResult, reason: string) => void;
  consumeHistoryWork: (scan: ScanResult) => boolean;
  chargeHistoryBytes: (scan: ScanResult, bytes: string) => boolean;
}

function successful(result: GitCommandResult): boolean {
  return result.status === 0 && !result.timedOut && !result.error;
}

function failureReason(result: GitCommandResult, fallback = "git_probe_error"): string {
  if (result.timedOut) return "git_probe_timeout";
  if (result.error || result.status === null) return "git_probe_error";
  return fallback;
}

function boundedGitRunner(scan: ScanResult, run: GitCommandRunner, callbacks: GitBackfillHistoryCallbacks): GitCommandRunner {
  return (args, cwd) => {
    const result = run(args, cwd);
    if (successful(result) && !callbacks.chargeHistoryBytes(scan, result.stdout)) {
      return { ...result, status: 1, error: "history_bytes" };
    }
    return result;
  };
}

function logPaths(chunk: string, fallback: string): string[] {
  const lines = chunk.split(/\r?\n/).filter((line) => line.length > 0);
  const paths: string[] = [];
  for (const line of lines.slice(1)) {
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    const status = fields[0] ?? "";
    const candidate = status.startsWith("R") || status.startsWith("C")
      ? fields[fields.length - 1]
      : fields[1];
    if (candidate && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths.length > 0 ? paths : [fallback];
}

function historyLog(
  run: GitCommandRunner,
  context: GitContext,
  gitPath: string,
  maxCommits: number,
): { commits: Array<{ commit: string; paths: string[] }>; bounded: boolean; reason?: string } {
  if (!context.root) return { commits: [], bounded: false, reason: context.reason ?? "git_unavailable" };
  const result = run(
    [
      "log",
      "--date-order",
      "--format=%H",
      "--name-status",
      `--max-count=${maxCommits}`,
      ...context.refs,
      "--",
      path.posix.dirname(gitPath),
    ],
    context.root,
  );
  if (!successful(result)) return { commits: [], bounded: false, reason: failureReason(result) };
  const commits: Array<{ commit: string; paths: string[] }> = [];
  const seen = new Set<string>();
  let currentCommit: string | undefined;
  let currentLines: string[] = [];
  const flush = (): void => {
    if (!currentCommit || seen.has(currentCommit)) return;
    seen.add(currentCommit);
    commits.push({ commit: currentCommit, paths: logPaths([currentCommit, ...currentLines].join("\n"), gitPath) });
  };
  for (const line of result.stdout.split(/\r?\n/)) {
    const value = line.trim();
    if (/^[0-9a-f]{40,64}$/.test(value)) {
      flush();
      currentCommit = value;
      currentLines = [];
    } else if (currentCommit) {
      currentLines.push(line);
    }
  }
  flush();
  return { commits: commits.slice(0, maxCommits), bounded: commits.length >= maxCommits };
}

function projectionPathFamily(gitPath: string, candidate: string): boolean {
  const directory = path.posix.dirname(gitPath);
  const stem = path.posix.basename(gitPath, ".yaml");
  const normalized = path.posix.normalize(candidate);
  return (
    candidate !== "" &&
    candidate === normalized &&
    !path.posix.isAbsolute(candidate) &&
    !candidate.split("/").includes("..") &&
    path.posix.dirname(candidate) === directory &&
    path.posix.basename(candidate).startsWith(`${stem}`) &&
    candidate.endsWith(".yaml")
  );
}

function changedProjectionPaths(
  run: GitCommandRunner,
  root: string,
  commit: string,
  gitPath: string,
): string[] {
  const result = run(["diff-tree", "--root", "-r", "-M", "--name-status", commit], root);
  if (!successful(result)) return [];
  const paths: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = line.split("\t");
    if (fields.length < 2) continue;
    const status = fields[0] ?? "";
    const candidates = status.startsWith("R") || status.startsWith("C")
      ? fields.slice(1)
      : [fields[1]];
    for (const candidate of candidates) {
      if (candidate && projectionPathFamily(gitPath, candidate) && !paths.includes(candidate)) paths.push(candidate);
    }
  }
  return paths;
}

function projectionPathsAtCommit(
  run: GitCommandRunner,
  root: string,
  commit: string,
  gitPath: string,
  parseTreeEntry: (stdout: string) => TreeEntry | undefined,
): string[] {
  const result = run(["ls-tree", "-r", "-z", commit, "--", path.posix.dirname(gitPath)], root);
  if (!successful(result)) return [];
  const paths: string[] = [];
  for (const item of result.stdout.split("\0")) {
    if (!item) continue;
    const entry = parseTreeEntry(item);
    if (entry && projectionPathFamily(gitPath, entry.path) && !paths.includes(entry.path)) paths.push(entry.path);
  }
  return paths;
}

function collectReachable(
  scan: ScanResult,
  run: GitCommandRunner,
  context: GitContext,
  callbacks: GitBackfillHistoryCallbacks,
): void {
  if (!context.root) return;
  const historicalRun = boundedGitRunner(scan, run, callbacks);
  const targetIds = new Set(scan.targets.keys());
  const artifactPaths = scan.contract.supportedArtifacts.map((artifactId) => ({
    artifactId,
    gitPath: callbacks.projectionGitPath(scan, context.root as string, artifactId),
  }));
  const seenOccurrences = new Set<string>();
  for (const item of artifactPaths) {
    if (!item.gitPath) {
      scan.diagnostics.push(`${item.artifactId} projection is outside the selected Git project`);
      continue;
    }
    const remainingCommits = scan.contract.maximumCommits - scan.historyWork;
    if (remainingCommits <= 0) {
      callbacks.markBounded(scan, "commit_count");
      break;
    }
    const log = historyLog(historicalRun, context, item.gitPath, remainingCommits);
    if (log.reason) {
      if (scan.boundedReasons.includes("history_bytes")) return;
      scan.diagnostics.push(`${item.artifactId} history scan failed: ${log.reason}`);
      continue;
    }
    if (log.bounded) callbacks.markBounded(scan, "commit_count");
    for (const commit of log.commits) {
      if (!callbacks.consumeHistoryWork(scan)) {
        callbacks.markBounded(scan, "commit_count");
        break;
      }
      scan.reachableCommits.add(commit.commit);
      const paths = [...new Set([
        ...commit.paths,
        ...changedProjectionPaths(historicalRun, context.root, commit.commit, item.gitPath),
        ...projectionPathsAtCommit(historicalRun, context.root, commit.commit, item.gitPath, callbacks.parseTreeEntry),
      ])].filter((candidate) => projectionPathFamily(item.gitPath as string, candidate));
      for (const gitPath of paths) {
        const tree = historicalRun(["ls-tree", "-r", "-z", commit.commit, "--", gitPath], context.root);
        if (!successful(tree)) {
          if (scan.boundedReasons.includes("history_bytes")) return;
          scan.diagnostics.push(`cannot inspect ${commit.commit}:${gitPath}: ${failureReason(tree)}`);
          continue;
        }
        const treeEntry = callbacks.parseTreeEntry(tree.stdout);
        if (!treeEntry) continue;
        const display = callbacks.displayPath(scan.projectRoot, context.root, treeEntry.path);
        if (!display) continue;
        const occurrenceKey = `${commit.commit}:${display}:${treeEntry.blobId}:${item.artifactId}`;
        if (seenOccurrences.has(occurrenceKey)) continue;
        seenOccurrences.add(occurrenceKey);
        const content = historicalRun(["cat-file", "-p", treeEntry.blobId], context.root);
        if (!successful(content)) {
          if (scan.boundedReasons.includes("history_bytes")) return;
          scan.diagnostics.push(`cannot read ${commit.commit}:${treeEntry.path}: ${failureReason(content)}`);
          continue;
        }
        callbacks.occurrenceFromProjection(
          content.stdout,
          {
            commit: commit.commit,
            path: display,
            gitPath: treeEntry.path,
            blobId: treeEntry.blobId,
            reachable: true,
          },
          item.artifactId,
          scan.sourceRoot,
          targetIds,
          scan.invalid,
          (occurrence) => callbacks.addGroup(scan.groups, occurrence),
        );
      }
      if (scan.boundedReasons.includes("history_bytes")) break;
    }
    if (scan.boundedReasons.includes("history_bytes")) break;
  }
}

function collectRewritten(
  scan: ScanResult,
  run: GitCommandRunner,
  context: GitContext,
  callbacks: GitBackfillHistoryCallbacks,
): void {
  if (!context.root || scan.targets.size === 0) return;
  const historicalRun = boundedGitRunner(scan, run, callbacks);
  const remainingCommits = scan.contract.maximumCommits - scan.historyWork;
  if (remainingCommits <= 0) {
    callbacks.markBounded(scan, "commit_count");
    return;
  }
  const reflog = historicalRun(
    ["reflog", "show", "--format=%H", "--max-count", String(remainingCommits), "HEAD"],
    context.root,
  );
  if (!successful(reflog) || scan.boundedReasons.includes("history_bytes")) return;
  const targetIds = new Set(scan.targets.keys());
  const paths = scan.contract.supportedArtifacts.map((artifactId) => ({
    artifactId,
    gitPath: callbacks.projectionGitPath(scan, context.root as string, artifactId),
  }));
  const commits = reflog.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value) => /^[0-9a-f]{40,64}$/.test(value));
  if (commits.length >= remainingCommits) callbacks.markBounded(scan, "commit_count");
  for (const commit of commits) {
    if (!/^[0-9a-f]{40,64}$/.test(commit) || scan.reachableCommits.has(commit)) continue;
    if (!callbacks.consumeHistoryWork(scan)) return;
    for (const item of paths) {
      if (!item.gitPath) continue;
      const historicalPaths = [...new Set([
        ...changedProjectionPaths(historicalRun, context.root, commit, item.gitPath),
        ...projectionPathsAtCommit(historicalRun, context.root, commit, item.gitPath, callbacks.parseTreeEntry),
      ])];
      for (const gitPath of historicalPaths) {
        const tree = historicalRun(["ls-tree", "-r", "-z", commit, "--", gitPath], context.root);
        if (!successful(tree)) {
          if (scan.boundedReasons.includes("history_bytes")) return;
          continue;
        }
        const treeEntry = callbacks.parseTreeEntry(tree.stdout);
        if (!treeEntry) continue;
        const display = callbacks.displayPath(scan.projectRoot, context.root, treeEntry.path);
        if (!display) continue;
        const content = historicalRun(["cat-file", "-p", treeEntry.blobId], context.root);
        if (!successful(content)) return;
        callbacks.occurrenceFromProjection(
          content.stdout,
          {
            commit,
            path: display,
            gitPath: treeEntry.path,
            blobId: treeEntry.blobId,
            reachable: false,
          },
          item.artifactId,
          scan.sourceRoot,
          targetIds,
          scan.invalid,
          (occurrence) => {
            const values = scan.rewritten.get(occurrence.entryId) ?? [];
            if (!values.some((value) => value.commit === occurrence.commit && value.contentHash === occurrence.contentHash)) {
              values.push(occurrence);
            }
            scan.rewritten.set(occurrence.entryId, values);
          },
        );
      }
    }
    if (scan.historyWork >= scan.contract.maximumCommits) {
      callbacks.markBounded(scan, "commit_count");
      return;
    }
  }
}

export function collectGitHistory(
  scan: ScanResult,
  run: GitCommandRunner,
  context: GitContext,
  callbacks: GitBackfillHistoryCallbacks,
): void {
  collectReachable(scan, run, context, callbacks);
  collectRewritten(scan, run, context, callbacks);
}
