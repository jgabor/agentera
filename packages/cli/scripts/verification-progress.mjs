import { sourceDiagnosticPattern } from "./source-diagnostics.mjs";

// Diagnostic progress only, never verification evidence. The closed grammar
// allows fixed labels and inventory-relative test identity, but excludes absolute
// paths, command arguments, environment values and arbitrary child logs. This is
// a diagnostic filter, not a security boundary against a hostile child process.
const owners = {
  overlap: ["source", "build", "package", "invocation"],
  qualification: ["generated-overlap", "stress", "typecheck", "certification", "performance", "capacity", "compact", "capability-contract", "activation-conjunction"],
};
const statuses = new Set(["started", "running", "passed", "failed", "cancelled"]);
const linePattern = /^AGENTERA_VERIFICATION_PROGRESS scope=(overlap|qualification) owner=([a-z-]+) status=([a-z]+) elapsedMs=(\d{1,10})$/;
const writeStderr = (line) => process.stderr.write(line);

export function createVerificationProgress(scope, owner, { write = writeStderr, now = () => performance.now() } = {}) {
  if (!owners[scope]?.includes(owner)) throw new Error("unknown verification progress owner");
  const started = now();
  let finished = false;
  const emit = (status) => write(`AGENTERA_VERIFICATION_PROGRESS scope=${scope} owner=${owner} status=${status} elapsedMs=${Math.max(0, Math.round(now() - started))}\n`);
  emit("started");
  const interval = setInterval(() => emit("running"), 30_000);
  interval.unref?.();
  return {
    complete(status) {
      if (finished) return;
      if (!statuses.has(status) || status === "started" || status === "running") throw new Error("invalid verification completion status");
      finished = true;
      clearInterval(interval);
      emit(status);
    },
  };
}

export function createOverlapProgressForwarder(write = writeStderr, { sourceOnly = false } = {}) {
  let pending = "";
  let oversized = false;
  return {
    feed(chunk) {
      for (const part of String(chunk).split(/(?<=\n)/)) {
        pending += part;
        if (pending.length > 512) {
          pending = "";
          oversized = true;
        }
        if (!part.endsWith("\n")) continue;
        const match = !oversized && linePattern.exec(pending.trimEnd());
        const source = !oversized && sourceDiagnosticPattern.exec(pending.trimEnd());
        try {
          if (source) write(`${source[0]}\n`);
          else if (!sourceOnly && match && match[1] === "overlap" && owners.overlap.includes(match[2]) && statuses.has(match[3])) write(`${match[0]}\n`);
        } catch {
          /* Diagnostic sinks never change the gate verdict. */
        }
        pending = "";
        oversized = false;
      }
    },
  };
}
