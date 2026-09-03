import { spawn, type ChildProcess } from "node:child_process";

export interface ColdProcessCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface ColdProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface ColdProcessOutcome {
  pid: number | null;
  status: number | null;
  signal: NodeJS.Signals | null;
  aborted: boolean;
  timedOut: boolean;
}

export interface ColdProcessSchedulerSnapshot {
  aborted: boolean;
  active: number;
  slots: number;
  waiters: number;
  timers: number;
  started: number;
  outcomes: ColdProcessOutcome[];
}

export interface ColdProcessScope {
  run(command: ColdProcessCommand): Promise<ColdProcessResult>;
  all<T>(promises: Iterable<PromiseLike<T> | T>): Promise<T[]>;
}

interface QueuedCommand {
  id: number;
  command: ColdProcessCommand;
  resolve: (result: ColdProcessResult) => void;
  reject: (error: Error) => void;
}

interface ActiveCommand {
  job: QueuedCommand;
  child: ChildProcess;
  commandTimer: NodeJS.Timeout;
  forceTimer?: NodeJS.Timeout;
  stdout: string;
  stderr: string;
  spawnError: string;
  timedOut: boolean;
  settled: boolean;
}

export interface ColdProcessSchedulerOptions {
  concurrency?: number;
  timeoutMs?: number;
  abortGraceMs?: number;
}

export class ColdProcessAbortedError extends Error {
  constructor(readonly cause: unknown) {
    super(`cold process scheduler aborted: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ColdProcessAbortedError";
  }
}

/**
 * Own every queued command, child close event, and timer inside one test scope.
 * Children stay in the participant process group so an outer qualification
 * cancellation reaches them directly on POSIX hosts.
 */
export class ColdProcessScheduler {
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly abortGraceMs: number;
  private readonly queued: QueuedCommand[] = [];
  private readonly active = new Map<number, ActiveCommand>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly outcomes: ColdProcessOutcome[] = [];
  private abortReason: unknown | undefined;
  private nextId = 1;
  private started = 0;
  private scopeActive = false;

  constructor(options: ColdProcessSchedulerOptions = {}) {
    this.concurrency = options.concurrency ?? 4;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.abortGraceMs = options.abortGraceMs ?? 250;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new TypeError("cold process scheduler concurrency must be a positive integer");
    }
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new TypeError("cold process scheduler timeout must be a positive integer");
    }
    if (!Number.isSafeInteger(this.abortGraceMs) || this.abortGraceMs < 1) {
      throw new TypeError("cold process scheduler abort grace must be a positive integer");
    }
  }

  snapshot(): ColdProcessSchedulerSnapshot {
    return {
      aborted: this.abortReason !== undefined,
      active: this.active.size,
      slots: this.active.size,
      waiters: this.queued.length,
      timers: this.timers.size,
      started: this.started,
      outcomes: this.outcomes.map((outcome) => ({ ...outcome })),
    };
  }

  async own<T>(callback: (scope: ColdProcessScope) => Promise<T>): Promise<T> {
    if (this.scopeActive) throw new Error("cold process scheduler scope is already active");
    this.scopeActive = true;
    const removeShutdownHooks = this.installShutdownHooks();
    try {
      const result = await callback({
        run: (command) => this.run(command),
        all: (promises) => this.all(promises),
      });
      await this.settle();
      if (this.abortReason !== undefined) throw new ColdProcessAbortedError(this.abortReason);
      return result;
    } catch (error) {
      await this.abortAndSettle(error);
      throw error;
    } finally {
      removeShutdownHooks();
      this.scopeActive = false;
    }
  }

  private run(command: ColdProcessCommand): Promise<ColdProcessResult> {
    if (this.abortReason !== undefined) {
      const rejected = Promise.reject<ColdProcessResult>(new ColdProcessAbortedError(this.abortReason));
      void rejected.catch(() => undefined);
      return rejected;
    }
    let resolve!: (result: ColdProcessResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<ColdProcessResult>((resolveResult, rejectResult) => {
      resolve = resolveResult;
      reject = rejectResult;
    });
    // The scope still returns the original rejecting promise to its caller, but
    // owns a rejection handler so abandoned siblings cannot become unhandled.
    void promise.catch(() => undefined);
    this.queued.push({ id: this.nextId++, command, resolve, reject });
    this.pump();
    return promise;
  }

  private async all<T>(promises: Iterable<PromiseLike<T> | T>): Promise<T[]> {
    let firstError: unknown;
    let failed = false;
    const guarded = [...promises].map(async (promise) => {
      try {
        return await promise;
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
          void this.abortAndSettle(error).catch(() => undefined);
        }
        throw error;
      }
    });
    const settled = await Promise.allSettled(guarded);
    if (failed) {
      await this.settle();
      throw firstError;
    }
    return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
  }

  private pump(): void {
    while (this.abortReason === undefined && this.active.size < this.concurrency && this.queued.length > 0) {
      this.start(this.queued.shift()!);
    }
    this.resolveIdle();
  }

  private start(job: QueuedCommand): void {
    let child: ChildProcess;
    try {
      child = spawn(job.command.command, job.command.args, {
        cwd: job.command.cwd,
        env: job.command.env ?? process.env,
        detached: false,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      job.resolve({
        status: 1,
        signal: null,
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
      });
      this.pump();
      return;
    }
    this.started += 1;
    const active = {
      job,
      child,
      commandTimer: undefined as unknown as NodeJS.Timeout,
      stdout: "",
      stderr: "",
      spawnError: "",
      timedOut: false,
      settled: false,
    } satisfies ActiveCommand;
    this.active.set(job.id, active);
    active.commandTimer = this.trackTimer(() => {
      if (active.settled) return;
      active.timedOut = true;
      this.terminate(active, "SIGKILL");
    }, this.timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      active.stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      active.stderr += chunk;
    });
    child.on("error", (error) => {
      active.spawnError = error.message;
    });
    child.on("close", (status, signal) => this.close(active, status, signal));
    child.stdin?.end(job.command.input);
  }

  private close(active: ActiveCommand, status: number | null, signal: NodeJS.Signals | null): void {
    if (active.settled) return;
    active.settled = true;
    this.clearTrackedTimer(active.commandTimer);
    if (active.forceTimer !== undefined) this.clearTrackedTimer(active.forceTimer);
    this.active.delete(active.job.id);
    const aborted = this.abortReason !== undefined;
    this.outcomes.push({
      pid: active.child.pid ?? null,
      status,
      signal,
      aborted,
      timedOut: active.timedOut,
    });
    if (aborted) {
      active.job.reject(new ColdProcessAbortedError(this.abortReason));
    } else {
      active.job.resolve({
        status: active.spawnError === "" ? status : 1,
        signal,
        stdout: active.stdout,
        stderr: active.spawnError === "" ? active.stderr : `${active.stderr}${active.spawnError}\n`,
      });
    }
    this.pump();
  }

  private async abortAndSettle(reason: unknown): Promise<void> {
    if (this.abortReason === undefined) {
      this.abortReason = reason;
      const cancellation = new ColdProcessAbortedError(reason);
      for (const job of this.queued.splice(0)) job.reject(cancellation);
      for (const active of this.active.values()) {
        this.terminate(active, "SIGTERM");
        active.forceTimer ??= this.trackTimer(() => {
          if (!active.settled && this.active.get(active.job.id) === active) {
            this.terminate(active, "SIGKILL");
          }
        }, this.abortGraceMs);
      }
      this.resolveIdle();
    }
    await this.settle();
  }

  private terminate(active: ActiveCommand, signal: NodeJS.Signals): void {
    if (active.settled || active.child.pid === undefined) return;
    try {
      active.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  private trackTimer(callback: () => void, milliseconds: number): NodeJS.Timeout {
    let timer: NodeJS.Timeout;
    timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
      this.resolveIdle();
    }, milliseconds);
    this.timers.add(timer);
    return timer;
  }

  private clearTrackedTimer(timer: NodeJS.Timeout): void {
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  private settle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private isIdle(): boolean {
    return this.active.size === 0 && this.queued.length === 0 && this.timers.size === 0;
  }

  private resolveIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private installShutdownHooks(): () => void {
    let shuttingDown = false;
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = new Map<NodeJS.Signals, () => void>();
    for (const signal of signals) {
      const handler = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        const exitAfterSettlement = () => {
          process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129);
        };
        void this.abortAndSettle(new Error(`participant received ${signal}`)).then(exitAfterSettlement, exitAfterSettlement);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
    const onExit = () => {
      for (const active of this.active.values()) this.terminate(active, "SIGKILL");
    };
    process.once("exit", onExit);
    return () => {
      for (const [signal, handler] of handlers) process.removeListener(signal, handler);
      process.removeListener("exit", onExit);
    };
  }
}
