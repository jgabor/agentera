import fs from "node:fs";
import path from "node:path";

// Observations, never verdicts. Omit titles, argv, env values and child content.
const fileLabel = "(?:source-setup|packages/cli/test/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\\.test\\.ts)";
export const sourceDiagnosticPattern = new RegExp(
  `^AGENTERA_SOURCE_DIAGNOSTIC file=(${fileLabel}) phase=(barrier-start|barrier-end|compile-start|compile-end|queued|collected|execution-start|execution-end|case-start|case-end|fixture-ready|native-start|native-child-start|native-end) index=(\\d{1,6}) elapsedMs=(\\d{1,10}) durationMs=(\\d{1,10}) status=(observed|passed|failed|skipped|unknown)$`,
);

export function writeSourceDiagnostic({ file, phase, index = 0, elapsedMs = 0, durationMs = 0, status = "observed" }, { fd = 2, environment = process.env } = {}) {
  if (environment.AGENTERA_SOURCE_DIAGNOSTICS !== "1") return;
  const line = `AGENTERA_SOURCE_DIAGNOSTIC file=${file} phase=${phase} index=${index} elapsedMs=${Math.max(0, Math.round(elapsedMs))} durationMs=${Math.max(0, Math.round(durationMs))} status=${status}`;
  if (!sourceDiagnosticPattern.test(line)) return;
  // Synchronous writes survive interruption without reporter flush or finally.
  // Diagnostic errors never replace the authoritative test/gate result.
  try {
    if (environment.AGENTERA_SOURCE_DIAGNOSTIC_OUTPUT)
      fs.appendFileSync(environment.AGENTERA_SOURCE_DIAGNOSTIC_OUTPUT, `${line}\n`, {
        mode: 0o600,
      });
  } catch {
    /* best effort */
  }
  try {
    fs.writeSync(fd, `${line}\n`);
  } catch {
    /* best effort */
  }
}

export function startNativeDiagnostic(file, index) {
  const started = Date.now();
  const emit = (phase, status = "observed") =>
    writeSourceDiagnostic({
      file,
      phase,
      index,
      elapsedMs: Date.now() - started,
      durationMs: Date.now() - started,
      status,
    });
  emit("native-start");
  return {
    started,
    complete(result) {
      emit("native-end", result.error || result.status !== 0 ? "failed" : "passed");
    },
  };
}

export default class SourceDiagnosticReporter {
  constructor({ environment = process.env, now = () => performance.now() } = {}) {
    this.environment = environment;
    this.now = now;
    this.started = now();
    this.modules = new Map();
    this.cases = new Map();
    try {
      const root = environment.AGENTERA_SOURCE_DIAGNOSTIC_ROOT;
      const files = JSON.parse(environment.AGENTERA_SOURCE_DIAGNOSTIC_FILES ?? "[]");
      this.files = new Map(files.filter((file) => typeof file === "string" && sourceDiagnosticPattern.test(`AGENTERA_SOURCE_DIAGNOSTIC file=${file} phase=queued index=0 elapsedMs=0 durationMs=0 status=observed`)).map((file) => [path.resolve(root, file), file]));
    } catch {
      this.files = new Map();
    }
    this.offset = 0;
    this.pending = "";
    this.allowedFiles = new Set(this.files.values());
  }
  onInit() {
    if (this.environment.AGENTERA_SOURCE_DIAGNOSTICS !== "1" || !this.environment.AGENTERA_SOURCE_DIAGNOSTIC_OUTPUT) return;
    // The native task runner does not relay the fixture child's extra descriptor.
    // Its append-only record is already durable; relay only child starts from
    // that file. Helper start/end records already reach the normal worker pipe.
    this.interval = setInterval(() => this.forwardNative(), 500);
    this.interval.unref?.();
  }
  forwardNative() {
    let fd;
    try {
      fd = fs.openSync(this.environment.AGENTERA_SOURCE_DIAGNOSTIC_OUTPUT, "r");
      const bytes = Buffer.alloc(64 * 1024);
      let remaining = Math.min(Math.max(0, fs.fstatSync(fd).size - this.offset), 2 * 1024 * 1024);
      while (remaining > 0) {
        const count = fs.readSync(fd, bytes, 0, Math.min(bytes.length, remaining), this.offset);
        if (!count) break;
        this.offset += count;
        remaining -= count;
        for (const part of bytes
          .subarray(0, count)
          .toString("utf8")
          .split(/(?<=\n)/)) {
          this.pending += part;
          if (!part.endsWith("\n")) continue;
          const match = this.pending.length <= 512 && sourceDiagnosticPattern.exec(this.pending.trimEnd());
          if (match && match[2] === "native-child-start" && this.allowedFiles.has(match[1])) {
            try {
              fs.writeSync(2, `${match[0]}\n`);
            } catch {
              /* best effort */
            }
          }
          this.pending = "";
        }
        // A partial oversized record cannot grow unbounded or expose its tail.
        if (this.pending.length > 512) this.pending = "invalid ";
      }
    } catch {
      /* Missing/unwritable diagnostics never change a verdict. */
    } finally {
      if (fd !== undefined)
        try {
          fs.closeSync(fd);
        } catch {
          /* best effort */
        }
    }
  }
  onTestRunEnd() {
    clearInterval(this.interval);
    this.forwardNative();
  }
  emit(module, phase, index = 0, durationMs = 0, status = "observed") {
    const file = this.files.get(module?.moduleId);
    if (file) writeSourceDiagnostic({ file, phase, index, elapsedMs: this.now() - this.started, durationMs, status }, { environment: this.environment });
  }
  onTestModuleQueued(module) {
    this.modules.set(module.moduleId, { started: this.now(), index: 0 });
    this.emit(module, "queued");
  }
  onTestModuleCollected(module) {
    this.emit(module, "collected", 0, this.now() - (this.modules.get(module.moduleId)?.started ?? this.now()));
  }
  onTestModuleStart(module) {
    const state = this.modules.get(module.moduleId);
    if (state) state.execution = this.now();
    this.emit(module, "execution-start");
  }
  onTestModuleEnd(module) {
    this.emit(module, "execution-end", 0, this.now() - (this.modules.get(module.moduleId)?.execution ?? this.now()));
  }
  onTestCaseReady(test) {
    const state = this.modules.get(test.module.moduleId);
    if (!state) return;
    const index = ++state.index;
    this.cases.set(test.id, { index, started: this.now() });
    this.emit(test.module, "case-start", index);
  }
  onTestCaseResult(test) {
    const state = this.cases.get(test.id);
    if (!state) return;
    const status = test.result().state;
    // Callbacks can arrive in a batch after a synchronous worker call. Use the
    // worker's measured duration, not time between callback arrivals.
    this.emit(test.module, "case-end", state.index, test.diagnostic()?.duration ?? this.now() - state.started, ["passed", "failed", "skipped"].includes(status) ? status : "unknown");
    this.cases.delete(test.id);
  }
}
