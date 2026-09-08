// Diagnostic checkpoints only: never performance evidence. Labels are closed to
// keep child-controlled output (paths, credentials, reporter text) out of summaries.
const phase = "(?:none|fixture_(?:small|large)|validation_(?:small|large)|archive_fixture_(?:small|large)|(?:startup|bounded_list|archive_list)_(?:small|large)_[1-5]|exact_get_large_[1-5]|evidence)";
const checkpoint = new RegExp(`^AGENTERA_PERFORMANCE_PROGRESS last=(${phase}) inFlight=(${phase}) elapsedMs=(\\d{1,10}) clock=entity-performance/performance\\.now$`);

export function createPerformanceProgress(write = (line) => process.stdout.write(line)) {
  const started = performance.now();
  let last = "none";
  let inFlight = "none";
  const emit = () => write(`AGENTERA_PERFORMANCE_PROGRESS last=${last} inFlight=${inFlight} elapsedMs=${Math.round(performance.now() - started)} clock=entity-performance/performance.now\n`);
  return {
    start(label) {
      inFlight = label;
      emit();
    },
    complete() {
      last = inFlight;
      inFlight = "none";
      emit();
    },
  };
}

export function createPerformanceProgressReader() {
  let latest;
  let timeout;
  let frozen = false;
  const streams = new Map();
  return {
    feed(chunk, channel = "stdout") {
      let { pending = "", oversized = false } = streams.get(channel) ?? {};
      for (const part of String(chunk).split(/(?<=\n)/)) {
        pending += part;
        if (pending.length > 512) {
          oversized = true;
          pending = "";
        }
        if (part.endsWith("\n")) {
          if (!oversized && /Test timed out in \d+ms/.test(pending)) timeout ??= "performance test deadline exceeded";
          if (!oversized && pending.includes("cold CLI did not complete serialized output")) timeout ??= "cold sample deadline exceeded";
          const match = channel === "stdout" && !oversized && checkpoint.exec(pending.trimEnd());
          if (match && !timeout && !frozen && (!latest || Number(match[3]) >= latest.elapsedMs)) {
            latest = { last: match[1], inFlight: match[2], elapsedMs: Number(match[3]) };
          }
          pending = "";
          oversized = false;
        }
      }
      streams.set(channel, { pending, oversized });
    },
    get timeout() {
      return timeout;
    },
    freeze() {
      frozen = true;
    },
    summary(elapsedMs, clock) {
      return `performance diagnostic: last-completed=${latest?.last ?? "unobserved"}; work-in-flight=${latest?.inFlight ?? "unobserved"}; checkpoint elapsedMs=${latest?.elapsedMs ?? "unobserved"} clock=entity-performance/performance.now; owner elapsedMs=${elapsedMs} clock=${clock}`;
    },
  };
}
